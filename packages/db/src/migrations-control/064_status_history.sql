-- Status screen history — bounded, auto-pruned per-day rollup of system health.
-- One row per (series, UTC day). Worst-severity-of-day is monotonic via sev_rank;
-- down/crit/known seconds accumulate so the Status screen can render a real
-- uptime % and per-day outage-duration tooltips. Written by the API-side
-- StatusHistorySampler (so a runtime outage is recorded as crit, not a gap) and
-- pruned to a rolling ~45-day window. Lives in control.db because system health
-- is profile-independent, while the ledger DB rotates per profile.
CREATE TABLE IF NOT EXISTS status_history (
  series     TEXT    NOT NULL,
  bucket_ts  INTEGER NOT NULL,
  sev_rank   INTEGER NOT NULL DEFAULT 0,
  sev        TEXT    NOT NULL DEFAULT 'ok',
  down_secs  INTEGER NOT NULL DEFAULT 0,
  crit_secs  INTEGER NOT NULL DEFAULT 0,
  known_secs INTEGER NOT NULL DEFAULT 0,
  value      REAL,
  detail     TEXT,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (series, bucket_ts)
);
CREATE INDEX IF NOT EXISTS idx_status_history_bucket ON status_history (bucket_ts);
