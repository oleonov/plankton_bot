export const DUST_THRESHOLD_USDC = 0.5;

export function resolveOpenPositionStatus(currentValueUsdc: number): "open" | "dust" {
  return currentValueUsdc < DUST_THRESHOLD_USDC ? "dust" : "open";
}
