CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  profile             TEXT NOT NULL,
  equity_usdc         REAL NOT NULL,
  wallet_usdc         REAL,
  position_value_usdc REAL NOT NULL,
  realized_pnl_usdc   REAL NOT NULL,
  open_value_usdc     REAL NOT NULL,
  captured_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_profile_ts ON portfolio_snapshots(profile, captured_at DESC);
