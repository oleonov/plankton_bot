-- GATE-lane entry / bounce-exit policy blocks (live experiment, Phase 1 —
-- docs/plans/2026-07-15-gate-bounce-live-experiment.md).
--
-- Backfills the default-OFF gateEntry and bounceExit blocks into any existing
-- execution_policy_json rows that are missing them, then bumps
-- execution_policy_version so a running runtime hot-reloads and picks up the
-- new fields.
--
-- Both blocks default to enabled:false, mode:"off", whitelistConditionIds:[]
-- so no live-order behavior changes — this is purely a schema-forward
-- migration. Research-backed params (fixed, do not tune here): gateEntry
-- minLifespanDays 30 / minPrice 0.01 / maxPrice 0.15 / microMaxOrderUsdc 2;
-- bounceExit targetGainPct 0.257 / timeoutMs 14400000 (4h) / microMaxOrderUsdc 2.

CREATE TEMP TABLE _gate_entry_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _gate_entry_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND json_type(execution_policy_json, '$.gateEntry') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.gateEntry',
         json('{"enabled":false,"mode":"off","minLifespanDays":30,"minPrice":0.01,"maxPrice":0.15,"whitelistConditionIds":[],"microMaxOrderUsdc":2}')
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _gate_entry_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _gate_entry_targets);

DROP TABLE _gate_entry_targets;

CREATE TEMP TABLE _bounce_exit_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _bounce_exit_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND json_type(execution_policy_json, '$.bounceExit') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.bounceExit',
         json('{"enabled":false,"mode":"off","targetGainPct":0.257,"timeoutMs":14400000,"whitelistConditionIds":[],"microMaxOrderUsdc":2}')
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _bounce_exit_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _bounce_exit_targets);

DROP TABLE _bounce_exit_targets;
