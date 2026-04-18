-- Phase 7.1: Drop family_id (and family_key) columns from ledger tables.
--
-- Nullable columns: use ALTER TABLE DROP COLUMN (SQLite 3.35+).
-- NOT NULL columns (pnl_ledger.family_id, merge_ledger.family_id): recreate-table pattern.
--
-- Also drops corresponding idx_*_family* indexes.

-- ── markets ─────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_markets_family_id;
ALTER TABLE markets DROP COLUMN family_id;
ALTER TABLE markets DROP COLUMN family_key;

-- ── orders ──────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_orders_family;
ALTER TABLE orders DROP COLUMN family_id;

-- ── fills ───────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_fills_family;
ALTER TABLE fills DROP COLUMN family_id;

-- ── positions ───────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_positions_family;
ALTER TABLE positions DROP COLUMN family_id;

-- ── inventory_lots ───────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_inventory_lots_family;
ALTER TABLE inventory_lots DROP COLUMN family_id;

-- ── settlement_ledger ────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_settlement_family;
ALTER TABLE settlement_ledger DROP COLUMN family_id;

-- ── risk_events ──────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_risk_events_family;
ALTER TABLE risk_events DROP COLUMN family_id;

-- ── pnl_ledger (NOT NULL family_id — recreate-table) ─────────────────────────
CREATE TABLE pnl_ledger_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id     TEXT NOT NULL REFERENCES fills(fill_id),
  position_id TEXT NOT NULL REFERENCES positions(position_id),
  delta       REAL NOT NULL,
  filled_at   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP INDEX IF EXISTS idx_pnl_ledger_family;

INSERT INTO pnl_ledger_new (id, fill_id, position_id, delta, filled_at, created_at)
  SELECT id, fill_id, position_id, delta, filled_at, created_at FROM pnl_ledger;

DROP TABLE pnl_ledger;
ALTER TABLE pnl_ledger_new RENAME TO pnl_ledger;

CREATE INDEX IF NOT EXISTS idx_pnl_ledger_filled_at ON pnl_ledger(filled_at);

-- ── merge_ledger (NOT NULL family_id — recreate-table) ────────────────────────
CREATE TABLE merge_ledger_new (
  merge_id       TEXT PRIMARY KEY,
  condition_id   TEXT NOT NULL,
  merged_amount  REAL NOT NULL,
  spread_pnl     REAL NOT NULL,
  merged_at      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

DROP INDEX IF EXISTS idx_merge_ledger_family;

INSERT INTO merge_ledger_new (merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at)
  SELECT merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at FROM merge_ledger;

DROP TABLE merge_ledger;
ALTER TABLE merge_ledger_new RENAME TO merge_ledger;

CREATE INDEX IF NOT EXISTS idx_merge_ledger_merged_at ON merge_ledger(merged_at);
