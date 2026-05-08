-- R47/Risk-gate capacity widening.
-- Moves the live small-wallet caps from "2 open BUYs only" to DB-backed
-- BUY/SELL/total/per-token limits that can hot-reload through execution_policy_json.

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.buyCapacity',
         json('{"enabled":true,"minNewEntryWalletHeadroomUsdc":7,"minAddWalletHeadroomUsdc":5,"maxOpenBuyOrders":15,"maxOpenBuyOrdersPerToken":2}')
       ),
       updated_at = datetime('now')
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.buyCapacity') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.buyCapacity.maxOpenBuyOrdersPerToken',
         COALESCE(json_extract(execution_policy_json, '$.buyCapacity.maxOpenBuyOrdersPerToken'), 2)
       ),
       updated_at = datetime('now')
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.buyCapacity') IS NOT NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.buyCapacity.maxOpenBuyOrders',
         15
       ),
       updated_at = datetime('now')
 WHERE profile_id = 'live-lite'
   AND execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.buyCapacity') IS NOT NULL
   AND COALESCE(json_extract(execution_policy_json, '$.buyCapacity.maxOpenBuyOrders'), 2) = 2;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.sellCapacity',
         json('{"enabled":true,"maxOpenSellOrders":10,"maxOpenSellOrdersPerToken":2}')
       ),
       updated_at = datetime('now')
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.sellCapacity') IS NULL;

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.orderCapacity',
         json('{"enabled":true,"maxOpenOrdersTotal":22}')
       ),
       updated_at = datetime('now')
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.orderCapacity') IS NULL;

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1;
