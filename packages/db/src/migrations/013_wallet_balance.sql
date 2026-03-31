-- Create profile_summaries if missing (legacy monolithic migration path).
CREATE TABLE IF NOT EXISTS profile_summaries (
  profile_id           TEXT PRIMARY KEY,
  paused               INTEGER NOT NULL DEFAULT 1,
  last_run_at          TEXT,
  open_orders          INTEGER NOT NULL DEFAULT 0,
  open_positions       INTEGER NOT NULL DEFAULT 0,
  total_exposure_usdc  REAL NOT NULL DEFAULT 0,
  balance_usdc         REAL,
  wallet_balance_usdc  REAL,
  last_preflight_status TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
