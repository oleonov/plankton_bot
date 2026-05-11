-- control.sql
-- Complete DDL for control.db — shared across profiles.
-- Reconstructed from legacy migrations 001-011 + profile switching spec additions.

PRAGMA foreign_keys = ON;

-- ═══════════ PROFILES ═══════════

CREATE TABLE IF NOT EXISTS profiles (
  profile_id    TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profile_settings (
  profile_id             TEXT PRIMARY KEY REFERENCES profiles(profile_id),
  initial_balance_usdc   REAL,
  envelope_json          TEXT,
  risk_caps_json         TEXT,
  wallet_mode            TEXT,
  min_order_usdc         REAL,
  fallback_min_order_usdc_relayer REAL,
  fallback_min_order_usdc_eoa     REAL,
  relayer_json           TEXT,
  execution_policy_json  TEXT,
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS profile_summaries (
  profile_id           TEXT PRIMARY KEY REFERENCES profiles(profile_id),
  paused               INTEGER NOT NULL DEFAULT 1,
  last_run_at          TEXT,
  open_orders          INTEGER NOT NULL DEFAULT 0,
  open_positions       INTEGER NOT NULL DEFAULT 0,
  total_exposure_usdc  REAL NOT NULL DEFAULT 0,
  balance_usdc         REAL,
  wallet_balance_usdc  REAL,
  last_preflight_status TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ RUNTIME CONTROL STATE ═══════════
-- Singleton row for current runtime state

CREATE TABLE IF NOT EXISTS runtime_control_state (
  id                       INTEGER PRIMARY KEY CHECK (id = 1),
  current_profile          TEXT REFERENCES profiles(profile_id),
  desired_profile          TEXT REFERENCES profiles(profile_id),
  current_switch_id        TEXT,
  current_run_id           TEXT,
  current_instance_id      TEXT,
  runtime_status           TEXT NOT NULL DEFAULT 'stopped',  -- stopped | starting | ready_paused | running | stopping | failed
  paused                   INTEGER NOT NULL DEFAULT 1,
  resume_intent_at         TEXT,             -- one-shot deploy resume intent (ISO timestamp, NULL = no intent)
  schema_version           INTEGER NOT NULL DEFAULT 1,
  selection_rules_version  INTEGER NOT NULL DEFAULT 0,
  execution_policy_version INTEGER NOT NULL DEFAULT 0,
  continuation_mode        TEXT NOT NULL DEFAULT 'leg_local'
    CHECK (continuation_mode IN ('leg_local', 'market_wide')),
  continuation_mode_version INTEGER NOT NULL DEFAULT 0,
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ OPERATOR COMMANDS ═══════════
-- From 001_initial.sql + 007 (initiator_type, initiator) + extended: scope, profile, command_group

CREATE TABLE IF NOT EXISTS operator_commands (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action          TEXT NOT NULL,
  target_id       TEXT,
  reason          TEXT,
  scope           TEXT NOT NULL DEFAULT 'global',
  profile         TEXT,
  command_group   TEXT,
  initiator_type  TEXT NOT NULL DEFAULT 'operator',
  initiator       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator_commands_status ON operator_commands(status);

-- ═══════════ OPERATOR ACTIONS (audit log) ═══════════
-- From 001_initial.sql + extended: profile

CREATE TABLE IF NOT EXISTS operator_actions (
  action_id     TEXT PRIMARY KEY,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  profile       TEXT,
  reason        TEXT,
  performed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_operator_actions_ts ON operator_actions(performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_actions_target ON operator_actions(target_id);

-- ═══════════ STATE TRANSITIONS ═══════════

CREATE TABLE IF NOT EXISTS state_transitions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  from_state      TEXT NOT NULL,
  to_state        TEXT NOT NULL,
  trigger_type    TEXT NOT NULL,
  initiator       TEXT,
  profile         TEXT,
  deployment_id   TEXT,
  reason          TEXT NOT NULL,
  scores_snapshot TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_state_transitions_entity
  ON state_transitions(entity_type, entity_id, created_at DESC);

-- ═══════════ SERVICE HEARTBEATS ═══════════

CREATE TABLE IF NOT EXISTS service_heartbeats (
  service_name      TEXT NOT NULL,
  instance_id       TEXT NOT NULL,
  profile           TEXT,
  run_id            TEXT,
  last_heartbeat_at TEXT NOT NULL,
  status_json       TEXT,
  PRIMARY KEY (service_name, instance_id)
);

-- ═══════════ CONFIG IMPORTS ═══════════

CREATE TABLE IF NOT EXISTS config_imports (
  import_id          TEXT PRIMARY KEY,
  source_path        TEXT,
  source_checksum    TEXT NOT NULL,
  source_version     INTEGER,
  families_added     INTEGER NOT NULL DEFAULT 0,
  families_updated   INTEGER NOT NULL DEFAULT 0,
  families_skipped   INTEGER NOT NULL DEFAULT 0,
  families_unchanged INTEGER NOT NULL DEFAULT 0,
  result_json        TEXT,
  imported_at        TEXT NOT NULL DEFAULT (datetime('now')),
  imported_by        TEXT
);

-- ═══════════ PROFILE SWITCH REQUESTS ═══════════

CREATE TABLE IF NOT EXISTS profile_switch_requests (
  switch_id          TEXT PRIMARY KEY,
  from_profile       TEXT NOT NULL REFERENCES profiles(profile_id),
  to_profile         TEXT NOT NULL REFERENCES profiles(profile_id),
  ledger_reset_policy TEXT NOT NULL DEFAULT 'preserve',
  deploy_plan_json   TEXT,
  state              TEXT NOT NULL DEFAULT 'requested',
  error_message      TEXT,
  archive_path       TEXT,
  requested_by       TEXT,
  requested_at       TEXT NOT NULL DEFAULT (datetime('now')),
  started_at         TEXT,
  completed_at       TEXT
);

-- ═══════════ PREFLIGHT REPORTS ═══════════

CREATE TABLE IF NOT EXISTS preflight_reports (
  report_id         TEXT PRIMARY KEY,
  switch_request_id TEXT REFERENCES profile_switch_requests(switch_id),
  profile           TEXT NOT NULL REFERENCES profiles(profile_id),
  kind              TEXT NOT NULL,
  status            TEXT NOT NULL,
  blockers_json     TEXT,
  warnings_json     TEXT,
  info_json         TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ SELECTION RULES ═══════════
-- Per-profile market admission rules (06-spec §0 Market Selection Layer).

CREATE TABLE IF NOT EXISTS selection_rules (
  rule_id      TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,
  rule_type    TEXT NOT NULL CHECK (rule_type IN
                 ('include_prefix','exclude_prefix','include_slug','exclude_slug')),
  pattern      TEXT NOT NULL CHECK (length(pattern) BETWEEN 1 AND 256),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(profile_id, rule_type, pattern)
);

CREATE INDEX IF NOT EXISTS idx_selection_rules_profile_enabled
  ON selection_rules(profile_id, enabled);

-- ═══════════ ALGO DECISION ENGINE ═══════════

CREATE TABLE IF NOT EXISTS algo_decision_rules (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  priority                INTEGER NOT NULL,
  rule_id                 TEXT NOT NULL,
  state_condition         TEXT NOT NULL,
  price_operator          TEXT,
  price_value             REAL,
  time_since_last_operator TEXT,
  time_since_last_seconds INTEGER,
  buy_count_min           INTEGER,
  buy_count_max           INTEGER,
  hold_duration_operator  TEXT,
  hold_duration_seconds   INTEGER,
  action                  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS algo_size_rules (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type             TEXT NOT NULL,
  priority                INTEGER NOT NULL,
  rule_id                 TEXT NOT NULL,
  state_condition         TEXT NOT NULL,
  price_operator          TEXT,
  price_value             REAL,
  nth_buy                 INTEGER,
  buy_count_min           INTEGER,
  buy_count_max           INTEGER,
  size_usdc               REAL NOT NULL
);
