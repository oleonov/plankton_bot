import type { AlgoTokenModeState, Market, Order, OrderLifetimePolicy } from "@krabs/domain";

export interface ExitOrderLifetimeInput {
  order: Pick<Order, "createdAt" | "orderId" | "tokenId" | "side">;
  market: Pick<Market, "endDate"> | null;
  modeState: AlgoTokenModeState | null;
  policy: OrderLifetimePolicy;
  flatTtlMs: number;
  nowMs: number;
}

export interface ExitOrderLifetimeDecision {
  enabled: boolean;
  enforcement: OrderLifetimePolicy["enforcement"];
  mode: AlgoTokenModeState["mode"] | "UNKNOWN";
  confidence: AlgoTokenModeState["modeConfidence"] | "unknown";
  modeStatus: AlgoTokenModeState["modeStatus"] | "unknown";
  flatTtlMs: number;
  modeTtlMs: number;
  effectiveTtlMs: number;
  ageMs: number;
  timeToEndMs: number | null;
  resolutionCapApplied: boolean;
  rateLimited: boolean;
  wouldCancelUnderFlat: boolean;
  wouldCancelUnderMode: boolean;
  cancelReason: "ttl_exceeded" | "end_date_safety_buffer" | null;
}

export function resolveExitOrderLifetime(input: ExitOrderLifetimeInput): ExitOrderLifetimeDecision {
  const ageMs = Math.max(0, input.nowMs - Date.parse(input.order.createdAt));
  const modeState = input.modeState;
  const modeTtlMs = modeState ? ttlForMode(modeState, input.policy) : input.policy.passive.lowTtlMs;
  const endDateMs = parseEndDateMs(input.market?.endDate ?? null);
  const timeToEndMs = endDateMs == null ? null : endDateMs - input.nowMs;
  const base: Omit<
    ExitOrderLifetimeDecision,
    | "effectiveTtlMs"
    | "resolutionCapApplied"
    | "rateLimited"
    | "wouldCancelUnderMode"
    | "cancelReason"
  > = {
    enabled: input.policy.enabled,
    enforcement: input.policy.enforcement,
    mode: modeState?.mode ?? "PASSIVE",
    confidence: modeState?.modeConfidence ?? "low",
    modeStatus: modeState?.modeStatus ?? "confirmed",
    flatTtlMs: input.flatTtlMs,
    modeTtlMs,
    ageMs,
    timeToEndMs,
    wouldCancelUnderFlat: ageMs > input.flatTtlMs,
  };

  if (!input.policy.enabled) {
    return {
      ...base,
      effectiveTtlMs: input.flatTtlMs,
      resolutionCapApplied: false,
      rateLimited: false,
      wouldCancelUnderMode: false,
      cancelReason: null,
    };
  }

  const resolution = resolveResolutionLimit(input.policy, timeToEndMs);

  if (input.order.side === "sell") {
    const capApplied = resolution.capMs < input.flatTtlMs;
    const effectiveTtlMs = Math.max(1_000, Math.min(input.flatTtlMs, resolution.capMs));
    return {
      ...base,
      mode: "UNKNOWN",
      confidence: "unknown",
      modeStatus: "unknown",
      modeTtlMs: input.flatTtlMs,
      effectiveTtlMs,
      resolutionCapApplied: capApplied,
      rateLimited: false,
      // SELL bypass: `wouldCancelUnderMode` semantically equivalent to
      // `wouldCancelUnderFlat` here because mode classification was bypassed.
      // Field name kept for response-shape stability across consumers.
      wouldCancelUnderMode: ageMs > effectiveTtlMs,
      cancelReason:
        ageMs > effectiveTtlMs ? (capApplied ? resolution.cancelReason : "ttl_exceeded") : null,
    };
  }

  const capApplied = resolution.capMs < modeTtlMs;
  const effectiveTtlMs = Math.max(1_000, Math.min(modeTtlMs, resolution.capMs));
  return {
    ...base,
    effectiveTtlMs,
    resolutionCapApplied: capApplied,
    rateLimited: false,
    wouldCancelUnderMode: ageMs > effectiveTtlMs,
    cancelReason:
      ageMs > effectiveTtlMs ? (capApplied ? resolution.cancelReason : "ttl_exceeded") : null,
  };
}

function ttlForMode(state: AlgoTokenModeState, policy: OrderLifetimePolicy): number {
  if (state.mode === "BURST") return ttlByConfidence(policy.burst, state.modeConfidence);
  if (state.mode === "MIDDLE") {
    return ttlByStage(
      state.ttlStage,
      ttlByConfidence(policy.middle, state.modeConfidence),
      policy.middle.mediumTtlMs,
      policy.middle.highTtlMs,
    );
  }
  return ttlByStage(
    state.ttlStage,
    ttlByConfidence(policy.passive, state.modeConfidence),
    policy.passive.mediumTtlMs,
    policy.passive.highTtlMs,
  );
}

function ttlByConfidence(
  ttl: { lowTtlMs: number; mediumTtlMs: number; highTtlMs: number },
  confidence: AlgoTokenModeState["modeConfidence"],
): number {
  if (confidence === "high") return ttl.highTtlMs;
  if (confidence === "medium") return ttl.mediumTtlMs;
  return ttl.lowTtlMs;
}

function ttlByStage(
  stage: number,
  baseTtlMs: number,
  mediumTtlMs: number,
  highTtlMs: number,
): number {
  if (stage >= 2) return Math.max(baseTtlMs, highTtlMs);
  if (stage >= 1) return Math.max(baseTtlMs, mediumTtlMs);
  return baseTtlMs;
}

function resolveResolutionLimit(
  policy: OrderLifetimePolicy,
  timeToEndMs: number | null,
): {
  capMs: number;
  cancelReason: "ttl_exceeded" | "end_date_safety_buffer";
} {
  if (timeToEndMs == null) {
    return { capMs: Number.POSITIVE_INFINITY, cancelReason: "ttl_exceeded" };
  }
  if (timeToEndMs <= 0) {
    return { capMs: Number.POSITIVE_INFINITY, cancelReason: "ttl_exceeded" };
  }
  // ADR-028: no timestamp-only hard stop. Plankton trades past nominal end_date;
  // actual tradability is checked at SELL placement by hard-liveness.
  const safetyCapMs =
    timeToEndMs > policy.safetyBufferMs
      ? timeToEndMs - policy.safetyBufferMs
      : Number.POSITIVE_INFINITY;
  const aggressiveCapMs =
    timeToEndMs <= policy.resolutionAggressiveWindowMs
      ? policy.resolutionExitTtlCapMs
      : Number.POSITIVE_INFINITY;
  return {
    capMs: Math.min(safetyCapMs, aggressiveCapMs),
    cancelReason: safetyCapMs <= aggressiveCapMs ? "end_date_safety_buffer" : "ttl_exceeded",
  };
}

function parseEndDateMs(endDate: string | null): number | null {
  if (!endDate) return null;
  const value = Date.parse(endDate);
  return Number.isFinite(value) ? value : null;
}
