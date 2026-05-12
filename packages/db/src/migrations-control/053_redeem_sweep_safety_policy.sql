CREATE TEMP TABLE IF NOT EXISTS _redeem_sweep_safety_targets(profile_id TEXT PRIMARY KEY);
DELETE FROM _redeem_sweep_safety_targets;

INSERT OR IGNORE INTO _redeem_sweep_safety_targets(profile_id)
SELECT profile_id
  FROM profile_settings
 WHERE json_extract(execution_policy_json, '$.redeemSweep.enabled') IS NOT 0
    OR COALESCE(json_extract(execution_policy_json, '$.redeemSweep.intervalMs'), 0) != 14400000
    OR COALESCE(json_extract(execution_policy_json, '$.redeemSweep.minAgeAfterResolutionSec'), 0) != 28800;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         COALESCE(execution_policy_json, '{}'),
         '$.redeemSweep.enabled',
         json('false'),
         '$.redeemSweep.intervalMs',
         14400000,
         '$.redeemSweep.minAgeAfterResolutionSec',
         28800
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _redeem_sweep_safety_targets);

UPDATE runtime_control_state
   SET execution_policy_version = execution_policy_version + 1,
       updated_at = datetime('now')
 WHERE EXISTS (SELECT 1 FROM _redeem_sweep_safety_targets);

DROP TABLE IF EXISTS _redeem_sweep_safety_targets;
