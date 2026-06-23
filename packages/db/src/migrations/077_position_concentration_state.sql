CREATE TABLE IF NOT EXISTS position_concentration_state (
  concentration_key TEXT PRIMARY KEY,
  key_type TEXT NOT NULL CHECK (key_type IN ('condition', 'token')),
  condition_id TEXT NULL,
  token_id TEXT NOT NULL,
  lifecycle_start_at TEXT NOT NULL,
  bankroll_at_first_buy_usdc REAL NOT NULL,
  gross_buy_filled_usdc REAL NOT NULL DEFAULT 0,
  gross_high_water_usdc REAL NOT NULL DEFAULT 0,
  post_harvest_refill_spent_usdc REAL NOT NULL DEFAULT 0,
  last_profitable_sell_at TEXT NULL,
  last_profitable_sell_price REAL NULL,
  last_pre_sell_avg_entry REAL NULL,
  profitable_sell_count INTEGER NOT NULL DEFAULT 0,
  last_buy_at TEXT NULL,
  last_sell_at TEXT NULL,
  archived_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_position_concentration_state_key_type
  ON position_concentration_state(key_type);

CREATE INDEX IF NOT EXISTS idx_position_concentration_state_condition
  ON position_concentration_state(condition_id)
  WHERE condition_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_position_concentration_state_token
  ON position_concentration_state(token_id);

CREATE INDEX IF NOT EXISTS idx_position_concentration_state_archived
  ON position_concentration_state(archived_at);
