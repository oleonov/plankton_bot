-- ledger.sql
-- Complete DDL for ledger-{profile}.db — per-profile trading data.
-- Reconstructed from legacy migrations 001-011, keeping only ledger tables.

PRAGMA foreign_keys = ON;

-- ═══════════ MARKETS ═══════════
-- From 001_initial.sql + 005 (event_slug)

CREATE TABLE IF NOT EXISTS markets (
  token_id                  TEXT PRIMARY KEY,
  condition_id              TEXT NOT NULL,
  slug                      TEXT NOT NULL,
  question                  TEXT NOT NULL,
  outcome                   TEXT NOT NULL,
  outcome_index             INTEGER,
  regime                    TEXT,
  horizon                   TEXT,
  end_date                  TEXT,
  active                    INTEGER NOT NULL DEFAULT 1,
  tradable                  INTEGER NOT NULL DEFAULT 1,
  tick_size                 REAL NOT NULL,
  neg_risk                  INTEGER NOT NULL DEFAULT 0,
  event_slug                TEXT,
  event_market_count        INTEGER NOT NULL DEFAULT 1,
  selection_status          TEXT NOT NULL DEFAULT 'unknown'
    CHECK (selection_status IN
      ('unknown','matched_include','matched_exclude','step2_fallback_include','fallback_exclude')),
  selection_winning_rule_id TEXT,
  gamma_created_at          TEXT,
  -- Track B strike-aware rollout (migration 060): raw Gamma strike signals.
  -- group_item_* collected/persisted for a future Track C; the Track B
  -- classifier ignores them (F6, spec §3.6). tags_json is a JSON string array.
  group_item_title          TEXT,
  group_item_threshold      TEXT,
  tags_json                 TEXT,
  -- Step 3 (audit doc §D3): soft-ranking score columns. NULL = "not yet
  -- scored" (never store 0 — it is a valid model output). Owned exclusively
  -- by SoftRankingScoreModule via MarketRepository.updateScoresBatch; the
  -- market upsert path must NOT mention these columns.
  score                     REAL,
  score_model_version       TEXT,
  scored_at                 TEXT,
  features_captured_at      TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active);
CREATE INDEX IF NOT EXISTS idx_markets_slug ON markets(slug);
CREATE INDEX IF NOT EXISTS idx_markets_condition_id ON markets(condition_id);
CREATE INDEX IF NOT EXISTS idx_markets_selection_status ON markets(selection_status);
CREATE INDEX IF NOT EXISTS idx_markets_tracked ON markets(active, tradable) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_markets_score ON markets(score) WHERE score IS NOT NULL;

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
  public_trade_count_24h INTEGER DEFAULT NULL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_token_ts
  ON market_snapshots(token_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_snapshots_captured_at
  ON market_snapshots(captured_at);

-- ═══════════ ORDERS ═══════════
-- From 001_initial.sql + 007 (signal_reason)

CREATE TABLE IF NOT EXISTS orders (
  order_id           TEXT PRIMARY KEY,
  client_order_id    TEXT NOT NULL UNIQUE,
  token_id           TEXT NOT NULL,
  condition_id       TEXT NOT NULL DEFAULT '',
  side               TEXT NOT NULL,
  order_type         TEXT NOT NULL,
  post_only          INTEGER NOT NULL DEFAULT 0,
  price              REAL NOT NULL,
  size               REAL NOT NULL,
  size_usdc          REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  cancel_reason      TEXT,
  cancel_age_ms      INTEGER,
  cancel_age_bucket  TEXT,
  fill_progress_shares NUMERIC,
  market_horizon     TEXT,
  exchange_order_id  TEXT,
  signal_id          TEXT,
  signal_reason      TEXT,
  decision_rule_id   TEXT,
  signal_timestamp   TEXT,
  exchange_error_code    TEXT,
  exchange_error_message TEXT,
  exchange_error_payload TEXT,
  exchange_rejection_reason TEXT,
  bot_run_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token_id);
CREATE INDEX IF NOT EXISTS idx_orders_client_oid ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_exchange_oid ON orders(exchange_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_bot_run ON orders(bot_run_id);
CREATE INDEX IF NOT EXISTS idx_orders_token_status ON orders(token_id, status);

-- ═══════════ DECISION SIGNAL LOG ═══════════
-- From 041_decision_signal_telemetry.sql

CREATE TABLE IF NOT EXISTS decision_signal_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id                TEXT NOT NULL,
  token_id                 TEXT NOT NULL,
  condition_id             TEXT NOT NULL DEFAULT '',
  side                     TEXT NOT NULL,
  decision_rule_id         TEXT,
  sizing_rule_id           TEXT,
  notional_bucket          TEXT,
  state                    TEXT NOT NULL,
  price                    REAL NOT NULL,
  buy_count                INTEGER NOT NULL,
  time_since_last_seconds  REAL,
  signal_timestamp         TEXT NOT NULL,
  is_add                   INTEGER,
  add_age_ms               INTEGER,
  add_age_bucket           TEXT,
  add_price_change_pct     REAL,
  add_price_change_bucket  TEXT,
  nth_buy_at_emit          INTEGER,
  is_exit                  INTEGER,
  is_first_sell            INTEGER,
  holding_time_ms          INTEGER,
  holding_time_bucket      TEXT,
  exit_pnl_pct             REAL,
  exit_pnl_bucket          TEXT,
  sold_bought_ratio        REAL,
  sold_bought_ratio_bucket TEXT,
  entry_fresh_edge_kind    TEXT,
  entry_fresh_edge_shadow_class TEXT,
  entry_fresh_edge_payload_json TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decision_signal_log_ts
  ON decision_signal_log(signal_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_decision_signal_log_side_rule_ts
  ON decision_signal_log(side, decision_rule_id, signal_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_decision_signal_log_token_ts
  ON decision_signal_log(token_id, signal_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_decision_signal_log_signal_id
  ON decision_signal_log(signal_id);

-- ═══════════ FILLS ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS fills (
  fill_id      TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(order_id),
  token_id     TEXT NOT NULL,
  condition_id TEXT NOT NULL DEFAULT '',
  side         TEXT NOT NULL,
  price        REAL NOT NULL,
  size         REAL NOT NULL,
  size_usdc    REAL NOT NULL,
  liquidity_role TEXT NOT NULL DEFAULT 'unknown',
  fee          REAL NOT NULL DEFAULT 0,
  fee_rate_bps REAL NOT NULL DEFAULT 0,
  signal_id    TEXT,
  decision_rule_id TEXT,
  signal_timestamp TEXT,
  reconciled   INTEGER NOT NULL DEFAULT 0,
  filled_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_token ON fills(token_id);
CREATE INDEX IF NOT EXISTS idx_fills_filled_at ON fills(filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_fills_unreconciled ON fills(reconciled) WHERE reconciled = 0;

-- ═══════════ ORDER PRICE COOLDOWNS ═══════════
-- From 052_order_price_cooldowns.sql

CREATE TABLE IF NOT EXISTS order_price_cooldowns (
  token_id                  TEXT NOT NULL,
  side                      TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price_x10000              INTEGER NOT NULL,
  stale_cancel_count        INTEGER NOT NULL DEFAULT 0,
  cooldown_until_ts_utc     INTEGER NOT NULL DEFAULT 0,
  last_event_ts_utc         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, side, price_x10000)
);

CREATE INDEX IF NOT EXISTS idx_order_price_cooldowns_until
  ON order_price_cooldowns(cooldown_until_ts_utc);

-- ═══════════ POSITIONS ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS positions (
  position_id        TEXT PRIMARY KEY,
  token_id           TEXT NOT NULL,
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
  consecutive_state_failed_count INTEGER NOT NULL DEFAULT 0,
  redeem_quarantine_until_ts     INTEGER,
  last_state_failed_ts           INTEGER,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_id);
CREATE INDEX IF NOT EXISTS idx_positions_redeem_quarantine_until
  ON positions(redeem_quarantine_until_ts)
  WHERE redeem_quarantine_until_ts IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_positions_condition_redeem_quarantine
  ON positions(condition_id, redeem_quarantine_until_ts);
-- idx_positions_unique_open_per_token (partial UNIQUE on token_id WHERE
-- status='open') is created in bootstrapLedgerDb after an idempotent repair
-- step so that upgrade installs with pre-existing duplicate-open rows don't
-- break on `CREATE UNIQUE INDEX`. See packages/db/src/bootstrap.ts.

-- ═══════════ INVENTORY LOTS (FIFO) ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS inventory_lots (
  lot_id          TEXT PRIMARY KEY,
  position_id     TEXT NOT NULL REFERENCES positions(position_id),
  token_id        TEXT NOT NULL,
  side            TEXT NOT NULL,
  size            REAL NOT NULL,
  remaining_size  REAL NOT NULL,
  entry_price     REAL NOT NULL,
  cost_usdc       REAL NOT NULL,
  fill_id         TEXT NOT NULL REFERENCES fills(fill_id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_position ON inventory_lots(position_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_token ON inventory_lots(token_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_remaining
  ON inventory_lots(position_id, remaining_size) WHERE remaining_size > 0;

-- ═══════════ PNL LEDGER ═══════════
-- From 002_pnl_ledger.sql + 007 (family index)

CREATE TABLE IF NOT EXISTS pnl_ledger (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fill_id     TEXT NOT NULL REFERENCES fills(fill_id),
  position_id TEXT NOT NULL REFERENCES positions(position_id),
  delta       REAL NOT NULL,
  filled_at   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pnl_ledger_filled_at ON pnl_ledger(filled_at);

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
  resolution       TEXT NOT NULL,
  settlement_price REAL NOT NULL,
  size             REAL NOT NULL,
  delta            REAL NOT NULL,
  settled_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_settlement_settled_at ON settlement_ledger(settled_at);

-- ═══════════ POSITION DRIFTS ═══════════
-- From 037_position_drifts.sql — Phase 3.A independent on-chain-vs-local sensor.

CREATE TABLE IF NOT EXISTS position_drifts (
  settlement_id     TEXT PRIMARY KEY REFERENCES settlement_ledger(settlement_id),
  token_id          TEXT NOT NULL,
  condition_id      TEXT NOT NULL,
  detected_at       TEXT NOT NULL,
  on_chain_balance  TEXT NOT NULL,
  last_checked_at   TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('open','resolved')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_position_drifts_status
  ON position_drifts(status, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_drifts_token
  ON position_drifts(token_id);

-- ═══════════ REDEEM LOG ═══════════
-- Audit trail for direct wallet redeem sweeps of Data API redeemable positions.

CREATE TABLE IF NOT EXISTS redeem_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_id TEXT NOT NULL,
  token_ids TEXT NOT NULL,
  attempt_ts INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('attempting','success','submitted','pending','skipped','failed','rejected','failed_max_retries','failed_orphaned')),
  tx_hash TEXT,
  gas_used INTEGER,
  error_msg TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_redeem_log_condition_ts
  ON redeem_log(condition_id, attempt_ts DESC);

CREATE INDEX IF NOT EXISTS idx_redeem_log_status_ts
  ON redeem_log(status, attempt_ts DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_redeem_log_unique_in_flight
  ON redeem_log(condition_id)
  WHERE status IN ('attempting', 'submitted', 'pending');

-- ═══════════ EXECUTION POLICY OBSERVATIONS (ADR-015) ═══════════
-- One row per BUY/SELL signal that reaches execution-term resolution so SQL
-- and the dashboard can compare edge vs bounded-midpoint pricing and
-- dead-side buckets over 24-72h windows. Append-only.

CREATE TABLE IF NOT EXISTS execution_policy_observations (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id               TEXT NOT NULL,
  signal_id                TEXT,
  client_order_id          TEXT,
  decision_rule_id         TEXT,
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
  pricing_delta_ticks      REAL,
  round_level_hit          TEXT,
  sizing_rule_id           TEXT,
  notional_bucket          TEXT,
  sell_shadow_avg_entry    REAL,
  sell_shadow_avg_entry_source TEXT,
  sell_shadow_signal_price REAL,
  sell_shadow_execution_price REAL,
  sell_shadow_execution_vs_signal_ratio REAL,
  sell_shadow_execution_vs_avg_entry_ratio REAL,
  sell_shadow_cap5_violation INTEGER,
  sell_shadow_cap10_violation INTEGER,
  sell_shadow_exit_pricing_mode TEXT,
  sell_shadow_exit_anchor_mode TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_execution_policy_observations_profile_ts
  ON execution_policy_observations(profile_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_policy_observations_token_ts
  ON execution_policy_observations(token_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_policy_observations_created_at
  ON execution_policy_observations(created_at);

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
CREATE INDEX IF NOT EXISTS idx_runtime_metrics_captured_at
  ON runtime_metrics(captured_at);

-- ═══════════ RISK EVENTS ═══════════
-- From 001_initial.sql

CREATE TABLE IF NOT EXISTS risk_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_created_at ON risk_events(created_at);

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
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_captured_at ON portfolio_snapshots(captured_at);

-- ═══════════ MERGE LEDGER ═══════════
-- From 021_merge_ledger.sql

CREATE TABLE IF NOT EXISTS merge_ledger (
  merge_id       TEXT PRIMARY KEY,
  condition_id   TEXT NOT NULL,
  merged_amount  REAL NOT NULL,
  spread_pnl     REAL NOT NULL,
  merged_at      TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  updated_at              TEXT NOT NULL,
  -- ADR-027 §D-C: cumulative sizes for §11.2 cost basis + sold/bought ratio.
  cumulative_buy_size     REAL NOT NULL DEFAULT 0,
  cumulative_buy_notional REAL NOT NULL DEFAULT 0,
  cumulative_sell_size    REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS algo_token_mode_state (
  token_id                 TEXT PRIMARY KEY,
  condition_id             TEXT NOT NULL,
  outcome_index            INTEGER,
  mode                     TEXT NOT NULL CHECK (mode IN ('PASSIVE', 'MIDDLE', 'BURST')),
  mode_confidence          TEXT NOT NULL CHECK (mode_confidence IN ('low', 'medium', 'high')),
  mode_status              TEXT NOT NULL CHECK (mode_status IN ('candidate', 'confirmed')),
  mode_since               TEXT NOT NULL,
  mode_assessed_at         TEXT NOT NULL,
  ttl_stage                INTEGER NOT NULL DEFAULT 0,
  last_fill_at             TEXT,
  last_order_at            TEXT,
  last_stale_cancel_at     TEXT,
  fill_count_window        INTEGER NOT NULL DEFAULT 0,
  order_count_window       INTEGER NOT NULL DEFAULT 0,
  first_fill_latency_ms    INTEGER,
  median_gap_ms            INTEGER,
  p75_gap_ms               INTEGER,
  span_ms                  INTEGER,
  last_fill_timestamps_json TEXT,
  transition_count_day     INTEGER NOT NULL DEFAULT 0,
  transition_day           TEXT,
  reset_reason             TEXT,
  updated_at               TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_algo_token_mode_state_condition
  ON algo_token_mode_state(condition_id);

CREATE INDEX IF NOT EXISTS idx_algo_token_mode_state_mode
  ON algo_token_mode_state(mode, mode_confidence);

CREATE INDEX IF NOT EXISTS idx_algo_token_mode_state_updated
  ON algo_token_mode_state(updated_at);

CREATE TABLE IF NOT EXISTS leg_state_transitions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id         TEXT NOT NULL,
  position_id      TEXT,
  fill_id          TEXT,
  order_id         TEXT,
  client_order_id  TEXT,
  condition_id     TEXT,
  from_phase       TEXT NOT NULL CHECK (from_phase IN ('S0', 'S1', 'S2', 'S3', 'S4')),
  to_phase         TEXT NOT NULL CHECK (to_phase IN ('S0', 'S1', 'S2', 'S3', 'S4')),
  action           TEXT NOT NULL CHECK (action IN ('BUY', 'SELL', 'CLEAR', 'SETTLE')),
  price            REAL,
  size             REAL,
  size_usdc        REAL,
  from_buy_count   INTEGER NOT NULL,
  from_sell_count  INTEGER NOT NULL,
  to_buy_count     INTEGER NOT NULL,
  to_sell_count    INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  occurred_at      TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leg_state_transitions_fill_unique
  ON leg_state_transitions(fill_id)
  WHERE fill_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leg_state_transitions_token_ts
  ON leg_state_transitions(token_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_leg_state_transitions_position_ts
  ON leg_state_transitions(position_id, occurred_at DESC, id DESC)
  WHERE position_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leg_state_transitions_created_at
  ON leg_state_transitions(created_at);
