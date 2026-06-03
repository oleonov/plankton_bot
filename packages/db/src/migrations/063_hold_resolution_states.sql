CREATE TABLE IF NOT EXISTS hold_resolution_states (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,
  condition_id TEXT,
  position_id TEXT,
  source_order_id TEXT,
  source_signal_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'resolved_zero_loss', 'recovered', 'cancelled', 'superseded')
  ),
  marker_created_at TEXT NOT NULL,
  expected_resolution_at TEXT,
  attempt_count_for_redeem INTEGER NOT NULL DEFAULT 0,
  exit_pnl_pct REAL,
  stale_reason TEXT NOT NULL,
  liveness_verdict TEXT NOT NULL,
  redeem_quarantine_observed_at TEXT,
  alert_emitted_at TEXT,
  cleared_at TEXT,
  clear_reason TEXT,
  metadata_json TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hold_resolution_active_token
  ON hold_resolution_states(token_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_hold_resolution_status_marker_created
  ON hold_resolution_states(status, marker_created_at);

CREATE INDEX IF NOT EXISTS idx_hold_resolution_token_status
  ON hold_resolution_states(token_id, status);

CREATE INDEX IF NOT EXISTS idx_hold_resolution_condition_status
  ON hold_resolution_states(condition_id, status);

CREATE INDEX IF NOT EXISTS idx_hold_resolution_expected_resolution
  ON hold_resolution_states(expected_resolution_at);
