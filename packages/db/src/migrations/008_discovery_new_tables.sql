-- 008_discovery_new_tables.sql
-- New tables for family discovery and promotion system.

-- ═══════════ FAMILY CANDIDATES ═══════════

CREATE TABLE IF NOT EXISTS family_candidates (
  candidate_id          TEXT PRIMARY KEY,
  family_key            TEXT NOT NULL,
  regime                TEXT NOT NULL,
  horizon               TEXT NOT NULL,
  cadence               TEXT NOT NULL DEFAULT 'ad-hoc',
  pattern_confidence    TEXT NOT NULL DEFAULT 'low',
  primary_category      TEXT NOT NULL DEFAULT 'other',
  strategy_profile      TEXT NOT NULL DEFAULT 'scalp',
  slug_pattern          TEXT,
  matched_family_id     TEXT,
  active_market_count   INTEGER NOT NULL DEFAULT 0,
  nearest_end_date      TEXT,
  cluster_volume_24h    REAL NOT NULL DEFAULT 0,
  recurrence_score      REAL,
  recycle_score         REAL,
  live_viability_score  REAL,
  toxicity_penalty      REAL,
  gate_recommendation   TEXT NOT NULL DEFAULT 'ignore',
  recommendation_reason TEXT,
  scores_updated_at     TEXT,
  status                TEXT NOT NULL DEFAULT 'discovered',
  first_seen_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at          TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at           TEXT,
  materialized_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidates_status ON family_candidates(status);
CREATE INDEX IF NOT EXISTS idx_candidates_recommendation ON family_candidates(gate_recommendation);

-- ═══════════ CANDIDATE OBSERVATIONS ═══════════

CREATE TABLE IF NOT EXISTS candidate_observations (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id          TEXT NOT NULL REFERENCES family_candidates(candidate_id),
  active_market_count   INTEGER NOT NULL,
  cluster_volume_24h    REAL NOT NULL,
  nearest_end_date      TEXT,
  observed_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_candidate_obs_id_ts
  ON candidate_observations(candidate_id, observed_at DESC);

-- ═══════════ CANDIDATE OBSERVATION MARKETS ═══════════

CREATE TABLE IF NOT EXISTS candidate_observation_markets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id    TEXT NOT NULL REFERENCES family_candidates(candidate_id),
  observed_at     TEXT NOT NULL,
  condition_id    TEXT NOT NULL,
  slug            TEXT NOT NULL,
  end_date        TEXT,
  volume_24h      REAL,
  UNIQUE(candidate_id, observed_at, condition_id)
);

CREATE INDEX IF NOT EXISTS idx_com_candidate_ts
  ON candidate_observation_markets(candidate_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_com_slug
  ON candidate_observation_markets(slug);

-- ═══════════ PROMOTION PROPOSALS ═══════════

CREATE TABLE IF NOT EXISTS promotion_proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id       TEXT NOT NULL,
  current_state   TEXT NOT NULL,
  proposed_state  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  scores_snapshot TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT,
  resolved_by     TEXT,
  applied_command_id INTEGER REFERENCES operator_commands(id)
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON promotion_proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_family ON promotion_proposals(family_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_one_pending_per_family
  ON promotion_proposals(family_id) WHERE status = 'pending';

-- ═══════════ STATE TRANSITIONS ═══════════

CREATE TABLE IF NOT EXISTS state_transitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  from_state      TEXT NOT NULL,
  to_state        TEXT NOT NULL,
  trigger_type    TEXT NOT NULL,
  initiator       TEXT,
  reason          TEXT NOT NULL,
  scores_snapshot TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_state_transitions_entity
  ON state_transitions(entity_type, entity_id, created_at DESC);
