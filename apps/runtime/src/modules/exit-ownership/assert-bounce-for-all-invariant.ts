import {
  formatOwnershipInvariantBreakdown,
  formatOwnershipInvariantRemedy,
  hasOwnershipInvariantViolation,
  readOwnershipInvariantViolations,
  type OwnershipInvariantId,
} from "@krabs/db";
import type { Database } from "better-sqlite3";

/**
 * Release A Phase 5 — post-activation ownership invariant, widened to I1–I5 in Phase 6 (§9a).
 *
 * Thrown when `bounceExit.applyToAllMarkets` is enabled but the ledger violates any exit-ownership
 * invariant. The original class — an active position with a NULL `exit_owner` — is legacy-routed
 * (profile) rather than bounce under owner-authoritative servicing, silently violating the
 * bounce-for-all intent. The five structural classes (I1–I5) are worse: a SELL bound to nothing, to
 * a non-current position, or carrying the other owner's rule id is already resting on the exchange,
 * and placement guards never revisit a resting order. So the runtime hard-stops instead of trading
 * it, and the operator repairs the ledger before resuming — per class, because the census writes only
 * `positions.exit_owner` and the other five live in `orders`/`positions` rows it never touches.
 *
 * The name and the `nullOwners` field are kept: the field is what the fatal log has always
 * reported, and `counts` is what makes the five new classes nameable rather than "some violation".
 */
export class BounceForAllNullOwnerError extends Error {
  readonly nullOwners: number;

  constructor(public readonly counts: Readonly<Record<OwnershipInvariantId, number>>) {
    super(
      `bounceExit.applyToAllMarkets is enabled but the ledger violates exit-ownership invariants (${formatOwnershipInvariantBreakdown(counts)}) — ${formatOwnershipInvariantRemedy(counts)}`,
    );
    this.name = "BounceForAllNullOwnerError";
    this.nullOwners = counts.nullOwners;
  }
}

/** Count active positions with an unassigned (NULL) exit owner. */
export function countActiveNullOwnerPositions(ledgerDb: Database): number {
  return readOwnershipInvariantViolations(ledgerDb).counts.nullOwners;
}

/**
 * Fail-closed startup guard: when `applyToAllMarkets` is active, EVERY active position must have an
 * assigned owner AND the ledger must be structurally consistent (I1–I5). Throws
 * {@link BounceForAllNullOwnerError} carrying the full breakdown. A no-op when the flag is off
 * (whitelist-only assignment — NULL owners are legitimate pre-census legacy positions, and the
 * widening must stay inert while disabled).
 */
export function assertBounceForAllOwnershipInvariant(
  ledgerDb: Database,
  applyToAllMarkets: boolean,
): void {
  if (applyToAllMarkets !== true) return;
  const violations = readOwnershipInvariantViolations(ledgerDb);
  if (hasOwnershipInvariantViolation(violations)) {
    throw new BounceForAllNullOwnerError(violations.counts);
  }
}

/** Structural — the startup gate needs two pino levels, and a test needs to record both. */
interface StartupGateLogger {
  error(obj: object, msg: string): void;
  fatal(obj: object, msg: string): void;
}

export interface OwnershipInvariantStartupGate {
  ledgerDb: Database;
  controlDb: Database;
  applyToAllMarkets: boolean;
  log: StartupGateLogger;
}

/**
 * The boot-time half of the guard: assert, and on ANY escaping error leave `control.db` in a state
 * a deploy resume-intent cannot act on.
 *
 * The persist is unconditional and comes FIRST. The widened reader runs six queries against a
 * multi-GB ledger, so it can throw something that is not a {@link BounceForAllNullOwnerError} — a
 * prepare failure, a schema/migration mismatch, an I/O error. Before Phase 6 such an error skipped
 * the typed `catch` entirely and reached the top-level handler, which exits WITHOUT persisting,
 * leaving `runtime_status='running'`.
 *
 * The inner `try/catch` is the load-bearing half: an unwritable/locked `control.db` must not
 * replace the error being reported, or the operator debugs a SQLite write failure instead of the
 * invariant violation. Same pattern as the startup-adoption abort in `index.ts`.
 */
export function runOwnershipInvariantStartupGate(gate: OwnershipInvariantStartupGate): void {
  try {
    assertBounceForAllOwnershipInvariant(gate.ledgerDb, gate.applyToAllMarkets);
  } catch (err) {
    try {
      gate.controlDb
        .prepare(
          "UPDATE runtime_control_state SET runtime_status = 'failed', paused = 1, updated_at = datetime('now') WHERE id = 1",
        )
        .run();
    } catch (persistErr) {
      gate.log.error(
        { err: persistErr },
        "failed to persist failed/paused control state after ownership-invariant abort",
      );
    }
    if (err instanceof BounceForAllNullOwnerError) {
      gate.log.fatal(
        { ...err.counts },
        `startup HARD-STOP — bounceExit.applyToAllMarkets is enabled but the ledger violates exit-ownership invariants; ${formatOwnershipInvariantRemedy(err.counts)}`,
      );
    } else {
      gate.log.fatal({ err }, "startup ownership-invariant check failed");
    }
    throw err;
  }
}
