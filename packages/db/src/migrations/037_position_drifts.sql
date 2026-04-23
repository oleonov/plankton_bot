-- Phase 3.A: Position drift ledger — independent sensor that compares the
-- local `settlement_ledger` view of algo-redeemed positions against the
-- on-chain outcome-token balance. A non-zero balance after local settle
-- means the redeem transaction never cleared the position on-chain.
--
-- Keyed on `settlement_id` (FK to settlement_ledger) so each ledger row has
-- at most one drift record. `on_chain_balance` stays TEXT to preserve the
-- raw bigint from getOutcomeTokenBalance without float rounding, matching
-- the PositionDriftDetected event payload shape.

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
