-- 007_discovery_existing_alters.sql
-- Extends existing tables for family discovery system.

-- orders: persist signal reason for repricing exit tracking
ALTER TABLE orders ADD COLUMN signal_reason TEXT;

-- operator_commands: distinguish system vs operator initiated
ALTER TABLE operator_commands ADD COLUMN initiator_type TEXT NOT NULL DEFAULT 'operator';
ALTER TABLE operator_commands ADD COLUMN initiator TEXT;

-- pnl_ledger: index for per-family recycle score queries
CREATE INDEX IF NOT EXISTS idx_pnl_ledger_family ON pnl_ledger(family_id);

-- family_evidence: normalized score columns
ALTER TABLE family_evidence ADD COLUMN recurrence_score REAL;
ALTER TABLE family_evidence ADD COLUMN recycle_score REAL;
ALTER TABLE family_evidence ADD COLUMN live_viability_score REAL;
ALTER TABLE family_evidence ADD COLUMN toxicity_penalty REAL;
ALTER TABLE family_evidence ADD COLUMN scores_updated_at TEXT;
