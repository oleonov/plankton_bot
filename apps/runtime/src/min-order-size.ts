import {
  SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
  SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON,
} from "./internal-order-reasons.js";

const MIN_ORDER_SIZE_EPSILON = 1e-9;
import { isKnownTokenMinimum } from "@krabs/domain";
import { TokenMinimumBlocked, type ExchangeGateway, type PlaceOrderParams } from "@krabs/domain";

export async function prepareSuccessorMinimum(
  gateway: ExchangeGateway,
  current: () => { params: PlaceOrderParams; state: string } | null,
): Promise<(() => boolean) | null> {
  const initial = current();
  if (!initial || !gateway.prepareOrder || !gateway.validatePreparedMinimum) return null;
  try {
    const prepared = await gateway.prepareOrder(initial.params);
    return () => {
      try {
        const latest = current();
        if (!latest || JSON.stringify(latest) !== JSON.stringify(initial)) return false;
        gateway.validatePreparedMinimum!(prepared);
        return true;
      } catch (error) {
        if (error instanceof TokenMinimumBlocked) return false;
        throw error;
      }
    };
  } catch (error) {
    if (error instanceof TokenMinimumBlocked) return null;
    throw error;
  }
}

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

/**
 * The `SignalConversionSkipped` reason meaning "this market's exchange minimum is
 * unknown". Produced by `signal-to-order`, consumed by `algo-decision-module` to
 * decide that this one inputs-unchanged skip must still be re-armed. Both sides
 * already import this module, so it is the shared home that adds no new edge.
 *
 * NOT in `internal-order-reasons.ts`: those are order-level rejection reasons on a
 * different event with a different (kebab-case) convention. A rename on either
 * side of THIS literal silently disables the re-arm, which is why it is one const.
 */
export const ENTRY_UNKNOWN_MIN_SKIP_REASON = "entry_unknown_min";

/**
 * Retry backoff for a `/books` hydration that produced NO minimum.
 *
 * Deliberately not a telemetry-scale dedupe: while the minimum stays unknown the
 * caller's entry (algo-decision) or exit (execution) is blocked, so a first
 * request that failed or omitted the token would cost a full blackout even though
 * the value became available immediately afterwards. 60 s matches the full-sweep
 * cadence the suppression path documents as its recovery route, and stays three
 * orders of magnitude below the ~31/s tick rate that caused the incident.
 *
 * Shared here rather than per-module because both callers throttle the SAME
 * gateway call; two windows drifting apart would silently change how hard the
 * `/books` endpoint is hit.
 */
export const MIN_ORDER_SIZE_HYDRATION_RETRY_MS = 60 * 1000;

/**
 * Single definition of "the exchange minimum is KNOWN". Mirrors the guard in
 * `resolveSellableShareFloor` (@krabs/domain) so the entry path, the book-cache
 * hydration path and the pricing path can never disagree about whether a market's
 * `min_order_size` has been observed yet.
 */
export function isKnownMinOrderSize(
  minOrderSize: number | null | undefined,
): minOrderSize is number {
  return isKnownTokenMinimum(minOrderSize);
}

export function resolveEffectiveMinOrderSize(
  minOrderSize: number | null | undefined,
  fallback = DEFAULT_FALLBACK_MIN_ORDER_SIZE,
): number {
  return isKnownMinOrderSize(minOrderSize) ? minOrderSize : fallback;
}

export function isExecutableOrderSize(
  size: number,
  minOrderSize: number | null | undefined,
  fallback = DEFAULT_FALLBACK_MIN_ORDER_SIZE,
): boolean {
  return size + MIN_ORDER_SIZE_EPSILON >= resolveEffectiveMinOrderSize(minOrderSize, fallback);
}

// Track S5 P1 — truncate an available-liquidity size DOWN to a whole multiple of
// the order-size step so a partial exit never overstates the size it can fill.
// The step is the effective market min order size (fallback when unknown). The
// epsilon absorbs float undershoot (e.g. 99.9999999999) so an exact multiple is
// not dropped a full step; over-truncation past available liquidity stays
// conservative. "float-precision OK" per spec — the result rides into the order.
export function floorToMinOrderStep(
  size: number,
  minOrderSize: number | null | undefined,
  fallback = DEFAULT_FALLBACK_MIN_ORDER_SIZE,
): number {
  if (!Number.isFinite(size) || size <= 0) return 0;
  const step = resolveEffectiveMinOrderSize(minOrderSize, fallback);
  return Math.floor((size + MIN_ORDER_SIZE_EPSILON) / step) * step;
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
