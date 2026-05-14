const MIN_ORDER_SIZE_EPSILON = 1e-9;

// R68/R69: Plankton SELL fills include 16.86% below 5 shares; p5 fill
// size = 0.77 share. Real Polymarket CLOB minimum is below 5. This
// fallback fires only when market.minOrderSize is unavailable (e.g. CLOB
// metadata fetch failed); value=1 keeps us permissive enough to not
// block Plankton-observed paths. If actual CLOB min is higher, CLOB
// rejects the order and dust counter routes it into abandonment per
// R67 spec 11.5. CLOB metadata fetch is the primary path
// (packages/exchange/src/mappers.ts:284); fallback is safety net only.
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
