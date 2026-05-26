-- Track B strike-aware rollout: raw Gamma strike signals for classifyMarketRegime.
-- group_item_* are collected/persisted for a future Track C; the Track B
-- classifier ignores them (F6, spec §3.6). tags is stored as a JSON array of
-- strings in TEXT (matches the project's other array-in-TEXT columns).
SELECT safe_add_column('markets', 'group_item_title', 'TEXT');
SELECT safe_add_column('markets', 'group_item_threshold', 'TEXT');
SELECT safe_add_column('markets', 'tags_json', 'TEXT');
