-- Add position_id to the orders table (Release A Phase 3 — full-prevention re-arch,
-- docs/plans/2026-07-24-release-a-phase3-owner-servicing.md).
--
-- Persists the EXACT originating position identity on every order so the executor
-- can scope cancel / replace / bounce-backstop by position CYCLE instead of by
-- token, and reject a stale cross-cycle command (a queued order from a closed
-- position cycle A must not act on a reopened cycle B that happens to share the
-- token). NULL = legacy / pre-migration order (cannot be matched → treated
-- conservatively as stale by the startup fence).
--
-- Additive and inert on its own: nothing reads position_id until the P2 producers
-- start stamping it and the P5 boundaries start validating it, all landing in the
-- same atomic Release A.
SELECT safe_add_column('orders', 'position_id', 'TEXT');

CREATE INDEX IF NOT EXISTS idx_orders_position ON orders(position_id);
