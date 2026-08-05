-- GET /metrics/r23 (apps/api/src/routes/metrics.ts) buckets R23 fires by hour under
--   WHERE decision_rule_id = 'R23_DIP_TRIGGER' AND signal_timestamp >= ?
-- with no `side` term. Migration 041's idx_decision_signal_log_side_rule_ts leads with `side`,
-- so it cannot serve that predicate: the planner falls back to idx_decision_signal_log_ts and
-- filters every row in the 24 h window of a table that takes thousands of rows per minute.
-- This index already exists on the production ledger — added by hand while diagnosing the
-- endpoint — but no migration creates it, so any rebuilt or restored database silently loses it.
-- Verified on production 2026-08-05: the planner picks it as a COVERING index over the 219,927
-- R23 rows, so the scan never touches the table at all.
CREATE INDEX IF NOT EXISTS idx_decision_signal_log_rule_ts
  ON decision_signal_log(decision_rule_id, signal_timestamp DESC);
