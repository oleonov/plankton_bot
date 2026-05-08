UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.buyCapacity',
         json('{"enabled":true,"minNewEntryWalletHeadroomUsdc":7,"minAddWalletHeadroomUsdc":5,"maxOpenBuyOrders":2}')
       ),
       updated_at = datetime('now')
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.buyCapacity') IS NULL;

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1
 WHERE EXISTS (
   SELECT 1
     FROM profile_settings
    WHERE execution_policy_json IS NOT NULL
      AND json_valid(execution_policy_json) = 1
      AND json_extract(execution_policy_json, '$.buyCapacity.enabled') IS NOT NULL
 );
