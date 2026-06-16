import type {
  DustCleanupDecisionInput,
  DustCleanupDecisionOutput,
  DustAutoCloseNonCloseableReason,
  DustAutoCloseSkipReason,
  TrackS4DustAutoCloseConfig,
} from "@krabs/domain";

export function computeDustCleanup(
  input: DustCleanupDecisionInput,
  config: TrackS4DustAutoCloseConfig,
): DustCleanupDecisionOutput {
  if (!config.enabled) return skip("disabled");
  if (input.redeemInFlight) return skip("redeem_in_flight");
  if (input.profileOwned) return skip("profile_owned");
  if (!input.retryEligible) return skip("retry_backoff");

  const thresholds = config.thresholds;
  if (
    !isFiniteNonNegative(input.liquidationValueUsdc) ||
    input.liquidationValueUsdc >= thresholds.liquidationValueMaxUsdc
  ) {
    return skip("liquidation_above_threshold");
  }
  if (
    !isFiniteNonNegative(input.costBasisUsdc) ||
    input.costBasisUsdc > thresholds.costBasisMaxUsdc
  ) {
    return skip("cost_above_threshold");
  }

  const hasPriorSell = Number.isInteger(input.sellCountTotal) && input.sellCountTotal > 0;
  if (!hasPriorSell && input.status !== "dust") return skip("no_prior_sell");
  if (
    input.status !== "dust" &&
    (input.lastSellAgeMs == null ||
      !isFiniteNonNegative(input.lastSellAgeMs) ||
      input.lastSellAgeMs < thresholds.lastSellMinAgeMs)
  ) {
    return skip("recent_sell");
  }

  const nonCloseableReason = getNonCloseableReason(input, config);
  if (nonCloseableReason != null) return markNonCloseable(nonCloseableReason, config);

  const limitPrice = floorToTick(
    input.bestBid! - input.tickSize * config.execution.priceOffsetTicks,
    input.tickSize,
  );
  return {
    action: "close",
    reason: "qualified",
    limitPrice,
    sellSize: input.size,
    nextRetryDelayMs: null,
  };
}

function getNonCloseableReason(
  input: DustCleanupDecisionInput,
  config: TrackS4DustAutoCloseConfig,
): DustAutoCloseNonCloseableReason | null {
  if (input.status === "dust") return "status_dust";
  if (!input.marketTradable) return "market_not_tradable";
  if (input.minOrderSize == null || !isFinitePositive(input.minOrderSize)) {
    return "unknown_min_order_size";
  }
  if (!isFiniteNonNegative(input.size) || input.size < input.minOrderSize) {
    return "below_min_order_size";
  }
  if (input.bestBid == null) return "missing_best_bid";
  if (!isFinitePositive(input.bestBid) || !isFinitePositive(input.tickSize)) return "invalid_price";

  const computed = floorToTick(
    input.bestBid - input.tickSize * config.execution.priceOffsetTicks,
    input.tickSize,
  );
  if (!isFinitePositive(computed) || computed < input.minValidPrice) return "invalid_price";
  return null;
}

function skip(reason: DustAutoCloseSkipReason): DustCleanupDecisionOutput {
  return {
    action: "skip",
    reason,
    limitPrice: null,
    sellSize: null,
    nextRetryDelayMs: null,
  };
}

function markNonCloseable(
  reason: DustAutoCloseNonCloseableReason,
  config: TrackS4DustAutoCloseConfig,
): DustCleanupDecisionOutput {
  return {
    action: "mark_non_closeable",
    reason,
    limitPrice: null,
    sellSize: null,
    nextRetryDelayMs: config.retryBackoffMs,
  };
}

function floorToTick(value: number, tickSize: number): number {
  const floored = Math.floor((value + Number.EPSILON) / tickSize) * tickSize;
  return Number(floored.toFixed(6));
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
