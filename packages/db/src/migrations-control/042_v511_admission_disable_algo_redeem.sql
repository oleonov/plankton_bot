-- v5.13 / R37 live safety:
--   1. Disable legacy v2.3 prefix admission rules. Runtime hard filters now
--      own market admission; exact slug rules remain available for manual ops.
--   2. Remove unvalidated algo-REDEEM rules. Resolution/reconciliation redeem
--      paths remain active and are not stored in algo_decision_rules.
--   3. Convert D6 to HOLD for the $50 live test (DB-visible suppression).
--   4. Backfill DB-backed v5.11 market-selection policy defaults.

UPDATE selection_rules
SET enabled = 0,
    note = CASE
      WHEN note IS NULL OR note = ''
        THEN 'disabled by migration 042 (v5.13 hard-filter admission)'
      ELSE note || '; disabled by migration 042 (v5.13 hard-filter admission)'
    END,
    updated_at = datetime('now')
WHERE rule_type IN ('include_prefix', 'exclude_prefix')
  AND enabled = 1;

UPDATE runtime_control_state
SET selection_rules_version = selection_rules_version + 1,
    updated_at = datetime('now')
WHERE id = 1;

DELETE FROM algo_decision_rules
WHERE action = 'REDEEM'
  AND rule_id = 'REDEEM'
  AND state_condition IN ('S1', 'S2')
  AND price_operator = '<'
  AND price_value = 0.05
  AND hold_duration_operator = '<='
  AND hold_duration_seconds = 3600;

UPDATE algo_decision_rules
SET action = 'HOLD'
WHERE rule_id = 'D6'
  AND state_condition = 'S2'
  AND buy_count_min >= 4
  AND action = 'BUY';

CREATE TEMP TABLE _v511_policy_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _v511_policy_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND json_extract(execution_policy_json, '$.marketSelection') IS NULL;

UPDATE profile_settings
SET execution_policy_json = json_set(
      execution_policy_json,
      '$.marketSelection',
      json('{"maxMidPrice":0.5,"minLiquidity":100}')
    ),
    updated_at = datetime('now')
WHERE profile_id IN (SELECT profile_id FROM _v511_policy_targets);

UPDATE runtime_control_state
SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
    updated_at = datetime('now')
WHERE id = 1
  AND EXISTS (SELECT 1 FROM _v511_policy_targets);

DROP TABLE _v511_policy_targets;
