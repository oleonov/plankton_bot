-- 001_initial.sql
-- Initial schema for poly_plankton trading bot.
-- All market_id columns renamed to token_id per domain model.

-- ═══════════ MARKETS ═══════════

CREATE TABLE IF NOT EXISTS markets (
  token_id      TEXT PRIMARY KEY,
  condition_id  TEXT NOT NULL,
  slug          TEXT NOT NULL,
  question      TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  family_id     TEXT,
  family_key    TEXT,
  regime        TEXT,
  horizon       TEXT,
  end_date      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  tick_size     REAL NOT NULL,
  neg_risk      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_markets_family_id ON markets(family_id);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active);
CREATE INDEX IF NOT EXISTS idx_markets_slug ON markets(slug);
CREATE INDEX IF NOT EXISTS idx_markets_condition_id ON markets(condition_id);

-- ═══════════ MARKET SNAPSHOTS ═══════════

CREATE TABLE IF NOT EXISTS market_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id     TEXT NOT NULL REFERENCES markets(token_id),
  best_bid     REAL,
  best_ask     REAL,
  last_price   REAL,
  volume_24h   REAL,
  liquidity    REAL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_token_ts
  ON market_snapshots(token_id, captured_at DESC);

-- ═══════════ FAMILY CATALOG (Identity) ═══════════

CREATE TABLE IF NOT EXISTS family_catalog (
  family_id         TEXT PRIMARY KEY,
  family_key        TEXT NOT NULL,
  primary_category  TEXT NOT NULL,
  regime            TEXT NOT NULL,
  horizon           TEXT NOT NULL,
  cadence           TEXT NOT NULL,
  strategy_profile  TEXT NOT NULL,
  topic_key         TEXT,
  slug_pattern      TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_family_catalog_key ON family_catalog(family_key);
CREATE INDEX IF NOT EXISTS idx_family_catalog_regime ON family_catalog(regime);

-- ═══════════ FAMILY EVIDENCE ═══════════

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
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ FAMILY RULES ═══════════
-- Flat columns for all 7 rule blocks; JSON for session windows.

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
  target_roi_band_low                      REAL,
  target_roi_band_high                     REAL,
  max_unmoved_hold_hours                   REAL,
  max_tail_hold_hours                      REAL,

  -- two_sided
  allow_two_sided                          INTEGER NOT NULL DEFAULT 0,
  two_sided_mode                           TEXT NOT NULL DEFAULT 'disabled',
  min_activity_for_two_sided               INTEGER,

  -- tail_suppression
  max_open_value_usdc                      REAL NOT NULL DEFAULT 50,
  max_active_markets                       INTEGER NOT NULL DEFAULT 100,
  max_dust_positions                       INTEGER NOT NULL DEFAULT 50,
  tail_quarantine_threshold_usdc           REAL NOT NULL DEFAULT 1000.0,
  tail_quarantine_threshold_ratio          REAL NOT NULL DEFAULT 1000.0,
  stale_tail_prune_enabled                 INTEGER NOT NULL DEFAULT 0,
  threshold_cleanup_required               INTEGER NOT NULL DEFAULT 0,

  -- session (JSON blobs for window arrays)
  active_windows_utc                       TEXT NOT NULL DEFAULT '[]',
  reduced_windows_utc                      TEXT NOT NULL DEFAULT '[]',
  weekday_bias                             TEXT NOT NULL DEFAULT 'normal',

  updated_at                               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ FAMILY RULES SNAPSHOT (audit) ═══════════

CREATE TABLE IF NOT EXISTS family_rules_snapshot (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id    TEXT NOT NULL REFERENCES family_catalog(family_id),
  snapshot     TEXT NOT NULL,  -- full JSON serialization
  reason       TEXT NOT NULL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_family_rules_snapshot_family
  ON family_rules_snapshot(family_id, captured_at DESC);

-- ═══════════ FAMILY RUNTIME STATE ═══════════

CREATE TABLE IF NOT EXISTS family_runtime_state (
  family_id               TEXT PRIMARY KEY REFERENCES family_catalog(family_id),
  runtime_mode            TEXT NOT NULL DEFAULT 'active',
  open_value_usdc         REAL NOT NULL DEFAULT 0,
  open_position_count     INTEGER NOT NULL DEFAULT 0,
  open_dust_count         INTEGER NOT NULL DEFAULT 0,
  active_market_count     INTEGER NOT NULL DEFAULT 0,
  current_tail_cost_usdc  REAL NOT NULL DEFAULT 0,
  tail_adjusted_pnl_live  REAL NOT NULL DEFAULT 0,
  last_entry_ts           TEXT,
  last_exit_ts            TEXT,
  quarantine_reason       TEXT,
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ ORDERS ═══════════

CREATE TABLE IF NOT EXISTS orders (
  order_id           TEXT PRIMARY KEY,
  client_order_id    TEXT NOT NULL UNIQUE,
  token_id           TEXT NOT NULL,
  family_id          TEXT NOT NULL,
  side               TEXT NOT NULL,
  order_type         TEXT NOT NULL,
  price              REAL NOT NULL,
  size               REAL NOT NULL,
  size_usdc          REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  exchange_order_id  TEXT,
  signal_id          TEXT,
  bot_run_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_family ON orders(family_id);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token_id);
CREATE INDEX IF NOT EXISTS idx_orders_client_oid ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_bot_run ON orders(bot_run_id);

-- ═══════════ FILLS ═══════════

CREATE TABLE IF NOT EXISTS fills (
  fill_id      TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(order_id),
  token_id     TEXT NOT NULL,
  family_id    TEXT NOT NULL,
  side         TEXT NOT NULL,
  price        REAL NOT NULL,
  size         REAL NOT NULL,
  size_usdc    REAL NOT NULL,
  fee          REAL NOT NULL DEFAULT 0,
  reconciled   INTEGER NOT NULL DEFAULT 0,
  filled_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_family ON fills(family_id);
CREATE INDEX IF NOT EXISTS idx_fills_token ON fills(token_id);
CREATE INDEX IF NOT EXISTS idx_fills_filled_at ON fills(filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_fills_unreconciled ON fills(reconciled) WHERE reconciled = 0;

-- ═══════════ POSITIONS ═══════════

CREATE TABLE IF NOT EXISTS positions (
  position_id        TEXT PRIMARY KEY,
  token_id           TEXT NOT NULL,
  family_id          TEXT NOT NULL,
  side               TEXT NOT NULL,
  size               REAL NOT NULL DEFAULT 0,
  avg_entry_price    REAL NOT NULL DEFAULT 0,
  cost_basis_usdc    REAL NOT NULL DEFAULT 0,
  current_value_usdc REAL,
  realized_pnl       REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open',
  opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at          TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_family ON positions(family_id);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_id);

-- ═══════════ INVENTORY LOTS (FIFO) ═══════════

CREATE TABLE IF NOT EXISTS inventory_lots (
  lot_id          TEXT PRIMARY KEY,
  position_id     TEXT NOT NULL REFERENCES positions(position_id),
  token_id        TEXT NOT NULL,
  family_id       TEXT NOT NULL,
  side            TEXT NOT NULL,
  size            REAL NOT NULL,
  remaining_size  REAL NOT NULL,
  entry_price     REAL NOT NULL,
  cost_usdc       REAL NOT NULL,
  fill_id         TEXT NOT NULL REFERENCES fills(fill_id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_position ON inventory_lots(position_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_family ON inventory_lots(family_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_token ON inventory_lots(token_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_remaining
  ON inventory_lots(position_id, remaining_size) WHERE remaining_size > 0;

-- ═══════════ RISK EVENTS ═══════════

CREATE TABLE IF NOT EXISTS risk_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  family_id   TEXT,
  payload     TEXT NOT NULL,  -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_events_family ON risk_events(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events(event_type, created_at DESC);

-- ═══════════ RUNTIME METRICS ═══════════

CREATE TABLE IF NOT EXISTS runtime_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  value       REAL NOT NULL,
  labels      TEXT,  -- JSON key-value
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_metrics_name_ts
  ON runtime_metrics(metric_name, captured_at DESC);

-- ═══════════ BOT RUNS ═══════════

CREATE TABLE IF NOT EXISTS bot_runs (
  run_id      TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,  -- 'simulation' | 'paper' | 'live-lite'
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  summary     TEXT  -- JSON
);

-- ═══════════ OPERATOR COMMANDS (pending queue) ═══════════

CREATE TABLE IF NOT EXISTS operator_commands (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  action      TEXT NOT NULL,
  target_id   TEXT,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_operator_commands_status ON operator_commands(status);

-- ═══════════ OPERATOR ACTIONS (audit log) ═══════════

CREATE TABLE IF NOT EXISTS operator_actions (
  action_id     TEXT PRIMARY KEY,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  reason        TEXT,
  performed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_operator_actions_ts ON operator_actions(performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_operator_actions_target ON operator_actions(target_id);
