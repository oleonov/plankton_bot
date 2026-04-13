const MIN_ORDER_SIZE_EPSILON = 1e-9;

export const DEFAULT_FALLBACK_MIN_ORDER_SIZE = 5;

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
