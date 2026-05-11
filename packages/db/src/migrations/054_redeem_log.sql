CREATE TABLE IF NOT EXISTS redeem_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_id TEXT NOT NULL,
  token_ids TEXT NOT NULL,
  attempt_ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('attempting','success','submitted','pending','skipped','failed','rejected','failed_max_retries','failed_orphaned')),
  tx_hash TEXT,
  gas_used INTEGER,
  error_msg TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_redeem_log_condition_ts
  ON redeem_log(condition_id, attempt_ts DESC);

CREATE INDEX IF NOT EXISTS idx_redeem_log_status_ts
  ON redeem_log(status, attempt_ts DESC);
