-- Step 3 (audit doc §D3): soft-ranking score columns + partial index.
-- Runtime ledger DBs upgrade via bootstrapLedgerDb (safeAddColumn calls +
-- ledger.sql re-exec). This file exists for non-runtime DB consumers
-- (research scripts, tools) that iterate the migrations directory.
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, so the file is NOT replayable
-- standalone — idempotency relies on runMigrations skipping already-applied
-- filenames via schema_migrations.
ALTER TABLE markets ADD COLUMN score REAL;
ALTER TABLE markets ADD COLUMN score_model_version TEXT;
ALTER TABLE markets ADD COLUMN scored_at TEXT;
ALTER TABLE markets ADD COLUMN features_captured_at TEXT;

CREATE INDEX IF NOT EXISTS idx_markets_score ON markets(score) WHERE score IS NOT NULL;
