import type { OrderBookSnapshot, PriceLevel } from "./types.js";

export interface EffectiveFillPriceResult {
  effectiveFillPrice: number | null;
  worstFillPrice: number | null;
  liquidityAvailable: number;
  targetSize: number;
  exhausted: boolean;
  levelsTouched: number;
}

export function computeEffectiveFillPrice(
  book: Pick<OrderBookSnapshot, "bids" | "asks" | "bestBid" | "bestAsk">,
  targetSize: number,
  side: "buy" | "sell",
): EffectiveFillPriceResult {
  const normalizedTarget = Number.isFinite(targetSize) && targetSize > 0 ? targetSize : 0;
  if (normalizedTarget === 0) {
    const top =
      side === "sell" ? finitePositiveOrNull(book.bestBid) : finitePositiveOrNull(book.bestAsk);
    return {
      effectiveFillPrice: top,
      worstFillPrice: top,
      liquidityAvailable: 0,
      targetSize: 0,
      exhausted: false,
      levelsTouched: top == null ? 0 : 1,
    };
  }

  const levels = normalizeLevels(side === "sell" ? book.bids : book.asks, side);
  let remaining = normalizedTarget;
  let filled = 0;
  let notional = 0;
  let worstFillPrice: number | null = null;
  let levelsTouched = 0;

  for (const level of levels) {
    if (remaining <= 0) break;
    const sizeAtLevel = Math.min(remaining, level.size);
    if (sizeAtLevel <= 0) continue;
    filled += sizeAtLevel;
    notional += sizeAtLevel * level.price;
    remaining -= sizeAtLevel;
    worstFillPrice = level.price;
    levelsTouched += 1;
  }

  return {
    effectiveFillPrice: filled > 0 ? notional / filled : null,
    worstFillPrice,
    liquidityAvailable: filled,
    targetSize: normalizedTarget,
    exhausted: filled + 1e-9 < normalizedTarget,
    levelsTouched,
  };
}

function normalizeLevels(levels: readonly PriceLevel[], side: "buy" | "sell"): PriceLevel[] {
  const valid = levels.filter(
    (level) =>
      Number.isFinite(level.price) &&
      level.price > 0 &&
      Number.isFinite(level.size) &&
      level.size > 0,
  );
  return valid.sort((a, b) => (side === "sell" ? b.price - a.price : a.price - b.price));
}

function finitePositiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
