-- R60 taker min-size guard configuration.
-- Preserve operator-edited opportunisticTaker fields; only fill missing guard
-- knobs and explicit profile fallback minimums with current code defaults.

SELECT safe_add_column('profile_settings', 'fallback_min_order_usdc_relayer', 'REAL');
SELECT safe_add_column('profile_settings', 'fallback_min_order_usdc_eoa', 'REAL');

CREATE TEMP TABLE _taker_guard_config_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _taker_guard_config_targets(profile_id)
SELECT profile_id
  FROM profile_settings
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND (
        json_type(execution_policy_json, '$.opportunisticTaker.safetyBuffer') IS NULL
     OR json_type(execution_policy_json, '$.opportunisticTaker.fallbackMinNotionalUsdc') IS NULL
     OR json_type(execution_policy_json, '$.opportunisticTaker.marketableBuyMinNotionalUsdc') IS NULL
   );

UPDATE profile_settings
   SET execution_policy_json = json_set(
         CASE
           WHEN json_type(execution_policy_json, '$.opportunisticTaker') = 'object'
             THEN execution_policy_json
           ELSE json_set(
             execution_policy_json,
             '$.opportunisticTaker',
             json('{"enabled":true,"maxSpreadTicks":2,"sides":["buy","sell"]}')
           )
         END,
         '$.opportunisticTaker.safetyBuffer',
         CASE
           WHEN json_type(execution_policy_json, '$.opportunisticTaker.safetyBuffer') IS NULL
             THEN 1.05
           ELSE json_extract(execution_policy_json, '$.opportunisticTaker.safetyBuffer')
         END,
         '$.opportunisticTaker.fallbackMinNotionalUsdc',
         CASE
           WHEN json_type(execution_policy_json, '$.opportunisticTaker.fallbackMinNotionalUsdc') IS NULL
             THEN 1
           ELSE json_extract(execution_policy_json, '$.opportunisticTaker.fallbackMinNotionalUsdc')
         END,
         '$.opportunisticTaker.marketableBuyMinNotionalUsdc',
         CASE
           WHEN json_type(execution_policy_json, '$.opportunisticTaker.marketableBuyMinNotionalUsdc') IS NULL
             THEN 1
           ELSE json_extract(execution_policy_json, '$.opportunisticTaker.marketableBuyMinNotionalUsdc')
         END
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _taker_guard_config_targets);

UPDATE profile_settings
   SET fallback_min_order_usdc_relayer = COALESCE(fallback_min_order_usdc_relayer, 1),
       fallback_min_order_usdc_eoa = COALESCE(fallback_min_order_usdc_eoa, 3),
       updated_at = datetime('now')
 WHERE fallback_min_order_usdc_relayer IS NULL
    OR fallback_min_order_usdc_eoa IS NULL;

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _taker_guard_config_targets);

DROP TABLE _taker_guard_config_targets;
