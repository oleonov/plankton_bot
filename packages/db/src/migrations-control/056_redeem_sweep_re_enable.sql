-- Re-enable redeemSweep on every profile after the Polymarket relayer
-- `invalid metadata field` fix made settlement safe again. Migration 053
-- had force-disabled the flag as a safety net while the metadata bug was
-- blocking all redeem submissions. The metadata fix lands together with
-- this migration, so the safety net is no longer needed and the flag must
-- be on for the orchestrator to actually exercise the fix.

CREATE TEMP TABLE IF NOT EXISTS _redeem_sweep_reenable_targets(profile_id TEXT PRIMARY KEY);
DELETE FROM _redeem_sweep_reenable_targets;

INSERT OR IGNORE INTO _redeem_sweep_reenable_targets(profile_id)
SELECT profile_id
  FROM profile_settings
 WHERE COALESCE(json_extract(execution_policy_json, '$.redeemSweep.enabled'), 0) = 0;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         COALESCE(execution_policy_json, '{}'),
         '$.redeemSweep.enabled',
         json('true')
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _redeem_sweep_reenable_targets);

UPDATE runtime_control_state
   SET execution_policy_version = execution_policy_version + 1,
       updated_at = datetime('now')
 WHERE EXISTS (SELECT 1 FROM _redeem_sweep_reenable_targets);

DROP TABLE IF EXISTS _redeem_sweep_reenable_targets;
