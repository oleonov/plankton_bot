-- R58 self-referential SELL pricing fix.
-- Existing live profiles should place SELL exits from bestBid + N ticks rather
-- than their own visible bestAsk, and downprice churn is capped at 3 attempts.

CREATE TEMP TABLE _r58_bid_anchored_sell_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _r58_bid_anchored_sell_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND (
    COALESCE(json_extract(execution_policy_json, '$.exitPricingMode'), '') != 'bid-anchored'
    OR COALESCE(json_extract(execution_policy_json, '$.exitBidAnchorTicks'), -1) != 3
    OR json_type(execution_policy_json, '$.exitRepriceOnDownprice') IS NULL
    OR COALESCE(json_extract(execution_policy_json, '$.exitRepriceOnDownprice.maxRepricesPerOrder'), -1) != 3
  );

UPDATE profile_settings
   SET execution_policy_json = json_set(
         CASE
           WHEN json_type(execution_policy_json, '$.exitRepriceOnDownprice') = 'object'
             THEN execution_policy_json
           ELSE json_set(
             execution_policy_json,
             '$.exitRepriceOnDownprice',
             json('{"enabled":true,"thresholdTicks":5,"maxRepricesPerOrder":3,"stuckWarningEnabled":true,"stuckWarningAgeMs":14400000,"stuckWarningGapPct":0.1}')
           )
         END,
         '$.exitPricingMode',
         'bid-anchored',
         '$.exitBidAnchorTicks',
         3,
         '$.exitRepriceOnDownprice.maxRepricesPerOrder',
         3
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _r58_bid_anchored_sell_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _r58_bid_anchored_sell_targets);

DROP TABLE _r58_bid_anchored_sell_targets;
