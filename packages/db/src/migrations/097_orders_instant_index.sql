-- `apps/api/src/routes/events.ts` (the SSE endpoint) reads `orders.updated_at` through
-- `ledgerInstant()` rather than the raw column, for the same reason migration 095 normalized it:
-- the live ledger carries 38,454 canonical-ISO rows and 29,670 legacy SQLite-space rows, and
-- `' '` (0x20) < `'T'` (0x54) makes a raw `MAX()`/`> ?`/`ORDER BY` return the OLDER row whenever
-- both renderings land on the same calendar day — that split is what stalled the
-- order:filled/order:cancelled stream. Wrapping it is correct, but it discards any index on the
-- raw column, and `takeSnapshot()` runs `MAX(ledgerInstant("updated_at"))` on EVERY ~2 s tick of
-- EVERY SSE connection, with the delta query (`WHERE … > ? ORDER BY … DESC LIMIT 20`) following
-- right behind it whenever a row actually changed — both over a 101,107-row table with no index on
-- `updated_at` at all. Measured: 34-39 ms raw vs 50-52 ms wrapped, unaffordable per tick.
--
-- This expression index restores both call sites. Verified on the pinned SQLite 3.51.3: the bare
-- `MAX()` becomes `SEARCH orders USING COVERING INDEX idx_orders_updated_instant` instead of a full
-- table scan, and the range query becomes `SEARCH orders USING INDEX idx_orders_updated_instant
-- (<expr>>?)` instead of `SCAN orders` + `USE TEMP B-TREE FOR ORDER BY`.
--
-- It must stay byte-identical to `ledgerInstant("updated_at")` in packages/db/src/db-timestamp.ts;
-- SQLite matches expression indexes by expression, so any drift silently costs the seek.
CREATE INDEX IF NOT EXISTS idx_orders_updated_instant
  ON orders(julianday(replace(updated_at, '+00', '')) DESC);
