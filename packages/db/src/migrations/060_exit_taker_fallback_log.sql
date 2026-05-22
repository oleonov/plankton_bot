CREATE TABLE IF NOT EXISTS exit_taker_fallback_log (
  ts INTEGER NOT NULL,
  position_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  profit_ratio REAL NOT NULL,
  qty REAL NOT NULL,
  best_bid REAL NOT NULL,
  result TEXT NOT NULL,
  failure_reason TEXT,
  PRIMARY KEY (ts, position_id)
);

CREATE INDEX IF NOT EXISTS idx_exit_taker_fallback_position
  ON exit_taker_fallback_log(position_id, ts);
