// Track A "add throttle" — the shared, pure Track A add-throttle evaluator.
// KRABS-SPECIFIC risk logic, NOT Plankton logic — under this rule Plankton loses
// money; it is kept only because a Krabs replay improved Krabs by +$74.69 at the
// 60-minute / no-SELL threshold (30m, 120m, 180m were worse). The function is
// PURE (no side effects), but its verdict drives LIVE enforcement in the
// signal-to-order bridge: an approved add BUY is blocked before
// PlaceOrderRequested when the result is a throttle_candidate and
// policy.trackAAddThrottle.enforce is on.
//
// Rule: flag an add/scale-in BUY as a throttle candidate when
//   decisionType == "add" AND leg age >= 60 minutes AND no SELL has occurred in
//   the current leg before this add.
//
// Fail-open: if the leg start (firstBuyTs) or the in-leg SELL state is unknown,
// the result is `unknown` with a typed reason — never a throttle_candidate.

import type { LegStateRepository, TokenId } from "@krabs/domain";
import {
  deriveDecisionType,
  deriveSourceGroup,
  type DeadMarketDecisionType,
  type DeadMarketSourceGroup,
} from "./dead-market-score.js";

/** Validated leg-age threshold (minutes). Krabs replay optimum; see header. */
export const TRACK_A_MIN_LEG_AGE_MINUTES = 60;
export const TRACK_A_ADD_THROTTLE_REASON = "age_60m_no_sell";

export type TrackAClassification = "allow" | "throttle_candidate" | "unknown";

export type TrackAReason =
  | "not_add"
  | "insufficient_age"
  | "sell_seen"
  | "missing_first_buy_ts"
  | "missing_sell_state"
  | typeof TRACK_A_ADD_THROTTLE_REASON;

export interface TrackAAddThrottleInput {
  /** entry/add/unknown derived from signal.reason (see deriveDecisionType). */
  decisionType: DeadMarketDecisionType;
  /** Epoch ms of the current leg's first BUY fill. null => unknown. */
  firstBuyTs: number | null;
  /** Whether any SELL fill has occurred in the current leg. null => unknown. */
  hasSellInLeg: boolean | null;
  /** Evaluation time (epoch ms). */
  now: number;
}

export interface TrackAAddThrottleResult {
  classification: TrackAClassification;
  reason: TrackAReason;
  legAgeMinutes: number | null;
}

const result = (
  classification: TrackAClassification,
  reason: TrackAReason,
  legAgeMinutes: number | null,
): TrackAAddThrottleResult => ({ classification, reason, legAgeMinutes });

export function evaluateTrackAAddThrottle(input: TrackAAddThrottleInput): TrackAAddThrottleResult {
  // The rule only targets adds; entries and unknowns are out of scope.
  if (input.decisionType !== "add") return result("allow", "not_add", null);

  // Without a leg start we cannot compute age at all.
  if (input.firstBuyTs == null || !Number.isFinite(input.firstBuyTs)) {
    return result("unknown", "missing_first_buy_ts", null);
  }

  const legAgeMinutes = (input.now - input.firstBuyTs) / 60_000;

  // Age is decisive: if the add is too young the throttle can never apply, so
  // we don't need (and don't wait on) the SELL state — definitive allow.
  if (legAgeMinutes < TRACK_A_MIN_LEG_AGE_MINUTES) {
    return result("allow", "insufficient_age", legAgeMinutes);
  }

  // Old enough to throttle, but the SELL state is required to decide.
  if (input.hasSellInLeg == null) {
    return result("unknown", "missing_sell_state", legAgeMinutes);
  }
  if (input.hasSellInLeg) return result("allow", "sell_seen", legAgeMinutes);

  return result("throttle_candidate", TRACK_A_ADD_THROTTLE_REASON, legAgeMinutes);
}

/** Signal fields the shared evaluator needs (a structural subset of Signal). */
export interface TrackASignalInput {
  reason: string | null | undefined;
  decisionRuleId: string | null | undefined;
  tokenId: TokenId;
}

export interface TrackASignalEvaluation {
  decisionType: DeadMarketDecisionType;
  sourceGroup: DeadMarketSourceGroup;
  result: TrackAAddThrottleResult;
  /** Epoch ms of the leg's first BUY (adds only); null when unknown. */
  firstBuyTs: number | null;
  /** In-leg SELL presence (adds only); null when unknown. */
  hasSellInLeg: boolean | null;
  /** Whether a leg row was found (adds only; always false for entries). */
  legStatePresent: boolean;
}

// Single source of truth for Track A classification, used by the live bridge
// enforcement (same fail-open semantics). The leg repo is queried ONLY for adds;
// entries/unknowns short-circuit without a lookup. A null/absent repo or
// unparseable leg start fails open to `unknown` (never a throttle_candidate).
export function evaluateSignalTrackAAddThrottle(
  signal: TrackASignalInput,
  legStateRepo: Pick<LegStateRepository, "get"> | undefined,
  now: number,
): TrackASignalEvaluation {
  const decisionType = deriveDecisionType(signal.reason);
  const sourceGroup = deriveSourceGroup(signal.decisionRuleId);
  const legState = decisionType === "add" ? (legStateRepo?.get(signal.tokenId) ?? null) : null;
  const firstBuyTs = legState ? parseLegStartMs(legState.firstTradeAt) : null;
  const hasSellInLeg = legState ? (legState.sellCount ?? 0) > 0 : null;

  const result = evaluateTrackAAddThrottle({ decisionType, firstBuyTs, hasSellInLeg, now });

  return {
    decisionType,
    sourceGroup,
    result,
    firstBuyTs,
    hasSellInLeg,
    legStatePresent: legState != null,
  };
}

function parseLegStartMs(firstTradeAt: string): number | null {
  const ts = Date.parse(firstTradeAt);
  return Number.isFinite(ts) ? ts : null;
}
