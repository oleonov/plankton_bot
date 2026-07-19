// Sellable-sizing floor (docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md).
//
// The exchange enforces a `min_order_size` in SHARES (5 on Polymarket, verified
// live). A position must be large enough that EVERY bounce-ladder rung — the
// smallest of which is `positionSize * min(ladderFractions)` — clears that
// minimum, otherwise the exit fragments below min and the position can never be
// sold (research_plankton/bot_pnl_exit_root_cause_2026-07-19.md: 352 held-to-zero
// positions, -$387). So the sellable floor is derived from the SMALLEST ladder
// fraction, not the tier count, and carries a headroom buffer.
//
// Pure — no I/O, no runtime import. Behind `sellableFlow.enabled` at the call sites.

const DEFAULT_SELLABLE_BUFFER = 1.2;

export interface SellableShareFloorInput {
  /** Exchange `min_order_size` in shares. `null`/invalid → floor is unknown (null). */
  minOrderSize: number | null | undefined;
  /** Bounce-exit `ladderFractions` — the smallest one sets the binding rung. */
  ladderFractions: readonly number[];
  /** Headroom multiplier (default 1.2). */
  buffer?: number;
}

/**
 * Minimum position size (shares) for a sellable position: `ceil(minOrderSize /
 * min(ladderFractions) * buffer)`. Returns **null when `minOrderSize` is
 * unknown/invalid** — deliberately NOT falling back to 1 (the caller must SKIP an
 * unknown-min market, since a live-lite SELL blocks unknown min anyway), and null
 * when `ladderFractions` is empty/invalid.
 */
export function resolveSellableShareFloor(input: SellableShareFloorInput): number | null {
  const { minOrderSize, ladderFractions } = input;
  if (typeof minOrderSize !== "number" || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
    return null;
  }
  const positiveFractions = ladderFractions.filter(
    (f) => typeof f === "number" && Number.isFinite(f) && f > 0,
  );
  if (positiveFractions.length === 0) return null;
  const smallest = Math.min(...positiveFractions);
  const buffer =
    typeof input.buffer === "number" && Number.isFinite(input.buffer) && input.buffer > 0
      ? input.buffer
      : DEFAULT_SELLABLE_BUFFER;
  return Math.ceil((minOrderSize / smallest) * buffer);
}

/** True when `shares` clears the sellable floor. A `null` floor (unknown min) is NOT sellable. */
export function isSellablePositionSize(shares: number, floor: number | null): boolean {
  return floor != null && Number.isFinite(shares) && shares + 1e-9 >= floor;
}
