import { computeEffectiveFillPrice } from "./orderbook.js";
import type { OrderBookSnapshot, Position, TrackS1WalkingLadderPolicy } from "./types.js";
import { normalizeDistribution, satisfiesSmallestTier } from "./ladder-construction.js";

export type S1EligibilityReason =
  | "eligible"
  | "disabled"
  | "no_position"
  | "position_closed"
  | "wrong_tier"
  | "handoff_window"
  | "active_ladder_exists"
  | "dead_market"
  | "below_min_tier_size"
  | "not_thin";

export type S1ThinReason = "exhausted" | "wide_spread" | "thin_best_bid";

export type S1EligibilityResult =
  | { eligible: true; thinReason: S1ThinReason }
  | { eligible: false; reason: Exclude<S1EligibilityReason, "eligible"> };

export interface S1EligibilityInput {
  position: Position | null;
  book: OrderBookSnapshot | null;
  marketEndDate: string | null;
  nowMs: number;
  hasActiveS1Ladder: boolean;
  policy: TrackS1WalkingLadderPolicy;
}

export function isS1Eligible(input: S1EligibilityInput): S1EligibilityResult {
  if (!input.policy.enabled) return { eligible: false, reason: "disabled" };
  const position = input.position;
  if (!position) return { eligible: false, reason: "no_position" };
  if (position.status !== "open" || position.size <= 0) {
    return { eligible: false, reason: "position_closed" };
  }
  if (
    position.avgEntryPrice <= 0 ||
    position.avgEntryPrice >= input.policy.cheapLongshotMaxAvgEntry
  ) {
    return { eligible: false, reason: "wrong_tier" };
  }
  if (input.hasActiveS1Ladder) return { eligible: false, reason: "active_ladder_exists" };
  if (
    timeToResolutionSeconds(input.marketEndDate, input.nowMs) <=
    input.policy.handoffTimeToResolutionSeconds
  ) {
    return { eligible: false, reason: "handoff_window" };
  }

  const book = input.book;
  if (!book || !isLiveEnoughForS1(book, input.policy)) {
    return { eligible: false, reason: "dead_market" };
  }
  const minOrderSize = book.minOrderSize && book.minOrderSize > 0 ? book.minOrderSize : 1;
  const distribution = normalizeDistribution(
    input.policy.volumeDistribution,
    input.policy.numTiers,
  );
  if (!satisfiesSmallestTier(position.size, minOrderSize, distribution)) {
    return { eligible: false, reason: "below_min_tier_size" };
  }

  const effective = computeEffectiveFillPrice(book, position.size, "sell");
  if (effective.exhausted) return { eligible: true, thinReason: "exhausted" };
  const spreadTicks = resolveSpreadTicks(book);
  if (spreadTicks != null && spreadTicks > input.policy.thinSpreadTicks) {
    return { eligible: true, thinReason: "wide_spread" };
  }
  const bestBidDepth = depthAtBestBid(book);
  if (bestBidDepth < position.size * input.policy.bestBidDepthRatio) {
    return { eligible: true, thinReason: "thin_best_bid" };
  }
  return { eligible: false, reason: "not_thin" };
}

export function timeToResolutionSeconds(endDate: string | null, nowMs: number): number {
  if (!endDate) return Number.POSITIVE_INFINITY;
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return Number.POSITIVE_INFINITY;
  return (endMs - nowMs) / 1000;
}

function isLiveEnoughForS1(book: OrderBookSnapshot, policy: TrackS1WalkingLadderPolicy): boolean {
  return (
    typeof book.bestBid === "number" &&
    Number.isFinite(book.bestBid) &&
    book.bestBid >= policy.minBestBid &&
    typeof book.bestAsk === "number" &&
    Number.isFinite(book.bestAsk) &&
    book.bestAsk > 0 &&
    book.bestAsk <= 0.97 &&
    book.asks.length > 0
  );
}

function resolveSpreadTicks(book: OrderBookSnapshot): number | null {
  if (book.bestBid == null || book.bestAsk == null) return null;
  const spread = book.spread ?? book.bestAsk - book.bestBid;
  const inferredTick = inferTick(book);
  return inferredTick > 0 ? spread / inferredTick : null;
}

function inferTick(book: OrderBookSnapshot): number {
  const prices = [...book.bids, ...book.asks].map((level) => level.price);
  const decimals = prices.reduce((max, price) => {
    const text = String(price);
    const [, fraction = ""] = text.split(".");
    return Math.max(max, fraction.length);
  }, 3);
  return 1 / Math.pow(10, Math.min(Math.max(decimals, 3), 6));
}

function depthAtBestBid(book: OrderBookSnapshot): number {
  if (book.bestBid == null) return 0;
  return book.bids
    .filter((level) => Math.abs(level.price - book.bestBid!) < 1e-9)
    .reduce((sum, level) => sum + level.size, 0);
}
