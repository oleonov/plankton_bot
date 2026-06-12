import type Database from "better-sqlite3";
import type {
  MarketSnapshotRepository,
  MarketSnapshot,
  MarketSnapshotPositionValuation,
  TokenId,
} from "@krabs/domain";

export class SqliteMarketSnapshotRepository implements MarketSnapshotRepository {
  constructor(private readonly db: Database.Database) {}

  saveBatch(snapshots: MarketSnapshot[]): void {
    if (snapshots.length === 0) return;

    const insert = this.prepareInsert();
    const run = this.db.transaction((batch: MarketSnapshot[]) => {
      for (const s of batch) {
        insert.run(
          s.tokenId,
          s.bestBid,
          s.bestAsk,
          s.lastPrice,
          s.volume24h,
          s.liquidity,
          s.publicTradeCount24h,
          s.capturedAt,
        );
      }
    });
    run(snapshots);
  }

  saveBatchWithPositionValuations(
    snapshots: MarketSnapshot[],
    valuations: MarketSnapshotPositionValuation[],
  ): void {
    if (snapshots.length === 0 && valuations.length === 0) return;
    const insert = this.prepareInsert();
    const updatePosition = this.db.prepare(
      `UPDATE positions
          SET current_value_usdc = COALESCE(?, current_value_usdc),
              liquidation_value_usdc = ?,
              liquidation_price = ?,
              liquidation_depth_exhausted = ?,
              liquidation_value_updated_at = ?,
              updated_at = ?
        WHERE token_id = ?
          AND status IN ('open', 'dust')`,
    );

    const run = this.db.transaction(
      (batch: MarketSnapshot[], valuationBatch: MarketSnapshotPositionValuation[]) => {
        for (const s of batch) {
          insert.run(
            s.tokenId,
            s.bestBid,
            s.bestAsk,
            s.lastPrice,
            s.volume24h,
            s.liquidity,
            s.publicTradeCount24h,
            s.capturedAt,
          );
        }
        for (const valuation of valuationBatch) {
          updatePosition.run(
            valuation.currentValueUsdc,
            valuation.liquidationValueUsdc,
            valuation.liquidationPrice,
            valuation.liquidationDepthExhausted ? 1 : 0,
            valuation.updatedAt,
            valuation.updatedAt,
            valuation.tokenId,
          );
        }
      },
    );
    run(snapshots, valuations);
  }

  private prepareInsert(): Database.Statement {
    return this.db.prepare(
      `INSERT INTO market_snapshots
         (token_id, best_bid, best_ask, last_price, volume_24h, liquidity,
          public_trade_count_24h, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  prune(
    olderThanIso: string,
    options?: { readonly preserveTokenIds?: readonly TokenId[] },
  ): number {
    const preserveTokenIds = [...new Set(options?.preserveTokenIds?.map(String) ?? [])];
    if (preserveTokenIds.length === 0) {
      const result = this.db
        .prepare("DELETE FROM market_snapshots WHERE captured_at < ?")
        .run(olderThanIso);
      return result.changes;
    }
    const placeholders = preserveTokenIds.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `DELETE FROM market_snapshots
         WHERE captured_at < ?
           AND token_id NOT IN (${placeholders})`,
      )
      .run(olderThanIso, ...preserveTokenIds);
    return result.changes;
  }
}
