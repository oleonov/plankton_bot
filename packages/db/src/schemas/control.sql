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
  profile_id           TEXT PRIMARY KEY REFERENCES profiles(profile_id),
  initial_balance_usdc REAL,
  envelope_json        TEXT,
  risk_caps_json       TEXT,
  wallet_mode          TEXT,
  min_order_usdc       REAL,
  relayer_json         TEXT,
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
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

-- ═══════════ FAMILY CATALOG (Identity) ═══════════
-- From 001_initial.sql + new columns: source_type, origin_checksum

CREATE TABLE IF NOT EXISTS family_catalog (
  family_id         TEXT PRIMARY KEY,
  family_key        TEXT NOT NULL,
  primary_category  TEXT NOT NULL,
  regime            TEXT NOT NULL,
  horizon           TEXT NOT NULL,
  cadence           TEXT NOT NULL,
  strategy_profile  TEXT NOT NULL,
  fee_tier          TEXT NOT NULL DEFAULT 'unknown',
  live_wallet_requirement TEXT NOT NULL DEFAULT 'relayer-required',
  requires_post_only_for_live INTEGER NOT NULL DEFAULT 1,
  source_type       TEXT NOT NULL DEFAULT 'yaml_import',
  origin_checksum   TEXT,
  topic_key         TEXT,
  slug_pattern      TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_family_catalog_key ON family_catalog(family_key);
CREATE INDEX IF NOT EXISTS idx_family_catalog_regime ON family_catalog(regime);

-- ═══════════ FAMILY RULES ═══════════
-- From 001_initial.sql — all 7 rule blocks, unchanged

CREATE TABLE IF NOT EXISTS family_rules (
  family_id                                TEXT PRIMARY KEY REFERENCES family_catalog(family_id),

  -- universe
  enabled                                  INTEGER NOT NULL DEFAULT 0,
  action                                   TEXT NOT NULL DEFAULT 'blocked',
  priority_rank                            INTEGER NOT NULL DEFAULT 999,
  session_mode                             TEXT NOT NULL DEFAULT 'active-window',

  -- entry
  entry_mode                               TEXT NOT NULL DEFAULT 'disabled',
  min_entry_price                          REAL NOT NULL DEFAULT 0,
  max_entry_price                          REAL NOT NULL DEFAULT 1,
  max_initial_notional_usdc                REAL NOT NULL DEFAULT 5,
  allow_high_price_one_shot                INTEGER NOT NULL DEFAULT 0,
  high_price_threshold                     REAL NOT NULL DEFAULT 0.20,
  require_proven_family_above_price        REAL NOT NULL DEFAULT 0.20,
  preferred_entry_band                     TEXT,
  max_probe_count_per_market               INTEGER,
  entry_cooldown_seconds                   INTEGER,
  max_new_markets_per_session              INTEGER,
  probe_size_usdc                          REAL NOT NULL DEFAULT 5,
  add_size_usdc                            REAL NOT NULL DEFAULT 4,

  -- scale_in
  scale_mode                               TEXT NOT NULL DEFAULT 'disabled',
  default_max_buys_per_leg                 INTEGER NOT NULL DEFAULT 3,
  heavy_max_buys_per_leg                   INTEGER NOT NULL DEFAULT 6,
  allow_heavy_campaigns                    INTEGER NOT NULL DEFAULT 0,
  require_positive_recycle_history_for_scale INTEGER NOT NULL DEFAULT 1,

  -- exit
  exit_mode                                TEXT NOT NULL DEFAULT 'disabled',
  primary_profit_model                     TEXT NOT NULL DEFAULT 'sell-into-strength',
  allow_runner_extension                   INTEGER NOT NULL DEFAULT 0,
  prefer_fast_recycle                      INTEGER NOT NULL DEFAULT 1,
  resolution_holding_allowed               INTEGER NOT NULL DEFAULT 0,
  resolution_buffer_minutes                INTEGER NOT NULL DEFAULT 60,
  target_roi_band_low                      REAL,
  target_roi_band_high                     REAL,
  max_unmoved_hold_hours                   REAL,
  max_tail_hold_hours                      REAL,

  -- two_sided
  allow_two_sided                          INTEGER NOT NULL DEFAULT 0,
  two_sided_mode                           TEXT NOT NULL DEFAULT 'disabled',
  min_activity_for_two_sided               INTEGER,

  -- throughput
  max_concurrent_orders_per_family         INTEGER,
  max_probe_in_flight_per_token            INTEGER,
  max_entry_signals_per_tick_per_family    INTEGER,
  fast_lane_enabled                        INTEGER,
  dust_lane_enabled                        INTEGER,
  queue_jump_canary_enabled                INTEGER,

  -- tail_suppression
  max_open_value_usdc                      REAL NOT NULL DEFAULT 50,
  max_active_markets                       INTEGER NOT NULL DEFAULT 100,
  max_dust_positions                       INTEGER NOT NULL DEFAULT 50,
  tail_quarantine_threshold_usdc           REAL NOT NULL DEFAULT 1000.0,
  tail_quarantine_threshold_ratio          REAL NOT NULL DEFAULT 1000.0,
  stale_tail_prune_enabled                 INTEGER NOT NULL DEFAULT 0,
  threshold_cleanup_required               INTEGER NOT NULL DEFAULT 0,
  auto_settle_resolved_markets             INTEGER NOT NULL DEFAULT 1,

  -- session
  active_windows_utc                       TEXT NOT NULL DEFAULT '[]',
  reduced_windows_utc                      TEXT NOT NULL DEFAULT '[]',
  weekday_bias                             TEXT NOT NULL DEFAULT 'normal',

  updated_at                               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS family_rule_defaults (
  scope                               TEXT PRIMARY KEY CHECK (scope = 'global'),
  min_entry_price                     REAL NOT NULL,
  max_entry_price                     REAL NOT NULL,
  high_price_threshold                REAL NOT NULL,
  require_proven_family_above_price   REAL NOT NULL,
  preferred_entry_band                TEXT,
  updated_at                          TEXT NOT NULL
);

-- ═══════════ FAMILY RULES SNAPSHOT (audit) ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS family_rules_snapshot (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id    TEXT NOT NULL REFERENCES family_catalog(family_id),
  snapshot     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_family_rules_snapshot_family
  ON family_rules_snapshot(family_id, captured_at DESC);

-- ═══════════ FAMILY DEPLOYMENTS ═══════════
-- New table: per (family, profile) deployment control

-- Post-Phase 6 shape: single enable/disable lever, no legacy governance columns.
CREATE TABLE IF NOT EXISTS family_deployments (
  family_id            TEXT NOT NULL REFERENCES family_catalog(family_id),
  profile              TEXT NOT NULL REFERENCES profiles(profile_id),
  enabled              INTEGER NOT NULL DEFAULT 0,
  disabled_at          TEXT,
  disabled_reason      TEXT,
  priority             INTEGER NOT NULL DEFAULT 999,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (family_id, profile)
);

CREATE INDEX IF NOT EXISTS idx_family_deployments_profile_enabled ON family_deployments(profile, enabled);

-- ═══════════ FAMILY VALIDATION SCORECARDS ═══════════
-- New table: score snapshots per (family, profile)

CREATE TABLE IF NOT EXISTS family_validation_scorecards (
  scorecard_id             TEXT PRIMARY KEY,
  family_id                TEXT NOT NULL REFERENCES family_catalog(family_id),
  profile                  TEXT NOT NULL REFERENCES profiles(profile_id),
  evidence_status          TEXT NOT NULL DEFAULT 'unknown',
  evidence_score           REAL NOT NULL DEFAULT 0,
  recurrence_score         REAL,
  recycle_score            REAL,
  live_viability_score     REAL,
  toxicity_penalty         REAL,
  trade_count              INTEGER NOT NULL DEFAULT 0,
  market_count             INTEGER NOT NULL DEFAULT 0,
  realized_pnl             REAL NOT NULL DEFAULT 0,
  tail_adjusted_pnl        REAL NOT NULL DEFAULT 0,
  both_sided_eligible      INTEGER NOT NULL DEFAULT 0,
  heavy_campaign_eligible  INTEGER NOT NULL DEFAULT 0,
  active_window_edge_score REAL,
  summary_json             TEXT,
  validated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (family_id, profile, validated_at)
);

-- ═══════════ FAMILY VALIDATION LATEST ═══════════
-- Materialized latest scorecard per (family, profile)

CREATE TABLE IF NOT EXISTS family_validation_latest (
  family_id    TEXT NOT NULL REFERENCES family_catalog(family_id),
  profile      TEXT NOT NULL REFERENCES profiles(profile_id),
  scorecard_id TEXT NOT NULL REFERENCES family_validation_scorecards(scorecard_id),
  PRIMARY KEY (family_id, profile)
);

-- ═══════════ FAMILY PROFILE ROLLUPS ═══════════
-- Lightweight runtime aggregates published by runtime

CREATE TABLE IF NOT EXISTS family_profile_rollups (
  family_id          TEXT NOT NULL REFERENCES family_catalog(family_id),
  profile            TEXT NOT NULL REFERENCES profiles(profile_id),
  open_value_usdc    REAL NOT NULL DEFAULT 0,
  open_positions     INTEGER NOT NULL DEFAULT 0,
  active_markets     INTEGER NOT NULL DEFAULT 0,
  realized_pnl       REAL NOT NULL DEFAULT 0,
  tail_cost_usdc     REAL NOT NULL DEFAULT 0,
  tail_adjusted_pnl  REAL NOT NULL DEFAULT 0,
  last_trade_at      TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (family_id, profile)
);

-- ═══════════ FAMILY CONFIG META ═══════════
-- Import/edit metadata per family

CREATE TABLE IF NOT EXISTS family_config_meta (
  family_id              TEXT PRIMARY KEY REFERENCES family_catalog(family_id),
  last_imported_at       TEXT,
  last_operator_edit_at  TEXT,
  import_checksum        TEXT
);

-- ═══════════ RUNTIME CONTROL STATE ═══════════
-- Singleton row for current runtime state

CREATE TABLE IF NOT EXISTS runtime_control_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  current_profile     TEXT REFERENCES profiles(profile_id),
  desired_profile     TEXT REFERENCES profiles(profile_id),
  current_switch_id   TEXT,
  current_run_id      TEXT,
  current_instance_id TEXT,
  runtime_status      TEXT NOT NULL DEFAULT 'stopped',  -- stopped | starting | ready_paused | running | stopping | failed
  paused              INTEGER NOT NULL DEFAULT 1,
  resume_intent_at    TEXT,             -- one-shot deploy resume intent (ISO timestamp, NULL = no intent)
  schema_version      INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
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

-- ═══════════ FAMILY EVIDENCE (legacy compat) ═══════════
-- Kept for backward compatibility with existing repos and raw SQL.
-- Phase 4 will migrate consumers to family_validation_scorecards.

CREATE TABLE IF NOT EXISTS family_evidence (
  family_id                     TEXT PRIMARY KEY REFERENCES family_catalog(family_id),
  evidence_status               TEXT NOT NULL DEFAULT 'unknown',
  evidence_score                REAL NOT NULL DEFAULT 0,
  promotion_state               TEXT NOT NULL DEFAULT 'probe-only',
  local_trade_count             INTEGER NOT NULL DEFAULT 0,
  local_market_count            INTEGER NOT NULL DEFAULT 0,
  local_realized_pnl_fifo       REAL NOT NULL DEFAULT 0,
  open_tail_cost_usdc           REAL NOT NULL DEFAULT 0,
  tail_adjusted_pnl             REAL NOT NULL DEFAULT 0,
  remote_closed_realized_pnl    REAL,
  open_position_count           INTEGER,
  open_dust_count               INTEGER,
  both_sided_eligible           INTEGER NOT NULL DEFAULT 0,
  heavy_campaign_eligible       INTEGER NOT NULL DEFAULT 0,
  active_window_edge_score      REAL,
  last_validated_at             TEXT,
  recurrence_score              REAL,
  recycle_score                 REAL,
  live_viability_score          REAL,
  toxicity_penalty              REAL,
  scores_updated_at             TEXT,
  probe_substate                TEXT,
  repricing_exit_count          INTEGER NOT NULL DEFAULT 0,
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
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
