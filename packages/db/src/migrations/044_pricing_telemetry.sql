-- ADR-023 D-F: pricing telemetry on execution_policy_observations.
-- pricing_delta_ticks: signed distance from the order's natural edge in ticks
--   (BUY: selected - bestBid; SELL: bestAsk - selected).
-- round_level_hit: round-level taxonomy bucket from R29 evidence
--   (min_tick > 0.05x > 0.01x > 0.005x > off-round, mutually exclusive).
-- Runtime ledger DBs upgrade via bootstrapLedgerDb safeAddColumn calls; this
-- file exists for non-runtime DB consumers iterating the migrations
-- directory. Idempotency relies on runMigrations skipping already-applied
-- filenames via schema_migrations (no `ADD COLUMN IF NOT EXISTS` in SQLite).
ALTER TABLE execution_policy_observations ADD COLUMN pricing_delta_ticks REAL;
ALTER TABLE execution_policy_observations ADD COLUMN round_level_hit TEXT;
