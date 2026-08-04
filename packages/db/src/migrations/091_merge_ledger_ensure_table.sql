-- 092 has to ALTER merge_ledger, and on an upgraded ledger that table is not guaranteed to exist
-- when migrations run. 021 created it, but `LEDGER_BASELINE_MIGRATIONS` marks 021 as already
-- applied on every DB that has a `markets` table, so a legacy ledger that never actually got the
-- table skips 021 forever — and on that path `bootstrapLedgerDb` execs `ledger.sql` only AFTER
-- `runMigrations`, so the canonical CREATE lands too late to help a migration.
--
-- This file closes that gap the only way a migration can: by not assuming. It is deliberately pure
-- DDL with no `safe_add_column` — that macro is evaluated by the runner BEFORE the rest of the file
-- is exec'd, so a CREATE TABLE sitting above it in the same file would still run too late.
--
-- Shape is the post-033 one (no `family_id`): 033 is baselined too, so a DB arriving here without
-- the table must land directly on the current shape rather than resurrect a dropped column.
CREATE TABLE IF NOT EXISTS merge_ledger (
  merge_id       TEXT PRIMARY KEY,
  condition_id   TEXT NOT NULL,
  merged_amount  REAL NOT NULL,
  spread_pnl     REAL NOT NULL,
  merged_at      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_merge_ledger_merged_at ON merge_ledger(merged_at);
