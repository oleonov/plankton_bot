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

ALTER TABLE orders ADD COLUMN decision_rule_id TEXT;
ALTER TABLE orders ADD COLUMN signal_timestamp TEXT;
ALTER TABLE orders ADD COLUMN exchange_error_code TEXT;
ALTER TABLE orders ADD COLUMN exchange_error_message TEXT;
ALTER TABLE orders ADD COLUMN exchange_error_payload TEXT;

ALTER TABLE fills ADD COLUMN signal_id TEXT;
ALTER TABLE fills ADD COLUMN decision_rule_id TEXT;
ALTER TABLE fills ADD COLUMN signal_timestamp TEXT;

ALTER TABLE execution_policy_observations ADD COLUMN decision_rule_id TEXT;
