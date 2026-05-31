import {
  SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
  SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON,
} from "./internal-order-reasons.js";

const MIN_ORDER_SIZE_EPSILON = 1e-9;

export type SellPreSubmitGuardResult =
  | { proceed: true; minOrderSize: number }
  | {
      proceed: false;
      reason:
        | typeof SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON
        | typeof SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON;
      minOrderSize: number | null;
    };

// R68/R69: Plankton SELL fills include 16.86% below 5 shares; p5 fill size
// was 0.77 share. Keep the generic helper permissive for non-final sizing and
// BUY-side paths. Live-lite SELL submission must use `evaluateSellPreSubmitGuard`
// with explicit CLOB metadata instead of this fallback, so unknown min-size can
// block before CLOB rather than producing external reject storms.
export const DEFAULT_FALLBACK_MIN_ORDER_SIZE = 1;

export function resolveEffectiveMinOrderSize(
  minOrderSize: number | null | undefined,
  fallback = DEFAULT_FALLBACK_MIN_ORDER_SIZE,
): number {
  return typeof minOrderSize === "number" && Number.isFinite(minOrderSize) && minOrderSize > 0
    ? minOrderSize
    : fallback;
}

export function isExecutableOrderSize(
  size: number,
  minOrderSize: number | null | undefined,
  fallback = DEFAULT_FALLBACK_MIN_ORDER_SIZE,
): boolean {
  return size + MIN_ORDER_SIZE_EPSILON >= resolveEffectiveMinOrderSize(minOrderSize, fallback);
}

export function evaluateSellPreSubmitGuard(
  size: number,
  minOrderSize: number | null | undefined,
): SellPreSubmitGuardResult {
  if (typeof minOrderSize !== "number" || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
    return {
      proceed: false,
      reason: SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON,
      minOrderSize: null,
    };
  }

  if (size + MIN_ORDER_SIZE_EPSILON < minOrderSize) {
    return {
      proceed: false,
      reason: SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
      minOrderSize,
    };
  }

  return { proceed: true, minOrderSize };
}
