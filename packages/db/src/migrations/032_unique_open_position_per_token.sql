-- Enforce "at most one open row per token" as a DB invariant.
--
-- The contract was previously upheld only by convention in PositionRepository
-- and InventoryHandler.applyBuyFill's findByTokenId-merge path. This partial
-- unique index turns any violation into a SQLITE_CONSTRAINT error, preventing
-- silent exposure drift from aberrant writes (direct SQL, recovery scripts,
-- concurrent applyFill races).
--
-- Repair pre-existing violations first: collapse duplicate opens by closing
-- all but the canonical row. Winner selection matches PositionRepository
-- .findByTokenId (packages/db/src/repositories/position-repository.ts:55) which
-- uses `ORDER BY opened_at DESC LIMIT 1`. Tie-breaker `position_id DESC`
-- deterministically resolves rows with identical opened_at (where the
-- repository currently defers to SQLite's implementation-defined order).

UPDATE positions
   SET status = 'closed',
       closed_at = COALESCE(closed_at, datetime('now')),
       updated_at = datetime('now')
 WHERE position_id IN (
   SELECT p1.position_id
     FROM positions p1
     JOIN positions p2
       ON p1.token_id = p2.token_id
      AND p1.status = 'open'
      AND p2.status = 'open'
      AND (
            p1.opened_at < p2.opened_at
         OR (p1.opened_at = p2.opened_at AND p1.position_id < p2.position_id)
      )
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique_open_per_token
  ON positions(token_id) WHERE status = 'open';
