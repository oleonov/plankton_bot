export const POLYMARKET_CRYPTO_TAKER_FEE_RATE = 0.072;

export const POLYMARKET_TAKER_FEE_RATES_BY_CATEGORY: Readonly<Record<string, number>> = {
  crypto: POLYMARKET_CRYPTO_TAKER_FEE_RATE,
  sports: 0.03,
  finance: 0.04,
  politics: 0.04,
  geopolitics: 0,
};

export function resolvePolymarketTakerFeeRate(input: {
  feeRateBps: number;
  category?: string | null | undefined;
}): number {
  const category = input.category?.toLowerCase();
  if (category && POLYMARKET_TAKER_FEE_RATES_BY_CATEGORY[category] !== undefined) {
    return POLYMARKET_TAKER_FEE_RATES_BY_CATEGORY[category];
  }
  if (!Number.isFinite(input.feeRateBps) || input.feeRateBps <= 0) return 0;
  if (input.feeRateBps === 1000) return POLYMARKET_CRYPTO_TAKER_FEE_RATE;
  return input.feeRateBps / 10_000;
}

export function computePolymarketBuyShareFee(input: {
  grossSize: number;
  price: number;
  feeRate: number;
}): number {
  return input.grossSize * input.feeRate * (1 - input.price);
}

export function computePolymarketTakerFeeUsdc(input: {
  grossSize: number;
  price: number;
  feeRate: number;
}): number {
  return input.grossSize * input.feeRate * input.price * (1 - input.price);
}
