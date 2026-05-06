-- ADR-024 D-C: sizing telemetry on decision_signal_log.
-- sizing_rule_id: rule id (B1..B7, S1..S7, FALLBACK) returned by evaluateSize
--   at signal-emission time; carries the rule attribution alongside
--   decision_rule_id.
-- notional_bucket: §4.6 USDC bucket for Signal.suggestedSizeUsdc, mutually
--   exclusive over the ten canonical buckets at 06_algorithm_spec.md:454-467.
-- Runtime ledger DBs upgrade via bootstrapLedgerDb safeAddColumn calls; this
-- file exists for non-runtime DB consumers iterating the migrations directory.
-- Idempotency relies on runMigrations skipping already-applied filenames via
-- schema_migrations (no `ADD COLUMN IF NOT EXISTS` in SQLite).
ALTER TABLE decision_signal_log ADD COLUMN sizing_rule_id TEXT;
ALTER TABLE decision_signal_log ADD COLUMN notional_bucket TEXT;
