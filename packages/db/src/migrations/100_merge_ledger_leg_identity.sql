-- The runner wraps this recreate/copy/marker sequence in one BEGIN IMMEDIATE transaction.
CREATE TABLE merge_ledger_new (
  merge_id TEXT PRIMARY KEY,
  condition_id TEXT NOT NULL,
  merged_amount REAL NOT NULL,
  spread_pnl REAL NOT NULL,
  merged_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('pending', 'onchain', 'applied')),
  yes_token_id TEXT,
  no_token_id TEXT,
  yes_position_id TEXT,
  no_position_id TEXT,
  CHECK (status = 'applied' OR ((
    trim(yes_token_id) != '' AND trim(no_token_id) != '' AND
    trim(yes_position_id) != '' AND trim(no_position_id) != '' AND
    yes_token_id != no_token_id AND yes_position_id != no_position_id
  ) IS TRUE))
);
INSERT INTO merge_ledger_new (merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status)
SELECT merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status
FROM merge_ledger;
DROP TABLE merge_ledger;
ALTER TABLE merge_ledger_new RENAME TO merge_ledger;
CREATE INDEX idx_merge_ledger_merged_at ON merge_ledger(merged_at);
CREATE INDEX idx_merge_ledger_status_pending ON merge_ledger(status) WHERE status != 'applied';
CREATE UNIQUE INDEX idx_merge_ledger_one_non_terminal_per_condition
  ON merge_ledger(condition_id) WHERE status != 'applied';
