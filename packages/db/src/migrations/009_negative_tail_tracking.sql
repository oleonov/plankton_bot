-- 009_negative_tail_tracking.sql
-- Track when tail first went negative for horizon-aware demotion windows.

ALTER TABLE family_runtime_state ADD COLUMN first_negative_tail_at TEXT;
