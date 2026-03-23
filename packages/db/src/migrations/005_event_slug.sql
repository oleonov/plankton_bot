-- 005_event_slug.sql
-- Add event_slug column to markets table.
-- The event slug is the parent event's URL slug on Polymarket,
-- distinct from the market-level slug used for pattern matching.

ALTER TABLE markets ADD COLUMN event_slug TEXT;
