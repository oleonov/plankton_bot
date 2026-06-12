export const POLYMARKET_CRYPTO_TAKER_FEE_RATE = 0.07;

export const CATEGORICAL_FALLBACK_RATES: Readonly<Record<string, number>> = {
  crypto: POLYMARKET_CRYPTO_TAKER_FEE_RATE,
  finance: 0.04,
  sports: 0.03,
  culture: 0.05,
  geopolitics: 0,
};

export const UNIVERSAL_FALLBACK_RATE = 0.05;

export const POLYMARKET_TAKER_FEE_RATES_BY_CATEGORY = CATEGORICAL_FALLBACK_RATES;

/**
 * V2 fee resolution priority:
 *   1. CLOB market fee metadata (`fd.r` + `fd.e` from `getClobMarketInfo`) —
 *      primary V2 source. A finite `rate` (including `0` for zero-fee markets)
 *      is treated as authoritative. The gateway is responsible for sourcing
 *      `exponent`; per `@polymarket/clob-client-v2@1.0.2` it defaults to `0`
 *      when `fd.e` is absent (`fd?.e ?? 0`), so this resolver passes through
 *      whatever `feeInfo.exponent` the gateway supplies.
 *   2. `fee_rate_bps` from the live fill payload — exchange-supplied per-fill rate.
 *      Synthesized with `exponent: 1` (V1-equivalent flat-by-bonding-curve).
 *   3. Per-category fallback table — last-resort when neither is available;
 *      also `exponent: 1`.
 *
 * The category table is retained only as a defensive fallback; it should not
 * be hit on the V2 hot path once `MarketFeeInfo` is wired through callers.
 */
export function resolvePolymarketTakerFeeRate(input: {
  feeRateBps: number;
  category?: string | null | undefined;
  feeInfo?: { rate: number; exponent: number } | null | undefined;
}): { rate: number; exponent: number } {
  if (
    input.feeInfo &&
    Number.isFinite(input.feeInfo.rate) &&
    input.feeInfo.rate >= 0 &&
    Number.isFinite(input.feeInfo.exponent)
  ) {
    return { rate: input.feeInfo.rate, exponent: input.feeInfo.exponent };
  }
  if (Number.isFinite(input.feeRateBps) && input.feeRateBps > 0) {
    if (input.feeRateBps === 1000) return { rate: POLYMARKET_CRYPTO_TAKER_FEE_RATE, exponent: 1 };
    return { rate: input.feeRateBps / 10_000, exponent: 1 };
  }
  const category = input.category?.toLowerCase();
  if (category) {
    const categoryRate = POLYMARKET_TAKER_FEE_RATES_BY_CATEGORY[category];
    if (categoryRate !== undefined) {
      return { rate: categoryRate, exponent: 1 };
    }
  }
  return { rate: 0, exponent: 1 };
}

/**
 * V2 platform fee rate per V2 SDK `adjustBuyAmountForFees`:
 *   platformFeeRate = rate * (price * (1 - price)) ** exponent
 */
export function computePolymarketPlatformFeeRate(input: {
  price: number;
  rate: number;
  exponent: number;
}): number {
  if (!Number.isFinite(input.price) || !Number.isFinite(input.rate)) return 0;
  if (input.rate <= 0) return 0;
  // exponent=0 is a valid V2 value (collapses the bonding-curve adjustment to
  // a flat `rate`). Default to 1 only when missing or non-finite.
  const exponent = Number.isFinite(input.exponent) ? input.exponent : 1;
  const base = input.price * (1 - input.price);
  if (base <= 0) return 0;
  return input.rate * Math.pow(base, exponent);
}

export function computePolymarketSellFeeFractionOfRevenue(input: {
  price: number;
  rate: number;
  exponent: number;
}): number {
  if (!Number.isFinite(input.price) || input.price <= 0) return 0;
  const perShareFee = computePolymarketPlatformFeeRate(input);
  return perShareFee / input.price;
}

export function computeTrackRMinGrossExitRatio(input: {
  effectiveFillPrice: number;
  rate: number;
  exponent: number;
  safetyMargin: number;
}): number {
  if (!Number.isFinite(input.effectiveFillPrice) || input.effectiveFillPrice <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const feeFraction = computePolymarketSellFeeFractionOfRevenue({
    price: input.effectiveFillPrice,
    rate: input.rate,
    exponent: input.exponent,
  });
  if (!Number.isFinite(feeFraction) || feeFraction < 0 || feeFraction >= 1) {
    return Number.POSITIVE_INFINITY;
  }
  const safetyMargin =
    Number.isFinite(input.safetyMargin) && input.safetyMargin > 0 ? input.safetyMargin : 0;
  return 1 / (1 - feeFraction) + safetyMargin;
}

export function computePolymarketBuyShareFee(input: {
  grossSize: number;
  price: number;
  rate: number;
  exponent: number;
}): number {
  if (input.price <= 0) return 0;
  const platformFeeRate = computePolymarketPlatformFeeRate({
    price: input.price,
    rate: input.rate,
    exponent: input.exponent,
  });
  return (input.grossSize * platformFeeRate) / input.price;
}

export function computePolymarketTakerFeeUsdc(input: {
  grossSize: number;
  price: number;
  rate: number;
  exponent: number;
}): number {
  const platformFeeRate = computePolymarketPlatformFeeRate({
    price: input.price,
    rate: input.rate,
    exponent: input.exponent,
  });
  return input.grossSize * platformFeeRate;
}
