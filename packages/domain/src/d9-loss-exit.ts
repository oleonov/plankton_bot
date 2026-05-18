import type { AlgoState } from "./algo-engine.js";

export const H5_WIDE_COHORT_GUARD_REASON = "h5-wide-cohort-guard";

export interface D9LossExitContext {
  state: AlgoState;
  currentPrice: number;
  cumulativeBuyNotional: number;
  cumulativeBuySize: number;
  publicTradeCount24h: number | null;
  daysToResolve: number | null;
}

export interface D9LossExitCohortGuardPolicy {
  enabled: boolean;
  state: AlgoState;
  avgBuyMin: number;
  avgBuyMax: number;
  minDaysToResolve: number;
}

export interface D9LossExitPolicy {
  enabled: boolean;
  states: readonly AlgoState[];
  minPublicTradeCount24h: number;
  cohortGuard: D9LossExitCohortGuardPolicy;
}

export interface D9Result {
  fire: boolean;
  reason:
    | "disabled"
    | "state-mismatch"
    | "avg-buy-unavailable"
    | "not-in-loss"
    | "liquidity-data-missing"
    | "market-illiquid"
    | typeof H5_WIDE_COHORT_GUARD_REASON
    | "d9-loss-exit-fired";
  profitRatio: number | null;
  avgBuyPrice: number | null;
  daysToResolve: number | null;
  publicTradeCount24h: number | null;
}

/**
 * Plankton-mirror loss-exit trigger derived from R96 Q3 best 2D rule.
 *
 * Formula: fire if state in policy.states AND profitRatio < 1.0 AND
 * publicTradeCount24h >= minPublicTradeCount24h.
 *
 * Numerical derivation (do NOT change without R-evidence):
 * - threshold 41: R96 Q3 candidate 2D rule, balanced acc 76.62%,
 *   highest non-degenerate balanced accuracy on n=4,555 CUT vs n=573,192
 *   HOLD opportunities (research_plankton/plankton_loss_exit_boundary_R96_report.md)
 * - states [S1, S2]: R96 Q4 state-conditional; S3 has 0 HOLD samples
 *   (terminal state by definition); OTHER too few
 * - profitRatio < 1.0: loss definition, mathematical identity
 */
export function evaluateD9LossExit(ctx: D9LossExitContext, policy: D9LossExitPolicy): D9Result {
  if (!policy.enabled) {
    return noFire("disabled", null, null, ctx.daysToResolve, ctx.publicTradeCount24h);
  }
  if (!policy.states.includes(ctx.state)) {
    return noFire("state-mismatch", null, null, ctx.daysToResolve, ctx.publicTradeCount24h);
  }
  if (ctx.cumulativeBuySize <= 0 || !Number.isFinite(ctx.cumulativeBuySize)) {
    return noFire("avg-buy-unavailable", null, null, ctx.daysToResolve, ctx.publicTradeCount24h);
  }
  const avgBuyPrice = ctx.cumulativeBuyNotional / ctx.cumulativeBuySize;
  if (!Number.isFinite(avgBuyPrice) || avgBuyPrice <= 0) {
    return noFire("avg-buy-unavailable", null, null, ctx.daysToResolve, ctx.publicTradeCount24h);
  }
  const profitRatio = ctx.currentPrice / avgBuyPrice;
  if (!Number.isFinite(profitRatio)) {
    return noFire("not-in-loss", null, avgBuyPrice, ctx.daysToResolve, ctx.publicTradeCount24h);
  }
  if (matchesH5WideCohortGuard(ctx, policy.cohortGuard, avgBuyPrice)) {
    return noFire(
      H5_WIDE_COHORT_GUARD_REASON,
      profitRatio,
      avgBuyPrice,
      ctx.daysToResolve,
      ctx.publicTradeCount24h,
    );
  }
  if (profitRatio >= 1.0) {
    return noFire(
      "not-in-loss",
      profitRatio,
      avgBuyPrice,
      ctx.daysToResolve,
      ctx.publicTradeCount24h,
    );
  }
  if (ctx.publicTradeCount24h == null) {
    return noFire("liquidity-data-missing", profitRatio, avgBuyPrice, ctx.daysToResolve, null);
  }
  if (ctx.publicTradeCount24h < policy.minPublicTradeCount24h) {
    return noFire(
      "market-illiquid",
      profitRatio,
      avgBuyPrice,
      ctx.daysToResolve,
      ctx.publicTradeCount24h,
    );
  }
  return {
    fire: true,
    reason: "d9-loss-exit-fired",
    profitRatio,
    avgBuyPrice,
    daysToResolve: ctx.daysToResolve,
    publicTradeCount24h: ctx.publicTradeCount24h,
  };
}

function matchesH5WideCohortGuard(
  ctx: D9LossExitContext,
  guard: D9LossExitCohortGuardPolicy,
  avgBuyPrice: number,
): boolean {
  if (!guard.enabled) return false;
  if (ctx.state !== guard.state) return false;
  if (ctx.daysToResolve == null || !Number.isFinite(ctx.daysToResolve)) return false;
  if (ctx.daysToResolve <= guard.minDaysToResolve) return false;
  return avgBuyPrice >= guard.avgBuyMin && avgBuyPrice <= guard.avgBuyMax;
}

function noFire(
  reason: D9Result["reason"],
  profitRatio: number | null,
  avgBuyPrice: number | null,
  daysToResolve: number | null,
  publicTradeCount24h: number | null,
): D9Result {
  return {
    fire: false,
    reason,
    profitRatio,
    avgBuyPrice,
    daysToResolve,
    publicTradeCount24h,
  };
}
