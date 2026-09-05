-- Additive v2 intervals. Every column stays nullable so a v1 rollback writer can
-- continue inserting the original six-column snapshot shape.
CREATE TABLE IF NOT EXISTS trading_state_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_state TEXT NOT NULL,
  signals_produced INTEGER NOT NULL,
  signals_approved INTEGER NOT NULL,
  signals_rejected INTEGER NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

SELECT safe_add_column('trading_state_snapshots', 'window_version', 'INTEGER');
SELECT safe_add_column('trading_state_snapshots', 'window_started_at', 'TEXT');
SELECT safe_add_column('trading_state_snapshots', 'window_ended_at', 'TEXT');
SELECT safe_add_column('trading_state_snapshots', 'orders_accepted', 'INTEGER');
SELECT safe_add_column('trading_state_snapshots', 'order_notional_usdc', 'REAL');
SELECT safe_add_column('trading_state_snapshots', 'fills_received', 'INTEGER');
SELECT safe_add_column('trading_state_snapshots', 'fill_notional_usdc', 'REAL');
SELECT safe_add_column('trading_state_snapshots', 'rejection_reasons_json', 'TEXT');

CREATE INDEX IF NOT EXISTS idx_trading_state_snapshots_window_v2
  ON trading_state_snapshots(window_version, window_started_at, window_ended_at);
