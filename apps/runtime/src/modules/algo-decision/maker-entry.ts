// Pure maker-entry decision core for R23-triggered post-only BUY limit orders.
// No side effects, no I/O, no state — safe to call in both shadow projection
// and micro-live paths (Phase 3 / Phase 5).
//
// WHY floor vs ceil: BUY entry uses floorToTick (never pay more than intended);
// SELL/harvest target uses ceilToTick (never accept less than intended). This
// mirrors the side-aware snapping convention already in executable-price.ts.

import { floorToTick, ceilToTick } from "../../executable-price.js";
import type { R23DipTriggerResult } from "@krabs/domain";

export interface MakerBookSnapshot {
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly tickSize: number;
}

export interface MakerEntryInputs {
  readonly improveTicks: number;
  readonly harvestGainPct: number;
}

export interface MakerEntryDecision {
  readonly shouldPost: boolean;
  readonly buyPx: number | null;
  readonly harvestPx: number | null;
  readonly reason: string;
}

/**
 * Compute the post-only BUY limit price: bestBid improved by `improveTicks`
 * ticks toward the ask, then floor-snapped to the tick grid.
 */
export function computeMakerEntryPrice(
  bestBid: number,
  tickSize: number,
  improveTicks: number,
): number {
  return floorToTick(bestBid + improveTicks * tickSize, tickSize);
}

/**
 * Compute the harvest (SELL) target: entryPx scaled up by gainPct, ceil-snapped
 * to tick (sell no less than target).
 */
export function computeHarvestTarget(entryPx: number, gainPct: number, tickSize: number): number {
  return ceilToTick(entryPx * (1 + gainPct), tickSize);
}

function isValidBook(book: MakerBookSnapshot): boolean {
  return (
    Number.isFinite(book.bestBid) &&
    book.bestBid > 0 &&
    Number.isFinite(book.bestAsk) &&
    book.bestAsk > book.bestBid
  );
}

/**
 * Evaluate whether to post a maker entry BUY.
 *
 * Returns shouldPost=true only when:
 *  1. R23 fired.
 *  2. Book is valid (finite bestBid > 0, bestAsk > bestBid).
 *  3. Computed buyPx is strictly below bestAsk (post-only non-cross assertion).
 *
 * Otherwise shouldPost=false with a descriptive reason:
 *  "r23_not_fired" | "invalid_book" | "would_cross"
 */
export function evaluateMakerEntry(
  r23: R23DipTriggerResult,
  book: MakerBookSnapshot,
  inputs: MakerEntryInputs,
): MakerEntryDecision {
  if (!r23.fire) {
    return { shouldPost: false, buyPx: null, harvestPx: null, reason: "r23_not_fired" };
  }
  if (!isValidBook(book)) {
    return { shouldPost: false, buyPx: null, harvestPx: null, reason: "invalid_book" };
  }
  const buyPx = computeMakerEntryPrice(book.bestBid, book.tickSize, inputs.improveTicks);
  if (buyPx >= book.bestAsk) {
    return { shouldPost: false, buyPx: null, harvestPx: null, reason: "would_cross" };
  }
  const harvestPx = computeHarvestTarget(buyPx, inputs.harvestGainPct, book.tickSize);
  return { shouldPost: true, buyPx, harvestPx, reason: "ok" };
}
