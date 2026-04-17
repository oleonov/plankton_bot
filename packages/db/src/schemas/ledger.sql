-- ledger.sql
-- Complete DDL for ledger-{profile}.db — per-profile trading data.
-- Reconstructed from legacy migrations 001-011, keeping only ledger tables.

PRAGMA foreign_keys = ON;

-- ═══════════ MARKETS ═══════════
-- From 001_initial.sql + 005 (event_slug)

CREATE TABLE IF NOT EXISTS markets (
  token_id      TEXT PRIMARY KEY,
  condition_id  TEXT NOT NULL,
  slug          TEXT NOT NULL,
  question      TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  outcome_index INTEGER,
  family_id     TEXT,
  family_key    TEXT,
  regime        TEXT,
  horizon       TEXT,
  end_date      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  tick_size     REAL NOT NULL,
  neg_risk      INTEGER NOT NULL DEFAULT 0,
  event_slug    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_markets_family_id ON markets(family_id);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active);
CREATE INDEX IF NOT EXISTS idx_markets_slug ON markets(slug);
CREATE INDEX IF NOT EXISTS idx_markets_condition_id ON markets(condition_id);

-- ═══════════ MARKET SNAPSHOTS ═══════════
-- From 001_initial.sql

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

-- ═══════════ ORDERS ═══════════
-- From 001_initial.sql + 007 (signal_reason)

CREATE TABLE IF NOT EXISTS orders (
  order_id           TEXT PRIMARY KEY,
  client_order_id    TEXT NOT NULL UNIQUE,
  token_id           TEXT NOT NULL,
  family_id          TEXT,
  condition_id       TEXT NOT NULL DEFAULT '',
  side               TEXT NOT NULL,
  order_type         TEXT NOT NULL,
  post_only          INTEGER NOT NULL DEFAULT 0,
  price              REAL NOT NULL,
  size               REAL NOT NULL,
  size_usdc          REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  exchange_order_id  TEXT,
  signal_id          TEXT,
  signal_reason      TEXT,
  bot_run_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_family ON orders(family_id);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token_id);
CREATE INDEX IF NOT EXISTS idx_orders_client_oid ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_exchange_oid ON orders(exchange_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_bot_run ON orders(bot_run_id);

-- ═══════════ FILLS ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS fills (
  fill_id      TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(order_id),
  token_id     TEXT NOT NULL,
  family_id    TEXT,
  condition_id TEXT NOT NULL DEFAULT '',
  side         TEXT NOT NULL,
  price        REAL NOT NULL,
  size         REAL NOT NULL,
  size_usdc    REAL NOT NULL,
  liquidity_role TEXT NOT NULL DEFAULT 'unknown',
  fee          REAL NOT NULL DEFAULT 0,
  fee_rate_bps REAL NOT NULL DEFAULT 0,
  reconciled   INTEGER NOT NULL DEFAULT 0,
  filled_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_family ON fills(family_id);
CREATE INDEX IF NOT EXISTS idx_fills_token ON fills(token_id);
CREATE INDEX IF NOT EXISTS idx_fills_filled_at ON fills(filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_fills_unreconciled ON fills(reconciled) WHERE reconciled = 0;

-- ═══════════ POSITIONS ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS positions (
  position_id        TEXT PRIMARY KEY,
  token_id           TEXT NOT NULL,
  family_id          TEXT,
  condition_id       TEXT NOT NULL DEFAULT '',
  side               TEXT NOT NULL,
  size               REAL NOT NULL DEFAULT 0,
  avg_entry_price    REAL NOT NULL DEFAULT 0,
  cost_basis_usdc    REAL NOT NULL DEFAULT 0,
  current_value_usdc REAL,
  realized_pnl       REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open',
  entry_style        TEXT,
  opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at          TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_family ON positions(family_id);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_id);

-- ═══════════ INVENTORY LOTS (FIFO) ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS inventory_lots (
  lot_id          TEXT PRIMARY KEY,
  position_id     TEXT NOT NULL REFERENCES positions(position_id),
  token_id        TEXT NOT NULL,
  family_id       TEXT,
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

-- ═══════════ PNL LEDGER ═══════════
-- From 002_pnl_ledger.sql + 007 (family index)

CREATE TABLE IF NOT EXISTS pnl_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id     TEXT NOT NULL REFERENCES fills(fill_id),
  position_id TEXT NOT NULL REFERENCES positions(position_id),
  family_id   TEXT NOT NULL,
  delta       REAL NOT NULL,
  filled_at   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pnl_ledger_filled_at ON pnl_ledger(filled_at);
CREATE INDEX IF NOT EXISTS idx_pnl_ledger_family ON pnl_ledger(family_id);

-- ═══════════ MARKET RESOLUTIONS ═══════════
-- From 003_market_resolutions.sql + 004 (status)

CREATE TABLE IF NOT EXISTS market_resolutions (
  condition_id TEXT PRIMARY KEY,
  resolution   TEXT NOT NULL,
  resolved_at  TEXT NOT NULL,
  detected_at  TEXT NOT NULL,
  source       TEXT NOT NULL,
  raw_response TEXT,
  status       TEXT NOT NULL DEFAULT 'settled'
);

-- ═══════════ SETTLEMENT LEDGER ═══════════
-- From 003_market_resolutions.sql

CREATE TABLE IF NOT EXISTS settlement_ledger (
  settlement_id    TEXT PRIMARY KEY,
  condition_id     TEXT NOT NULL REFERENCES market_resolutions(condition_id),
  position_id      TEXT NOT NULL REFERENCES positions(position_id),
  token_id         TEXT NOT NULL,
  family_id        TEXT,
  resolution       TEXT NOT NULL,
  settlement_price REAL NOT NULL,
  size             REAL NOT NULL,
  delta            REAL NOT NULL,
  settled_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_settlement_family ON settlement_ledger(family_id);
CREATE INDEX IF NOT EXISTS idx_settlement_settled_at ON settlement_ledger(settled_at);

-- ═══════════ BOT RUNS ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS bot_runs (
  run_id      TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  summary     TEXT
);

-- ═══════════ RUNTIME METRICS ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS runtime_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  value       REAL NOT NULL,
  labels      TEXT,
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_metrics_name_ts
  ON runtime_metrics(metric_name, captured_at DESC);

-- ═══════════ RISK EVENTS ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS risk_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  family_id   TEXT,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_events_family ON risk_events(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events(event_type, created_at DESC);

-- ═══════════ TRADING STATE SNAPSHOTS ═══════════
-- From 014_trading_state_snapshots.sql

CREATE TABLE IF NOT EXISTS trading_state_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_state     TEXT    NOT NULL,
  signals_produced  INTEGER NOT NULL,
  signals_approved  INTEGER NOT NULL,
  signals_rejected  INTEGER NOT NULL,
  captured_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_trading_state_snapshots_ts
  ON trading_state_snapshots(captured_at DESC);

-- ═══════════ FAMILY RUNTIME STATE (legacy compat) ═══════════
-- Kept for backward compatibility with existing repos and raw SQL.
-- Phase 4 will migrate consumers to family_profile_runtime_state.
-- Cumulative schema: 001_initial + 006_effective_mode + 009_negative_tail + 011_probe_substate

CREATE TABLE IF NOT EXISTS family_runtime_state (
  family_id               TEXT PRIMARY KEY,
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
  effective_mode          TEXT,
  derived_mode_reason     TEXT,
  first_negative_tail_at  TEXT,
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ FAMILY PROFILE RUNTIME STATE ═══════════
-- New table for Phase 2+: drops runtime_mode, quarantine_reason
-- From spec Section 3.3

CREATE TABLE IF NOT EXISTS family_profile_runtime_state (
  family_id                TEXT PRIMARY KEY,
  open_value_usdc          REAL NOT NULL DEFAULT 0,
  open_position_count      INTEGER NOT NULL DEFAULT 0,
  open_dust_count          INTEGER NOT NULL DEFAULT 0,
  active_market_count      INTEGER NOT NULL DEFAULT 0,
  current_tail_cost_usdc   REAL NOT NULL DEFAULT 0,
  tail_adjusted_pnl_live   REAL NOT NULL DEFAULT 0,
  last_entry_ts            TEXT,
  last_exit_ts             TEXT,
  effective_mode           TEXT,
  derived_mode_reason      TEXT,
  first_negative_tail_at   TEXT,
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ PORTFOLIO SNAPSHOTS ═══════════
-- From 018_portfolio_snapshots.sql

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  profile             TEXT NOT NULL,
  equity_usdc         REAL NOT NULL,
  wallet_usdc         REAL,
  position_value_usdc REAL NOT NULL,
  realized_pnl_usdc   REAL NOT NULL,
  open_value_usdc     REAL NOT NULL,
  captured_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_profile_ts ON portfolio_snapshots(profile, captured_at DESC);

-- ═══════════ MERGE LEDGER ═══════════
-- From 021_merge_ledger.sql

CREATE TABLE IF NOT EXISTS merge_ledger (
  merge_id       TEXT PRIMARY KEY,
  condition_id   TEXT NOT NULL,
  family_id      TEXT NOT NULL,
  merged_amount  REAL NOT NULL,
  spread_pnl     REAL NOT NULL,
  merged_at      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_merge_ledger_family ON merge_ledger(family_id);
CREATE INDEX IF NOT EXISTS idx_merge_ledger_merged_at ON merge_ledger(merged_at);

-- ═══════════ ALGO DECISION ENGINE ═══════════

CREATE TABLE IF NOT EXISTS leg_states (
  token_id                TEXT PRIMARY KEY,
  buy_count               INTEGER NOT NULL DEFAULT 0,
  sell_count              INTEGER NOT NULL DEFAULT 0,
  last_action             TEXT NOT NULL,
  first_trade_price       REAL NOT NULL,
  first_trade_at          TEXT NOT NULL,
  last_trade_at           TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);
