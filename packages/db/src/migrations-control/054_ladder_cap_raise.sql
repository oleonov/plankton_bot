-- Plankton-aligned multi-buy ladder cap raise.
-- Bumps `multiBuyLadder.perTokenUsdcCap` from the legacy 10-USDC default to 25
-- so the ladder can comfortably reach the 15-40 refill window that the
-- Plankton multi-BUY profitability cluster lives in (R55/R57). Operator
-- overrides are preserved: only profiles still on the legacy default of 10
-- are touched.

CREATE TEMP TABLE IF NOT EXISTS _r55_ladder_cap_targets(profile_id TEXT PRIMARY KEY);
DELETE FROM _r55_ladder_cap_targets;

INSERT OR IGNORE INTO _r55_ladder_cap_targets(profile_id)
SELECT profile_id
  FROM profile_settings
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.multiBuyLadder.perTokenUsdcCap') = 10;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.multiBuyLadder.perTokenUsdcCap',
         25
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _r55_ladder_cap_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _r55_ladder_cap_targets);

DROP TABLE IF EXISTS _r55_ladder_cap_targets;
