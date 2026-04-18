-- Phase 7.2: Drop family runtime-state tables from the ledger DB.
--
-- family_runtime_state was the original (merged-DB era) per-family aggregate.
-- family_profile_runtime_state is its split-ledger successor.
-- Both tables are superseded by selection-rule-based approaches and are no
-- longer read or written by any runtime code as of Phase 6.

DROP TABLE IF EXISTS family_runtime_state;
DROP TABLE IF EXISTS family_profile_runtime_state;
