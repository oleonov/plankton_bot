-- ADR-015 observability: write one row per BUY/SELL signal that reaches
-- execution-term resolution so SQL + dashboard can compare edge vs
-- bounded-midpoint pricing and dead-side buckets over 24-72h windows.
--
-- Runbook: docs/runbooks/execution_policy_db_rollout.md §Observability Tasks.
-- Keep this as an append-only table; no UPDATE paths. Profile is denormalized
-- on each row because ledger.db is already per-profile but cross-profile
-- aggregation queries are simpler with the column present.

CREATE TABLE IF NOT EXISTS execution_policy_observations (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id               TEXT NOT NULL,
  signal_id                TEXT,
  client_order_id          TEXT,
  token_id                 TEXT NOT NULL,
  market_slug              TEXT,
  side                     TEXT NOT NULL,
  signal_reason            TEXT,
  selected_pricing_mode    TEXT NOT NULL,
  selected_price           REAL,
  edge_price               REAL,
  bounded_price            REAL,
  bounded_outcome          TEXT NOT NULL,
  spread_ticks             REAL,
  improvement_ticks        REAL,
  dead_side_observed       INTEGER NOT NULL DEFAULT 0,
  dead_side_bucket         TEXT,
  dead_side_enforce_hit    INTEGER NOT NULL DEFAULT 0,
  dead_side_x60            INTEGER NOT NULL DEFAULT 0,
  dead_side_x120           INTEGER NOT NULL DEFAULT 0,
  dead_side_x300           INTEGER NOT NULL DEFAULT 0,
  dead_side_x900           INTEGER NOT NULL DEFAULT 0,
  time_to_end_ms           INTEGER,
  skipped_reason           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_execution_policy_observations_profile_ts
  ON execution_policy_observations(profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_policy_observations_token_ts
  ON execution_policy_observations(token_id, created_at DESC);
