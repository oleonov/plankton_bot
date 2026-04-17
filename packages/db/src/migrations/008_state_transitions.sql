-- 008_state_transitions.sql
-- State transition audit log. Discovery tables from the original 008 migration
-- were removed in 034; only the state_transitions table remains.

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
