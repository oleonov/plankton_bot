CREATE TABLE IF NOT EXISTS family_rule_defaults (
  scope                               TEXT PRIMARY KEY CHECK (scope = 'global'),
  min_entry_price                     REAL NOT NULL,
  max_entry_price                     REAL NOT NULL,
  high_price_threshold                REAL NOT NULL,
  require_proven_family_above_price   REAL NOT NULL,
  preferred_entry_band                TEXT,
  updated_at                          TEXT NOT NULL
);
