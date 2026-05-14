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
  private readonly fetchRecentSnapshots;
  private readonly lookbackMs: number;
  private readonly maxRowsScanned: number;

  constructor(db: Database.Database, opts: { lookbackMs?: number; maxRowsScanned?: number } = {}) {
    this.lookbackMs = opts.lookbackMs ?? 7 * 24 * 60 * 60 * 1000;
    this.maxRowsScanned = opts.maxRowsScanned ?? 200;
    this.fetchRecentSnapshots = db.prepare(
      `SELECT best_bid, best_ask, last_price
       FROM market_snapshots
       WHERE token_id = ?
         AND captured_at >= ?
       ORDER BY captured_at DESC, id DESC
       LIMIT ?`,
    );
  }

  findUsablePrice(tokenId: TokenId, nowMs: number = Date.now()): number | null {
    const oldestIso = new Date(nowMs - this.lookbackMs).toISOString();
    const rows = this.fetchRecentSnapshots.all(
      String(tokenId),
      oldestIso,
      this.maxRowsScanned,
    ) as Array<{
      best_bid: number | null;
      best_ask: number | null;
      last_price: number | null;
    }>;

    for (const row of rows) {
      const bid = LatestUsablePriceLookup.finitePositive(row.best_bid);
      const ask = LatestUsablePriceLookup.finitePositive(row.best_ask);
      if (bid !== null && ask !== null) return (bid + ask) / 2;
    }

    for (const row of rows) {
      const lastPrice = LatestUsablePriceLookup.finitePositive(row.last_price);
      if (lastPrice !== null) return lastPrice;
    }

    return null;
  }

  private static finitePositive(value: number | null): number | null {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }
}
