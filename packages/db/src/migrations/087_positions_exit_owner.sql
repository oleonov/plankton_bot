-- Add exit_owner sticky-ownership marker to the positions table (Release A —
-- docs/plans/2026-07-23-release-a-exit-ownership.md).
--
-- One immutable field per position, decided ONCE at the position's first BUY
-- fill: 'bounce' (serviced only by the tiered bounce-exit ladder) or 'profile'
-- (today's complete non-bounce exit stack — ProfileLadder/S1/D8/D9/dust —
-- unchanged), or NULL (pre-activation / legacy → today's per-cycle routing until
-- the census backfills it). A reopened token gets a NEW position row, so
-- ownership dies with the cycle.
--
-- INERT until Release A's assignment + guards + flag land: this migration only
-- adds a NULL column, so no exit is routed by it yet. The repository excludes
-- exit_owner from its UPSERT DO UPDATE clause (write-once on INSERT); the trigger
-- below is defense-in-depth so a stray UPDATE can never mutate an owned position.
SELECT safe_add_column('positions', 'exit_owner', 'TEXT');

CREATE TRIGGER IF NOT EXISTS trg_positions_exit_owner_immutable
BEFORE UPDATE OF exit_owner ON positions
FOR EACH ROW
WHEN OLD.exit_owner IS NOT NULL AND (NEW.exit_owner IS NULL OR NEW.exit_owner <> OLD.exit_owner)
BEGIN
  SELECT RAISE(ABORT, 'exit_owner is immutable once set');
END;
