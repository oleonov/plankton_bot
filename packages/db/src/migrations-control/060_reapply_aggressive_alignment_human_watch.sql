-- ADR-033 phase A redeploy after operator rollback.
--
-- The previous rollback was config/compose-only, so migration 059 remains
-- recorded as applied. Re-assert the aggressive DB state explicitly:
-- FALLBACK becomes HOLD and R23 is enabled. Performance alerts stay
-- visibility-only; human operators decide pause/rollback.

UPDATE algo_decision_rules
   SET action = 'HOLD'
 WHERE rule_id = 'FALLBACK'
   AND priority = 999
   AND action <> 'HOLD';

UPDATE profile_settings
   SET execution_policy_json = json_set(
         CASE
           WHEN execution_policy_json IS NULL OR json_valid(execution_policy_json) = 0
             THEN json('{}')
           ELSE execution_policy_json
         END,
         '$.r23DipTrigger',
         json('{"enabled":true,"dropThresholdRatio":0.683,"windowMs":86400000}')
       ),
       updated_at = datetime('now')
 WHERE profile_id = 'live-lite';

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1;
