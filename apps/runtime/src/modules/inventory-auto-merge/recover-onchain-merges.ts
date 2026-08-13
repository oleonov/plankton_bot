import { evaluateRecordedMergeLegs, invalidRecordedMergeIdentity } from "@krabs/domain";
import type {
  EventBus,
  FillRepository,
  Position,
  PositionRepository,
  MarketRepository,
  OrderRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
  MergeRecord,
} from "@krabs/domain";
import type Database from "better-sqlite3";
import type { Logger } from "../../logger.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { MergeCandidate } from "./merge-candidate-service.js";
import { MergeSettler } from "./merge-settler.js";

/**
 * `writeCounter` is optional on the writer, and a merge metric that silently vanishes on a writer
 * without it would hide exactly the events an operator watches for. Shared by the module and the
 * recovery path so both record the same way.
 */
export function recordMetricCounter(
  runtimeMetrics: RuntimeMetricWriter | undefined,
  metricName: string,
  labels: Record<string, unknown>,
): void {
  const serializedLabels = JSON.stringify(labels);
  if (runtimeMetrics?.writeCounter) {
    runtimeMetrics.writeCounter(metricName, 1, serializedLabels);
    return;
  }
  runtimeMetrics?.writeEvent(metricName, 1, serializedLabels);
}

export interface ApplyAndPublishDeps {
  bus: EventBus;
  settler: MergeSettler;
}

/**
 * The ONE way a merge becomes local state. `applyMerge` is the money half (FIFO lots consumed,
 * spread P&L booked, both positions written, the ledger row advanced to 'applied' — all in one
 * transaction); the two publishes are the half every event-driven cache downstream depends on —
 * leg state, S1/profile ownership, exposure. A caller that did only the first would close both
 * positions while those caches still believed them open, which is why this pair lives in one
 * function instead of being repeated per call site.
 *
 * The published positions are the ones `applyMerge` returns, NOT a re-read: `findByTokenId` filters
 * `status != 'closed'`, so re-reading publishes nothing for a leg the merge consumed entirely — and
 * a fully consumed leg is precisely the update subscribers cannot afford to miss. A 10-vs-20 merge
 * would announce only the surviving leg; a 10-vs-10 merge would announce neither.
 *
 * Returns the pair rather than discarding it: a caller that settles several merges before any
 * subscriber exists (the pre-supervisor startup recovery) needs the settled positions back so it
 * can replay the publishes once subscribers are actually listening — see
 * `recoverConfirmedOnchainMerges`'s `settled` return field.
 */
export async function applyMergeAndPublish(
  deps: ApplyAndPublishDeps,
  candidate: MergeCandidate,
  mergeId: string,
): Promise<{ yes: Position; no: Position }> {
  const { yes, no } = deps.settler.applyMerge(candidate, mergeId);
  await deps.bus.publish("PositionUpdated", { position: yes });
  await deps.bus.publish("PositionUpdated", { position: no });
  return { yes, no };
}

export interface RepublishLegsDeps {
  bus: EventBus;
  positionRepo: PositionRepository;
  log: Logger;
}

/**
 * Converges this process's event-driven caches after an apply that did not publish.
 *
 * The failure that makes this necessary is a LOST `markApplied` CAS: another process settled the
 * row first, so the SHARED ledger already holds the merged legs while every cache in THIS process —
 * leg state, S1/profile ownership, exposure — keeps the pre-merge ones, because the winner
 * published on its own bus. Publishing what the ledger now holds is the only thing that converges
 * them, and it is harmless on a genuine failure: the transaction rolled back, so the rows are
 * exactly the ones subscribers already have.
 *
 * Both lookups are required, not either/or: `findById` on the SNAPSHOT ids is what a fully
 * consumed leg needs — it is 'closed', which `findByTokenId`'s `status != 'closed'` filter drops —
 * but the snapshot id can also be stale. Between the snapshot being taken and this call, a
 * concurrent process can replace the active row for a token (a new position cycle, startup
 * adoption); `findById` on the OLD id then republishes a row nobody subscribes to anymore while the
 * token's real current row stays unannounced. `findByTokenId` on the CURRENT row closes that gap.
 * The two sets overlap whenever nothing has changed, so results are deduped by position id before
 * publishing — never announcing the same row twice.
 */
export async function republishMergeLegs(
  deps: RepublishLegsDeps,
  legs: Pick<
    MergeCandidate,
    "conditionId" | "yesPositionId" | "noPositionId" | "yesTokenId" | "noTokenId"
  >,
): Promise<void> {
  try {
    const positions = new Map<string, Position>();
    for (const positionId of [legs.yesPositionId, legs.noPositionId]) {
      const position = deps.positionRepo.findById(positionId);
      if (position) positions.set(position.positionId, position);
    }
    for (const tokenId of [legs.yesTokenId, legs.noTokenId]) {
      const position = deps.positionRepo.findByTokenId(tokenId);
      if (position) positions.set(position.positionId, position);
    }
    for (const position of positions.values()) {
      await deps.bus.publish("PositionUpdated", { position });
    }
  } catch (e) {
    deps.log.error(
      { conditionId: legs.conditionId, err: String(e) },
      "failed to republish merge legs after a failed apply — event-driven caches may hold pre-merge state",
    );
  }
}

export interface OnchainMergeRecoveryDeps {
  bus: EventBus;
  positionRepo: PositionRepository;
  orderRepo?: OrderRepository;
  marketRepo?: MarketRepository;
  fillRepo?: FillRepository;
  lotRepo: InventoryLotRepository;
  mergeLedgerRepo: MergeLedgerRepository;
  db: Database.Database;
  log: Logger;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
}

/**
 * Recorded identities, not the mutable catalog, decide which positions may be settled.
 * A malformed or post-intent timestamp fails closed; lot timestamps use the intent's second floor.
 */
function evaluateRecordedRow(deps: OnchainMergeRecoveryDeps, row: MergeRecord) {
  const leg = (tokenId: MergeRecord["yesTokenId"], positionId: MergeRecord["yesPositionId"]) => {
    const position = positionId === null ? null : deps.positionRepo.findById(positionId);
    return {
      tokenId,
      positionId,
      position:
        position === null
          ? null
          : {
              tokenId: String(position.tokenId),
              status: position.status,
              openedAt: position.openedAt,
            },
      liveLotCreatedAts:
        positionId === null ? [] : deps.lotRepo.findOpen(positionId).map((lot) => lot.createdAt),
    };
  };
  return evaluateRecordedMergeLegs({
    mergedAt: row.mergedAt,
    yes: leg(row.yesTokenId, row.yesPositionId),
    no: leg(row.noTokenId, row.noPositionId),
  });
}

/**
 * Only for the POST-attempt re-read, where falling back to a known set is justified. The FIRST read
 * must never be swallowed — see `recoverConfirmedOnchainMerges`.
 */
function rereadMergeFenceOrNull(deps: OnchainMergeRecoveryDeps): MergeRecord[] | null {
  try {
    return deps.mergeLedgerRepo.findNonTerminal();
  } catch (e) {
    deps.log.error({ err: String(e) }, "failed to read non-terminal merge ledger rows");
    return null;
  }
}

/**
 * Settles every merge a previous process left provably on chain but locally unapplied.
 *
 * An 'onchain' row is the ONE non-terminal state that needs no guess. `gateway.mergePositions`
 * resolves only on a proven on-chain settlement, so the shares really are merged and the only thing
 * missing is the local half — the FIFO lot consumption, the spread P&L and the two position updates
 * `MergeSettler` commits in the same transaction as the status flip. Replaying that transaction is
 * a REPAIR, not a retry: nothing is submitted, and the fence lifts because the divergence is
 * genuinely gone rather than merely hidden.
 *
 * The amount and both leg identities come from the LEDGER row, never from a freshly computed
 * candidate: the chain moved the recorded amount from the recorded positions, whatever the local
 * book or mutable market catalog looks like now.
 *
 * A 'pending' row is deliberately left alone. It cannot be told apart from "never broadcast"
 * without an on-chain read this code does not do, and consuming lots for a merge that may never
 * have happened is the one error no later step can undo.
 *
 * WHY THIS IS NOT INSIDE InventoryManagerModule: restoring local state needs no relayer, no
 * settlement client and no feature flag — it is pure bookkeeping about merges that ALREADY
 * happened. Living in the module made it disappear precisely when it was most needed: with
 * `ENABLE_INVENTORY_AUTO_MERGE=false`, or after an operator followed the preflight blocker's advice
 * to disable auto-merge, the module is never constructed and an 'onchain' row stayed fenced
 * forever. Only NEW submissions are feature- and relayer-gated. Running it before
 * `supervisor.start()` is also what makes the caches consistent for free: every module hydrates
 * afterwards, so none of them can be holding a pre-repair view of a position this closed.
 *
 * `settled` carries every position from a SUCCESSFUL apply back to the caller (r12-P2). The
 * pre-supervisor call site publishes these on the bus as it goes, but at that point in boot no
 * module has subscribed yet — the publishes land on an empty bus and are lost. `settled` lets that
 * caller replay them once subscribers actually exist, instead of the repair silently depending on
 * every module's own hydration to notice a position this call already closed. Only successful
 * applies are included: a row that fell into the republish branch already published nothing new
 * (see `republishMergeLegs`), so re-publishing it here would just repeat that no-op.
 */
export async function recoverConfirmedOnchainMerges(
  deps: OnchainMergeRecoveryDeps,
): Promise<{ recovered: number; remaining: MergeRecord[]; settled: Position[] }> {
  // The FIRST read must not be swallowed into an empty report. `{ recovered: 0, remaining: [] }` is
  // indistinguishable from "the fence is clear", and the caller treats it as a successful recovery
  // and boots on — with auto-merge disabled nothing checks again, so an unapplied on-chain merge
  // would be handed to the trading runtime as if both legs were sound. "The fence could not be
  // read" is not "the fence is clear": abort the boot (the caller persists it as failed) and let an
  // operator look. The re-read below is the opposite case — there a fallback set is available.
  let rows: MergeRecord[];
  try {
    rows = deps.mergeLedgerRepo.findNonTerminal();
  } catch (e) {
    deps.log.error(
      { err: String(e) },
      "failed to read the merge fence at start-up — aborting boot rather than continuing with an unknown fence",
    );
    throw e;
  }
  if (rows.length === 0) return { recovered: 0, remaining: [], settled: [] };

  const confirmed = rows.filter((r) => r.status === "onchain");
  const settledHere = new Set<string>();
  const settled: Position[] = [];
  let recovered = 0;

  if (confirmed.length > 0) {
    const settler = new MergeSettler(
      deps.positionRepo,
      deps.lotRepo,
      deps.mergeLedgerRepo,
      deps.db,
    );

    for (const row of confirmed) {
      const invalidIdentity = invalidRecordedMergeIdentity({
        yesTokenId: row.yesTokenId,
        noTokenId: row.noTokenId,
        yesPositionId: row.yesPositionId,
        noPositionId: row.noPositionId,
      });
      if (invalidIdentity) {
        deps.log.error(
          { mergeId: row.mergeId, conditionId: row.conditionId, reason: invalidIdentity },
          "confirmed on-chain merge has invalid recorded identity — row stays fenced",
        );
        recordMetricCounter(deps.runtimeMetrics, "inventory_merge_recovery_fenced_total", {
          reason: invalidIdentity,
        });
        continue;
      }
      const legs = {
        conditionId: row.conditionId,
        mergeAmount: row.mergedAmount,
        yesTokenId: row.yesTokenId!,
        noTokenId: row.noTokenId!,
        yesPositionId: row.yesPositionId!,
        noPositionId: row.noPositionId!,
      };
      const evaluation = evaluateRecordedRow(deps, row);
      if (!evaluation.ok) {
        deps.log.error(
          { mergeId: row.mergeId, conditionId: row.conditionId, reason: evaluation.reason },
          "confirmed on-chain merge cannot be settled locally — recorded leg validation failed; row stays fenced",
        );
        recordMetricCounter(deps.runtimeMetrics, "inventory_merge_recovery_fenced_total", {
          reason: evaluation.reason,
        });
        continue;
      }
      try {
        const { yes, no } = await applyMergeAndPublish(
          { bus: deps.bus, settler },
          legs,
          row.mergeId,
        );
        recovered += 1;
        settledHere.add(row.mergeId);
        settled.push(yes, no);
        deps.log.warn(
          { mergeId: row.mergeId, conditionId: row.conditionId, mergedAmount: row.mergedAmount },
          "settled a confirmed on-chain merge a previous run left unapplied — fence lifted",
        );
        recordMetricCounter(deps.runtimeMetrics, "inventory_merge_recovered_total", { count: 1 });
      } catch (e) {
        // A lost `markApplied` CAS lands here too: another process settled this row first, its
        // transaction rolled ours back, and the row is already 'applied'. Fenced-and-reported is
        // the right outcome for both that and a genuine failure — neither may double-consume lots.
        deps.log.error(
          { mergeId: row.mergeId, conditionId: row.conditionId, err: String(e) },
          "failed to settle a confirmed on-chain merge — the row stays fenced for an operator",
        );
        // ...but "not settled BY US" is not "not settled". On the lost-CAS half the winner already
        // moved the shared positions, and the re-read below then drops the now-'applied' row and
        // reports a clean fence — so without this the caches of a process that is ALREADY running
        // (this helper also runs from `InventoryManagerModule.start()`, after modules hydrated)
        // would keep pre-merge sizes and trade phantom inventory behind a fence that looks lifted.
        await republishMergeLegs(deps, legs);
      }
    }
  }

  // Re-read whenever anything was ATTEMPTED, not only when something succeeded: a process that
  // loses the `markApplied` CAS rolls back with `recovered` still 0, yet the row it lost the race
  // for is now 'applied' by the winner — reporting the pre-attempt set would announce an
  // already-healed condition as fenced. On a failed re-read fall back to the rows we know we did
  // not settle; an empty list would be the one answer that is never justified, because "the fence
  // could not be read" is not "the fence is clear".
  const remaining =
    confirmed.length === 0
      ? rows
      : (rereadMergeFenceOrNull(deps) ?? rows.filter((r) => !settledHere.has(r.mergeId)));
  if (remaining.length > 0) {
    deps.log.error(
      {
        count: remaining.length,
        merges: remaining.map((r) => ({
          mergeId: r.mergeId,
          conditionId: r.conditionId,
          status: r.status,
        })),
      },
      "merge ledger has non-terminal rows — those conditions are FENCED from further merges until an operator reconciles them on chain with scripts/merge-ledger-reconcile.ts",
    );
  }
  return { recovered, remaining, settled };
}
