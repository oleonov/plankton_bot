-- 023_family_throughput_policy.sql
-- Adds optional per-family throughput policy knobs. NULL preserves the
-- runtime's tier fallback behavior for existing families.

ALTER TABLE family_rules ADD COLUMN max_concurrent_orders_per_family INTEGER;
ALTER TABLE family_rules ADD COLUMN max_probe_in_flight_per_token INTEGER;
ALTER TABLE family_rules ADD COLUMN max_entry_signals_per_tick_per_family INTEGER;
