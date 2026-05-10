-- R55 multi-buy ladder calibration.
-- Enable ladder continuation and raise the per-token cap to Plankton p90.
-- Other multiBuyLadder knobs remain operator-controlled as-is.
-- The JSON object below is a migration-time snapshot for legacy rows that
-- lack multiBuyLadder entirely; it is intentionally not synced at runtime.

CREATE TEMP TABLE _r55_ladder_policy_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _r55_ladder_policy_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND (
    COALESCE(json_extract(execution_policy_json, '$.multiBuyLadder.enabled'), 0) != 1
    OR COALESCE(json_extract(execution_policy_json, '$.multiBuyLadder.maxLadderFillsPerToken'), 5) != 15
  );

UPDATE profile_settings
   SET execution_policy_json = json_set(
         CASE
           WHEN json_type(execution_policy_json, '$.multiBuyLadder') = 'object'
             THEN execution_policy_json
           ELSE json_set(
             execution_policy_json,
             '$.multiBuyLadder',
             json('{"enabled":false,"maxLadderFillsPerToken":5,"ladderGapMs":60000,"perTokenUsdcCap":10,"maxPriceDriftTicks":5,"minStepFillRate":0.1}')
           )
         END,
         '$.multiBuyLadder.enabled',
         json('true'),
         '$.multiBuyLadder.maxLadderFillsPerToken',
         15
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _r55_ladder_policy_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _r55_ladder_policy_targets);

DROP TABLE _r55_ladder_policy_targets;
