-- BUY-side throughput light raise.
-- Preserve operator edits, but move profiles still on the old default 15-slot
-- BUY cap to the new 25-slot default. Per-token BUY cap remains unchanged.

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.buyCapacity.maxOpenBuyOrders',
         25,
         '$.buyCapacity.maxOpenBuyOrdersPerToken',
         COALESCE(json_extract(execution_policy_json, '$.buyCapacity.maxOpenBuyOrdersPerToken'), 2)
       ),
       updated_at = datetime('now')
 WHERE execution_policy_json IS NOT NULL
   AND json_valid(execution_policy_json) = 1
   AND json_extract(execution_policy_json, '$.buyCapacity') IS NOT NULL
   AND json_extract(execution_policy_json, '$.buyCapacity.maxOpenBuyOrders') = 15;

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1
 WHERE changes() > 0;
