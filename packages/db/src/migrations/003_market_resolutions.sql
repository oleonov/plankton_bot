-- 003_market_resolutions.sql
-- Tracks market resolution events and per-position settlement PnL.

CREATE TABLE IF NOT EXISTS market_resolutions (
  condition_id TEXT PRIMARY KEY,
  resolution   TEXT NOT NULL,
  resolved_at  TEXT NOT NULL,
  detected_at  TEXT NOT NULL,
  source       TEXT NOT NULL,
  raw_response TEXT
);

-- Separate from pnl_ledger: pnl_ledger.fill_id → fills.fill_id → orders.order_id.
-- Settlement has no real order or fill, so a dedicated table avoids FK chain issues.
CREATE TABLE IF NOT EXISTS settlement_ledger (
  settlement_id    TEXT PRIMARY KEY,
  condition_id     TEXT NOT NULL REFERENCES market_resolutions(condition_id),
  position_id      TEXT NOT NULL REFERENCES positions(position_id),
  token_id         TEXT NOT NULL,
  family_id        TEXT NOT NULL,
  resolution       TEXT NOT NULL,
  settlement_price REAL NOT NULL,
  size             REAL NOT NULL,
  delta            REAL NOT NULL,
  settled_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_settlement_family ON settlement_ledger(family_id);
CREATE INDEX IF NOT EXISTS idx_settlement_settled_at ON settlement_ledger(settled_at);
