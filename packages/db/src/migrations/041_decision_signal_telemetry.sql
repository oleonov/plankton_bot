CREATE TABLE IF NOT EXISTS decision_signal_log (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id                TEXT NOT NULL,
  token_id                 TEXT NOT NULL,
  condition_id             TEXT NOT NULL DEFAULT '',
  side                     TEXT NOT NULL,
  decision_rule_id         TEXT,
  state                    TEXT NOT NULL,
  price                    REAL NOT NULL,
  buy_count                INTEGER NOT NULL,
  time_since_last_seconds  REAL,
  signal_timestamp         TEXT NOT NULL,
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

SELECT safe_add_column('orders', 'decision_rule_id', 'TEXT');
SELECT safe_add_column('orders', 'signal_timestamp', 'TEXT');
SELECT safe_add_column('orders', 'exchange_error_code', 'TEXT');
SELECT safe_add_column('orders', 'exchange_error_message', 'TEXT');
SELECT safe_add_column('orders', 'exchange_error_payload', 'TEXT');

SELECT safe_add_column('fills', 'signal_id', 'TEXT');
SELECT safe_add_column('fills', 'decision_rule_id', 'TEXT');
SELECT safe_add_column('fills', 'signal_timestamp', 'TEXT');

SELECT safe_add_column('execution_policy_observations', 'decision_rule_id', 'TEXT');
