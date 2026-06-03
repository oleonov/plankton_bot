CREATE TABLE IF NOT EXISTS floor_intents (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  condition_id TEXT,
  position_id TEXT,
  source_order_id TEXT,
  source_signal_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'superseded', 'cancelled')),
  target_price REAL NOT NULL,
  floor_ratio_applied REAL,
  normal_signal_floor_would_have_blocked INTEGER,
  normal_signal_floor_price REAL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  consumed_at TEXT,
  consuming_order_id TEXT,
  cleared_at TEXT,
  clear_reason TEXT,
  metadata_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_floor_intents_active_token
  ON floor_intents(token_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_floor_intents_token_status
  ON floor_intents(token_id, status);

CREATE INDEX IF NOT EXISTS idx_floor_intents_condition_status
  ON floor_intents(condition_id, status);

CREATE INDEX IF NOT EXISTS idx_floor_intents_expires_at
  ON floor_intents(expires_at);
