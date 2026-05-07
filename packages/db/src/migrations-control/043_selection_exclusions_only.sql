-- v5.13 operator-surface cleanup:
-- Market admission is hard-filter driven. The selection_rules table remains
-- only as a manual exact-slug deny-list.

CREATE TEMP TABLE _legacy_selection_rules AS
SELECT COUNT(*) AS c
FROM selection_rules
WHERE rule_type <> 'exclude_slug';

DELETE FROM selection_rules
WHERE rule_type <> 'exclude_slug';

UPDATE runtime_control_state
SET selection_rules_version = selection_rules_version + 1,
    updated_at = datetime('now')
WHERE id = 1
  AND (SELECT c FROM _legacy_selection_rules) > 0;

DROP TABLE _legacy_selection_rules;
