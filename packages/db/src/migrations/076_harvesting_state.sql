CREATE TABLE execution_profile_state_v2 (
  token_id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('cheap', 'medium', 'expensive')),
  state TEXT NOT NULL CHECK (
    state IN (
      'SCANNING',
      'PROBING',
      'ACCUMULATING',
      'HARVESTING',
      'EXITING',
      'QD_HANDOFF',
      'ABANDONED',
      'ABANDONED_DORMANT',
      'CLOSED'
    )
  ),
  assumed_at TEXT NOT NULL,
  last_avg_entry REAL NOT NULL,
  last_transition_at TEXT NOT NULL,
  active_ladder_id TEXT NULL,
  handoff_started_at TEXT NULL,
  add_count INTEGER NOT NULL DEFAULT 0,
  last_buy_at_ms INTEGER NULL,
  initial_probe_size_usd REAL NULL,
  metadata_json TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO execution_profile_state_v2 (
  token_id,
  condition_id,
  profile,
  state,
  assumed_at,
  last_avg_entry,
  last_transition_at,
  active_ladder_id,
  handoff_started_at,
  add_count,
  last_buy_at_ms,
  initial_probe_size_usd,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  token_id,
  condition_id,
  profile,
  state,
  assumed_at,
  last_avg_entry,
  last_transition_at,
  active_ladder_id,
  handoff_started_at,
  add_count,
  last_buy_at_ms,
  initial_probe_size_usd,
  metadata_json,
  created_at,
  updated_at
FROM execution_profile_state;

DROP TABLE execution_profile_state;

ALTER TABLE execution_profile_state_v2 RENAME TO execution_profile_state;

CREATE INDEX IF NOT EXISTS idx_execution_profile_state_state
  ON execution_profile_state(state);

CREATE INDEX IF NOT EXISTS idx_execution_profile_state_profile
  ON execution_profile_state(profile);

CREATE INDEX IF NOT EXISTS idx_execution_profile_state_ladder
  ON execution_profile_state(active_ladder_id);
