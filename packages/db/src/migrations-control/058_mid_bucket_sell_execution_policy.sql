-- Mid-bucket SELL execution rewrite.
--
-- Live-lite policy migration only:
-- - Add sellReplaceMinPriceDeltaTicks default 2 when absent.
-- - Move opportunistic taker to BUY-only.
-- - Move legacy 5m exitOrderTtlMs to 30m, while preserving operator overrides.

CREATE TEMP TABLE _mid_bucket_sell_policy_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _mid_bucket_sell_policy_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE profile_id = 'live-lite'
  AND execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND (
    json_type(execution_policy_json, '$.sellReplaceMinPriceDeltaTicks') IS NULL
    OR json_type(execution_policy_json, '$.exitOrderTtlMs') IS NULL
    OR json_extract(execution_policy_json, '$.exitOrderTtlMs') = 300000
    OR json_type(execution_policy_json, '$.opportunisticTaker') IS NOT 'object'
    OR json_type(execution_policy_json, '$.opportunisticTaker.sides') IS NOT 'array'
    OR json_array_length(execution_policy_json, '$.opportunisticTaker.sides') != 1
    OR json_extract(execution_policy_json, '$.opportunisticTaker.sides[0]') IS NOT 'buy'
  );

UPDATE profile_settings
   SET execution_policy_json = json_set(
         CASE
           WHEN json_type(execution_policy_json, '$.opportunisticTaker') = 'object'
             THEN execution_policy_json
           ELSE json_set(
             execution_policy_json,
             '$.opportunisticTaker',
             json('{"enabled":true,"maxSpreadTicks":2,"sides":["buy"],"safetyBuffer":1.05,"fallbackMinNotionalUsdc":1,"marketableBuyMinNotionalUsdc":1}')
           )
         END,
         '$.sellReplaceMinPriceDeltaTicks',
         CASE
           WHEN json_type(execution_policy_json, '$.sellReplaceMinPriceDeltaTicks') IS NULL
             THEN 2
           ELSE json_extract(execution_policy_json, '$.sellReplaceMinPriceDeltaTicks')
         END,
         '$.exitOrderTtlMs',
         CASE
           WHEN json_type(execution_policy_json, '$.exitOrderTtlMs') IS NULL
             OR json_extract(execution_policy_json, '$.exitOrderTtlMs') = 300000
             THEN 1800000
           ELSE json_extract(execution_policy_json, '$.exitOrderTtlMs')
         END,
         '$.opportunisticTaker.sides',
         json('["buy"]')
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _mid_bucket_sell_policy_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _mid_bucket_sell_policy_targets);

DROP TABLE _mid_bucket_sell_policy_targets;
