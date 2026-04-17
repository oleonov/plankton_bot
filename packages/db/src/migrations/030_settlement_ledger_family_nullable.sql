-- Make family_id nullable on settlement_ledger.
--
-- Migration 029 made family_id nullable on orders/fills/positions/inventory_lots
-- to support the null-family algo critical path (design spec
-- 2026-04-16-remove-familyid-critical-path), but missed settlement_ledger.
--
-- Effect of the gap: when a null-family position settles, code paths that pass
-- `String(position.familyId)` write the literal 4-char string "null" into the
-- NOT NULL family_id column — passing the constraint but corrupting family
-- attribution. This migration removes the NOT NULL constraint so the code can
-- pass a real SQL NULL instead.
--
-- SQLite cannot ALTER COLUMN nullability, so we rebuild the table.

CREATE TABLE settlement_ledger_new (
  settlement_id    TEXT PRIMARY KEY,
  condition_id     TEXT NOT NULL REFERENCES market_resolutions(condition_id),
  position_id      TEXT NOT NULL REFERENCES positions(position_id),
  token_id         TEXT NOT NULL,
  family_id        TEXT,
  resolution       TEXT NOT NULL,
  settlement_price REAL NOT NULL,
  size             REAL NOT NULL,
  delta            REAL NOT NULL,
  settled_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO settlement_ledger_new SELECT * FROM settlement_ledger;

DROP TABLE settlement_ledger;
ALTER TABLE settlement_ledger_new RENAME TO settlement_ledger;

CREATE INDEX IF NOT EXISTS idx_settlement_family ON settlement_ledger(family_id);
CREATE INDEX IF NOT EXISTS idx_settlement_settled_at ON settlement_ledger(settled_at);
