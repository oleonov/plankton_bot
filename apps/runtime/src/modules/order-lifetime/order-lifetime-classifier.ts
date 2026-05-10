import type {
  AlgoTokenModeState,
  ConditionId,
  Fill,
  Market,
  Order,
  OrderLifetimePolicy,
  TokenId,
  TokenOrderLifetimeConfidence,
  TokenOrderLifetimeMode,
} from "@krabs/domain";

const MAX_FILL_TIMESTAMPS = 10;
const MODE_TRANSITION_STATUSES = new Set(["candidate", "confirmed"]);

export interface ModeClassificationInput {
  tokenId: TokenId;
  conditionId: ConditionId;
  outcomeIndex: number | null;
  fills: readonly Pick<Fill, "filledAt">[];
  orders: readonly Pick<Order, "createdAt">[];
  market: Pick<Market, "active" | "endDate"> | null;
  previous: AlgoTokenModeState | null;
  policy: OrderLifetimePolicy;
  nowMs: number;
}

export interface ModeClassificationResult {
  state: AlgoTokenModeState;
  transitioned: boolean;
  transitionReason: string;
}

interface FillStats {
  fillTimesMs: number[];
  orderTimesMs: number[];
  fillCount: number;
  orderCount: number;
  firstFillLatencyMs: number | null;
  medianGapMs: number | null;
  p75GapMs: number | null;
  spanMs: number | null;
  lastFillAt: string | null;
  lastOrderAt: string | null;
}

interface ModeProposal {
  mode: TokenOrderLifetimeMode;
  confidence: TokenOrderLifetimeConfidence;
  status: AlgoTokenModeState["modeStatus"];
  reason: string;
}

export function classifyOrderLifetimeMode(
  input: ModeClassificationInput,
): ModeClassificationResult {
  const stats = buildFillStats(input.fills, input.orders);
  const reset = resolveResetProposal(input, stats);
  const proposal = reset ?? resolveModeProposal(input, stats);
  const guarded = applyOscillationGuard(proposal, input.previous, input.policy, input.nowMs);
  const state = buildState(input, stats, guarded);
  return {
    state,
    transitioned: didTransition(input.previous, state),
    transitionReason: guarded.reason,
  };
}

export function advanceOrderLifetimeTtlStage(
  state: AlgoTokenModeState,
  policy: OrderLifetimePolicy,
  nowMs: number,
): AlgoTokenModeState {
  const maxStage = state.mode === "BURST" ? 0 : 2;
  const ttlStage = Math.min(maxStage, state.ttlStage + 1);
  const transitionDay = normalizeTransitionDay(state, policy, nowMs);
  return {
    ...state,
    ttlStage,
    lastStaleCancelAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    resetReason: ttlStage > state.ttlStage ? "stale_exit_ttl_stage_advance" : state.resetReason,
    transitionCountDay: transitionDay.transitionCountDay,
    transitionDay: transitionDay.transitionDay,
  };
}

function resolveResetProposal(
  input: ModeClassificationInput,
  stats: FillStats,
): ModeProposal | null {
  const previous = input.previous;
  if (input.market?.active === false) return passive("market_inactive", "confirmed", "low");
  const lastFillAt = stats.lastFillAt ?? previous?.lastFillAt ?? null;
  if (lastFillAt) {
    const lastFillMs = Date.parse(lastFillAt);
    if (Number.isFinite(lastFillMs) && input.nowMs - lastFillMs > input.policy.staleResetMs) {
      return passive("no_fills_24h_reset", "confirmed", "low");
    }
  }
  if (stats.fillCount === 0) return passive("no_fills", "confirmed", "low");
  return null;
}

function resolveModeProposal(input: ModeClassificationInput, stats: FillStats): ModeProposal {
  const burstHysteresis = preserveConfirmedBurst(input, stats);
  if (burstHysteresis) return burstHysteresis;
  if (isBurstConfirmed(input.policy, stats)) {
    return {
      mode: "BURST",
      confidence: confidenceFor("BURST", stats, input.policy),
      status: "confirmed",
      reason: "burst_confirmed_fast_gaps",
    };
  }
  if (isMiddleConfirmed(input.policy, stats)) {
    return {
      mode: "MIDDLE",
      confidence: confidenceFor("MIDDLE", stats, input.policy),
      status: "confirmed",
      reason: "middle_confirmed_moderate_gaps",
    };
  }
  if (isBurstCandidate(input.policy, stats)) {
    return {
      mode: "BURST",
      confidence: "low",
      status: "candidate",
      reason: "burst_candidate_fast_first_fill",
    };
  }
  return {
    mode: "PASSIVE",
    confidence: confidenceFor("PASSIVE", stats, input.policy),
    status: "confirmed",
    reason: "passive_default_slow_or_sparse_fills",
  };
}

function preserveConfirmedBurst(
  input: ModeClassificationInput,
  stats: FillStats,
): ModeProposal | null {
  if (input.previous?.mode !== "BURST" || input.previous.modeStatus !== "confirmed") return null;
  if (hasStrongSlowEvidence(input.policy, stats)) {
    if (isMiddleConfirmed(input.policy, stats)) {
      return {
        mode: "MIDDLE",
        confidence: confidenceFor("MIDDLE", stats, input.policy),
        status: "confirmed",
        reason: "burst_to_middle_strong_slow_evidence",
      };
    }
    return {
      mode: "PASSIVE",
      confidence: confidenceFor("PASSIVE", stats, input.policy),
      status: "confirmed",
      reason: "burst_to_passive_strong_slow_evidence",
    };
  }
  return {
    mode: "BURST",
    confidence: confidenceFor("BURST", stats, input.policy),
    status: "confirmed",
    reason: "burst_confirmed_hysteresis",
  };
}

function isBurstCandidate(policy: OrderLifetimePolicy, stats: FillStats): boolean {
  return (
    stats.fillCount === 1 &&
    stats.firstFillLatencyMs != null &&
    stats.firstFillLatencyMs <= policy.burst.candidateFirstFillLatencyMs
  );
}

function isBurstConfirmed(policy: OrderLifetimePolicy, stats: FillStats): boolean {
  if (stats.fillCount < 2) return false;
  const direct =
    (stats.spanMs ?? Number.POSITIVE_INFINITY) <= policy.burst.confirmSpanMs &&
    (stats.medianGapMs ?? Number.POSITIVE_INFINITY) <= policy.burst.confirmMedianGapMs;
  const latencyBackstop =
    stats.firstFillLatencyMs != null &&
    stats.firstFillLatencyMs <= policy.burst.confirmFirstFillLatencyMs &&
    (stats.p75GapMs ?? Number.POSITIVE_INFINITY) <= policy.burst.confirmP75GapMs &&
    (stats.spanMs ?? Number.POSITIVE_INFINITY) <= policy.burst.confirmMaxSpanMs;
  return direct || latencyBackstop;
}

function isMiddleConfirmed(policy: OrderLifetimePolicy, stats: FillStats): boolean {
  if (stats.fillCount < 2 || stats.medianGapMs == null || stats.spanMs == null) return false;
  return (
    stats.medianGapMs >= policy.middle.minMedianGapMs &&
    stats.medianGapMs <= policy.middle.maxMedianGapMs &&
    stats.spanMs <= policy.middle.maxSpanMs
  );
}

function hasStrongSlowEvidence(policy: OrderLifetimePolicy, stats: FillStats): boolean {
  if (stats.fillCount < 5 || stats.medianGapMs == null) return false;
  if (stats.medianGapMs >= 2 * 60_000) return true;
  return (stats.spanMs ?? 0) > policy.passive.highConfidenceMinSpanMs;
}

function confidenceFor(
  mode: TokenOrderLifetimeMode,
  stats: FillStats,
  policy: OrderLifetimePolicy,
): TokenOrderLifetimeConfidence {
  if (mode === "BURST") return burstConfidence(stats, policy);
  if (mode === "MIDDLE") return middleConfidence(stats, policy);
  return passiveConfidence(stats, policy);
}

function burstConfidence(
  stats: FillStats,
  policy: OrderLifetimePolicy,
): TokenOrderLifetimeConfidence {
  if (stats.fillCount >= 5 && (stats.medianGapMs ?? Infinity) <= policy.burst.confirmMedianGapMs) {
    return "high";
  }
  if (stats.fillCount >= 3) return "medium";
  return "low";
}

function middleConfidence(
  stats: FillStats,
  policy: OrderLifetimePolicy,
): TokenOrderLifetimeConfidence {
  const stable =
    (stats.medianGapMs ?? -1) >= policy.middle.minMedianGapMs &&
    (stats.medianGapMs ?? Infinity) <= policy.middle.maxMedianGapMs;
  if (stats.fillCount >= 5 && stable) return "high";
  if (stats.fillCount >= 3) return "medium";
  return "low";
}

function passiveConfidence(
  stats: FillStats,
  policy: OrderLifetimePolicy,
): TokenOrderLifetimeConfidence {
  const slowGaps = (stats.medianGapMs ?? 0) > policy.middle.maxMedianGapMs;
  const longSpan = (stats.spanMs ?? 0) > policy.passive.highConfidenceMinSpanMs;
  if (stats.fillCount >= policy.passive.highConfidenceMinFills && (longSpan || slowGaps)) {
    return "high";
  }
  if (stats.fillCount >= 3) return "medium";
  return "low";
}

function buildFillStats(
  fills: readonly Pick<Fill, "filledAt">[],
  orders: readonly Pick<Order, "createdAt">[],
): FillStats {
  const fillTimesMs = sortedTimes(fills.map((f) => f.filledAt)).slice(-MAX_FILL_TIMESTAMPS);
  const orderTimesMs = sortedTimes(orders.map((o) => o.createdAt));
  const gaps = fillTimesMs.slice(1).map((value, idx) => value - (fillTimesMs[idx] ?? value));
  const firstOrderMs = orderTimesMs[0] ?? null;
  const firstFillMs = fillTimesMs[0] ?? null;
  const lastFillMs = fillTimesMs.at(-1) ?? null;
  const lastOrderMs = orderTimesMs.at(-1) ?? null;
  return {
    fillTimesMs,
    orderTimesMs,
    fillCount: fillTimesMs.length,
    orderCount: orderTimesMs.length,
    firstFillLatencyMs:
      firstOrderMs != null && firstFillMs != null && firstFillMs >= firstOrderMs
        ? firstFillMs - firstOrderMs
        : null,
    medianGapMs: percentile(gaps, 0.5),
    p75GapMs: percentile(gaps, 0.75),
    spanMs:
      firstFillMs != null && lastFillMs != null && fillTimesMs.length >= 2
        ? lastFillMs - firstFillMs
        : null,
    lastFillAt: lastFillMs != null ? new Date(lastFillMs).toISOString() : null,
    lastOrderAt: lastOrderMs != null ? new Date(lastOrderMs).toISOString() : null,
  };
}

function sortedTimes(values: readonly string[]): number[] {
  return values
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
}

function percentile(values: readonly number[], pct: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1);
  return sorted[idx] ?? null;
}

function passive(
  reason: string,
  status: AlgoTokenModeState["modeStatus"],
  confidence: TokenOrderLifetimeConfidence,
): ModeProposal {
  return { mode: "PASSIVE", confidence, status, reason };
}

function applyOscillationGuard(
  proposal: ModeProposal,
  previous: AlgoTokenModeState | null,
  policy: OrderLifetimePolicy,
  nowMs: number,
): ModeProposal {
  if (!previous || previous.mode === proposal.mode) return proposal;
  const normalized = normalizeTransitionDay(previous, policy, nowMs);
  if (normalized.transitionCountDay + 1 <= policy.oscillationTransitionLimitPerDay) {
    return proposal;
  }
  return passive("mode_oscillation_guard", "confirmed", "low");
}

function buildState(
  input: ModeClassificationInput,
  stats: FillStats,
  proposal: ModeProposal,
): AlgoTokenModeState {
  const previous = input.previous;
  const nowIso = new Date(input.nowMs).toISOString();
  const transitionDay = normalizeTransitionDay(previous, input.policy, input.nowMs);
  const transitioned = previous != null && previous.mode !== proposal.mode;
  const transitionCountDay = transitioned
    ? transitionDay.transitionCountDay + 1
    : transitionDay.transitionCountDay;
  return {
    tokenId: input.tokenId,
    conditionId: input.conditionId,
    outcomeIndex: input.outcomeIndex,
    mode: proposal.mode,
    modeConfidence: proposal.confidence,
    modeStatus: MODE_TRANSITION_STATUSES.has(proposal.status) ? proposal.status : "confirmed",
    modeSince: transitioned || !previous ? nowIso : previous.modeSince,
    modeAssessedAt: nowIso,
    ttlStage: transitioned ? 0 : (previous?.ttlStage ?? 0),
    lastFillAt: stats.lastFillAt,
    lastOrderAt: stats.lastOrderAt,
    lastStaleCancelAt: previous?.lastStaleCancelAt ?? null,
    fillCountWindow: stats.fillCount,
    orderCountWindow: stats.orderCount,
    firstFillLatencyMs: stats.firstFillLatencyMs,
    medianGapMs: stats.medianGapMs,
    p75GapMs: stats.p75GapMs,
    spanMs: stats.spanMs,
    lastFillTimestampsJson: JSON.stringify(
      stats.fillTimesMs.map((ms) => new Date(ms).toISOString()),
    ),
    transitionCountDay,
    transitionDay: transitionDay.transitionDay,
    resetReason: proposal.reason,
    updatedAt: nowIso,
  };
}

function normalizeTransitionDay(
  state: AlgoTokenModeState | null,
  _policy: OrderLifetimePolicy,
  nowMs: number,
): Pick<AlgoTokenModeState, "transitionCountDay" | "transitionDay"> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (!state || state.transitionDay !== day) {
    return { transitionCountDay: 0, transitionDay: day };
  }
  return { transitionCountDay: state.transitionCountDay, transitionDay: state.transitionDay };
}

function didTransition(previous: AlgoTokenModeState | null, state: AlgoTokenModeState): boolean {
  if (!previous) return false;
  return previous.mode !== state.mode || previous.modeStatus !== state.modeStatus;
}
