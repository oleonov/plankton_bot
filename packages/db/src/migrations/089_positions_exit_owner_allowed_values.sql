-- Enforce the exit_owner allowed-value set on already-migrated DBs (Release A
-- Phase 3 — docs/plans/2026-07-24-release-a-phase3-owner-servicing.md).
--
-- Fresh databases get a column-level CHECK (exit_owner IN ('bounce','profile') OR
-- exit_owner IS NULL) directly from ledger.sql. SQLite cannot ALTER-ADD a CHECK to
-- an existing column, and migration 087 (which created exit_owner CHECK-less) is
-- already applied and will not rerun — so upgraded databases enforce the same
-- invariant via triggers instead. Immutability is already covered by 087's
-- trg_positions_exit_owner_immutable; these triggers only bound the value set, so a
-- stray write of an out-of-range non-NULL value (which the runtime would otherwise
-- treat as non-bounce) can never land as a live-money invariant.
CREATE TRIGGER IF NOT EXISTS trg_positions_exit_owner_allowed_insert
BEFORE INSERT ON positions
FOR EACH ROW
WHEN NEW.exit_owner IS NOT NULL AND NEW.exit_owner NOT IN ('bounce', 'profile')
BEGIN
  SELECT RAISE(ABORT, 'exit_owner must be bounce, profile, or NULL');
END;

CREATE TRIGGER IF NOT EXISTS trg_positions_exit_owner_allowed_update
BEFORE UPDATE OF exit_owner ON positions
FOR EACH ROW
WHEN NEW.exit_owner IS NOT NULL AND NEW.exit_owner NOT IN ('bounce', 'profile')
BEGIN
  SELECT RAISE(ABORT, 'exit_owner must be bounce, profile, or NULL');
END;
