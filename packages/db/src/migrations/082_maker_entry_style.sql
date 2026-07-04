-- Add entry_style provenance marker to the orders table.
--
-- Positions already have entry_style (migration 017). This adds the upstream
-- carrier so that order → fill → position propagation is plumbed in Phase 2
-- and activated in Phase 5 (micro-live BUYs). All existing orders receive
-- NULL (no marker); nothing sets "maker" until Phase 5.
SELECT safe_add_column('orders', 'entry_style', 'TEXT');
