import type Database from "better-sqlite3";
import type { MarketSnapshotRepository, MarketSnapshot } from "@krabs/domain";

export class SqliteMarketSnapshotRepository implements MarketSnapshotRepository {
  constructor(private readonly db: Database.Database) {}

  saveBatch(snapshots: MarketSnapshot[]): void {
    if (snapshots.length === 0) return;

    const insert = this.db.prepare(
      `INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, volume_24h, liquidity, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const run = this.db.transaction((batch: MarketSnapshot[]) => {
      for (const s of batch) {
        insert.run(
          s.tokenId,
          s.bestBid,
          s.bestAsk,
          s.lastPrice,
          s.volume24h,
          s.liquidity,
          s.capturedAt,
        );
      }
    });
    run(snapshots);
  }

  prune(olderThanIso: string): number {
    const result = this.db
      .prepare("DELETE FROM market_snapshots WHERE captured_at < ?")
      .run(olderThanIso);
    return result.changes;
  }
}
