export const DUST_THRESHOLD_USDC = 0.5;
const MIN_ORDER_SIZE_EPSILON = 1e-9;

interface PositionStatusInput {
  size?: number | null | undefined;
  minOrderSize?: number | null | undefined;
}

export function resolveOpenPositionStatus(
  currentValueUsdc: number,
  input: PositionStatusInput = {},
): "open" | "dust" {
  if (
    typeof input.size === "number" &&
    Number.isFinite(input.size) &&
    typeof input.minOrderSize === "number" &&
    Number.isFinite(input.minOrderSize) &&
    input.minOrderSize > 0
  ) {
    return input.size + MIN_ORDER_SIZE_EPSILON >= input.minOrderSize ? "open" : "dust";
  }

  return currentValueUsdc < DUST_THRESHOLD_USDC ? "dust" : "open";
}
