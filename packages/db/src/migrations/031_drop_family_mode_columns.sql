-- Drop legacy per-family governance-mode columns from the legacy merged DB.
--
-- Pass 1 (previous work) stripped the API, web, and runtime surface area that
-- read runtime_mode / quarantine_reason / effective_mode / derived_mode_reason
-- on family_runtime_state. With no meaningful reads left, the columns are now
-- removed from the ledger schema entirely.
--
-- Note: family_profile_runtime_state lives only in the split ledger schema
-- (packages/db/src/schemas/ledger.sql), which is applied fresh from the
-- cumulative file — no migration is needed for that table here.

ALTER TABLE family_runtime_state DROP COLUMN runtime_mode;
ALTER TABLE family_runtime_state DROP COLUMN quarantine_reason;
ALTER TABLE family_runtime_state DROP COLUMN effective_mode;
ALTER TABLE family_runtime_state DROP COLUMN derived_mode_reason;
