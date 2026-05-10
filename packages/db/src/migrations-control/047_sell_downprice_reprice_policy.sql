-- R58 SELL downprice reprice calibration.
-- Tighten PASSIVE exit TTL to the observed 2h/4h/6h band and add the
-- DB-backed downprice reprice guard for existing profile rows. The object
-- below is a migration-time snapshot; runtime defaults live in domain.

CREATE TEMP TABLE _r58_sell_policy_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _r58_sell_policy_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND (
    COALESCE(json_extract(execution_policy_json, '$.orderLifetime.passive.lowTtlMs'), 0) != 7200000
    OR COALESCE(json_extract(execution_policy_json, '$.orderLifetime.passive.mediumTtlMs'), 0) != 14400000
    OR COALESCE(json_extract(execution_policy_json, '$.orderLifetime.passive.highTtlMs'), 0) != 21600000
    OR json_type(execution_policy_json, '$.exitRepriceOnDownprice') IS NULL
    OR COALESCE(json_extract(execution_policy_json, '$.exitRepriceOnDownprice.enabled'), 0) != 1
    OR COALESCE(json_extract(execution_policy_json, '$.exitRepriceOnDownprice.thresholdTicks'), 0) != 5
    OR COALESCE(json_extract(execution_policy_json, '$.exitRepriceOnDownprice.maxRepricesPerOrder'), 0) != 10
  );

UPDATE profile_settings
   SET execution_policy_json = json_set(
         CASE
           WHEN json_type(execution_policy_json, '$.exitRepriceOnDownprice') = 'object'
             THEN execution_policy_json
           ELSE json_set(
             execution_policy_json,
             '$.exitRepriceOnDownprice',
             json('{"enabled":true,"thresholdTicks":5,"maxRepricesPerOrder":10,"stuckWarningEnabled":true,"stuckWarningAgeMs":14400000,"stuckWarningGapPct":0.1}')
           )
         END,
         '$.orderLifetime.passive.lowTtlMs',
         7200000,
         '$.orderLifetime.passive.mediumTtlMs',
         14400000,
         '$.orderLifetime.passive.highTtlMs',
         21600000,
         '$.exitRepriceOnDownprice.enabled',
         json('true'),
         '$.exitRepriceOnDownprice.thresholdTicks',
         5,
         '$.exitRepriceOnDownprice.maxRepricesPerOrder',
         10,
         '$.exitRepriceOnDownprice.stuckWarningEnabled',
         json('true'),
         '$.exitRepriceOnDownprice.stuckWarningAgeMs',
         14400000,
         '$.exitRepriceOnDownprice.stuckWarningGapPct',
         0.1
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _r58_sell_policy_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _r58_sell_policy_targets);

DROP TABLE _r58_sell_policy_targets;
