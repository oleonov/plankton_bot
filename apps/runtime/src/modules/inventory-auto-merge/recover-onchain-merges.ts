import type {
  EventBus,
  Position,
  PositionRepository,
  OrderRepository,
  MarketRepository,
  FillRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
  MergeRecord,
} from "@krabs/domain";
import type Database from "better-sqlite3";
import { parseLedgerInstantMs } from "@krabs/db";
import type { Logger } from "../../logger.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import { MergeCandidateService } from "./merge-candidate-service.js";
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
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  fillRepo: FillRepository;
  lotRepo: InventoryLotRepository;
  mergeLedgerRepo: MergeLedgerRepository;
  db: Database.Database;
  log: Logger;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
}

interface StaleMergeLeg {
  leg: "yes" | "no";
  positionId: string;
  openedAt: string | undefined;
  legConditionId: string | undefined;
  reason: "opened-after" | "unparseable" | "foreign-condition" | "lot-after";
  /** Only on `lot-after` — the lot whose age refused the leg, so an operator knows what to reconcile. */
  lotCreatedAt?: string;
}

/**
 * A leg that genuinely took part in a merge necessarily PRE-EXISTS the write-ahead ledger row:
 * `recordPending` runs immediately before the on-chain call, and the legs it records are already
 * open at that instant. The ledger row itself carries no leg ids — only `conditionId` and the
 * merged amount — so recovery re-derives the legs from `findMergeCandidates()` on the CURRENT
 * active rows. If the original leg closed (consumed by this very merge, or by anything else) and a
 * new position cycle opened on the same token before recovery ran, `findMergeCandidates()` has no
 * memory of the original id and silently hands back the replacement. A derived leg whose `openedAt`
 * is LATER than the row's `mergedAt` is proof of exactly that substitution: it cannot be the leg
 * the on-chain merge actually moved. Settling against it would debit FIFO lots and cost basis for a
 * merge that leg never took part in. A fenced row is not free either — it never settles on a
 * restart, so auto-merge stays blocked for that condition until an operator resolves it with
 * `scripts/merge-ledger-reconcile.ts --discard <mergeId> --fenced --apply` and reconciles the
 * unconsumed lots by hand. But that cost is bounded and visible, whereas a wrong debit after an
 * irreversible on-chain merge cannot be undone. So the only safe disposition on any doubt is to
 * stop and leave the row fenced.
 *
 * The anchor is `row.mergedAt`, NOT `row.createdAt`: `merge_ledger.created_at` is written by
 * SQLite's `datetime('now')`, which has no sub-second resolution, so a replacement leg opened
 * milliseconds into the SAME second as the row would floor to an equal value and slip past a
 * second-truncated fence — exactly the wrong debit this check exists to stop. `merged_at` carries
 * full millisecond precision for every row this function ever sees: `recordPending` INSERTs it
 * from `recordedAt = new Date().toISOString()` (see `InventoryManagerModule.sweep()`'s
 * `const recordedAt`), `markOnchain` is a pure CAS
 * (`UPDATE merge_ledger SET status = 'onchain' WHERE merge_id = ? AND status = 'pending'`) that
 * never touches `merged_at`, and while `markApplied` DOES overwrite it with the settlement's real
 * value, that happens only on the terminal 'applied' state — which `findNonTerminal()` excludes and
 * which the caller here filters to `status === 'onchain'` rows anyway, so this function never sees
 * an already-applied row's `merged_at`. `mergedAt` is therefore always the exact instant the
 * write-ahead intent was recorded, safe to compare against `positions.opened_at` at full
 * millisecond precision with NO truncation on either side.
 *
 * Predating the row is necessary but not sufficient, because `findMergeCandidates` binds legs
 * through the MUTABLE `markets` catalog rather than through anything the merge recorded. Each leg
 * must also be OWNED by this merge's condition according to `positions.condition_id` — the one
 * value a market upsert cannot rewrite. See the `foreign-condition` branch below.
 *
 * Nor is `opened_at` itself durable provenance. `runStartupPositionAdoption` runs BEFORE this
 * recovery (see the boot sequence in index.ts) and its `rebuildTokenPosition` ranks a token's
 * non-closed rows `opened_at DESC` — so the winner is the NEWEST row, precisely a post-merge
 * replacement — then rewrites that winner's `opened_at` to the EARLIEST instant across itself and
 * every position it absorbs. One stale sibling older than `merged_at` is therefore enough to
 * backdate a replacement straight past the check below. The lot ages are what survive that: the
 * consolidation reparents inventory by rewriting `inventory_lots.position_id` only
 * (`mergeRetiredPositionFootprint`), never a lot's own `created_at`. See the `lot-after` branch.
 *
 * Returns the first leg that fails, or `null` when both legs are proven to belong to this
 * condition AND to predate the row in both their own `opened_at` and every live lot under them.
 */
function findStaleMergeLeg(
  positionRepo: PositionRepository,
  lotRepo: InventoryLotRepository,
  legs: MergeCandidate,
  row: MergeRecord,
): StaleMergeLeg | null {
  const mergedAtMs = parseLedgerInstantMs(row.mergedAt);
  const sides: Array<{ leg: "yes" | "no"; positionId: MergeCandidate["yesPositionId"] }> = [
    { leg: "yes", positionId: legs.yesPositionId },
    { leg: "no", positionId: legs.noPositionId },
  ];
  for (const side of sides) {
    const position = positionRepo.findById(side.positionId);
    const openedAt = position?.openedAt;
    const legConditionId = position?.conditionId as string | undefined;
    const openedAtMs = parseLedgerInstantMs(openedAt);
    // Fail CLOSED: an unparseable openedAt/mergedAt cannot prove the leg predates the merge, so it
    // is treated exactly like proof that it doesn't. A missing row lands here too — `findById`
    // returns undefined, `openedAt` is undefined, and the parse is NaN.
    if (!Number.isFinite(openedAtMs) || !Number.isFinite(mergedAtMs)) {
      return {
        leg: side.leg,
        positionId: side.positionId,
        openedAt,
        legConditionId,
        reason: "unparseable",
      };
    }
    // Predating the merge is necessary but NOT sufficient. `findMergeCandidates` groups positions
    // by `markets.conditionId` — the CURRENT catalog value, which `UPSERT_MARKET_SQL` rewrites
    // wholesale on every scanner upsert (market-repository.ts:135-142) and which the startup market
    // scan refreshes BEFORE this recovery runs. So an upsert that maps some OTHER condition's token
    // onto this one hands us a long-lived, genuinely old position from that other condition as this
    // merge's "leg": it predates `mergedAt` by months and sails through the freshness check, after
    // which `MergeSettler` debits ITS FIFO lots and cost basis for a merge it never took part in.
    // `positions.condition_id` is the only anchor that cannot be rewritten this way — the repository
    // writes it once at INSERT and deliberately omits it from `ON CONFLICT DO UPDATE SET`
    // (position-repository.ts:20-30) — so it, not the catalog, decides which condition owns the leg.
    // Mismatch is fenced, and so is the legacy empty string written before the column existed
    // (measured 2026-08-11 on the live ledger: 1 of 72 non-closed positions): an unknown owner
    // cannot prove ownership, and the two costs are not symmetric — a falsely fenced row costs one
    // operator escalation, a wrongly debited one is irreversible.
    if (legConditionId !== row.conditionId) {
      return {
        leg: side.leg,
        positionId: side.positionId,
        openedAt,
        legConditionId,
        reason: "foreign-condition",
      };
    }
    // `>=`, not `>`: both instants are millisecond-resolution, so a replacement opened in the SAME
    // millisecond as `recordPending` renders EQUAL and a strict `>` would wave it through as an
    // original leg. The two costs are not symmetric — a falsely fenced row costs one operator
    // escalation (the `--discard --fenced` exit exists for exactly that), while a falsely accepted
    // one debits a replacement's FIFO lots for a merge that already landed irreversibly on chain.
    if (openedAtMs >= mergedAtMs) {
      return {
        leg: side.leg,
        positionId: side.positionId,
        openedAt,
        legConditionId,
        reason: "opened-after",
      };
    }
    // The check above reads a field startup adoption rewrites BACKWARD (see the header): a
    // replacement that absorbs one older sibling arrives here wearing that sibling's `opened_at`
    // and clears it. Every live lot under a genuine original leg was bought before `recordPending`
    // recorded the intent, so requiring that too closes the consolidation path — the winner keeps
    // its own post-merge lots, and an old winner that absorbed a replacement inherits the
    // replacement's. The threshold is `merged_at` floored to its SECOND because a lot's
    // `created_at` is not uniformly millisecond-rendered — the column's schema DEFAULT is
    // `datetime('now')` — and a second-truncated value reads as much as 999 ms EARLIER than the
    // instant it records, which would slip a genuinely later lot under a raw comparison. Flooring
    // fences the whole second containing the intent instead, the same conservatism the `>=` above
    // applies to equality. An unparseable `created_at` fails CLOSED for the same reason a missing
    // position does: it cannot prove the lot predates the merge. The costs stay asymmetric — a leg
    // that scaled in after the intent was recorded is falsely fenced and costs one operator
    // escalation via `--discard --fenced`, while a wrong debit after an irreversible on-chain merge
    // cannot be undone.
    const mergedAtSecondMs = Math.floor(mergedAtMs / 1000) * 1000;
    const postMergeLot = lotRepo
      .findOpen(side.positionId)
      .find((lot) => !(parseLedgerInstantMs(lot.createdAt) < mergedAtSecondMs));
    if (postMergeLot) {
      return {
        leg: side.leg,
        positionId: side.positionId,
        openedAt,
        legConditionId,
        reason: "lot-after",
        lotCreatedAt: postMergeLot.createdAt,
      };
    }
  }
  return null;
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
 * The amount comes from the LEDGER row, never from a freshly computed candidate: the chain moved by
 * the amount that was recorded, whatever the local book looks like now. The candidate is consulted
 * only for the two legs' ids — recomputing the size here would settle a different merge than the
 * one that happened.
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
    const candidateService = new MergeCandidateService(
      deps.positionRepo,
      deps.orderRepo,
      deps.marketRepo,
      deps.fillRepo,
    );
    const settler = new MergeSettler(
      deps.positionRepo,
      deps.lotRepo,
      deps.mergeLedgerRepo,
      deps.db,
    );
    const legsByCondition = new Map(
      candidateService.findMergeCandidates().map((c) => [c.conditionId, c]),
    );

    for (const row of confirmed) {
      const legs = legsByCondition.get(row.conditionId);
      if (!legs) {
        deps.log.error(
          { mergeId: row.mergeId, conditionId: row.conditionId },
          "confirmed on-chain merge cannot be settled locally — no open YES/NO pair for the condition; the row stays fenced",
        );
        continue;
      }
      // The derived legs are a FRESH lookup, not the ones the on-chain merge actually moved — see
      // `findStaleMergeLeg`. A stale leg here means the original was replaced (a new position cycle
      // on the same token) since the write-ahead row was recorded, and settling against it would
      // debit the wrong row's FIFO lots after an irreversible on-chain merge. Stop rather than guess.
      const stale = findStaleMergeLeg(deps.positionRepo, deps.lotRepo, legs, row);
      if (stale) {
        const detail = {
          mergeId: row.mergeId,
          conditionId: row.conditionId,
          leg: stale.leg,
          positionId: stale.positionId,
          openedAt: stale.openedAt,
          legConditionId: stale.legConditionId,
          mergedAt: row.mergedAt,
          ...(stale.lotCreatedAt === undefined ? {} : { lotCreatedAt: stale.lotCreatedAt }),
        };
        if (stale.reason === "unparseable") {
          deps.log.error(
            detail,
            "confirmed on-chain merge cannot be settled locally — a leg's openedAt or the ledger " +
              "row's mergedAt is unparseable, so the leg cannot be proven to predate the merge; " +
              "the row stays fenced for an operator to reconcile",
          );
        } else if (stale.reason === "foreign-condition") {
          deps.log.error(
            detail,
            "confirmed on-chain merge cannot be settled locally — the derived leg's own " +
              "condition_id, written once when the position was created and never rewritten by a " +
              "market upsert, is not this merge's condition. The leg was derived from the CURRENT " +
              "markets catalog, which a scanner upsert can remap, so this position may belong to a " +
              "different condition entirely and its lots must not be debited for this merge. An " +
              "empty condition_id (legacy rows predating the column) is fenced for the same reason " +
              "— an unknown owner cannot prove ownership; the row stays fenced for an operator to " +
              "reconcile",
          );
        } else if (stale.reason === "lot-after") {
          deps.log.error(
            detail,
            "confirmed on-chain merge cannot be settled locally — the derived leg carries a LIVE " +
              "FIFO lot that cannot be shown to predate the START of the SECOND in which the " +
              "write-ahead row was recorded, so this leg's lots cannot be proven to be the ones " +
              "the merge moved and must not be debited, even though its openedAt predates the " +
              "merge. That threshold is the whole second, not the write-ahead instant, because " +
              "inventory_lots.created_at defaults to second-resolution datetime('now') and would " +
              "otherwise read up to 999 ms EARLIER than the moment it records — so a lot whose " +
              "own timestamp is demonstrably milliseconds BEFORE the write-ahead row is fenced " +
              "too, on purpose. openedAt alone is not evidence here: startup position adoption " +
              "rewrites a winner's opened_at BACKWARD to the earliest instant across every row it " +
              "absorbs, while never touching a lot's own created_at, so lot ages are the " +
              "provenance that survives consolidation. This is a deliberately conservative fence " +
              "and is NOT evidence of substitution — a legitimate scale-in made after the intent " +
              "was recorded trips it identically; the row stays fenced for an operator to " +
              "reconcile",
          );
        } else {
          deps.log.error(
            detail,
            "confirmed on-chain merge cannot be settled locally — a derived leg opened AT OR " +
              "AFTER the write-ahead row was recorded, so it cannot be shown to be the leg that " +
              "merge actually moved and its lots must not be debited. Equality of the two " +
              "timestamps is fenced deliberately and is NOT evidence of substitution — they are " +
              "two independent millisecond-resolution clock reads, so the leg may be the " +
              "original; the row stays fenced for an operator to reconcile",
          );
        }
        recordMetricCounter(deps.runtimeMetrics, "inventory_merge_recovery_fenced_total", {
          reason: stale.reason,
        });
        continue;
      }
      try {
        const { yes, no } = await applyMergeAndPublish(
          { bus: deps.bus, settler },
          { ...legs, mergeAmount: row.mergedAmount },
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
