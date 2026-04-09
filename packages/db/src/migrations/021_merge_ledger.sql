-- 021_merge_ledger.sql

CREATE TABLE IF NOT EXISTS merge_ledger (
  merge_id       TEXT PRIMARY KEY,
  condition_id   TEXT NOT NULL,
  family_id      TEXT NOT NULL,
  merged_amount  REAL NOT NULL,
  spread_pnl     REAL NOT NULL,
  merged_at      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_merge_ledger_family ON merge_ledger(family_id);
CREATE INDEX IF NOT EXISTS idx_merge_ledger_merged_at ON merge_ledger(merged_at);