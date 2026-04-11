-- 024_family_fast_lane.sql
-- Adds an optional per-family fast-lane flag. NULL preserves standard behavior.

ALTER TABLE family_rules ADD COLUMN fast_lane_enabled INTEGER;
