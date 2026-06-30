-- 079_legacy_accounting_backfill_20260630.sql
--
-- Scoped accounting backfill for two legacy position-cycle UNKNOWN_ACCT rows.
-- This is data-only and intentionally affects only exact historical rows found
-- during the 2026-06-30 read-only accounting investigation.
--
-- ROLLBACK (manual, if this scoped backfill ever needs to be undone):
--   DELETE FROM pnl_ledger
--    WHERE fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
--      AND position_id = 'pos-34928863542604747577136069195537517831839938618288352858238947625130728675067-1779091115233';
--
--   DELETE FROM settlement_ledger
--    WHERE settlement_id = 'legacy-backfill-doge-20260630-pos-1776980204052';
--
-- Split-ledger live-lite DBs seeded the baseline migrations without physically
-- running migration 033, so pnl_ledger.family_id may still exist and be NOT NULL.
-- Fresh/post-033 DBs do not have the column. Keep the data backfill portable:
-- add the column only when needed, then write the legacy-family value required
-- by the older live schema.
SELECT safe_add_column('pnl_ledger', 'family_id', 'TEXT');

-- Case 1: "Will no listed leader be out before 2027?" / Yes.
-- Migration 066 restored the local position realized_pnl to include the orphan
-- sell fill 212af2ee...#maker:0, but did not add the matching pnl_ledger row.
-- Add that one missing FIFO delta so position-cycles can reconcile.
INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
WITH target AS (
  SELECT
    f.fill_id,
    p.position_id,
    COALESCE(
      (
        SELECT existing.family_id
          FROM pnl_ledger existing
         WHERE existing.position_id = p.position_id
           AND existing.family_id IS NOT NULL
           AND length(existing.family_id) > 0
         ORDER BY existing.id ASC
         LIMIT 1
      ),
      'legacy'
    ) AS family_id,
    0.12631 AS delta,
    f.filled_at
  FROM fills f
  JOIN positions p
    ON p.position_id = 'pos-34928863542604747577136069195537517831839938618288352858238947625130728675067-1779091115233'
  WHERE f.fill_id = '212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0'
    AND f.token_id = '34928863542604747577136069195537517831839938618288352858238947625130728675067'
    AND lower(f.side) = 'sell'
    AND abs(f.price - 0.023) < 0.0000001
    AND abs(f.size - 7.43) < 0.0000001
    AND abs(f.size_usdc - 0.17089) < 0.0000001
    AND p.token_id = f.token_id
    AND abs(p.realized_pnl - 1.105584) < 0.000001
    AND NOT EXISTS (
      SELECT 1
        FROM pnl_ledger existing
       WHERE existing.fill_id = f.fill_id
         AND existing.position_id = p.position_id
    )
)
SELECT fill_id, position_id, family_id, delta, filled_at
FROM target
WHERE family_id IS NOT NULL
  AND length(family_id) > 0;

-- Case 2: Dogecoin Up or Down - April 23, 5:30PM-5:35PM ET / Down.
-- Two closed duplicate same-token cycles exist. The first cycle already has its
-- losing settlement row; the second has realized_pnl=-0.525 but no settlement
-- ledger linkage. Add the missing row only for the exact second cycle.
INSERT INTO settlement_ledger (
  settlement_id,
  condition_id,
  position_id,
  token_id,
  resolution,
  settlement_price,
  size,
  delta,
  settled_at
)
SELECT
  'legacy-backfill-doge-20260630-pos-1776980204052',
  '0x63acbf4e10da74f77c5fde2ba04607af499531b5960cc879c4d6ee03ad66a07f',
  p.position_id,
  p.token_id,
  mr.resolution,
  0.0,
  52.5,
  -0.525,
  COALESCE(p.closed_at, '2026-04-23T21:39:24.426Z')
FROM positions p
JOIN market_resolutions mr
  ON mr.condition_id = '0x63acbf4e10da74f77c5fde2ba04607af499531b5960cc879c4d6ee03ad66a07f'
WHERE p.position_id = 'pos-83537444247216274574034531285415887826691018030217949635658894281737339757145-1776980204052'
  AND p.token_id = '83537444247216274574034531285415887826691018030217949635658894281737339757145'
  AND p.status = 'closed'
  AND abs(p.size) < 0.0000001
  AND abs(p.realized_pnl - -0.525) < 0.0000001
  AND EXISTS (
    SELECT 1
      FROM inventory_lots il
     WHERE il.position_id = p.position_id
       AND il.token_id = p.token_id
       AND abs(il.size - 52.5) < 0.0000001
       AND abs(il.cost_usdc - 0.525) < 0.0000001
  )
  AND NOT EXISTS (
    SELECT 1
      FROM settlement_ledger existing
     WHERE existing.settlement_id = 'legacy-backfill-doge-20260630-pos-1776980204052'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM settlement_ledger existing
     WHERE existing.position_id = p.position_id
       AND existing.token_id = p.token_id
  );
