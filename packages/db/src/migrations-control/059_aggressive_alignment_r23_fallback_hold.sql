-- ADR-033 aggressive Plankton-alignment batch.
--
-- 1. Neutralize default FALLBACK BUY while preserving the required fallback row.
-- 2. Persist explicit R23 defaults into live-lite execution_policy_json so the
--    entry rule can be config-disabled without a code revert.

UPDATE algo_decision_rules
   SET action = 'HOLD'
 WHERE rule_id = 'FALLBACK'
   AND priority = 999
   AND action <> 'HOLD';

CREATE TEMP TABLE _r23_policy_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _r23_policy_targets(profile_id)
SELECT profile_id
  FROM profile_settings
 WHERE profile_id = 'live-lite'
   AND execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_type(execution_policy_json, '$.r23DipTrigger') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.r23DipTrigger',
         json('{"enabled":true,"dropThresholdRatio":0.683,"windowMs":86400000}')
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _r23_policy_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _r23_policy_targets);

DROP TABLE _r23_policy_targets;
