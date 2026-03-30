-- 012_proposal_profile_scorecard.sql
-- Add profile + source_scorecard_id to promotion_proposals for control evaluator.
-- Control.db already has these columns; this migration adds them to the ledger schema.

ALTER TABLE promotion_proposals ADD COLUMN profile TEXT;
ALTER TABLE promotion_proposals ADD COLUMN source_scorecard_id TEXT;

-- Replace the per-family unique index with per (family, profile) unique index.
-- SQLite cannot DROP INDEX IF EXISTS + recreate in a conditional way,
-- so we drop the old one and create the new one unconditionally.
DROP INDEX IF EXISTS idx_proposals_one_pending_per_family;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_one_pending_per_family_profile
  ON promotion_proposals(family_id, profile) WHERE status = 'pending' AND profile IS NOT NULL;
-- SQLite NULLs are distinct in unique indexes, so we need a separate index for NULL profile
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_one_pending_per_family_null_profile
  ON promotion_proposals(family_id) WHERE status = 'pending' AND profile IS NULL;
