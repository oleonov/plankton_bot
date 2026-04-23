const DEFAULT_TICK_SIZE = 0.01;
const PRICE_EPSILON = 1e-9;

export type ExecutablePriceValidationFailureReason =
  | "price-non-finite"
  | "price-below-min-tick"
  | "price-above-max-bound"
  | "price-off-tick-grid";

export type ExecutablePriceValidation =
  | {
      ok: true;
      tickSize: number;
      minPrice: number;
      maxPrice: number;
    }
  | {
      ok: false;
      reason: ExecutablePriceValidationFailureReason;
      tickSize: number;
      minPrice: number;
      maxPrice: number;
    };

export function validateExecutablePrice(
  price: number,
  tickSize: number,
): ExecutablePriceValidation {
  const normalizedTickSize =
    Number.isFinite(tickSize) && tickSize > 0 && tickSize < 1 ? tickSize : DEFAULT_TICK_SIZE;
  const minPrice = normalizedTickSize;
  const maxPrice = 1 - normalizedTickSize;

  if (!Number.isFinite(price)) {
    return {
      ok: false,
      reason: "price-non-finite",
      tickSize: normalizedTickSize,
      minPrice,
      maxPrice,
    };
  }
  if (price < minPrice - PRICE_EPSILON) {
    return {
      ok: false,
      reason: "price-below-min-tick",
      tickSize: normalizedTickSize,
      minPrice,
      maxPrice,
    };
  }
  if (price > maxPrice + PRICE_EPSILON) {
    return {
      ok: false,
      reason: "price-above-max-bound",
      tickSize: normalizedTickSize,
      minPrice,
      maxPrice,
    };
  }

  const snappedPrice = Math.round(price / normalizedTickSize) * normalizedTickSize;
  if (Math.abs(snappedPrice - price) > Math.max(PRICE_EPSILON, normalizedTickSize * 1e-6)) {
    return {
      ok: false,
      reason: "price-off-tick-grid",
      tickSize: normalizedTickSize,
      minPrice,
      maxPrice,
    };
  }

  return { ok: true, tickSize: normalizedTickSize, minPrice, maxPrice };
}
