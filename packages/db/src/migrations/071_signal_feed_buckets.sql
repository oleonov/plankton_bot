CREATE TABLE IF NOT EXISTS signal_feed_buckets (
  token_id TEXT NOT NULL,
  bucket_start_ms BIGINT NOT NULL,
  bucket_granularity_ms INTEGER NOT NULL,
  open_mid REAL NOT NULL,
  high_mid REAL NOT NULL,
  low_mid REAL NOT NULL,
  close_mid REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  trade_count INTEGER NOT NULL DEFAULT 0,
  notional_sum REAL NOT NULL DEFAULT 0.0,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (token_id, bucket_granularity_ms, bucket_start_ms)
);

CREATE INDEX IF NOT EXISTS idx_signal_feed_buckets_token_time
  ON signal_feed_buckets(token_id, bucket_start_ms DESC);

CREATE INDEX IF NOT EXISTS idx_signal_feed_buckets_granularity_time
  ON signal_feed_buckets(bucket_granularity_ms, bucket_start_ms);
