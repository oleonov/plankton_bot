-- 004_resolution_status.sql
-- Add status tracking to market_resolutions for settlement retry.
-- Default 'settled' for existing rows (already fully processed).

ALTER TABLE market_resolutions ADD COLUMN status TEXT NOT NULL DEFAULT 'settled';
