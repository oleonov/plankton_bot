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

  findLatestBboByTokens(
    tokenIds: readonly TokenId[],
  ): Map<string, { bestBid: number | null; bestAsk: number | null; tickSize: number | null }> {
    const result = new Map<
      string,
      { bestBid: number | null; bestAsk: number | null; tickSize: number | null }
    >();
    if (tokenIds.length === 0) return result;

    const ids = [...new Set(tokenIds.map(String))];
    const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const placeholders = ids.map(() => "?").join(", ");

    // LEFT JOIN markets to retrieve the token's actual tick_size. The JOIN key is
    // token_id (PK in both tables). tick_size is NULL when the markets row is absent.
    const rows = this.db
      .prepare(
        `SELECT s.token_id, s.best_bid, s.best_ask, m.tick_size
           FROM (
             SELECT token_id, best_bid, best_ask,
                    ROW_NUMBER() OVER (PARTITION BY token_id ORDER BY captured_at DESC) AS rn
               FROM market_snapshots
              WHERE token_id IN (${placeholders})
                AND captured_at >= ?
           ) s
           LEFT JOIN markets m ON m.token_id = s.token_id
          WHERE s.rn = 1`,
      )
      .all(...ids, cutoff) as Array<{
      token_id: string;
      best_bid: number | null;
      best_ask: number | null;
      tick_size: number | null;
    }>;

    for (const row of rows) {
      result.set(row.token_id, {
        bestBid: row.best_bid,
        bestAsk: row.best_ask,
        tickSize: row.tick_size,
      });
    }
    return result;
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
