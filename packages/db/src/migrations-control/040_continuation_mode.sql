-- ADR-016: DB-backed Post-Entry Continuation Filter mode toggle.
-- 'leg_local'   → ADR-010 D1 behavior (legState.buyCount + sellCount).
-- 'market_wide' → spec-aligned trade_count via DataApiTradeCountProvider.
--
-- Default 'leg_local' preserves status-quo on rollout. Operator flips to
-- 'market_wide' via POST /api/v1/runtime/policy. Hot-reload follows the
-- selection_rules / execution_policy version pattern: a paired version
-- column drives polling so changes propagate without restart.

ALTER TABLE runtime_control_state
  ADD COLUMN continuation_mode TEXT NOT NULL DEFAULT 'leg_local'
  CHECK (continuation_mode IN ('leg_local', 'market_wide'));

ALTER TABLE runtime_control_state
  ADD COLUMN continuation_mode_version INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1);
