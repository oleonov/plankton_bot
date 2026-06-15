import type Database from "better-sqlite3";
import type { OhlcBucket, TokenId } from "@krabs/domain";

export interface SignalFeedBucketRepository {
  upsertBucket(bucket: OhlcBucket, createdAtMs: number): void;
  upsertBuckets(buckets: readonly OhlcBucket[], createdAtMs: number): void;
  selectBucketsForToken(args: {
    tokenId: TokenId;
    bucketGranularityMs: number;
    sinceMs?: number;
    limit?: number;
  }): OhlcBucket[];
  deleteBucketsBefore(bucketGranularityMs: number, beforeMs: number): number;
}

export class SqliteSignalFeedRepository implements SignalFeedBucketRepository {
  constructor(private readonly db: Database.Database) {}

  upsertBucket(bucket: OhlcBucket, createdAtMs: number): void {
    this.db
      .prepare(
        `INSERT INTO signal_feed_buckets
         (token_id, bucket_start_ms, bucket_granularity_ms, open_mid, high_mid, low_mid,
          close_mid, sample_count, trade_count, notional_sum, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id, bucket_granularity_ms, bucket_start_ms) DO UPDATE SET
           open_mid = excluded.open_mid,
           high_mid = excluded.high_mid,
           low_mid = excluded.low_mid,
           close_mid = excluded.close_mid,
           sample_count = excluded.sample_count,
           trade_count = excluded.trade_count,
           notional_sum = excluded.notional_sum,
           created_at_ms = excluded.created_at_ms`,
      )
      .run(
        bucket.tokenId,
        bucket.bucketStartMs,
        bucket.bucketGranularityMs,
        bucket.openMid,
        bucket.highMid,
        bucket.lowMid,
        bucket.closeMid,
        bucket.sampleCount,
        bucket.tradeCount,
        bucket.notionalSum,
        createdAtMs,
      );
  }

  upsertBuckets(buckets: readonly OhlcBucket[], createdAtMs: number): void {
    for (const bucket of buckets) this.upsertBucket(bucket, createdAtMs);
  }

  selectBucketsForToken(args: {
    tokenId: TokenId;
    bucketGranularityMs: number;
    sinceMs?: number;
    limit?: number;
  }): OhlcBucket[] {
    const sinceClause = args.sinceMs == null ? "" : "AND bucket_start_ms >= @sinceMs";
    const limitClause = args.limit == null ? "" : "LIMIT @limit";
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM signal_feed_buckets
           WHERE token_id = @tokenId
             AND bucket_granularity_ms = @bucketGranularityMs
             ${sinceClause}
           ORDER BY bucket_start_ms DESC
           ${limitClause}
         )
         ORDER BY bucket_start_ms ASC`,
      )
      .all({
        tokenId: args.tokenId,
        bucketGranularityMs: args.bucketGranularityMs,
        sinceMs: args.sinceMs,
        limit: args.limit,
      }) as SignalFeedBucketRow[];
    return rows.map(toBucket);
  }

  deleteBucketsBefore(bucketGranularityMs: number, beforeMs: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM signal_feed_buckets
         WHERE bucket_granularity_ms = ?
           AND bucket_start_ms < ?`,
      )
      .run(bucketGranularityMs, beforeMs);
    return Number(result.changes);
  }
}

interface SignalFeedBucketRow {
  token_id: string;
  bucket_start_ms: number;
  bucket_granularity_ms: number;
  open_mid: number;
  high_mid: number;
  low_mid: number;
  close_mid: number;
  sample_count: number;
  trade_count: number;
  notional_sum: number;
}

function toBucket(row: SignalFeedBucketRow): OhlcBucket {
  return {
    tokenId: row.token_id as TokenId,
    bucketStartMs: row.bucket_start_ms,
    bucketGranularityMs: row.bucket_granularity_ms,
    openMid: row.open_mid,
    highMid: row.high_mid,
    lowMid: row.low_mid,
    closeMid: row.close_mid,
    sampleCount: row.sample_count,
    tradeCount: row.trade_count,
    notionalSum: row.notional_sum,
    persisted: true,
  };
}
