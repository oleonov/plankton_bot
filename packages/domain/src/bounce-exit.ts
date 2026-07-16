// GATE-lane entry eligibility (live experiment).
// See docs/plans/2026-07-15-gate-bounce-live-experiment.md — Phase 1: pure,
// config-driven eligibility check, no runtime wiring yet (decision-planner
// integration is Phase 2). Kept separate from the observe-only two-lane-entry
// shadow (apps/runtime/src/modules/algo-decision/two-lane-entry-shadow.ts):
// the shadow's GATE lane bakes in a notional proxy and looser, exploratory
// thresholds for classification/measurement and must not be conflated with
// this live, policy-driven gate.
import type { BounceExitPolicy, GateEntryPolicy } from "./types.js";
import { computeHarvestTarget } from "./tick-math.js";

// Decision-rule ID for the GATE live first-entry branch (decision-planner.ts,
// Phase 2). Sits alongside R23_DIP_TRIGGER_RULE_ID (r23-dip-trigger.ts) as the
// other first-entry candidate rule; kept here since packages/domain/src/bounce-exit.ts
// is the designated GATE-lane module (see the plan's scope budget).
export const GATE_ENTRY_RULE_ID = "GATE_ENTRY";

/**
 * Narrow structural subset of `NormalizedMarket` needed for GATE-lane
 * eligibility. Mirrors the `PreEntryInput` pattern in market-selection.ts —
 * avoids forcing callers/tests to build a full `NormalizedMarket` fixture.
 */
export interface GateEntryMarketInput {
  endDate: string | null;
  gammaCreatedAt: string | null;
  midPrice: number | null;
}

// Duplicated from two-lane-entry-shadow.ts's `computeLifespanDays` rather than
// imported: packages/domain must never depend on apps/runtime (dependency
// direction), and this is a 6-line pure date-diff helper, not worth a shared
// package for two call sites.
function computeLifespanDays(endDate: string | null, gammaCreatedAt: string | null): number | null {
  if (endDate == null || gammaCreatedAt == null) return null;
  const end = Date.parse(endDate);
  const created = Date.parse(gammaCreatedAt);
  if (!Number.isFinite(end) || !Number.isFinite(created)) return null;
  return (end - created) / 86_400_000;
}

/**
 * GATE-lane entry eligibility: inclusive lifespan/price bounds, no notional
 * component (unlike the two-lane shadow's exploratory GATE lane). Fails
 * closed (returns false) when lifespan or mid-price can't be derived.
 */
export function evaluateGateEntryEligibility(
  policy: GateEntryPolicy,
  market: GateEntryMarketInput,
): boolean {
  const lifespanDays = computeLifespanDays(market.endDate, market.gammaCreatedAt);
  const midPrice =
    market.midPrice != null && Number.isFinite(market.midPrice) ? market.midPrice : null;
  if (lifespanDays == null || midPrice == null) return false;

  return (
    lifespanDays >= policy.minLifespanDays &&
    midPrice >= policy.minPrice &&
    midPrice <= policy.maxPrice
  );
}

// Decision-rule IDs for the GATE-lane bounce-exit SELL branch (decision-planner.ts).
// Every rung of the resting-maker ladder shares BOUNCE_EXIT_TARGET_RULE_ID —
// rungs are told apart via the order metadata's `bounceRung.rungIndex`/`ladderId`
// (see decision-planner.ts/signal-to-order.ts), not the rule id. BACKSTOP is the
// near-resolution taker force-exit (docs/plans/2026-07-16-bounce-exit-ladder-
// redesign.md), replacing the old hold-time BOUNCE_EXIT_TIMEOUT_RULE_ID.
export const BOUNCE_EXIT_TARGET_RULE_ID = "BOUNCE_EXIT_TARGET";
export const BOUNCE_EXIT_BACKSTOP_RULE_ID = "BOUNCE_EXIT_BACKSTOP";

/**
 * True for the bounce-exit near-resolution force-exit SELL — the one signal
 * every guard-bypass/cancel/pricing site along the exit path must recognize
 * (docs/plans/2026-07-16-bounce-exit-ladder-redesign.md). A single predicate
 * so every call site stays in sync with the rule id (was duplicated ad hoc
 * under the old BOUNCE_EXIT_TIMEOUT_RULE_ID name). `side` is compared
 * case-insensitively: decision-planner's internal `TradeDecisionAction` is
 * uppercase ("SELL"), while `Signal.side` (what callers in signal-to-order.ts
 * hold) is lowercase ("sell").
 */
export function isBounceForceExit(sig: { side: string; decisionRuleId: string | null }): boolean {
  return sig.side.toLowerCase() === "sell" && sig.decisionRuleId === BOUNCE_EXIT_BACKSTOP_RULE_ID;
}

/**
 * Narrow inputs `evaluateBounceExit` needs from an open GATE-lane position and
 * its persisted rung state. Mirrors `GateEntryMarketInput`'s narrowing pattern —
 * avoids forcing callers/tests to build a full `Position`/`NormalizedMarket`.
 */
export interface BounceExitContext {
  /** Position's first-fill price — the ladder's fixed anchor (never the
   * mutable avgEntryPrice, which drifts with every add/partial-sell). */
  firstEntryPrice: number;
  /** Market tick size, for snapping each rung's price. */
  tickSize: number;
  /** Rung indices already placed (open or filled) for this position's ladder —
   * see decision-planner.ts/algo-decision-module.ts for how this is derived
   * from persisted order metadata. */
  placedRungIndices: readonly number[];
  /** Precomputed by the caller (Phase 2: always false — the real near-
   * resolution Track-Q wrapper is a later phase; this evaluator only accepts
   * the input and never derives it itself, keeping it pure/I-O-free). */
  backstopEligible: boolean;
}

export type BounceExitDecision =
  | { intent: "maker_rung"; rungIndex: number; px: number; fraction: number }
  | { intent: "backstop_taker" }
  | { intent: "none" };

/**
 * Inclusive entry-price-tiered gain lookup: the first tier where
 * `entryPrice <= maxPrice` wins (unlike D8's exclusive `<` bucket lookup —
 * see docs/plans/2026-07-16-bounce-exit-ladder-redesign.md REV2 H-M). Config
 * validation (`parseBounceExit`) requires the last tier's `maxPrice` to be
 * >= 1.0 — the top of the price domain — so the fallback below is defensive
 * only. Pure config-lookup.
 */
export function bounceExitTierGain(policy: BounceExitPolicy, entryPrice: number): number {
  for (const tier of policy.targetTiers) {
    if (entryPrice <= tier.maxPrice) return tier.gainPct;
  }
  return policy.targetTiers[policy.targetTiers.length - 1]!.gainPct;
}

/**
 * GATE-lane bounce-exit decision: the laddered resting-maker exit
 * (docs/plans/2026-07-16-bounce-exit-ladder-redesign.md). Selects the lowest
 * un-placed rung index and returns its price + size fraction; `{intent:"none"}`
 * once every configured rung is placed (open or filled) and no backstop is
 * eligible. `backstopEligible` is a precomputed input (Phase 2: the caller
 * always passes `false`, so `backstop_taker` is never produced yet — the real
 * near-resolution eligibility wrapper lands in a later phase) so this stays
 * pure — no I/O, no runtime import, no market/order lookups of its own.
 *
 * Rung pricing: rung0 = firstEntryPrice * (1 + bounceExitTierGain(...)); rung_k
 * (k >= 1) compounds the ladder step on top of rung0's *pre-tick-rounding*
 * value — `(1+tierGain) * (1+ladderStepPct)^k` — then snaps once via
 * `computeHarvestTarget`. Compounding from the raw anchor (rather than
 * chaining ceilToTick(ceilToTick(...))) applies exactly one tick-rounding per
 * rung instead of accumulating rounding drift rung over rung.
 */
export function evaluateBounceExit(
  ctx: BounceExitContext,
  policy: BounceExitPolicy,
): BounceExitDecision {
  if (ctx.backstopEligible) {
    return { intent: "backstop_taker" };
  }
  const tierGain = bounceExitTierGain(policy, ctx.firstEntryPrice);
  const placed = new Set(ctx.placedRungIndices);
  for (let rungIndex = 0; rungIndex < policy.ladderFractions.length; rungIndex++) {
    if (placed.has(rungIndex)) continue;
    const compoundedGain = (1 + tierGain) * Math.pow(1 + policy.ladderStepPct, rungIndex) - 1;
    return {
      intent: "maker_rung",
      rungIndex,
      px: computeHarvestTarget(ctx.firstEntryPrice, compoundedGain, ctx.tickSize),
      fraction: policy.ladderFractions[rungIndex]!,
    };
  }
  return { intent: "none" };
}
