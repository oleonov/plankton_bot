import type { ExecutionPolicy, NormalizedMarket } from "./types.js";

export type ExitTtlLiquidityTier = "thin" | "medium" | "liquid" | "default" | "disabled";

export interface ExitTtlResolution {
  readonly ttlMs: number;
  readonly tier: ExitTtlLiquidityTier;
  readonly publicTradeCount24h: number | null;
}

export function resolveExitTtlByMarket(
  market: Pick<NormalizedMarket, "publicTradeCount24h"> | null | undefined,
  policy: Pick<ExecutionPolicy, "exitOrderTtlMs" | "exitTtlByLiquidity">,
): ExitTtlResolution {
  const tierPolicy = policy.exitTtlByLiquidity;
  if (!tierPolicy.enabled) {
    return {
      ttlMs: policy.exitOrderTtlMs,
      tier: "disabled",
      publicTradeCount24h: null,
    };
  }

  const tradeCount = market?.publicTradeCount24h;
  if (tradeCount == null || !Number.isFinite(tradeCount)) {
    return {
      ttlMs: policy.exitOrderTtlMs,
      tier: "default",
      publicTradeCount24h: null,
    };
  }
  if (tradeCount <= 10) {
    return {
      ttlMs: tierPolicy.thinMs,
      tier: "thin",
      publicTradeCount24h: tradeCount,
    };
  }
  if (tradeCount <= 49) {
    return {
      ttlMs: tierPolicy.mediumMs,
      tier: "medium",
      publicTradeCount24h: tradeCount,
    };
  }
  return {
    ttlMs: policy.exitOrderTtlMs,
    tier: "liquid",
    publicTradeCount24h: tradeCount,
  };
}
