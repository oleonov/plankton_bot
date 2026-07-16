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

// Decision-rule IDs for the GATE-lane bounce-exit SELL branch (decision-planner.ts,
// Phase 3): a resting maker target (re)established while unfilled, or a taker
// force-exit once the position has aged past the timeout. Two distinct IDs so
// downstream sizing/pricing/order-repo lookups (Phase 4) can tell the two
// intents apart.
export const BOUNCE_EXIT_TARGET_RULE_ID = "BOUNCE_EXIT_TARGET";
export const BOUNCE_EXIT_TIMEOUT_RULE_ID = "BOUNCE_EXIT_TIMEOUT";

/**
 * Narrow inputs `evaluateBounceExit` needs from an open GATE-lane position and
 * its live order state. Mirrors `GateEntryMarketInput`'s narrowing pattern —
 * avoids forcing callers/tests to build a full `Position`/`NormalizedMarket`.
 */
export interface BounceExitContext {
  /** Position's avg entry price (buy-side cost basis for the harvest target). */
  avgBuyPrice: number;
  /** Seconds since the position's first fill (legState.firstTradeAt). */
  holdSeconds: number;
  /** Market tick size, for snapping the harvest target price. */
  tickSize: number;
  /** True when a live BOUNCE_EXIT_TARGET SELL order is already resting (orderRepo). */
  hasActiveBounceTargetOrder: boolean;
}

export type BounceExitDecision =
  | { intent: "maker_target"; targetPx: number }
  | { intent: "timeout_taker" }
  | { intent: "none" };

/**
 * GATE-lane bounce-exit decision (live experiment, Phase 3): resting maker
 * target at `avgBuyPrice * (1 + targetGainPct)` while unfilled and within the
 * timeout window; a taker force-exit once `holdSeconds` passes the timeout,
 * regardless of whether a target is still resting (the timeout is a hard
 * bail-out, not conditioned on order state). Pure — no I/O, no runtime import.
 */
export function evaluateBounceExit(
  ctx: BounceExitContext,
  policy: BounceExitPolicy,
): BounceExitDecision {
  const timeoutSeconds = policy.timeoutMs / 1000;
  if (ctx.holdSeconds >= timeoutSeconds) {
    return { intent: "timeout_taker" };
  }
  if (ctx.hasActiveBounceTargetOrder) {
    return { intent: "none" };
  }
  return {
    intent: "maker_target",
    targetPx: computeHarvestTarget(ctx.avgBuyPrice, policy.targetGainPct, ctx.tickSize),
  };
}
