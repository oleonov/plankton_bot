import {
  CATEGORICAL_FALLBACK_RATES,
  UNIVERSAL_FALLBACK_RATE,
  type FillRepository,
  type TrackRFeeQuote,
  type TrackRHonestPricingPolicy,
  type TrackRTakerFeeProvider,
} from "@krabs/domain";

type FeeGateway = {
  getMarketFeeInfo?: (conditionId: string) => Promise<{ rate: number; exponent: number } | null>;
};

type RuntimeMetricCounter = {
  writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
};

export interface TrackRFeeProviderDeps {
  feeGateway: FeeGateway;
  fillRepo: Pick<FillRepository, "findRecentTakerFeeRate">;
  runtimeMetrics?: RuntimeMetricCounter | undefined;
}

export function createTrackRFeeProvider(deps: TrackRFeeProviderDeps): TrackRTakerFeeProvider {
  return {
    resolveFeeQuote: async ({ conditionId, category, policy }): Promise<TrackRFeeQuote> => {
      const live = await deps.feeGateway.getMarketFeeInfo?.(conditionId);
      if (
        live &&
        Number.isFinite(live.rate) &&
        live.rate >= 0 &&
        Number.isFinite(live.exponent) &&
        live.exponent > 0
      ) {
        return { rate: live.rate, exponent: live.exponent, source: "live" };
      }
      if (live && (!Number.isFinite(live.exponent) || live.exponent <= 0)) {
        deps.runtimeMetrics?.writeCounter?.(
          "track_r_l1_skipped_invalid_exponent",
          1,
          JSON.stringify({ reason: "invalid_exponent" }),
        );
      }

      const recentRate = deps.fillRepo.findRecentTakerFeeRate?.(conditionId, 24);
      if (recentRate != null && Number.isFinite(recentRate) && recentRate >= 0) {
        return { rate: recentRate, exponent: 1, source: "fill" };
      }

      const normalizedCategory = typeof category === "string" ? category.toLowerCase() : null;
      if (normalizedCategory === "geopolitics") {
        return { rate: 0, exponent: 1, source: "fallback_category", category: normalizedCategory };
      }
      if (normalizedCategory) {
        const categoryRate = CATEGORICAL_FALLBACK_RATES[normalizedCategory];
        if (categoryRate !== undefined) {
          return {
            rate: categoryRate,
            exponent: 1,
            source: "fallback_category",
            category: normalizedCategory,
          };
        }
      }

      return {
        rate: resolveUniversalFallbackRate(policy),
        exponent: 1,
        source: "fallback_universal",
      };
    },
  };
}

function resolveUniversalFallbackRate(policy: TrackRHonestPricingPolicy): number {
  return Number.isFinite(policy.universalFallbackRate) && policy.universalFallbackRate > 0
    ? policy.universalFallbackRate
    : UNIVERSAL_FALLBACK_RATE;
}
