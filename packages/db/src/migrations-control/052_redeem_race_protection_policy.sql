-- Redeem sweep race protection. Preserve operator-customized policy; only add
-- the missing rollback flag for profiles that do not have it yet.

CREATE TEMP TABLE _redeem_race_protection_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _redeem_race_protection_targets(profile_id)
SELECT profile_id
  FROM profile_settings
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_type(execution_policy_json, '$.raceProtection.redeemInFlight.enabled') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         CASE
           WHEN json_type(execution_policy_json, '$.raceProtection') = 'object'
             THEN execution_policy_json
           ELSE json_set(execution_policy_json, '$.raceProtection', json('{}'))
         END,
         '$.raceProtection.redeemInFlight',
         json('{"enabled":true}')
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _redeem_race_protection_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _redeem_race_protection_targets);

DROP TABLE _redeem_race_protection_targets;
