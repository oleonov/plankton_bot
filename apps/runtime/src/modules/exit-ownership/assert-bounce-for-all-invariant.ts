import {
  formatOwnershipInvariantBreakdown,
  formatOwnershipInvariantRemedy,
  hasOwnershipInvariantViolation,
  isWorkingSellOrderStatus,
  readOwnershipInvariantViolations,
  type OwnershipInvariantId,
} from "@krabs/db";
import type { Database } from "better-sqlite3";

import { persistFailedStartupState } from "../../persist-failed-startup-state.js";

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
 * "Placement guards never revisit a resting order" is the load-bearing premise, and it is FALSE for
 * one set of orders: those this boot's startup classification has already quarantined as drain
 * targets. The P6 fence exists to revisit exactly those, by performing this invariant's own declared
 * remedy — cancelling them. Hard-stopping on a row the drain is about to clear is not the safe
 * direction: it terminates BEFORE issuing the remedy and leaves the real SELL resting unsupervised.
 * Hence {@link OwnershipInvariantStartupGate.drainedOrderIds}, and the fence assertion below that
 * makes the deferral honest rather than a hole.
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
  drainedOrderIds?: ReadonlySet<string>,
): void {
  if (applyToAllMarkets !== true) return;
  const violations = readOwnershipInvariantViolations(ledgerDb, undefined, drainedOrderIds);
  if (hasOwnershipInvariantViolation(violations)) {
    throw new BounceForAllNullOwnerError(violations.counts);
  }
}

/** Structural — the startup gate needs three pino levels, and a test needs to record them. */
interface StartupGateLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  fatal(obj: object, msg: string): void;
}

/**
 * Which boot checkpoint is asserting. One read cannot cover the whole boot: the gate proves the
 * ledger BEFORE `supervisor.start()`, and module startup then mutates that same ledger — most
 * concretely `ReconciliationModule.start()`, whose `await`ed startup pass auto-closes a position
 * confirmed missing on-chain WITHOUT cancelling the SELL still resting against it. That SELL was
 * correctly bound when the gate ran, so it is not a drain target and nothing downstream revisits
 * it; without a second read the fence would be released on a ledger the gate would now reject.
 */
export type OwnershipGatePhase = "pre-start" | "pre-fence-release";

const PHASE_DIAGNOSIS: Readonly<Record<OwnershipGatePhase, string>> = {
  "pre-start": "the ledger was already inconsistent when this process booted",
  "pre-fence-release":
    "the ledger PASSED the pre-start check and module startup then broke it — a position was closed out from under a resting SELL (reconciliation missing-remote auto-close, resolution, or an inventory merge)",
};

export interface OwnershipInvariantStartupGate {
  ledgerDb: Database;
  controlDb: Database;
  applyToAllMarkets: boolean;
  log: StartupGateLogger;
  /** Defaults to the historical single checkpoint, so only the second call site states its phase. */
  phase?: OwnershipGatePhase;
  /**
   * The exchange-live orders this boot's startup classification has already quarantined as drain
   * targets. Passing an id here is a CLAIM the caller must earn twice: it comes from the
   * authoritative open-orders snapshot, and {@link assertDrainedOrdersAreFenced} re-proves after
   * seeding that the barrier actually holds it before the startup fence is released.
   */
  drainedOrderIds?: ReadonlySet<string>;
  /** Proven exact-null recovery predecessors; excluded without creating a drain obligation. */
  recoveryPredecessorOrderIds?: ReadonlySet<string>;
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
 * {@link persistFailedStartupState} is shared with the startup-adoption and merge-recovery aborts
 * in `index.ts`; it swallows its own write failure so an unwritable/locked `control.db` cannot
 * replace the error being reported here.
 */
export function runOwnershipInvariantStartupGate(gate: OwnershipInvariantStartupGate): void {
  const phase = gate.phase ?? "pre-start";
  try {
    assertBounceForAllOwnershipInvariant(
      gate.ledgerDb,
      gate.applyToAllMarkets,
      startupExcludedOrderIds(gate),
    );
    logDeferredDrainViolations(gate, phase);
  } catch (err) {
    persistFailedStartupState(gate.controlDb, gate.log, `ownership-invariant abort (${phase})`);
    if (err instanceof BounceForAllNullOwnerError) {
      gate.log.fatal(
        { ...err.counts, phase },
        `startup HARD-STOP at the ${phase} ownership checkpoint — ${PHASE_DIAGNOSIS[phase]}; bounceExit.applyToAllMarkets is enabled but the ledger violates exit-ownership invariants; ${formatOwnershipInvariantRemedy(err.counts)}`,
      );
    } else {
      gate.log.fatal({ err, phase }, "startup ownership-invariant check failed");
    }
    throw err;
  }
}

function startupExcludedOrderIds(
  gate: OwnershipInvariantStartupGate,
): ReadonlySet<string> | undefined {
  if (!gate.recoveryPredecessorOrderIds?.size) return gate.drainedOrderIds;
  return new Set([...(gate.drainedOrderIds ?? []), ...gate.recoveryPredecessorOrderIds]);
}

/**
 * Names what the projected gate DEFERRED, so a boot that passed on a ledger the census would still
 * call broken is visible in the log rather than silent. Runs only when something was actually
 * projected: with no drain targets the projected and raw verdicts are the same read.
 */
function logDeferredDrainViolations(
  gate: OwnershipInvariantStartupGate,
  phase: OwnershipGatePhase,
): void {
  // Only the checkpoint that GRANTS the waiver announces it. By the pre-fence-release read the
  // drain has already been seeded and proved by the fence gate, so repeating "the boot aborts if
  // the barrier does not cancel them" would describe an obligation that is already discharged.
  if (phase !== "pre-start") return;
  if (gate.applyToAllMarkets !== true || !gate.drainedOrderIds?.size) return;
  const raw = readOwnershipInvariantViolations(
    gate.ledgerDb,
    undefined,
    gate.recoveryPredecessorOrderIds,
  );
  if (!hasOwnershipInvariantViolation(raw)) return;
  gate.log.warn(
    { ...raw.counts, drainedOrderIds: [...gate.drainedOrderIds] },
    `startup ownership invariants DEFERRED for orders the startup drain has already quarantined — the raw ledger still reports ${formatOwnershipInvariantBreakdown(raw.counts)}; the transition barrier must cancel them, and the boot aborts if it does not`,
  );
}

/**
 * Thrown when a deferred order is neither locally terminal nor held by a transition barrier — i.e.
 * the gate excused it on a promise the execution module did not keep.
 */
export class DrainedOrderUnfencedError extends Error {
  constructor(readonly orderIds: readonly string[]) {
    super(
      `startup drain targets excused by the ownership-invariant gate are neither terminal nor barrier-held (${orderIds.join(", ")}) — refusing to release the startup fence`,
    );
    this.name = "DrainedOrderUnfencedError";
  }
}

export interface DrainedOrderFenceGate {
  controlDb: Database;
  drainedOrderIds: ReadonlySet<string>;
  /** Current LOCAL status of an order, or null/undefined when the ledger has no such row. */
  readOrderStatus: (orderId: string) => string | null | undefined;
  /** Whether the order is registered as a target of its token's transition barrier. */
  isTransitionTarget: (orderId: string) => boolean;
  log: StartupGateLogger;
}

/**
 * The other half of the deferral, and the reason it is not a fail-open weakening: every id the gate
 * excused must, by the time the startup fence would be released, be EITHER
 *
 *   - out of the active-SELL relation on its own (a confirmed cancel or fill already landed), or
 *   - a registered target of its token's transition barrier — which rejects every new placement on
 *     that token and keeps retrying the cancel until it is confirmed.
 *
 * Anything else means the excuse was never earned: the ledger claims a live SELL that nothing is
 * draining. Fail closed — the fence stays latched and the process exits, which is the same outcome
 * as the pre-deferral hard-stop for exactly the cases that still deserve it.
 *
 * The status predicate is {@link isWorkingSellOrderStatus}, the SAME exclusion set the invariants'
 * active-SELL relation uses, so "no longer counted by the gate" and "no longer needs a barrier" are
 * one condition rather than two that can drift. A MISSING order row reads as working, and therefore
 * still demands a barrier.
 */
export function runDrainedOrderFenceGate(gate: DrainedOrderFenceGate): void {
  const unfenced = [...gate.drainedOrderIds].filter(
    (orderId) =>
      isWorkingSellOrderStatus(gate.readOrderStatus(orderId) ?? undefined) &&
      !gate.isTransitionTarget(orderId),
  );
  if (unfenced.length === 0) return;
  persistFailedStartupState(gate.controlDb, gate.log, "drain-fence abort");
  const err = new DrainedOrderUnfencedError(unfenced);
  gate.log.fatal({ orderIds: unfenced }, err.message);
  throw err;
}

export interface AbandonedDrainWaiver {
  controlDb: Database;
  drainedOrderIds: ReadonlySet<string>;
  log: StartupGateLogger;
}

/**
 * The third state of the deferral, alongside "drained" and "unfenced": the boot died of something
 * else entirely between the waiver and the drain — a failed pause write, a rejected module start, a
 * signal mid-startup.
 *
 * Ordering alone cannot rule that out. The drain is `await`ed work that can itself reject, so
 * "waiver ⇒ drain ran" is not a property any statement order can buy; what boot ordering DOES buy,
 * and what actually contains the risk, is "waiver ⇒ the drain ran OR the process dies" — every path
 * between the two terminates, so a waiver can never carry into live trading on an unproven ledger.
 *
 * What is genuinely lost is the diagnosis. The boot reports whatever failed FIRST, and the one fact
 * that needs acting on — which real SELL orders the gate excused are still resting on the exchange
 * with no owning position — never reaches the operator, who sees a generic crash loop and no reason
 * to reach for the census. Restating it is the whole job here: this does not rescue the orders (a
 * hard-stop at the gate would have left them resting too), it makes them findable.
 */
export function reportAbandonedDrainWaiver(waiver: AbandonedDrainWaiver): void {
  if (waiver.drainedOrderIds.size === 0) return;
  persistFailedStartupState(waiver.controlDb, waiver.log, "ownership drain waiver abandoned");
  waiver.log.fatal(
    { orderIds: [...waiver.drainedOrderIds] },
    "startup aborted between the ownership-invariant gate's drain waiver and the drain that was to honour it — these SELL orders are resting on the exchange with no owning position and nothing cancelled them",
  );
}
