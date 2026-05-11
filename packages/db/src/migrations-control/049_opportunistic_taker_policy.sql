-- R51-rerun SELL/placement calibration.
-- Adds tight-spread opportunistic taker pricing and moves bid-anchored SELL
-- anchor from engineering-judgment 3 ticks to the observed R51 median 4 ticks.
-- If an opportunisticTaker object already exists, treat its fields as operator
-- intent and only fill missing fields; this is a first-run normalization, not a
-- recurring policy override.

CREATE TEMP TABLE _r51_opportunistic_taker_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _r51_opportunistic_taker_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND (
    COALESCE(json_extract(execution_policy_json, '$.exitBidAnchorTicks'), -1) != 4
    OR json_type(execution_policy_json, '$.opportunisticTaker') IS NULL
    OR json_type(execution_policy_json, '$.opportunisticTaker.enabled') IS NULL
    OR json_type(execution_policy_json, '$.opportunisticTaker.maxSpreadTicks') IS NULL
    OR json_type(execution_policy_json, '$.opportunisticTaker.sides') IS NULL
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
         '$.exitBidAnchorTicks',
         4,
         '$.opportunisticTaker.enabled',
         CASE
           WHEN json_type(execution_policy_json, '$.opportunisticTaker.enabled') = 'false'
             THEN json('false')
           ELSE json('true')
         END,
         '$.opportunisticTaker.maxSpreadTicks',
         CASE
           WHEN json_type(execution_policy_json, '$.opportunisticTaker.maxSpreadTicks') IS NULL
             THEN 2
           ELSE json_extract(execution_policy_json, '$.opportunisticTaker.maxSpreadTicks')
         END,
         '$.opportunisticTaker.sides',
         CASE
           WHEN json_type(execution_policy_json, '$.opportunisticTaker.sides') = 'array'
             THEN json(json_extract(execution_policy_json, '$.opportunisticTaker.sides'))
           ELSE json('["buy","sell"]')
         END
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _r51_opportunistic_taker_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _r51_opportunistic_taker_targets);

DROP TABLE _r51_opportunistic_taker_targets;
