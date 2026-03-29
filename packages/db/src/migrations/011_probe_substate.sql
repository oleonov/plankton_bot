-- 011_probe_substate.sql
ALTER TABLE family_evidence ADD COLUMN probe_substate TEXT;
ALTER TABLE family_evidence ADD COLUMN repricing_exit_count INTEGER NOT NULL DEFAULT 0;
