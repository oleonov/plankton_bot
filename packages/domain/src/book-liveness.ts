import type { TokenId } from "./ids.js";

export const LIVE_BOOK_MAX_SPREAD_RATIO = 0.6153;
export const LIVE_BOOK_MAX_BID_PERSISTENCE_S = 35.5;
export const LIVE_BOOK_MIN_BID_MOVEMENT_30M = 0.0014;
export const LIVE_BOOK_MIN_PUBLIC_TRADE_COUNT_1H = 1;
export const LIVE_BOOK_MAX_STALENESS_MS = 10 * 60_000;

export interface BookContext {
  readonly assetId: TokenId;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spreadRatio?: number | null;
  readonly bidPersistenceS?: number | null;
  readonly bidMovement30m?: number | null;
  readonly publicTradeCount1h?: number | null;
  readonly ts: number;
  readonly capturedAt?: number | null;
}

export type LiveBookReason =
  | "spread_depth_activity_persistence_ok"
  | "missing_book"
  | "stale_book"
  | "crossed_or_invalid_book"
  | "wide_spread"
  | "insufficient_trade_activity"
  | "insufficient_bid_persistence"
  | "missing_persistence"
  | "missing_trade_activity"
  | "partial_book_context";

export interface LiveBookVerdict {
  readonly verdict: "live" | "dead" | "unknown";
  readonly reason: LiveBookReason;
}

export function isLiveBook(ctx: BookContext): LiveBookVerdict {
  if (!isFinitePositive(ctx.ts)) {
    return unknown("partial_book_context");
  }

  if (ctx.capturedAt != null) {
    if (!Number.isFinite(ctx.capturedAt)) return unknown("partial_book_context");
    if (ctx.ts - ctx.capturedAt > LIVE_BOOK_MAX_STALENESS_MS) return unknown("stale_book");
  }

  if (!isFinitePositive(ctx.bestBid) || !isFinitePositive(ctx.bestAsk)) {
    return dead("missing_book");
  }
  if (ctx.bestBid >= ctx.bestAsk) {
    return dead("crossed_or_invalid_book");
  }

  const spreadRatio = resolveSpreadRatio(ctx);
  if (spreadRatio == null) return unknown("partial_book_context");
  if (spreadRatio >= LIVE_BOOK_MAX_SPREAD_RATIO) return dead("wide_spread");

  if (ctx.bidPersistenceS == null || !Number.isFinite(ctx.bidPersistenceS)) {
    return unknown("missing_persistence");
  }
  if (ctx.bidPersistenceS >= LIVE_BOOK_MAX_BID_PERSISTENCE_S) {
    return dead("insufficient_bid_persistence");
  }

  const movementPass =
    ctx.bidMovement30m != null &&
    Number.isFinite(ctx.bidMovement30m) &&
    ctx.bidMovement30m > LIVE_BOOK_MIN_BID_MOVEMENT_30M;
  const tradePass =
    ctx.publicTradeCount1h != null &&
    Number.isFinite(ctx.publicTradeCount1h) &&
    ctx.publicTradeCount1h >= LIVE_BOOK_MIN_PUBLIC_TRADE_COUNT_1H;

  if (!movementPass && !tradePass) {
    if (ctx.bidMovement30m == null && ctx.publicTradeCount1h == null) {
      return unknown("missing_trade_activity");
    }
    return dead("insufficient_trade_activity");
  }

  return live();
}

function resolveSpreadRatio(ctx: BookContext): number | null {
  if (ctx.spreadRatio != null) {
    return Number.isFinite(ctx.spreadRatio) ? ctx.spreadRatio : null;
  }
  if (!isFinitePositive(ctx.bestBid) || !isFinitePositive(ctx.bestAsk)) return null;
  const mid = (ctx.bestBid + ctx.bestAsk) / 2;
  if (!isFinitePositive(mid)) return null;
  return (ctx.bestAsk - ctx.bestBid) / mid;
}

function live(): LiveBookVerdict {
  return { verdict: "live", reason: "spread_depth_activity_persistence_ok" };
}

function dead(reason: LiveBookReason): LiveBookVerdict {
  return { verdict: "dead", reason };
}

function unknown(reason: LiveBookReason): LiveBookVerdict {
  return { verdict: "unknown", reason };
}

function isFinitePositive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}
