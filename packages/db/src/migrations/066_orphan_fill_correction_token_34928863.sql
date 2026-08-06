-- 066_orphan_fill_correction_token_34928863.sql
--
-- One-time forensic data correction for the orphan sell-fill loop on token
-- 34928863…675067 (slug will-no-listed-leader-be-out-before-2027-147).
-- Full audit + reconciliation plan ("State X"):
--   research_plankton/inventory_drift_investigation_2026-06-10.md (§6-8).
--
-- `updated_at` is written ISO-8601, not `datetime('now')`: every other writer of
-- positions/leg_states/orders emits ISO, and the space format sorts BELOW any same-day
-- ISO string, breaking `MAX()`/`> ?`/`ORDER BY` over the column. See db-timestamp.ts.
--
-- Pathology: a repricing-exit SELL (order 0xe43fd65351bf) filled 7.43 @ 0.023
-- on-chain after the local order was cancelled (race) -> orphan fill
-- 212af2ee…#maker:0 with no local order, reconciled=0. On each restart, startup
-- adoption deleted the synthetic adoption order, rebuilt the position from the
-- current lots only, then re-replayed the 7.43 via consumeFifo, over-consuming
-- lots down to ~0.001 and finally throwing
-- "Insufficient inventory: requested 7.43, available 0.0009999…". Self-perpetuating.
-- No fund loss: the wallet holds 22.291 shares (MORE than the ledger's 0.001);
-- the $0.41 was untracked, never leaked.
--
-- This migration restores the ledger to the wallet-confirmed net:
--   net buys 122.972 − net sells 100.681 = 22.291 shares (all @0.006, FIFO-newest survive).
--
-- IDEMPOTENCY: ops 1-6 are gated on the orphan fill still being UNRECONCILED
-- (EXISTS … AND reconciled = 0). Op 7 flips reconciled -> 1 and MUST run LAST so
-- the gate stays satisfied for ops 1-6 within this single-transaction migration
-- (the runner wraps the whole file in one db.transaction, so there is no
-- BEGIN/COMMIT here). On any re-run the fill is already reconciled -> every gate
-- is false -> zero rows change. On sim/paper ledgers the orphan fill is absent
-- -> the same gate makes the whole migration a clean no-op.
--
-- ROLLBACK (manual, should never be needed — nothing is deleted, only restored;
-- values below are the documented pre-state from the investigation §6-8):
--   UPDATE fills SET reconciled = 0
--    WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0';
--   UPDATE inventory_lots SET remaining_size = 0.0009999
--    WHERE lot_id = 'lot-3f38410b-a321-45d3-be92-cc0badf86292#maker:0';
--   UPDATE inventory_lots SET remaining_size = 0
--    WHERE lot_id IN ('lot-1ff2d9ae-2563-494b-90b8-69c66ccd9bc1#maker:0',
--                     'lot-c6bd9df0-55cb-4556-9e9d-f84b8631470f#maker:0');
--   UPDATE positions SET size = 0.0009999, realized_pnl = 0.778664
--    WHERE position_id = 'pos-34928863542604747577136069195537517831839938618288352858238947625130728675067-1779091115233';
--   UPDATE leg_states SET sell_count = 5, cumulative_sell_size = 93.251
--    WHERE token_id = '34928863542604747577136069195537517831839938618288352858238947625130728675067';
--   UPDATE orders SET signal_reason = 'startup-adoption'
--    WHERE token_id = '34928863542604747577136069195537517831839938618288352858238947625130728675067'
--      AND signal_reason = 'orphan-reconciled-20260610';

-- 1-3. Restore inventory_lots to the true net 22.291 on the 3 newest @0.006 buy
--      lots (price-identical, so the distribution across them is economically neutral).
UPDATE inventory_lots
   SET remaining_size = 13.0
 WHERE lot_id = 'lot-3f38410b-a321-45d3-be92-cc0badf86292#maker:0'
   AND EXISTS (
     SELECT 1 FROM fills
      WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
        AND reconciled = 0
   );

UPDATE inventory_lots
   SET remaining_size = 7.0
 WHERE lot_id = 'lot-1ff2d9ae-2563-494b-90b8-69c66ccd9bc1#maker:0'
   AND EXISTS (
     SELECT 1 FROM fills
      WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
        AND reconciled = 0
   );

UPDATE inventory_lots
   SET remaining_size = 2.291
 WHERE lot_id = 'lot-c6bd9df0-55cb-4556-9e9d-f84b8631470f#maker:0'
   AND EXISTS (
     SELECT 1 FROM fills
      WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
        AND reconciled = 0
   );

-- 4. Restore the open position to the wallet-confirmed net + realized pnl
--    (0.904974 = 0.778664 prior + the orphan 7.43 sell credit 0.12631). Set
--    directly: after op 6 neutralizes signal_reason the startup-adoption cleanup
--    never re-runs rebuildTokenPosition for this token, so this value is durable.
UPDATE positions
   SET size = 22.291,
       avg_entry_price = 0.006,
       cost_basis_usdc = 0.133746,
       current_value_usdc = 0.4123,
       realized_pnl = 0.904974,
       status = 'open',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE position_id = 'pos-34928863542604747577136069195537517831839938618288352858238947625130728675067-1779091115233'
   AND EXISTS (
     SELECT 1 FROM fills
      WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
        AND reconciled = 0
   );

-- 5. Record the 6th (orphan) sell in the per-token leg-state aggregate
--    (100.681 = 93.251 prior five sells + the orphan 7.43).
UPDATE leg_states
   SET sell_count = 6,
       cumulative_sell_size = 100.681,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE token_id = '34928863542604747577136069195537517831839938618288352858238947625130728675067'
   AND EXISTS (
     SELECT 1 FROM fills
      WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
        AND reconciled = 0
   );

-- 6. Neutralize the synthetic startup-adoption order so the cleanup loop can no
--    longer re-adopt this token (belt; the B1 code guard is the suspenders).
UPDATE orders
   SET signal_reason = 'orphan-reconciled-20260610',
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE token_id = '34928863542604747577136069195537517831839938618288352858238947625130728675067'
   AND signal_reason = 'startup-adoption'
   AND lower(side) = 'sell'
   AND EXISTS (
     SELECT 1 FROM fills
      WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
        AND reconciled = 0
   );

-- 7. LAST: mark the orphan sell-fill reconciled. Must run last so the EXISTS
--    gate above stays true for ops 1-6 in this transaction; on replay the
--    `reconciled = 0` predicate matches nothing -> the migration is idempotent.
UPDATE fills
   SET reconciled = 1
 WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
   AND reconciled = 0;
