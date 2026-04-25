CREATE TABLE IF NOT EXISTS leg_state_transitions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id         TEXT NOT NULL,
  position_id      TEXT,
  fill_id          TEXT,
  order_id         TEXT,
  client_order_id  TEXT,
  condition_id     TEXT,
  from_phase       TEXT NOT NULL CHECK (from_phase IN ('S0', 'S1', 'S2', 'S3', 'S4')),
  to_phase         TEXT NOT NULL CHECK (to_phase IN ('S0', 'S1', 'S2', 'S3', 'S4')),
  action           TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'CLEAR', 'SETTLE')),
  price            REAL,
  size             REAL,
  size_usdc        REAL,
  from_buy_count   INTEGER NOT NULL,
  from_sell_count  INTEGER NOT NULL,
  to_buy_count     INTEGER NOT NULL,
  to_sell_count    INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  occurred_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leg_state_transitions_fill_unique
  ON leg_state_transitions(fill_id)
  WHERE fill_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leg_state_transitions_token_ts
  ON leg_state_transitions(token_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_leg_state_transitions_position_ts
  ON leg_state_transitions(position_id, occurred_at DESC, id DESC)
  WHERE position_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leg_state_transitions_created_at
  ON leg_state_transitions(created_at);
