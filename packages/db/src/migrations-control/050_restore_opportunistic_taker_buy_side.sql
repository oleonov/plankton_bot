-- Revert the emergency live-lite hot-config that temporarily limited
-- opportunistic taker to SELL while BUY taker fill accounting was fixed.
-- Preserve disabled/custom profiles unless they are exactly the hotfix shape.

CREATE TEMP TABLE _r60_restore_taker_buy_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _r60_restore_taker_buy_targets(profile_id)
SELECT profile_id
  FROM profile_settings
 WHERE json_type(execution_policy_json, '$.opportunisticTaker') = 'object'
   AND json_type(execution_policy_json, '$.opportunisticTaker.sides') = 'array'
   AND json_array_length(json_extract(execution_policy_json, '$.opportunisticTaker.sides')) = 1
   AND json_extract(execution_policy_json, '$.opportunisticTaker.sides[0]') = 'sell';

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.opportunisticTaker.sides',
         json_array('buy', 'sell')
       )
 WHERE profile_id IN (SELECT profile_id FROM _r60_restore_taker_buy_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _r60_restore_taker_buy_targets);

DROP TABLE _r60_restore_taker_buy_targets;
