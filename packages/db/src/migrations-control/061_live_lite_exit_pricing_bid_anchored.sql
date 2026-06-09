-- Track P F1 — re-assert bid-anchored SELL exit pricing on live-lite.
--
-- Migration 048 flipped exitPricingMode to 'bid-anchored', but the live-lite
-- profile later drifted back to 'midpoint-anchored' via an operator edit, so the
-- R58 fix is not active in production. Re-assert it explicitly for live-lite only
-- (same re-assertion pattern as migration 060). On wide one-sided longshot books
-- midpoint-anchored quotes near the phantom ask (10-50x avg_entry) and never
-- fills; bid-anchored rests the exit on the liquid bid side.
--
-- Idempotent: the WHERE clause targets live-lite only when it is not already
-- bid-anchored, so a re-run is a no-op and does not bump the policy version.

CREATE TEMP TABLE _f1_live_lite_bid_anchored_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _f1_live_lite_bid_anchored_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE profile_id = 'live-lite'
  AND execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND COALESCE(json_extract(execution_policy_json, '$.exitPricingMode'), '') != 'bid-anchored';

UPDATE profile_settings
   SET execution_policy_json = json_set(
         execution_policy_json,
         '$.exitPricingMode',
         'bid-anchored'
       ),
       updated_at = datetime('now')
 WHERE profile_id IN (SELECT profile_id FROM _f1_live_lite_bid_anchored_targets);

UPDATE runtime_control_state
   SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
       updated_at = datetime('now')
 WHERE id = 1
   AND EXISTS (SELECT 1 FROM _f1_live_lite_bid_anchored_targets);

DROP TABLE _f1_live_lite_bid_anchored_targets;
