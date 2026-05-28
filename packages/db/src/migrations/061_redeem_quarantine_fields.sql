-- Defensive repair for legacy split-ledger bootstraps that record migration 029
-- as baseline but still carry the pre-condition positions shape.
SELECT safe_add_column('positions', 'condition_id', 'TEXT');

SELECT safe_add_column('positions', 'consecutive_state_failed_count', 'INTEGER NOT NULL DEFAULT 0');
SELECT safe_add_column('positions', 'redeem_quarantine_until_ts', 'INTEGER');
SELECT safe_add_column('positions', 'last_state_failed_ts', 'INTEGER');

CREATE INDEX IF NOT EXISTS idx_positions_redeem_quarantine_until
  ON positions(redeem_quarantine_until_ts)
  WHERE redeem_quarantine_until_ts IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_positions_condition_redeem_quarantine
  ON positions(condition_id, redeem_quarantine_until_ts);
