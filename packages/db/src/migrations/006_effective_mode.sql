-- 006_effective_mode.sql
-- Add effective runtime mode (computed from tail health) and its reason.
-- Separate from runtime_mode which is operator-set only.

ALTER TABLE family_runtime_state ADD COLUMN effective_mode TEXT;
ALTER TABLE family_runtime_state ADD COLUMN derived_mode_reason TEXT;
