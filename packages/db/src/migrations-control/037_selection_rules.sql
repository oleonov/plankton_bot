CREATE TABLE IF NOT EXISTS selection_rules (
  rule_id      TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  rule_type    TEXT NOT NULL CHECK (rule_type IN
                 ('include_prefix','exclude_prefix','include_slug','exclude_slug')),
  pattern      TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 256),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile_id, rule_type, pattern)
);

CREATE INDEX IF NOT EXISTS idx_selection_rules_profile_enabled
  ON selection_rules(profile_id, enabled);

-- Version column drives engine cache invalidation. Bump on any write.
ALTER TABLE runtime_control_state ADD COLUMN selection_rules_version INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1);

-- Seed 06-spec prefixes for every known profile.
INSERT OR IGNORE INTO selection_rules (rule_id, profile_id, rule_type, pattern, note)
SELECT lower(hex(randomblob(16))), profile_id, 'include_prefix', 'elon-musk-',
       'seeded by migration 037 (06-spec)'
FROM profiles;
INSERT OR IGNORE INTO selection_rules (rule_id, profile_id, rule_type, pattern, note)
SELECT lower(hex(randomblob(16))), profile_id, 'include_prefix', 'bitcoin-',
       'seeded by migration 037 (06-spec)'
FROM profiles;
INSERT OR IGNORE INTO selection_rules (rule_id, profile_id, rule_type, pattern, note)
SELECT lower(hex(randomblob(16))), profile_id, 'include_prefix', 'ethereum-',
       'seeded by migration 037 (06-spec)'
FROM profiles;

UPDATE runtime_control_state SET selection_rules_version = 1 WHERE id = 1;
