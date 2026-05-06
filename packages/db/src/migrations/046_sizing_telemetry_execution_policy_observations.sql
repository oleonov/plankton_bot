-- ADR-024 D-D: sizing telemetry on execution_policy_observations.
-- sizing_rule_id: rule id (B1..B7, S1..S7, FALLBACK) carried via
--   Signal.sizingRuleId from emitted-signal time onto the bridge/order
--   observation row. Joinable with decision_signal_log.sizing_rule_id.
-- notional_bucket: §4.6 USDC bucket for Signal.suggestedSizeUsdc; lets
--   emitted-vs-placed sizing distributions be A/B'd in dashboards.
-- Runtime ledger DBs upgrade via bootstrapLedgerDb safeAddColumn calls; this
-- file exists for non-runtime DB consumers iterating the migrations directory.
-- Idempotency relies on runMigrations skipping already-applied filenames via
-- schema_migrations (no `ADD COLUMN IF NOT EXISTS` in SQLite).
ALTER TABLE execution_policy_observations ADD COLUMN sizing_rule_id TEXT;
ALTER TABLE execution_policy_observations ADD COLUMN notional_bucket TEXT;
