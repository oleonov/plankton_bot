-- R23 maker-entry policy block (Phase 0).
--
-- Backfills the default makerEntry block into any existing execution_policy_json
-- rows that are missing it, then bumps execution_policy_version so a running
-- runtime hot-reloads and picks up the new field.
--
-- makerEntry.mode defaults to "off" and whitelistConditionIds to [] so no
-- live-order behavior changes — this is purely a schema-forward migration.
-- collapseFloorPrice is JSON null (guard off) by design; do NOT change it to 0.02.

CREATE TEMP TABLE _maker_entry_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _maker_entry_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND json_type(execution_policy_json, '$.makerEntry') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.makerEntry',
         json('{"mode":"off","bidImproveTicks":1,"harvestGainPct":0.5,"fillWaitMs":300000,"makerMinLiquidity":5000,"makerMinVol24h":1000,"whitelistConditionIds":[],"microMaxOrderUsdc":10,"microMaxOpenUsdc":50,"collapseFloorPrice":null}')
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _maker_entry_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _maker_entry_targets);

DROP TABLE _maker_entry_targets;
