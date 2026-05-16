import type { AlgoState } from "./algo-engine.js";

export interface D9LossExitContext {
  state: AlgoState;
  currentPrice: number;
  cumulativeBuyNotional: number;
  cumulativeBuySize: number;
  publicTradeCount24h: number | null;
}

export interface D9LossExitPolicy {
  enabled: boolean;
  states: readonly AlgoState[];
  minPublicTradeCount24h: number;
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
    | "d9-loss-exit-fired";
  profitRatio: number | null;
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
    return noFire("disabled", null, ctx.publicTradeCount24h);
  }
  if (!policy.states.includes(ctx.state)) {
    return noFire("state-mismatch", null, ctx.publicTradeCount24h);
  }
  if (ctx.cumulativeBuySize <= 0 || !Number.isFinite(ctx.cumulativeBuySize)) {
    return noFire("avg-buy-unavailable", null, ctx.publicTradeCount24h);
  }
  const avgBuyPrice = ctx.cumulativeBuyNotional / ctx.cumulativeBuySize;
  if (!Number.isFinite(avgBuyPrice) || avgBuyPrice <= 0) {
    return noFire("avg-buy-unavailable", null, ctx.publicTradeCount24h);
  }
  const profitRatio = ctx.currentPrice / avgBuyPrice;
  if (!Number.isFinite(profitRatio)) {
    return noFire("not-in-loss", null, ctx.publicTradeCount24h);
  }
  if (profitRatio >= 1.0) {
    return noFire("not-in-loss", profitRatio, ctx.publicTradeCount24h);
  }
  if (ctx.publicTradeCount24h == null) {
    return noFire("liquidity-data-missing", profitRatio, null);
  }
  if (ctx.publicTradeCount24h < policy.minPublicTradeCount24h) {
    return noFire("market-illiquid", profitRatio, ctx.publicTradeCount24h);
  }
  return {
    fire: true,
    reason: "d9-loss-exit-fired",
    profitRatio,
    publicTradeCount24h: ctx.publicTradeCount24h,
  };
}

function noFire(
  reason: D9Result["reason"],
  profitRatio: number | null,
  publicTradeCount24h: number | null,
): D9Result {
  return {
    fire: false,
    reason,
    profitRatio,
    publicTradeCount24h,
  };
}
