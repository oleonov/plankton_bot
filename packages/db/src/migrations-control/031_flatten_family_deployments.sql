-- Phase 3 — Flatten family_deployments: add disabled_at/disabled_reason,
-- collapse reduce-only rows to disabled. The seven legacy columns
-- (strategy_stage, operator_mode, deployment_stage, probe_substate,
-- approved_snapshot_id, approved_scorecard_id, operator_reason) are kept
-- here so Phase 4 code can still read them; they are dropped by migration
-- 033 (Phase 6) after the archive snapshot this migration wrote.

-- 1. Archive full current state for rollback.
CREATE TABLE IF NOT EXISTS archive_family_deployments_031 AS
  SELECT * FROM family_deployments;

-- 2. Add new columns.
ALTER TABLE family_deployments ADD COLUMN disabled_at TEXT;
ALTER TABLE family_deployments ADD COLUMN disabled_reason TEXT;

-- 3. Collapse reduce-only → disabled.
UPDATE family_deployments
   SET enabled = 0,
       disabled_at = datetime('now'),
       disabled_reason = 'reduce-only-collapsed'
 WHERE strategy_stage = 'reduce-only';
