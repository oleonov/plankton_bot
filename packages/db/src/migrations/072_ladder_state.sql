CREATE TABLE IF NOT EXISTS ladder_state (
  token_id TEXT NOT NULL PRIMARY KEY,
  condition_id TEXT NOT NULL,
  ladder_id TEXT NOT NULL,
  band TEXT NOT NULL CHECK (band IN ('cheap', 'medium_low', 'medium_high', 'expensive')),
  phase INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'rebuilding', 'handoff_to_qd', 'closed', 'cancelled', 'orphan_recovered')
  ),
  active_rungs_json TEXT NOT NULL,
  filled_rungs_json TEXT NOT NULL DEFAULT '[]',
  last_avg_entry REAL NOT NULL,
  last_cost_basis_usdc REAL NOT NULL,
  last_mode TEXT NOT NULL CHECK (last_mode IN ('up', 'flat', 'avg_down')),
  last_bbo_reference_json TEXT,
  last_rebuild_at_ms BIGINT,
  last_fill_at_ms BIGINT,
  stale_checked_at_ms BIGINT,
  qd_handoff_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ladder_state_status
  ON ladder_state(status);

CREATE INDEX IF NOT EXISTS idx_ladder_state_band_status
  ON ladder_state(band, status);

CREATE INDEX IF NOT EXISTS idx_ladder_state_updated
  ON ladder_state(updated_at_ms DESC);
