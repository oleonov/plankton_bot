-- Drop dead redeem-sweep gate.
-- `redeemSweep.minAgeAfterResolutionSec` was a Gamma `end_date`-based wait that
-- frequently blocked redeems for resolved matches whose end_date pointed at the
-- parent event/tournament time (e.g. ATP $7.03 stuck for days). The runtime
-- now relies solely on the Polymarket data-api `redeemable=true` signal, which
-- mirrors the on-chain ConditionResolution event. The field is no longer read;
-- strip it from existing profile_settings rows so the persisted JSON matches
-- the runtime contract.

CREATE TEMP TABLE IF NOT EXISTS _redeem_min_age_targets(profile_id TEXT PRIMARY KEY);
DELETE FROM _redeem_min_age_targets;

INSERT OR IGNORE INTO _redeem_min_age_targets(profile_id)
SELECT profile_id
  FROM profile_settings
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.redeemSweep.minAgeAfterResolutionSec') IS NOT NULL;

UPDATE profile_settings
   SET execution_policy_json = json_remove(
         execution_policy_json,
         '$.redeemSweep.minAgeAfterResolutionSec'
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _redeem_min_age_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _redeem_min_age_targets);

DROP TABLE IF EXISTS _redeem_min_age_targets;
