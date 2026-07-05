-- Extend maker_shadow_orders with ladder / level tracking and a separate fill timestamp.
--
-- safe_add_column is idempotent: it is a no-op when the column already exists, which
-- happens on fresh installs where ledger.sql has already been applied first.
-- See packages/db/src/bootstrap.ts for the safe_add_column helper.

SELECT safe_add_column('maker_shadow_orders', 'ladder_id', 'TEXT');
SELECT safe_add_column('maker_shadow_orders', 'level_index', 'INTEGER');
SELECT safe_add_column('maker_shadow_orders', 'filled_at', 'TEXT');

-- Backfill pre-Phase-1 rows: each was a standalone level-0, so it forms its own
-- single-entry ladder.  updated_at is the best available proxy for filled_at on
-- rows that already transitioned to 'filled' before this migration ran.

UPDATE maker_shadow_orders
   SET ladder_id = shadow_order_id
 WHERE ladder_id IS NULL;

UPDATE maker_shadow_orders
   SET level_index = 0
 WHERE level_index IS NULL;

UPDATE maker_shadow_orders
   SET filled_at = updated_at
 WHERE stage = 'filled'
   AND filled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_maker_shadow_orders_ladder
  ON maker_shadow_orders (ladder_id, level_index);
