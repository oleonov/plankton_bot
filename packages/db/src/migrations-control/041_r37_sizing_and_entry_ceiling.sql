-- R37 pre-$50 live-test calibration:
-- 1) replace algo_size_rules.size_usdc with R37 Task 3 observed medians;
-- 2) tighten DB-backed BUY entry ceiling from 0.75 to 0.45.

UPDATE algo_size_rules
SET size_usdc = CASE rule_id
  WHEN 'B1' THEN 8.41
  WHEN 'B2' THEN 4.29
  WHEN 'B3' THEN 0.88
  WHEN 'B4' THEN 0.14
  WHEN 'B5' THEN 0.99
  WHEN 'B6' THEN 1.04
  WHEN 'B7' THEN 3.85
  WHEN 'FALLBACK' THEN 2.73
  ELSE size_usdc
END
WHERE action_type = 'BUY'
  AND rule_id IN ('B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'FALLBACK');

UPDATE algo_size_rules
SET size_usdc = CASE rule_id
  WHEN 'S1' THEN 5.81
  WHEN 'S2' THEN 5.73
  WHEN 'S3' THEN 5.00
  WHEN 'S4' THEN 1.05
  WHEN 'S5' THEN 0.71
  WHEN 'S6' THEN 1.54
  WHEN 'S7' THEN 2.33
  WHEN 'FALLBACK' THEN 2.63
  ELSE size_usdc
END
WHERE action_type = 'SELL'
  AND rule_id IN ('S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'FALLBACK');

CREATE TEMP TABLE _r37_policy_targets(profile_id TEXT PRIMARY KEY);

INSERT INTO _r37_policy_targets(profile_id)
SELECT profile_id
FROM profile_settings
WHERE execution_policy_json IS NOT NULL
  AND json_valid(execution_policy_json) = 1
  AND COALESCE(json_extract(execution_policy_json, '$.entryPriceCeiling'), -1) != 0.45;

UPDATE profile_settings
SET execution_policy_json = json_set(execution_policy_json, '$.entryPriceCeiling', 0.45),
    updated_at = datetime('now')
WHERE profile_id IN (SELECT profile_id FROM _r37_policy_targets);

UPDATE runtime_control_state
SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1,
    updated_at = datetime('now')
WHERE id = 1
  AND EXISTS (SELECT 1 FROM _r37_policy_targets);

DROP TABLE _r37_policy_targets;
