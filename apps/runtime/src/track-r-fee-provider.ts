import {
  CATEGORICAL_FALLBACK_RATES,
  UNIVERSAL_FALLBACK_RATE,
  type FillRepository,
  type FeeScheduleProvider,
  type FeeScheduleConfig,
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
  feeScheduleProvider?: FeeScheduleProvider | undefined;
  runtimeMetrics?: RuntimeMetricCounter | undefined;
}

export function createTrackRFeeProvider(deps: TrackRFeeProviderDeps): TrackRTakerFeeProvider {
  return {
    resolveFeeQuote: async (input): Promise<TrackRFeeQuote> => {
      const { conditionId, category, policy } = input;
      const live = await resolveLiveFeeQuote(deps, input);
      if (live) return live;

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

async function resolveLiveFeeQuote(
  deps: TrackRFeeProviderDeps,
  input: {
    conditionId: Parameters<TrackRTakerFeeProvider["resolveFeeQuote"]>[0]["conditionId"];
    tokenId: Parameters<TrackRTakerFeeProvider["resolveFeeQuote"]>[0]["tokenId"];
    category?: string | null;
    feeSchedule?: FeeScheduleConfig;
    nowMs: number;
  },
): Promise<TrackRFeeQuote | null> {
  const provider = deps.feeScheduleProvider;
  if (provider && input.feeSchedule?.enabled) {
    const quote = await provider.resolve({
      asOfMs: input.nowMs,
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      category: input.category ?? null,
      side: "sell",
      intendedLiquidityRole: "taker",
      config: input.feeSchedule,
    });
    if (
      Number.isFinite(quote.baseRate) &&
      quote.baseRate >= 0 &&
      Number.isFinite(quote.exponent) &&
      quote.exponent > 0 &&
      (quote.source === "api" || quote.source === "mixed")
    ) {
      return { rate: quote.baseRate, exponent: quote.exponent, source: "live" };
    }
    recordInvalidLiveExponent(deps, quote.exponent);
    return null;
  }

  const live = await deps.feeGateway.getMarketFeeInfo?.(input.conditionId);
  if (
    live &&
    Number.isFinite(live.rate) &&
    live.rate >= 0 &&
    Number.isFinite(live.exponent) &&
    live.exponent > 0
  ) {
    return { rate: live.rate, exponent: live.exponent, source: "live" };
  }
  if (live) recordInvalidLiveExponent(deps, live.exponent);
  return null;
}

function recordInvalidLiveExponent(deps: TrackRFeeProviderDeps, exponent: number): void {
  if (Number.isFinite(exponent) && exponent > 0) return;
  deps.runtimeMetrics?.writeCounter?.(
    "track_r_l1_skipped_invalid_exponent",
    1,
    JSON.stringify({ reason: "invalid_exponent" }),
  );
}

function resolveUniversalFallbackRate(policy: TrackRHonestPricingPolicy): number {
  return Number.isFinite(policy.universalFallbackRate) && policy.universalFallbackRate > 0
    ? policy.universalFallbackRate
    : UNIVERSAL_FALLBACK_RATE;
}
