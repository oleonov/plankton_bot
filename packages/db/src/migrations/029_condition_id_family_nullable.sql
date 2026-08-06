-- Add condition_id to orders, fills, positions.
-- Make family_id nullable on orders, fills, positions, inventory_lots.
--
-- SQLite does not support ALTER COLUMN to change nullability on existing columns.
-- For family_id: we must rebuild tables to remove the NOT NULL constraint.
-- For condition_id: added during the rebuild.
--
-- Existing rows keep their non-null family_id values.
-- Existing rows get condition_id = '' (empty string) as a migration default.
-- New inserts always provide the real conditionId.
-- The audit guarantee (conditionId always present) applies to newly written rows only.
--
-- 2026-08-05: the timestamp DEFAULTs below were changed from `datetime('now')` to ISO-8601.
-- Editing an already-applied migration is safe here because this file cannot re-run on any
-- existing DB: migrations are keyed by filename in `schema_migrations`, and `bootstrapLedgerDb`
-- lists 029 in LEDGER_BASELINE_MIGRATIONS so it never executes on the production split DB at all.
-- It only shapes fresh DBs built by `bootstrapDatabase` (the legacy merged path — scenario runner
-- and the test suites), which is exactly where the wrong default was still reachable.
-- Why it matters: readers bound and order on these columns, and SQLite's space format sorts BELOW
-- any same-day ISO string (`' '` 0x20 < `'T'` 0x54), so one row written by the DEFAULT would break
-- every `MAX()`/`> ?`/`ORDER BY` over the column. See db-timestamp.ts.

-- ═══ ORDERS: rebuild to make family_id nullable + add condition_id ═══

CREATE TABLE orders_new (
  order_id           TEXT PRIMARY KEY,
  client_order_id    TEXT NOT NULL UNIQUE,
  token_id           TEXT NOT NULL,
  family_id          TEXT,
  condition_id       TEXT NOT NULL DEFAULT '',
  side               TEXT NOT NULL,
  order_type         TEXT NOT NULL,
  post_only          INTEGER NOT NULL DEFAULT 0,
  price              REAL NOT NULL,
  size               REAL NOT NULL,
  size_usdc          REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  exchange_order_id  TEXT,
  signal_id          TEXT,
  signal_reason      TEXT,
  bot_run_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO orders_new SELECT
  order_id, client_order_id, token_id, family_id, '' AS condition_id,
  side, order_type, post_only, price, size, size_usdc, status,
  exchange_order_id, signal_id, signal_reason, bot_run_id, created_at, updated_at
FROM orders;

DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_family ON orders(family_id);
CREATE INDEX IF NOT EXISTS idx_orders_token ON orders(token_id);
CREATE INDEX IF NOT EXISTS idx_orders_client_oid ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_exchange_oid ON orders(exchange_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_bot_run ON orders(bot_run_id);

-- ═══ FILLS: rebuild to make family_id nullable + add condition_id ═══

CREATE TABLE fills_new (
  fill_id      TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(order_id),
  token_id     TEXT NOT NULL,
  family_id    TEXT,
  condition_id TEXT NOT NULL DEFAULT '',
  side         TEXT NOT NULL,
  price        REAL NOT NULL,
  size         REAL NOT NULL,
  size_usdc    REAL NOT NULL,
  liquidity_role TEXT NOT NULL DEFAULT 'unknown',
  fee          REAL NOT NULL DEFAULT 0,
  fee_rate_bps REAL NOT NULL DEFAULT 0,
  reconciled   INTEGER NOT NULL DEFAULT 0,
  filled_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO fills_new SELECT
  fill_id, order_id, token_id, family_id, '' AS condition_id,
  side, price, size, size_usdc, liquidity_role, fee, fee_rate_bps,
  reconciled, filled_at
FROM fills;

DROP TABLE fills;
ALTER TABLE fills_new RENAME TO fills;

CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_family ON fills(family_id);
CREATE INDEX IF NOT EXISTS idx_fills_token ON fills(token_id);
CREATE INDEX IF NOT EXISTS idx_fills_filled_at ON fills(filled_at DESC);
CREATE INDEX IF NOT EXISTS idx_fills_unreconciled ON fills(reconciled) WHERE reconciled = 0;

-- ═══ POSITIONS: rebuild to make family_id nullable + add condition_id ═══

CREATE TABLE positions_new (
  position_id        TEXT PRIMARY KEY,
  token_id           TEXT NOT NULL,
  family_id          TEXT,
  condition_id       TEXT NOT NULL DEFAULT '',
  side               TEXT NOT NULL,
  size               REAL NOT NULL DEFAULT 0,
  avg_entry_price    REAL NOT NULL DEFAULT 0,
  cost_basis_usdc    REAL NOT NULL DEFAULT 0,
  current_value_usdc REAL,
  realized_pnl       REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open',
  entry_style        TEXT,
  opened_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at          TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO positions_new SELECT
  position_id, token_id, family_id, '' AS condition_id,
  side, size, avg_entry_price, cost_basis_usdc, current_value_usdc,
  realized_pnl, status, entry_style, opened_at, closed_at, updated_at
FROM positions;

DROP TABLE positions;
ALTER TABLE positions_new RENAME TO positions;

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_family ON positions(family_id);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_id);

-- ═══ INVENTORY_LOTS: rebuild to make family_id nullable (no condition_id) ═══

CREATE TABLE inventory_lots_new (
  lot_id          TEXT PRIMARY KEY,
  position_id     TEXT NOT NULL REFERENCES positions(position_id),
  token_id        TEXT NOT NULL,
  family_id       TEXT,
  side            TEXT NOT NULL,
  size            REAL NOT NULL,
  remaining_size  REAL NOT NULL,
  entry_price     REAL NOT NULL,
  cost_usdc       REAL NOT NULL,
  fill_id         TEXT NOT NULL REFERENCES fills(fill_id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO inventory_lots_new SELECT * FROM inventory_lots;

DROP TABLE inventory_lots;
ALTER TABLE inventory_lots_new RENAME TO inventory_lots;

CREATE INDEX IF NOT EXISTS idx_inventory_lots_position ON inventory_lots(position_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_token ON inventory_lots(token_id);
