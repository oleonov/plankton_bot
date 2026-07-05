-- Phase 0 rev 2: ship plankton-derived makerEntry values + new scale-in/hold fields
-- in-place for all existing execution_policy_json rows.
--
-- Guard: do NOT modify rows where makerEntry.mode = 'micro_live' AND
-- whitelistConditionIds is a non-empty array (a live-order config).
-- Those rows change only via an explicit operator PATCH.
--
-- For harvestGainPct / fillWaitMs: update ONLY where the value is missing OR still
-- equals the old default (0.5 / 300000). Operator-customized values are left untouched.
-- For holdWindowMs / maxScaleInLevels / scaleInStepPct: add where missing only.

CREATE TEMP TABLE _maker067_targets (profile_id TEXT PRIMARY KEY);

INSERT INTO _maker067_targets (profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND json_type(execution_policy_json, '$.makerEntry') IS NOT NULL
  -- guard: leave any live-active maker config untouched
  AND NOT (
    json_extract(execution_policy_json, '$.makerEntry.mode') = 'micro_live'
    AND json_type(execution_policy_json, '$.makerEntry.whitelistConditionIds') = 'array'
    AND json_array_length(execution_policy_json, '$.makerEntry.whitelistConditionIds') > 0
  )
  -- only target rows that actually need a change
  AND (
    json_extract(execution_policy_json, '$.makerEntry.harvestGainPct') IS NULL
    OR json_extract(execution_policy_json, '$.makerEntry.harvestGainPct') = 0.5
    OR json_extract(execution_policy_json, '$.makerEntry.fillWaitMs') IS NULL
    OR json_extract(execution_policy_json, '$.makerEntry.fillWaitMs') = 300000
    OR json_extract(execution_policy_json, '$.makerEntry.holdWindowMs') IS NULL
    OR json_extract(execution_policy_json, '$.makerEntry.maxScaleInLevels') IS NULL
    OR json_extract(execution_policy_json, '$.makerEntry.scaleInStepPct') IS NULL
  );

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.makerEntry.harvestGainPct',
         CASE
           WHEN json_extract(execution_policy_json, '$.makerEntry.harvestGainPct') IS NULL
             OR json_extract(execution_policy_json, '$.makerEntry.harvestGainPct') = 0.5
           THEN 0.2
           ELSE json_extract(execution_policy_json, '$.makerEntry.harvestGainPct')
         END,
         '$.makerEntry.fillWaitMs',
         CASE
           WHEN json_extract(execution_policy_json, '$.makerEntry.fillWaitMs') IS NULL
             OR json_extract(execution_policy_json, '$.makerEntry.fillWaitMs') = 300000
           THEN 7200000
           ELSE json_extract(execution_policy_json, '$.makerEntry.fillWaitMs')
         END,
         '$.makerEntry.holdWindowMs',
         COALESCE(
           json_extract(execution_policy_json, '$.makerEntry.holdWindowMs'),
           10800000
         ),
         '$.makerEntry.maxScaleInLevels',
         COALESCE(
           json_extract(execution_policy_json, '$.makerEntry.maxScaleInLevels'),
           4
         ),
         '$.makerEntry.scaleInStepPct',
         COALESCE(
           json_extract(execution_policy_json, '$.makerEntry.scaleInStepPct'),
           0.1
         )
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _maker067_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _maker067_targets);

DROP TABLE _maker067_targets;
