import type Database from "better-sqlite3";
import type { TokenId } from "@krabs/domain";

/**
 * Bookkeeping-side latest usable price for a token.
 *
 * Distinct from MarketSnapshotPriceHistoryProvider (used in trading hot path):
 * this helper iterates older snapshots when the latest one is empty, preferring
 * bid+ask midpoint over last_price. Returns null when neither is found within
 * the lookback window.
 *
 * Used for current_value_usdc revaluation when Polymarket data-api does not
 * return the token, or when W4 event payload has no midPrice for startup
 * backfill.
 */
export class LatestUsablePriceLookup {
  private readonly fetchLatestBidAsk;
  private readonly fetchLatestLastPrice;
  private readonly lookbackMs: number;

  constructor(db: Database.Database, opts: { lookbackMs?: number } = {}) {
    this.lookbackMs = opts.lookbackMs ?? 7 * 24 * 60 * 60 * 1000;

    this.fetchLatestBidAsk = db.prepare(
      `SELECT best_bid, best_ask
       FROM market_snapshots
       WHERE token_id = ?
         AND captured_at >= ?
         AND best_bid IS NOT NULL AND best_bid > 0
         AND best_ask IS NOT NULL AND best_ask > 0
       ORDER BY captured_at DESC, id DESC
       LIMIT 1`,
    );

    this.fetchLatestLastPrice = db.prepare(
      `SELECT last_price
       FROM market_snapshots
       WHERE token_id = ?
         AND captured_at >= ?
         AND last_price IS NOT NULL AND last_price > 0
       ORDER BY captured_at DESC, id DESC
       LIMIT 1`,
    );
  }

  findUsablePrice(tokenId: TokenId, nowMs: number = Date.now()): number | null {
    const oldestIso = new Date(nowMs - this.lookbackMs).toISOString();

    const bidAskRow = this.fetchLatestBidAsk.get(String(tokenId), oldestIso) as
      | { best_bid: number; best_ask: number }
      | undefined;
    if (bidAskRow) {
      const bid = bidAskRow.best_bid;
      const ask = bidAskRow.best_ask;
      if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
        return (bid + ask) / 2;
      }
    }

    const lastPriceRow = this.fetchLatestLastPrice.get(String(tokenId), oldestIso) as
      | { last_price: number }
      | undefined;
    if (lastPriceRow) {
      const lastPrice = lastPriceRow.last_price;
      if (Number.isFinite(lastPrice) && lastPrice > 0) return lastPrice;
    }

    return null;
  }
}
