-- Enforce "at most one open row per token" as a DB invariant.
--
-- The contract was previously upheld only by convention in PositionRepository
-- and InventoryHandler.applyBuyFill's findByTokenId-merge path. This partial
-- unique index turns any violation into a SQLITE_CONSTRAINT error, preventing
-- silent exposure drift from aberrant writes (direct SQL, recovery scripts,
-- concurrent applyFill races).
--
-- Repair pre-existing violations first: collapse duplicate opens by closing
-- all but the canonical row — the chronologically newest one, matching
-- PositionRepository.findByTokenId (position-repository.ts:55). Tie-breaker
-- `position_id DESC` deterministically resolves rows with identical opened_at.
-- The repository deferred to SQLite's implementation-defined order when this
-- migration was written; findByTokenId and findActiveByTokenId now carry the same
-- tie-breaker, so all three ranking sites agree.
--
-- The winner is picked by INSTANT, not by text. This migration is not inert: it is
-- baselined away only for `bootstrapLedgerDb`, while `bootstrapDatabase` runs every
-- unapplied migration against an existing legacy merged DB, so an install that
-- stopped before 032 executes this UPDATE against real rows. On that path
-- `opened_at` genuinely carries both renderings — 001_initial.sql:245 defaulted the
-- column to `datetime('now')` and only 029 switched it to ISO — and within one
-- calendar day SQLite's space format sorts BELOW any ISO string (`' '` 0x20 <
-- `'T'` 0x54), so a text comparison would close the chronologically NEWER row.
-- `julianday(replace(...))` is `ledgerInstant()` inlined; migrations cannot import
-- from db-timestamp.ts, so the expression is spelled out. It cannot go NULL here:
-- `opened_at` is NOT NULL in every schema version and only ever holds one of those
-- two renderings, both of which julianday() parses.
--
-- Timestamps are written ISO-8601, not `datetime('now')`, for the same reason: a
-- repair row in space format would break `MAX()`/`> ?`/`ORDER BY` over the column.

UPDATE positions
   SET status = 'closed',
       closed_at = COALESCE(closed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE position_id IN (
   SELECT p1.position_id
     FROM positions p1
     JOIN positions p2
       ON p1.token_id = p2.token_id
      AND p1.status = 'open'
      AND p2.status = 'open'
      AND (
            julianday(replace(p1.opened_at, '+00', ''))
              < julianday(replace(p2.opened_at, '+00', ''))
         OR (julianday(replace(p1.opened_at, '+00', ''))
               = julianday(replace(p2.opened_at, '+00', ''))
             AND p1.position_id < p2.position_id)
      )
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique_open_per_token
  ON positions(token_id) WHERE status = 'open';
