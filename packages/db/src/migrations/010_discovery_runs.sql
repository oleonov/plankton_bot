-- 010_discovery_runs.sql
-- Persisted job queue for discovery scans.

CREATE TABLE IF NOT EXISTS discovery_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  requested_by    TEXT,
  requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  finished_at     TEXT,
  heartbeat_at    TEXT,
  stats_json      TEXT,
  error           TEXT,
  worker_id       TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_status ON discovery_runs(status);
