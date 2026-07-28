import type { Database } from "better-sqlite3";

/**
 * Release A Phase 5 — post-activation ownership invariant.
 *
 * Thrown when `bounceExit.applyToAllMarkets` is enabled but the ledger still holds
 * an active/dust position with a NULL `exit_owner`. Under owner-authoritative
 * servicing such a position is legacy-routed (profile) rather than bounce, silently
 * violating the bounce-for-all intent — so the runtime hard-stops instead of trading
 * it. The operator re-runs the census to backfill ownership before resuming.
 */
export class BounceForAllNullOwnerError extends Error {
  constructor(public readonly nullOwners: number) {
    super(
      `bounceExit.applyToAllMarkets is enabled but ${nullOwners} active/dust position(s) still have NULL exit_owner — run the census to backfill ownership before resuming`,
    );
    this.name = "BounceForAllNullOwnerError";
  }
}

/** Count active/dust positions with an unassigned (NULL) exit owner. */
export function countActiveNullOwnerPositions(ledgerDb: Database): number {
  const { n } = ledgerDb
    .prepare(
      `SELECT COUNT(*) AS n FROM positions WHERE exit_owner IS NULL AND status IN ('open', 'dust')`,
    )
    .get() as { n: number };
  return n;
}

/**
 * Fail-closed startup guard: when `applyToAllMarkets` is active, EVERY active/dust
 * position must have an assigned owner. Throws {@link BounceForAllNullOwnerError} if
 * any NULL owner remains. A no-op when the flag is off (whitelist-only assignment —
 * NULL owners are legitimate pre-census legacy positions).
 */
export function assertBounceForAllOwnershipInvariant(
  ledgerDb: Database,
  applyToAllMarkets: boolean,
): void {
  if (applyToAllMarkets !== true) return;
  const nullOwners = countActiveNullOwnerPositions(ledgerDb);
  if (nullOwners > 0) throw new BounceForAllNullOwnerError(nullOwners);
}
