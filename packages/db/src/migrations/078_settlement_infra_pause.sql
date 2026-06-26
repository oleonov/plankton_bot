-- Durable settlement-infra hard-pause window.
--
-- The SettlementInfraBreaker (Polygon RPC rate-limit / relayer outage guard) was
-- in-memory only: a restart cleared `disabledUntilMs` to 0, so the startup redeem
-- sweep fired against a still-rate-limited relayer and re-tripped the 429 hard
-- pause immediately. This single-row table persists the open window so a restart
-- re-arms the pause until the upstream quota actually resets.
CREATE TABLE IF NOT EXISTS settlement_infra_pause (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  disabled_until_ms INTEGER NOT NULL,
  code TEXT NULL,
  updated_at TEXT NOT NULL
);
