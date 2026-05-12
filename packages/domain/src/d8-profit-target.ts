import type { AlgoState } from "./algo-engine.js";
import type { ProfitTargetPolicyConfig } from "./types.js";

// CHANGE A — D8 profit-ratio SELL trigger per R66 spec 14.Y.
// Threshold is a function of avg_buy_price (cheaper tokens require higher
// multiplicative return before SELL). avg_buy_price itself is derived from
// leg_states.cumulative_buy_notional / cumulative_buy_size (migration 050) —
// no new column required.

// R66 median first-SELL holdTime ≈ 1.44 hours.
// NOTE: median excludes the fast 50% of Plankton's first-SELLs — if
// post-deploy data shows missed fast-profit cases, lower via control.db
// (e.g. to p25 ≈ 1h) without redeploy.
export const D8_HOLD_SECONDS_MIN = 5183 as const;

export const DEFAULT_PROFIT_TARGET_POLICY: ProfitTargetPolicyConfig = {
  enabled: true,
  holdSecondsMin: D8_HOLD_SECONDS_MIN,
};

interface ThresholdBucket {
  readonly maxPrice: number;
  readonly ratio: number;
}

export const D8_THRESHOLD_BUCKETS: readonly ThresholdBucket[] = [
  { maxPrice: 0.02, ratio: 2.0 },
  { maxPrice: 0.05, ratio: 1.2412 },
  { maxPrice: 0.1, ratio: 1.228 },
  { maxPrice: 0.2, ratio: 1.2105 },
  { maxPrice: 0.35, ratio: 1.1364 },
  { maxPrice: 0.5, ratio: 1.1005 },
];

/**
 * Resolve R66 14.Y multiplicative profit threshold for a given avg_buy_price.
 * Buckets are exclusive-upper-bound (price < maxPrice). avg_buy_price >= 0.50
 * is outside R66 coverage (only 1 token observed); fall back to the highest
 * defined bucket (0.35-0.50) ratio.
 */
export function getProfitThresholdByPrice(avgBuyPrice: number): number {
  for (const bucket of D8_THRESHOLD_BUCKETS) {
    if (avgBuyPrice < bucket.maxPrice) return bucket.ratio;
  }
  return D8_THRESHOLD_BUCKETS[D8_THRESHOLD_BUCKETS.length - 1]!.ratio;
}

export interface D8EvalContext {
  state: AlgoState;
  sellCount: number;
  currentPrice: number;
  cumulativeBuySize: number;
  cumulativeBuyNotional: number;
  holdDurationSeconds: number | null;
}

export type D8EvalResult =
  | {
      fire: true;
      profitRatio: number;
      threshold: number;
      avgBuyPrice: number;
    }
  | {
      fire: false;
      profitRatio: number | null;
      threshold: number | null;
      avgBuyPrice: number | null;
      reason:
        | "policy-disabled"
        | "state-mismatch"
        | "hold-time-not-met"
        | "no-buy-data"
        | "ratio-below-threshold";
    };

export function evaluateD8ProfitRatio(
  ctx: D8EvalContext,
  policy: ProfitTargetPolicyConfig,
): D8EvalResult {
  if (!policy.enabled) {
    return {
      fire: false,
      profitRatio: null,
      threshold: null,
      avgBuyPrice: null,
      reason: "policy-disabled",
    };
  }
  if (ctx.state !== "S1" && ctx.state !== "S2") {
    return {
      fire: false,
      profitRatio: null,
      threshold: null,
      avgBuyPrice: null,
      reason: "state-mismatch",
    };
  }
  if (ctx.holdDurationSeconds === null || ctx.holdDurationSeconds < policy.holdSecondsMin) {
    return {
      fire: false,
      profitRatio: null,
      threshold: null,
      avgBuyPrice: null,
      reason: "hold-time-not-met",
    };
  }
  if (ctx.cumulativeBuySize <= 0 || !Number.isFinite(ctx.cumulativeBuySize)) {
    return {
      fire: false,
      profitRatio: null,
      threshold: null,
      avgBuyPrice: null,
      reason: "no-buy-data",
    };
  }
  const avgBuyPrice = ctx.cumulativeBuyNotional / ctx.cumulativeBuySize;
  if (!Number.isFinite(avgBuyPrice) || avgBuyPrice <= 0) {
    return {
      fire: false,
      profitRatio: null,
      threshold: null,
      avgBuyPrice: null,
      reason: "no-buy-data",
    };
  }
  const threshold = getProfitThresholdByPrice(avgBuyPrice);
  const profitRatio = ctx.currentPrice / avgBuyPrice;
  if (profitRatio < threshold) {
    return { fire: false, profitRatio, threshold, avgBuyPrice, reason: "ratio-below-threshold" };
  }
  return { fire: true, profitRatio, threshold, avgBuyPrice };
}
