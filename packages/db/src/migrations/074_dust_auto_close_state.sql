CREATE TABLE IF NOT EXISTS dust_auto_close_state (
  token_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('attempted', 'non_closeable')),
  last_attempt_at_ms BIGINT NOT NULL,
  last_attempt_reason TEXT,
  next_retry_at_ms BIGINT NOT NULL,
  consecutive_attempts INTEGER NOT NULL DEFAULT 0,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dust_auto_close_state_next_retry
  ON dust_auto_close_state(next_retry_at_ms);
