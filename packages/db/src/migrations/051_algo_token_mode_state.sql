CREATE TABLE IF NOT EXISTS algo_token_mode_state (
  token_id                 TEXT PRIMARY KEY,
  condition_id             TEXT NOT NULL,
  outcome_index            INTEGER,
  mode                     TEXT NOT NULL CHECK (mode IN ('PASSIVE', 'MIDDLE', 'BURST')),
  mode_confidence          TEXT NOT NULL CHECK (mode_confidence IN ('low', 'medium', 'high')),
  mode_status              TEXT NOT NULL CHECK (mode_status IN ('candidate', 'confirmed')),
  mode_since               TEXT NOT NULL,
  mode_assessed_at         TEXT NOT NULL,
  ttl_stage                INTEGER NOT NULL DEFAULT 0,
  last_fill_at             TEXT,
  last_order_at            TEXT,
  last_stale_cancel_at     TEXT,
  fill_count_window        INTEGER NOT NULL DEFAULT 0,
  order_count_window       INTEGER NOT NULL DEFAULT 0,
  first_fill_latency_ms    INTEGER,
  median_gap_ms            INTEGER,
  p75_gap_ms               INTEGER,
  span_ms                  INTEGER,
  last_fill_timestamps_json TEXT,
  transition_count_day     INTEGER NOT NULL DEFAULT 0,
  transition_day           TEXT,
  reset_reason             TEXT,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_algo_token_mode_state_condition
  ON algo_token_mode_state(condition_id);

CREATE INDEX IF NOT EXISTS idx_algo_token_mode_state_mode
  ON algo_token_mode_state(mode, mode_confidence);

CREATE INDEX IF NOT EXISTS idx_algo_token_mode_state_updated
  ON algo_token_mode_state(updated_at);
