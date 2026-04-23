import type { PriceLevel } from "@plankton/domain";

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

export interface ExecutableTopOfBookInput {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly bids?: readonly PriceLevel[] | null;
  readonly asks?: readonly PriceLevel[] | null;
}

export interface ExecutableTopOfBook {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly midPrice: number | null;
  readonly spread: number | null;
}

function firstExecutableLevel(
  levels: readonly PriceLevel[] | null | undefined,
  tickSize: number,
): number | null {
  if (!levels || levels.length === 0) return null;
  for (const level of levels) {
    if (validateExecutablePrice(level.price, tickSize).ok) {
      return level.price;
    }
  }
  return null;
}

function sanitizeExecutableQuote(price: number | null, tickSize: number): number | null {
  if (price == null) return null;
  return validateExecutablePrice(price, tickSize).ok ? price : null;
}

export function deriveExecutableTopOfBook(
  input: ExecutableTopOfBookInput,
  tickSize: number,
): ExecutableTopOfBook {
  const bestBid = input.bids ? firstExecutableLevel(input.bids, tickSize) : null;
  const bestAsk = input.asks ? firstExecutableLevel(input.asks, tickSize) : null;
  const normalizedBestBid = bestBid ?? sanitizeExecutableQuote(input.bestBid, tickSize);
  const normalizedBestAsk = bestAsk ?? sanitizeExecutableQuote(input.bestAsk, tickSize);
  const midPrice =
    normalizedBestBid !== null && normalizedBestAsk !== null
      ? (normalizedBestBid + normalizedBestAsk) / 2
      : null;
  const spread =
    normalizedBestBid !== null && normalizedBestAsk !== null
      ? normalizedBestAsk - normalizedBestBid
      : null;

  return {
    bestBid: normalizedBestBid,
    bestAsk: normalizedBestAsk,
    midPrice,
    spread,
  };
}
