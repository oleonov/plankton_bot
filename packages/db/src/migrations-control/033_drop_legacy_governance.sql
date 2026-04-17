-- Phase 6 — Drop the seven legacy governance columns from family_deployments
-- (strategy_stage, operator_mode, deployment_stage, probe_substate,
--  approved_snapshot_id, approved_scorecard_id, operator_reason).
--
-- Phase 3 flattened deployments to a single enable/disable lever. Phases 4–5
-- purged the promotion/auto-rotation surface. The columns have been inert
-- read-only since Phase 3; this migration removes them for good.
--
-- Archive first for rollback safety.

CREATE TABLE IF NOT EXISTS archive_family_deployments_033 AS
  SELECT * FROM family_deployments;

CREATE TABLE family_deployments_new (
  family_id        TEXT NOT NULL REFERENCES family_catalog(family_id),
  profile          TEXT NOT NULL REFERENCES profiles(profile_id),
  enabled          INTEGER NOT NULL DEFAULT 0,
  disabled_at      TEXT,
  disabled_reason  TEXT,
  priority         INTEGER NOT NULL DEFAULT 999,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (family_id, profile)
);

INSERT INTO family_deployments_new
  (family_id, profile, enabled, disabled_at, disabled_reason, priority, created_at, updated_at)
SELECT
  family_id, profile, enabled, disabled_at, disabled_reason, priority, created_at, updated_at
FROM family_deployments;

DROP INDEX IF EXISTS idx_family_deployments_profile_enabled;
DROP TABLE family_deployments;
ALTER TABLE family_deployments_new RENAME TO family_deployments;

CREATE INDEX IF NOT EXISTS idx_family_deployments_profile_enabled
  ON family_deployments(profile, enabled);
