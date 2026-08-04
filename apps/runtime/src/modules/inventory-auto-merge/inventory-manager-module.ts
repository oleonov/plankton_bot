import type {
  EventBus,
  ExchangeGateway,
  PositionRepository,
  OrderRepository,
  MarketRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
  MergeRecord,
  RuntimeControl,
  RuntimeModule,
} from "@krabs/domain";
import { SettlementNotSubmittedError } from "@krabs/exchange";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { waitAtMost } from "../../lifecycle-chain.js";
import type { Logger } from "../../logger.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { SettlementInfraBreaker } from "../settlement-infra-breaker.js";
import { isSettlementInfraRateLimitError } from "../settlement-infra-breaker.js";
import { MergeCandidateService } from "./merge-candidate-service.js";
import { MergeSettler } from "./merge-settler.js";

export interface InventoryManagerDeps {
  bus: EventBus;
  gateway: ExchangeGateway;
  positionRepo: PositionRepository;
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  fillRepo: import("@krabs/domain").FillRepository;
  lotRepo: InventoryLotRepository;
  mergeLedgerRepo: MergeLedgerRepository;
  db: Database.Database;
  log: Logger;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  settlementInfraBreaker?: SettlementInfraBreaker | undefined;
  sweepIntervalMs?: number | null | undefined;
  /**
   * Optional pause gate. When the runtime is paused, periodic and
   * debounced merge sweeps are skipped so the bot does not submit on-chain
   * merges or write merge ledger rows.
   */
  runtimeControl?: RuntimeControl;
}

/**
 * How long `stop()` waits for a sweep that is already PAST its on-chain merge.
 *
 * That tail is short by construction: `applyMerge` is one synchronous SQLite transaction and the
 * only awaits after it are bus publishes, which the in-process bus dispatches synchronously. What
 * this bound deliberately does not cover is a sweep still INSIDE `gateway.mergePositions()` — the
 * live gateway allows its settlement lane 90s there, and `supervisor.stop()`'s own 40s ceiling would
 * truncate any wait long enough to matter. Expiring there is logged as an error rather than hidden:
 * it is the one case that can still leave a merge on chain with its ledger row stuck at 'onchain'
 * instead of 'applied' — a `merge_ledger.status = 'pending'` row is written and committed BEFORE the
 * on-chain call, so that residual window is now discoverable (it flips to 'onchain' the moment the
 * call resolves), it just is not resolved to 'applied' before the process exits.
 */
const SWEEP_DRAIN_WAIT_MS = 5_000;

export class InventoryManagerModule implements RuntimeModule {
  private readonly candidateService: MergeCandidateService;
  private readonly settler: MergeSettler;
  private interval: NodeJS.Timeout | null = null;
  /**
   * The sweep RUN in flight, not a boolean — `stop()` needs something to await, and a flag only
   * says that a pass exists. The pass holds an interval no ceiling can shorten: between the
   * on-chain merge and the ledger row that mirrors it. A process that exits in that gap now leaves
   * a `merge_ledger` row stuck at 'onchain' rather than no row at all — 'onchain' is unambiguous
   * divergence a recovery path can act on, which is what `stop()` still drains for here.
   */
  private sweepInFlight: Promise<void> | null = null;
  /**
   * Disambiguates two merge ids for the same condition minted in the same millisecond. `Date.now()`
   * alone is not enough: sweeps are event-driven as well as timed, so a pass that fails fast (the
   * gateway rejecting without a round trip) can be followed by the next one inside the same tick.
   * The duplicate id then fails `recordPending` on the merge_id primary key BEFORE submission, which
   * routes into the "nothing was broadcast" branch and lets `discardUnsubmittedIntents` delete the
   * EARLIER pass's 'pending' row — erasing the only local record of a merge that may already be on
   * chain, which is the exact hole the write-ahead intent exists to close.
   */
  private mergeIdSeq = 0;
  /**
   * Makes every merge id unique to THIS process, not merely to this sweep. A clock and a counter
   * are per-process, so two runtimes over one ledger (a rolling deploy, an overlapping restart) can
   * mint byte-identical ids — and `deletePending`, which keys on merge_id alone, would then let one
   * process's cleanup erase the other's live intent. A run-scoped component makes that
   * unrepresentable: an id can only ever name a row its own process wrote.
   */
  private readonly runId = randomUUID().slice(0, 8);
  private stopping = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: InventoryManagerDeps) {
    this.candidateService = new MergeCandidateService(
      deps.positionRepo,
      deps.orderRepo,
      deps.marketRepo,
      deps.fillRepo,
    );
    this.settler = new MergeSettler(deps.positionRepo, deps.lotRepo, deps.mergeLedgerRepo, deps.db);
  }

  public async start(): Promise<void> {
    // `stop()` latches `stopping` so a debounced sweep past clearTimeout's reach cannot open a new
    // on-chain merge. It is a LATCH, not a terminal state: `Supervisor.stop()` → `start()` is a
    // supported sequence, and leaving it set would make `haltReason()` skip every sweep forever
    // while `healthCheck()` still reports ok. Clear the old timers for the same reason a repeat
    // start must not leak them — an interval nothing holds a handle to cannot be cleared.
    this.stopping = false;
    if (this.interval) clearInterval(this.interval);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.reconcileNonTerminalMerges();

    const intervalMs = this.deps.sweepIntervalMs ?? 5 * 60 * 1000;
    this.interval = setInterval(() => void this.sweep(), intervalMs);
    this.deps.log.info({ intervalMs }, "inventory manager started");

    // Debounced reactive hints
    this.unsubs.push(
      this.deps.bus.subscribe("PositionUpdated", async () => {
        this.debouncedSweep();
      }),
    );
    this.unsubs.push(
      this.deps.bus.subscribe("FillReceived", async (payload) => {
        if (payload.side === "buy") {
          this.debouncedSweep();
        }
      }),
    );
  }

  public async stop(): Promise<void> {
    // Set BEFORE the timers are cleared: a debounced sweep whose timer has already fired is past
    // clearTimeout's reach, and this is what keeps it from opening a new on-chain merge on the way
    // out. Clearing the timers only prevents the passes that have not started.
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];

    const inFlight = this.sweepInFlight;
    if (!inFlight) return;
    await waitAtMost(inFlight, {
      ms: SWEEP_DRAIN_WAIT_MS,
      onExpired: () =>
        this.deps.log.error(
          { waitMs: SWEEP_DRAIN_WAIT_MS },
          "inventory sweep did not drain before shutdown — a submitted merge may be missing its ledger row",
        ),
    });
  }

  /**
   * Re-reads the non-terminal merge rows and refreshes the fence, returning the rows or null when
   * the ledger could not be read.
   *
   * A non-terminal row is the ONLY trace an interrupted merge leaves. 'onchain' means the chain
   * moved and this ledger did not; 'pending' means we cannot tell whether the submission landed.
   * Neither is resolved here on purpose: deciding a 'pending' row needs an on-chain read this
   * module does not do, and quietly "fixing" a divergence is how a divergence becomes permanent.
   *
   * The read is DURABLE state, not a cached decision, and that is the point: a process restart, a
   * lane TTL expiry or a settlement-breaker reset must not clear the fence, because none of them
   * learns anything about the chain.
   */
  private nextMergeId(conditionId: string): string {
    return `merge-${conditionId}-${Date.now()}-${this.runId}-${++this.mergeIdSeq}`;
  }

  /**
   * The fence is read from the DB at every use and never cached. A cached copy is wrong for both
   * readers: a sweep would gate submissions on state another process may have changed, and
   * `healthCheck` would report the opposite of the durable truth until the next sweep refreshed it.
   * The query is a single indexed lookup over a table that is empty in the healthy case.
   */
  private readMergeFence(): MergeRecord[] | null {
    try {
      return this.deps.mergeLedgerRepo.findNonTerminal();
    } catch (e) {
      this.deps.log.error({ err: String(e) }, "failed to read non-terminal merge ledger rows");
      return null;
    }
  }

  /**
   * An 'onchain' row is the ONE non-terminal state that needs no guess. `gateway.mergePositions`
   * resolves only on a proven on-chain settlement, so the shares really are merged and the only
   * thing missing is this process's local half — the FIFO lot consumption, the spread P&L and the
   * two position updates `MergeSettler` normally commits in the same transaction as the status
   * flip. Replaying that transaction is a REPAIR, not a retry: nothing is submitted, and the fence
   * lifts because the divergence is genuinely gone rather than merely hidden.
   *
   * The amount comes from the LEDGER row, never from a freshly computed candidate: the chain moved
   * by the amount that was recorded, whatever the local book looks like now. The candidate is
   * consulted only for the two legs' ids — recomputing the size here would settle a different
   * merge than the one that happened.
   *
   * A 'pending' row is deliberately left alone. It cannot be told apart from "never broadcast"
   * without an on-chain read this module does not do, and consuming lots for a merge that may never
   * have happened is the one error no later step can undo.
   */
  private settleConfirmedOnchainMerges(rows: MergeRecord[]): void {
    const confirmed = rows.filter((r) => r.status === "onchain");
    if (confirmed.length === 0) return;

    const legsByCondition = new Map(
      this.candidateService.findMergeCandidates().map((c) => [c.conditionId, c]),
    );
    for (const row of confirmed) {
      const legs = legsByCondition.get(row.conditionId);
      if (!legs) {
        this.deps.log.error(
          { mergeId: row.mergeId, conditionId: row.conditionId },
          "confirmed on-chain merge cannot be settled locally — no open YES/NO pair for the condition; the row stays fenced",
        );
        continue;
      }
      try {
        this.settler.applyMerge({ ...legs, mergeAmount: row.mergedAmount }, row.mergeId);
        this.deps.log.warn(
          { mergeId: row.mergeId, conditionId: row.conditionId, mergedAmount: row.mergedAmount },
          "settled a confirmed on-chain merge a previous run left unapplied — fence lifted",
        );
        this.recordBoundedMetricCounter("inventory_merge_recovered_total", { count: 1 });
      } catch (e) {
        this.deps.log.error(
          { mergeId: row.mergeId, conditionId: row.conditionId, err: String(e) },
          "failed to settle a confirmed on-chain merge — the row stays fenced for an operator",
        );
      }
    }
  }

  /**
   * Read failures are swallowed here because start-up alerting is a diagnostic: a bot that will not
   * start because its alerting query threw is strictly worse than one that starts without the
   * alert. The sweep treats the same failure differently — see `runSweep`.
   */
  private reconcileNonTerminalMerges(): void {
    const rows = this.readMergeFence();
    if (rows === null || rows.length === 0) return;
    this.settleConfirmedOnchainMerges(rows);

    // Re-read rather than filtering `rows`: the settles above deleted nothing but advanced rows to
    // 'applied', and reporting the pre-repair set would fence conditions that are no longer fenced.
    const remaining = this.readMergeFence();
    if (remaining === null || remaining.length === 0) return;
    this.deps.log.error(
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

  /**
   * Unhealthy while any condition is fenced. Nothing in the runtime acts on this automatically
   * (`collectHealth` only reports it), which is exactly what is wanted: an unreconciled merge is an
   * operator task, not a reason to stop trading — but it must not be invisible either, and a log
   * line emitted once at start-up is invisible by the time it matters.
   *
   * Fail-closed on an unreadable ledger, for the same reason the sweep skips: a health check that
   * cannot see the fence has not proven there is none, and reporting ok is the one answer that
   * makes the operator look away.
   */
  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    const rows = this.readMergeFence();
    const sweepDetail = `last_sweep_active=${this.sweepInFlight !== null}`;
    if (rows === null) {
      return { ok: false, detail: `${sweepDetail} fenced_conditions=unknown (ledger unreadable)` };
    }
    return {
      ok: rows.length === 0,
      detail: `${sweepDetail} fenced_conditions=${rows.length}`,
    };
  }

  private debouncedSweep(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.sweep(), 5000); // 5s debounce
  }

  /** Why this sweep must not run at all, or null to continue. */
  private haltReason(): "shutting down" | "runtime paused" | null {
    if (this.stopping) return "shutting down";
    if (this.deps.runtimeControl?.isPaused()) return "runtime paused";
    return null;
  }

  public sweep(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight;
    const run = this.runSweep().finally(() => {
      this.sweepInFlight = null;
    });
    this.sweepInFlight = run;
    return run;
  }

  private async runSweep(): Promise<void> {
    // One check is enough, and only because everything from here to `mergePositions()` is a single
    // synchronous block — `findMergeCandidates`, the breaker read and the fence read are all sync
    // (better-sqlite3), so no shutdown or pause can land in between. Adding an `await` above the
    // on-chain call breaks that and needs a second check immediately before it.
    const entryHalt = this.haltReason();
    if (entryHalt) {
      this.deps.log.debug({ reason: entryHalt }, "inventory manager sweep skipped");
      return;
    }

    // Declared outside the try because the catch has to know which intents this pass wrote: a row
    // recorded here and then abandoned by a throw is precisely the state the catch has to dispose of.
    const mergeIds = new Map<string, string>();
    // Distinguishes "the throw came from inside the gateway call" from "we never got that far".
    // Everything before the flip — candidate lookup, the breaker read, recording the intents — is
    // provably pre-submission, so a throw there leaves rows describing something that did not and
    // now cannot happen. Keeping them would file one false divergence report per candidate per
    // sweep, forever, for a local failure that never reached the chain.
    let submissionAttempted = false;

    try {
      const candidates = this.candidateService.findMergeCandidates();
      if (candidates.length === 0) return;

      this.deps.log.info({ count: candidates.length }, "found mergeable inventory candidates");

      // 1. Execute on-chain merges. Once this resolves the merge is irrevocable,
      // so the ledger MUST follow to stay consistent with on-chain state —
      // skipping the ledger application after pause would leak inventory and
      // cause permanent drift. We pause-check before the on-chain write.
      const infraPause = this.deps.settlementInfraBreaker?.current();
      if (infraPause) {
        this.deps.log.warn(
          { code: infraPause.code, until: infraPause.until },
          "inventory manager merge skipped by settlement infra breaker",
        );
        this.recordBoundedMetricCounter("inventory_merge_suppressed_settlement_breaker_total", {
          code: infraPause.code,
        });
        return;
      }

      // A candidate whose previous merge is still non-terminal must NOT be resubmitted. Nothing
      // about local state distinguishes "the merge never landed" from "it landed and we never saw
      // the receipt": both leave the YES/NO positions untouched, so `findMergeCandidates` returns
      // the condition again on every sweep once the lane TTL and the settlement breaker expire.
      // Resubmitting is not merely redundant — for a partially submitted fallback batch it is a
      // permanent stall, because the retry starts at the condition that ALREADY merged, fails there
      // for insufficient shares, and never reaches the one that was never submitted. Suppression
      // has to be durable (a DB read, not a process-lifetime flag) and it clears only when an
      // operator reconciles the row on chain, which is why `refreshMergeFence` resolves nothing by
      // itself.
      const fenceRows = this.readMergeFence();
      if (fenceRows === null) {
        // Unreadable ledger means the fence cannot be proven, and an unproven fence is not a fence.
        // Skipping a sweep costs nothing; submitting blind can double-merge.
        this.deps.log.error("merge sweep skipped — could not read the merge ledger fence");
        return;
      }
      const fenced = new Set(fenceRows.map((r) => r.conditionId));
      const eligible = candidates.filter((c) => !fenced.has(c.conditionId));
      if (eligible.length < candidates.length) {
        const suppressed = candidates
          .filter((c) => fenced.has(c.conditionId))
          .map((c) => c.conditionId);
        this.deps.log.warn(
          { suppressed },
          "merge candidates suppressed — a previous merge for them is still non-terminal and needs operator reconciliation",
        );
        this.recordBoundedMetricCounter("inventory_merge_suppressed_non_terminal_total", {
          count: suppressed.length,
        });
      }
      if (eligible.length === 0) return;

      // Write each merge's ledger INTENT before it is submitted on chain, and let each insert
      // commit on its own (no ambient transaction) — that is what makes the row durable before the
      // gateway call ever leaves the process, so a crash inside it (or in the drain window after)
      // still leaves a 'pending' row instead of nothing at all.
      //
      // The insert is also the CLAIM. The fence read above is a snapshot, and a snapshot cannot
      // arbitrate between two processes: both can read an empty fence and both submit the same
      // merge. A lost claim means someone else's merge for that condition is in flight and may
      // already be irrevocable — so the candidate is dropped from the batch and nothing is deleted,
      // while the rest of the batch proceeds normally.
      const recordedAt = new Date().toISOString();
      const claimed: typeof eligible = [];
      const lostClaims: string[] = [];
      for (const candidate of eligible) {
        const mergeId = this.nextMergeId(candidate.conditionId);
        // Registered BEFORE the write: `recordPending` can commit its row and still throw, and an
        // id nobody recorded is an intent no failure path can discard. Safe only because the id is
        // run-unique — `deletePending` keyed on it can never reach another writer's row.
        mergeIds.set(candidate.conditionId, mergeId);
        if (
          !this.deps.mergeLedgerRepo.recordPending({
            mergeId,
            conditionId: candidate.conditionId,
            mergedAmount: candidate.mergeAmount,
            recordedAt,
          })
        ) {
          // A lost claim inserted nothing, so there is no row of ours to track or clean up.
          mergeIds.delete(candidate.conditionId);
          lostClaims.push(candidate.conditionId);
          continue;
        }
        claimed.push(candidate);
      }
      if (lostClaims.length > 0) {
        this.deps.log.warn(
          { lostClaims },
          "merge candidates dropped — another writer already has a non-terminal merge for them",
        );
        this.recordBoundedMetricCounter("inventory_merge_claim_lost_total", {
          count: lostClaims.length,
        });
      }
      if (claimed.length === 0) return;

      submissionAttempted = true;
      await this.deps.gateway.mergePositions(
        claimed.map((c) => ({
          conditionId: c.conditionId,
          amount: c.mergeAmount,
        })),
      );

      // The gateway resolves ONLY on a confirmed on-chain settlement (see the `mergePositions`
      // contract in @krabs/domain) — an unconfirmed submission rejects instead of resolving here.
      // That is what makes the next line safe: every merge in the batch is now irrevocable. Flipping each
      // row to 'onchain' here — before applyMerge's transaction — turns a crash in the gap that
      // follows into unambiguous divergence (chain moved, ledger didn't) instead of the merely
      // ambiguous 'pending' state, which is exactly what a recovery path needs to act without
      // guessing whether the on-chain call actually landed.
      for (const mergeId of mergeIds.values()) {
        try {
          this.deps.mergeLedgerRepo.markOnchain(mergeId);
        } catch (e) {
          // A missing intent row means the ledger already diverged for THIS merge. The rest of the
          // batch is on chain and unaffected, and its positions still have to be applied — letting
          // one broken row abort the loop below would manufacture the very divergence we are
          // reporting, for every other candidate in the batch.
          this.deps.log.error({ mergeId, err: String(e) }, "failed to mark merge 'onchain'");
        }
      }

      // 2. Apply to ledger
      for (const candidate of claimed) {
        try {
          const mergeId = mergeIds.get(candidate.conditionId)!;
          this.settler.applyMerge(candidate, mergeId);
          this.deps.log.info(
            {
              conditionId: candidate.conditionId,
              amount: candidate.mergeAmount,
            },
            "inventory merge applied to ledger",
          );

          // 3. Notify system of updated positions to trigger exposure recomputation
          // We can just publish PositionUpdated for both sides
          const yesPos = this.deps.positionRepo.findByTokenId(candidate.yesTokenId);
          const noPos = this.deps.positionRepo.findByTokenId(candidate.noTokenId);
          if (yesPos) await this.deps.bus.publish("PositionUpdated", { position: yesPos });
          if (noPos) await this.deps.bus.publish("PositionUpdated", { position: noPos });
        } catch (e) {
          this.deps.log.error(
            { conditionId: candidate.conditionId, err: String(e) },
            "failed to apply merge to ledger",
          );
        }
      }
    } catch (e) {
      if (isSettlementInfraRateLimitError(e)) {
        this.pauseBreakerIfRateLimited(e);
        // A rate-limit that reaches HERE rejected the submission before any candidate became
        // irrevocable: merging goes out as ONE relayer batch, so there is no partially-submitted
        // batch to confuse this with. These rows provably record something that did not happen.
        // Dropping them is what keeps the startup report about real divergence — this path is not
        // rare (it has a dedicated breaker), and left alone it would bury the 'onchain' rows that
        // matter under one false alarm per candidate per throttled sweep.
        this.discardUnsubmittedIntents(mergeIds);
      } else if (!submissionAttempted || e instanceof SettlementNotSubmittedError) {
        // The other provably-nothing-broadcast class: either we never reached the gateway call
        // (a candidate lookup or a `recordPending` that threw), or the gateway itself refused
        // before submission — an unsupported client, or a batch it could not build in full. These
        // are not transient: an unsupported client throws on EVERY sweep, so preserving the rows
        // "just in case" accumulates false non-terminal intents forever and drowns the startup
        // divergence report in noise about merges that never had a chance to happen.
        //
        // Safe even when `recordPending` threw partway: `deletePending` deletes by merge_id AND
        // status = 'pending', so an id whose insert never landed is a no-op and an intent that has
        // since advanced to 'onchain'/'applied' cannot be erased by this path.
        this.deps.log.warn(
          { mergeIds: [...mergeIds.values()], err: String(e) },
          "merge sweep failed before submission — ledger rows discarded (nothing was broadcast)",
        );
        this.discardUnsubmittedIntents(mergeIds);
      } else if (mergeIds.size > 0) {
        // Every other failure — a timeout, an unknown error, or a `SettlementUnconfirmedError` for
        // a batch that WAS broadcast but never confirmed — may still have landed on chain, so the
        // rows stay 'pending'. That state means exactly "we do not know", which is the honest
        // answer here; a fourth status would only rename the same uncertainty.
        this.deps.log.error(
          { mergeIds: [...mergeIds.values()] },
          "merge sweep failed after recording intent — ledger rows left 'pending' (the submission may or may not have landed)",
        );
      }
      this.deps.log.error({ err: String(e) }, "inventory manager sweep failed");
    }
  }

  /**
   * Opens the settlement breaker when `error` is an infrastructure rate limit, and does nothing
   * otherwise. Shared by the direct and the partial-batch failure branches: the row disposition
   * differs between them, but "a 429 must throttle the next sweep" is the same rule either way.
   */
  private pauseBreakerIfRateLimited(error: unknown): void {
    if (!isSettlementInfraRateLimitError(error)) return;
    this.deps.settlementInfraBreaker?.pause("POLYGON_RPC_RATE_LIMITED", error);
    this.recordBoundedMetricCounter("inventory_merge_settlement_rate_limited_total", {
      code: "POLYGON_RPC_RATE_LIMITED",
    });
  }

  private discardUnsubmittedIntents(mergeIds: Map<string, string>): void {
    for (const mergeId of mergeIds.values()) {
      try {
        this.deps.mergeLedgerRepo.deletePending(mergeId);
      } catch (e) {
        this.deps.log.error(
          { mergeId, err: String(e) },
          "failed to discard unsubmitted merge intent",
        );
      }
    }
  }

  private recordBoundedMetricCounter(metricName: string, labels: Record<string, unknown>): void {
    const serializedLabels = JSON.stringify(labels);
    if (this.deps.runtimeMetrics?.writeCounter) {
      this.deps.runtimeMetrics.writeCounter(metricName, 1, serializedLabels);
      return;
    }
    this.deps.runtimeMetrics?.writeEvent(metricName, 1, serializedLabels);
  }
}
