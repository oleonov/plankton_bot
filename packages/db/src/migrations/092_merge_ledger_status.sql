-- Write-ahead merge intent (r26-M1). Before this migration, InventoryManagerModule submitted the
-- on-chain merge via gateway.mergePositions() and only AFTER it resolved did
-- MergeSettler.applyMerge() write the merge_ledger row — inside the same transaction as the
-- position/lot mutations. A process that dies in the gap between submission and that transaction
-- (SIGKILL, OOM, the supervisor's 40s shutdown budget running out) left the merge irrevocably on
-- chain with NO local record at all: nothing downstream could even tell it had happened, let alone
-- reconcile it.
--
-- `status` turns that silent gap into a discoverable one by recording the merge's INTENT before the
-- on-chain call, then advancing it in lockstep with the real-world event:
--   'pending' — written and committed in its own transaction BEFORE gateway.mergePositions() is
--               called, so the intent is durable before the submission ever leaves the process.
--               Ambiguous by construction (the on-chain call may or may not have landed) — it must
--               be surfaced distinctly from 'onchain', never silently collapsed into it or
--               auto-applied.
--   'onchain' — set immediately after gateway.mergePositions() resolves successfully. A row still
--               here at startup is UNAMBIGUOUS divergence: the chain moved and the local ledger did
--               not — exactly the state a recovery/alert path can act on without guessing.
--   'applied' — set in the same transaction as the position/lot mutations, inside
--               MergeSettler.applyMerge(). Consistent; nothing to do.
-- The 'pending' row does not PREVENT the divergence — nothing can, since the chain is not
-- transactional with SQLite. Its job is only to guarantee the divergence is always discoverable.
--
-- DEFAULT 'applied' is deliberate: every row that existed before this migration was written only
-- once a merge had already completed (the old save() call sat inside applyMerge's transaction), so
-- backfilling them as 'applied' preserves exactly what they already meant, instead of manufacturing
-- pending/onchain history that never happened.
SELECT safe_add_column('merge_ledger', 'status', 'TEXT NOT NULL DEFAULT ''applied'' CHECK (status IN (''pending'', ''onchain'', ''applied''))');

-- Startup reconciliation asks "which rows are NOT yet applied" — a partial index over the
-- non-terminal rows keeps that a near-constant lookup once the table is dominated (as it will be in
-- steady state) by terminal 'applied' rows, instead of a full-table scan.
CREATE INDEX IF NOT EXISTS idx_merge_ledger_status_pending
  ON merge_ledger(status) WHERE status != 'applied';
