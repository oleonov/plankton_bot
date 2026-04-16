-- Algo Decision Engine tables

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
