-- Retention sweeps signal_feed_buckets by AGE alone, but every existing index leads with
-- another column — idx_..._token_time on (token_id, ...) and idx_..._granularity_time on
-- (bucket_granularity_ms, ...). Measured on the production ledger (35.1M rows, 2026-07-30):
-- an age-only batch cost 3898 ms (full covering-index scan + TEMP B-TREE sort), and 2315 ms
-- even when nothing was expired — per sweep, on a synchronous better-sqlite3 connection.
-- Indexing the column the predicate actually filters on turns that into a range seek.
-- Deliberately NOT pinning the sweep to bucket_granularity_ms to reuse the existing index:
-- a hard-coded granularity is exactly what made signal-feed-manager's own prune silently
-- match zero rows for 44 days.
CREATE INDEX IF NOT EXISTS idx_signal_feed_buckets_start_ms
  ON signal_feed_buckets(bucket_start_ms);
