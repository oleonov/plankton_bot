CREATE TABLE IF NOT EXISTS execution_profile_state (
  token_id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  profile TEXT NOT NULL CHECK (profile IN ('cheap', 'medium', 'expensive')),
  state TEXT NOT NULL CHECK (
    state IN ('SCANNING', 'PROBING', 'ACCUMULATING', 'EXITING', 'QD_HANDOFF', 'ABANDONED', 'CLOSED')
  ),
  assumed_at TEXT NOT NULL,
  last_avg_entry REAL NOT NULL,
  last_transition_at TEXT NOT NULL,
  active_ladder_id TEXT NULL,
  handoff_started_at TEXT NULL,
  metadata_json TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_execution_profile_state_state
  ON execution_profile_state(state);

CREATE INDEX IF NOT EXISTS idx_execution_profile_state_profile
  ON execution_profile_state(profile);

CREATE INDEX IF NOT EXISTS idx_execution_profile_state_ladder
  ON execution_profile_state(active_ladder_id);
