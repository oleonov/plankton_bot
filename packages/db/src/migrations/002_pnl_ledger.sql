-- 002_pnl_ledger.sql
-- Records per-sell-fill realized PnL deltas for historical series.

CREATE TABLE IF NOT EXISTS pnl_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id     TEXT NOT NULL REFERENCES fills(fill_id),
  position_id TEXT NOT NULL REFERENCES positions(position_id),
  family_id   TEXT NOT NULL,
  delta       REAL NOT NULL,
  filled_at   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pnl_ledger_filled_at ON pnl_ledger(filled_at);
