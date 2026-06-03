import type { TokenId } from "./ids.js";

export const REPRICE_THRESHOLD_FIXED_TICKS = 3;
export const REPRICE_THRESHOLD_MAX_STALENESS_MS = 10 * 60_000;

export type RepriceSubtype = "strike" | "non-strike";
export type RepriceLivenessVerdict = "live" | "dead" | "unknown";

export interface RepriceContext {
  readonly assetId: TokenId;
  readonly subtype: RepriceSubtype;
  readonly currentSpread: number | null;
  readonly currentMid: number | null;
  readonly livenessVerdict: RepriceLivenessVerdict;
  readonly capturedAt: number | null;
  readonly ts: number;
}

export type RepriceThresholdReason =
  | "fixed_3_live_strike"
  | "liveness_dead"
  | "liveness_unknown"
  | "non_strike_static_fallback"
  | "missing_market_data_fallback"
  | "stale_market_data_fallback";

export interface RepriceThresholdDecision {
  readonly shouldReprice: boolean;
  readonly tickThreshold: number | null;
  readonly reason: RepriceThresholdReason;
}

export function computeRepriceThreshold(ctx: RepriceContext): RepriceThresholdDecision {
  if (ctx.livenessVerdict === "dead") return gated("liveness_dead");
  if (ctx.livenessVerdict === "unknown") return gated("liveness_unknown");
  if (ctx.subtype !== "strike") return gated("non_strike_static_fallback");
  if (!hasFreshTimestamp(ctx)) return gated("stale_market_data_fallback");
  if (!hasFiniteMarketData(ctx.currentSpread, ctx.currentMid)) {
    return gated("missing_market_data_fallback");
  }

  return {
    shouldReprice: true,
    tickThreshold: REPRICE_THRESHOLD_FIXED_TICKS,
    reason: "fixed_3_live_strike",
  };
}

function gated(reason: RepriceThresholdReason): RepriceThresholdDecision {
  return {
    shouldReprice: false,
    tickThreshold: null,
    reason,
  };
}

function hasFreshTimestamp(ctx: Pick<RepriceContext, "capturedAt" | "ts">): boolean {
  if (ctx.capturedAt == null) return false;
  if (!Number.isFinite(ctx.capturedAt) || !Number.isFinite(ctx.ts)) return false;
  return ctx.ts - ctx.capturedAt <= REPRICE_THRESHOLD_MAX_STALENESS_MS;
}

function hasFiniteMarketData(...values: ReadonlyArray<number | null>): boolean {
  return values.every((value) => value != null && Number.isFinite(value));
}
