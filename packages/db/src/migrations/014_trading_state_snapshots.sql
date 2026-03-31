CREATE TABLE IF NOT EXISTS trading_state_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_state     TEXT    NOT NULL,
  signals_produced  INTEGER NOT NULL,
  signals_approved  INTEGER NOT NULL,
  signals_rejected  INTEGER NOT NULL,
  captured_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trading_state_snapshots_ts
  ON trading_state_snapshots(captured_at DESC);
