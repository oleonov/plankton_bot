import { statSync } from "node:fs";
import type Database from "better-sqlite3";
import type { RuntimeControl, RuntimeModule } from "@krabs/domain";
import { ACTIVE_REDEEM_LOG_STATUS_SQL } from "@krabs/db";
import { SIGNAL_TELEMETRY_RISK_EVENT_TYPES } from "../../risk-event-volume.js";
import type { LifecycleToken } from "../../lifecycle-chain.js";
import { LifecycleChain, LIFECYCLE_STOP_WAIT_MS, waitAtMost } from "../../lifecycle-chain.js";
import type { Logger } from "../../logger.js";
import { runWalCheckpointOffThread, type CheckpointResult } from "./wal-checkpoint.js";

export const LATEST_ONLY_RUNTIME_METRICS = [
  "runtime_paused",
  "last_reconciliation",
  "reconciliation_clean",
  "reconciliation_drift",
  "market_data_last_update",
  "market_data_source",
  "execution_mode",
  "live_lite_envelope",
  "market_data_poll_progress",
  "signal_activity",
  "last_entry_approved",
  "last_signal_rejected",
  "signal_conversion_activity",
  "risk_event_volume",
  "user_order_stream_activity",
  "market_data_stream_activity",
  "algo_decision_eval_counters",
  "algo_decision_latency",
  "r23_cache_activity",
  "scanner_activity",
  "execution_queue",
  "startup_adoption",
  "startup_leg_state_seed",
] as const;

export interface LedgerRetentionConfig {
  intervalMs?: number;
  batchSize?: number;
  maxDeletedRowsPerRun?: number;
  /**
   * SOFT deadline for the DELETE phase of a pass, checked BETWEEN batches — not a wall-clock
   * ceiling. The row budget bounds work, not time — see {@link runTask}.
   *
   * The distinction is not pedantry: `task.run(limit)` is one synchronous better-sqlite3 call, so
   * while a batch is inside SQLite this deadline cannot be evaluated, a timer cannot fire, and
   * SIGTERM cannot be handled. A pass therefore overruns by up to the duration of ONE batch, and the
   * shutdown budget must be read as "this deadline PLUS one unbounded batch". The batch size is what
   * keeps that term small; raising it widens the overrun this ceiling cannot see.
   *
   * It deliberately does NOT cover the checkpoint, which runs off-thread and therefore cannot
   * freeze the runtime no matter how long it takes.
   */
  maxRunDurationMs?: number;
  runtimeMetricsTtlMs?: number;
  marketSnapshotsTtlMs?: number;
  executionPolicyObservationsTtlMs?: number;
  decisionSignalLogTtlMs?: number;
  tradingStateSnapshotsTtlMs?: number;
  portfolioSnapshotsTtlMs?: number;
  highVolumeRuntimeMetricsTtlMs?: number;
  signalTelemetryRiskEventsTtlMs?: number;
  highVolumeRiskEventsTtlMs?: number;
  orderRejectedRiskEventsTtlMs?: number;
  riskEventsTtlMs?: number;
  criticalRiskEventsTtlMs?: number;
  signalFeedBucketsTtlMs?: number;
  redeemLogChurnTtlMs?: number;
  redeemLogMaxRowsPerRun?: number;
  checkpointIntervalMs?: number;
  checkpointMinDeletedRows?: number;
  /** How long the off-thread checkpoint may wait for readers — see {@link CHECKPOINT_BUSY_TIMEOUT_MS}. */
  checkpointBusyTimeoutMs?: number;
  /** Ceiling on the WAIT for the checkpoint worker — see {@link CHECKPOINT_TIMEOUT_MS}. */
  checkpointTimeoutMs?: number;
  runOnStart?: boolean;
}

export interface LedgerRetentionResult {
  ranAt: string;
  deleted: Record<string, number>;
  checkpointed: boolean;
}

export interface LedgerRetentionModuleDeps {
  db: Database.Database;
  log: Logger;
  config?: LedgerRetentionConfig;
  runtimeControl?: RuntimeControl;
  /**
   * Filesystem path of the ledger, needed to open the checkpoint's OWN connection in a worker
   * thread. Omit it (in-memory ledgers, tests that only exercise deletes) and the WAL checkpoint is
   * simply not attempted — an in-memory database has no WAL to reclaim.
   */
  checkpointDbPath?: string;
  /**
   * Re-read per pass, not snapshotted at construction: the execution policy supports live
   * version-based reloads, so an operator who raises `signalFeed.retentionDays` through the API to
   * protect history would otherwise keep losing rows at the old horizon until the next restart —
   * and lowering it would likewise do nothing. Returns null when the policy has no usable value,
   * in which case the configured fallback stands.
   */
  resolveSignalFeedBucketsTtlMs?: () => number | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long the off-thread checkpoint may wait for readers. The wait costs a worker thread, not the
 * event loop, so it can be generous: a checkpoint that gives up after one second loses to any
 * reader that merely OVERLAPS it, and losing every scheduled attempt is how a production WAL
 * reached 18.7 GB. One minute rides out the ordinary API read wave while still bounding the worker.
 */
const CHECKPOINT_BUSY_TIMEOUT_MS = 60_000;

/**
 * Ceiling on how long a pass waits for the checkpoint worker. It bounds a WEDGED worker, not a slow
 * one, so it has to clear the slowest legitimate run by a wide margin: up to
 * {@link CHECKPOINT_BUSY_TIMEOUT_MS} waiting for readers, then copying a WAL that has reached tens
 * of gigabytes on production. Ten minutes is well past both, and the retry cadence is `intervalMs`
 * anyway. Without a ceiling a worker stuck on an unresponsive filesystem never posts, never errors
 * and never exits — and `stop()`, which awaits the pass, hangs with it for the life of the process.
 */
const CHECKPOINT_TIMEOUT_MS = 10 * 60_000;

/**
 * Ceiling on how long `stop()` waits for a pass that is already running.
 *
 * The pass bounds ITSELF everywhere but one place: the delete loop breaks at the next batch
 * boundary once `stopping` is set, while a pass parked inside `maybeCheckpoint` waits up to
 * {@link CHECKPOINT_TIMEOUT_MS} — ten minutes. `stop()` awaiting that unbounded turned a SIGTERM
 * into a ten-minute shutdown, which the container resolves with SIGKILL long before it ends: the
 * databases are never closed and every later module's stop never runs at all.
 *
 * Walking away is safe, which is what makes a ceiling the right answer rather than a smaller
 * `CHECKPOINT_TIMEOUT_MS`. After the checkpoint await the pass only records `lastRunAt` and logs —
 * it touches no database — and the checkpoint itself runs on the WORKER's own connection, so
 * closing ours behind it changes nothing. A checkpoint killed midway loses nothing either: frames
 * stay in the WAL and the next run copies them again. Five seconds is a term of the shutdown budget
 * in `docker-compose.yml`'s `stop_grace_period`; raising it means redoing that arithmetic.
 */
const STOP_PASS_WAIT_MS = 5_000;

/**
 * Consecutive failed checkpoints after which the warning becomes an error. At the 5 min retry
 * cadence that is a quarter hour of a WAL that cannot be reclaimed — no longer a transient reader
 * but a held read transaction someone has to clear, so it must not stay a routine warn line.
 */
const CHECKPOINT_STARVATION_ALERT_THRESHOLD = 3;

/**
 * Floor for the signal-feed retention horizon. The feed writes warm buckets at 60 000 ms and
 * archives at 3 600 000 ms, so a horizon shorter than a single cold bucket cannot be a real
 * operator intent — it can only be a mis-scaled or overflowed value, and applying it would delete
 * effectively the whole table. Deleting is irreversible, so an unusable horizon skips the sweep.
 */
const MIN_SIGNAL_FEED_RETENTION_MS = HOUR_MS;

const DEFAULT_CONFIG: Required<LedgerRetentionConfig> = {
  intervalMs: 5 * 60 * 1000,
  batchSize: 5_000,
  // v063: bumped 10× to keep up with observed insertion rates (decision_signal_log
  // alone runs ~800k rows/h). Previous 50k cap was too small to drain backlog
  // after a TTL change and let the WAL accumulate.
  maxDeletedRowsPerRun: 500_000,
  // Half the 5 min cadence: a pass that hits this ceiling still leaves the next one a full idle
  // interval, so a large backlog drains over many passes instead of one long freeze.
  maxRunDurationMs: 150_000,
  runtimeMetricsTtlMs: 30 * DAY_MS,
  marketSnapshotsTtlMs: 3 * DAY_MS,
  // v063: 90d TTLs would have held ~17 GB/day each on a 100 GB disk — observed
  // ledger growth filled `/dev/vda2` in ~12h after v062 deploy. 7d caps keep
  // steady-state size to a workable footprint while preserving recent windows
  // for analytics. v135 tightens the hottest debug tables to 72h after the
  // db-size guard exposed that 7d still leaves too little operational headroom.
  executionPolicyObservationsTtlMs: 3 * DAY_MS,
  decisionSignalLogTtlMs: 3 * DAY_MS,
  tradingStateSnapshotsTtlMs: 14 * DAY_MS,
  portfolioSnapshotsTtlMs: 90 * DAY_MS,
  highVolumeRuntimeMetricsTtlMs: DAY_MS,
  // v063: signal_emitted is no longer written (recordDecisionSignal now writes
  // structured rows to decision_signal_log only). The TTL rule is retained to
  // sweep historical rows still present in the ledger; once they age out the
  // bucket effectively only sees signal_suppressed (~8k/h). 1d cap is plenty.
  signalTelemetryRiskEventsTtlMs: 1 * DAY_MS,
  highVolumeRiskEventsTtlMs: DAY_MS,
  orderRejectedRiskEventsTtlMs: 14 * DAY_MS,
  riskEventsTtlMs: 90 * DAY_MS,
  criticalRiskEventsTtlMs: 90 * DAY_MS,
  // signal_feed_buckets had NO effective retention: it grew to 35.1M rows / 15.50 GB — 48% of
  // the whole 32.20 GB ledger, by a full `dbstat` walk — and tripped the db-size guard
  // (2026-07-30). Its four btrees: idx_..._token_time 5.70 GB, sqlite_autoindex_1 3.87 GB,
  // the table 5.16 GB, idx_..._granularity_time 0.77 GB. Root cause: signal-feed-manager's own
  // maintenancePrune deletes only rows matching `coldArchiveBucketMs` granularity
  // (3_600_000ms), but every row is written at `warmBucketMs` granularity (60_000ms) — the
  // prune predicate never matched anything it wrote (verified on production: 35.1M/35.1M
  // rows at granularity 60_000, zero at 3_600_000). Fallback only: index.ts passes the
  // operator's declared `executionProfile.signalFeed.retentionDays`, which is the single
  // source of truth. This mirrors that field's own domain default (execution-policy.ts).
  signalFeedBucketsTtlMs: 7 * DAY_MS,
  // redeem_log had NO retention: 4.28M rows / 2.0 GB (11% of the ledger), 99.55% of it the two
  // churn reason codes this task is scoped to. That backlog is legacy — the writer used to emit one
  // row per sweep for a condition the bot had already stopped touching, and `recordRecurringSkip`
  // now downsamples to one row per quarantine episode per module instance — but it still trickles,
  // so this keeps draining rather than running dry. 7 d is 7x the widest window any reader actually
  // DECIDES on (`findLatestAttemptTs` against `inFlightTtlMs`, operator-configurable up to 24 h —
  // execution-policy.ts:997). Readers that scan further back are covered instead by the condition
  // guard in the task below, which keeps every row of a condition that still has an active one.
  redeemLogChurnTtlMs: 7 * DAY_MS,
  // Caps this task at 50k rows — 10 batches at today's `batchSize` — instead of letting one pass
  // take 500k of the backlog against the shared budget, inside a startup pass `executeStart` awaits
  // before reconciliation and the redeem sweep. It bounds rows and statement count, NOT wall-clock:
  // `LIMIT` says nothing about rows examined, lock wait or I/O, and `runTask` checks the deadline
  // only after each synchronous DELETE returns.
  redeemLogMaxRowsPerRun: 50_000,
  // Unconditional checkpoint cadence (separate from the delete-driven trigger
  // below). Without this the WAL grows indefinitely for a freshly-deployed
  // ledger where retention has nothing to delete yet — observed at 642 MB on
  // a 7.3 GB main DB before this guard was added.
  checkpointIntervalMs: HOUR_MS,
  checkpointMinDeletedRows: 50_000,
  checkpointBusyTimeoutMs: CHECKPOINT_BUSY_TIMEOUT_MS,
  checkpointTimeoutMs: CHECKPOINT_TIMEOUT_MS,
  runOnStart: true,
};

const HIGH_VOLUME_RUNTIME_METRICS = [
  "fee_schedule_active_period",
  "redeem_sweep_skipped_total",
  "redeem_quarantine_skipped_total",
] as const;

const HIGH_VOLUME_RISK_EVENTS = [
  "track_r_margin_threshold_sampled",
  "d9_suppressed_on_profile_owned",
] as const;

type DeleteTask = {
  key: string;
  run: (limit: number) => number;
  maxRowsPerRun?: number;
};

export class LedgerRetentionModule implements RuntimeModule {
  private readonly config: Required<LedgerRetentionConfig>;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopping = false;
  private inFlightPass: Promise<LedgerRetentionResult> | null = null;
  private lastRunAt: string | null = null;
  private lastCheckpointAtMs = 0;
  private consecutiveFailedCheckpoints = 0;
  private signalFeedSweepDisabled = false;
  /** Where the next pass starts its rotation through `buildTasks` — see `executePass`. */
  private taskCursor = 0;
  /**
   * Non-null while a timed-out checkpoint worker is still alive. It holds an open connection to the
   * ledger, so it is a READER — starting the next checkpoint on top of it adds one more thing for
   * that checkpoint to be starved by.
   */
  private abandonedCheckpointExit: Promise<number | null> | null = null;
  /**
   * Every lifecycle transition runs through here, in call order, one at a time. The `stopping` flag
   * alone could not order them: it makes a `start()` that is ALREADY past its startup pass give up,
   * but a `stop()` arriving one microtask later still returns while that start installs its
   * interval, and a second `start()` overlapping the first simply overwrites `this.timer` and leaks
   * the previous interval — a module the supervisor believes is down, sweeping and checkpointing a
   * ledger being torn down.
   */
  private readonly lifecycle = new LifecycleChain(() =>
    this.log.error("lifecycle transition superseded by a later one — dropped"),
  );

  constructor(private readonly deps: LedgerRetentionModuleDeps) {
    this.config = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
    this.log = deps.log.child({ module: "ledger-retention" });
  }

  start(): Promise<void> {
    return this.lifecycle.run((token) => this.executeStart(token));
  }

  private async executeStart(token: LifecycleToken): Promise<void> {
    this.stopping = false;
    // A repeat start would otherwise overwrite the handle and leak the running interval, leaving a
    // second sweep loop nothing can ever clear.
    this.clearTimer();
    if (this.config.runOnStart) {
      await this.runOnce();
    }
    // A stop() that landed while the startup pass was running already cleared the (absent) timer
    // and returned. Installing one now would resurrect the module after the supervisor believes it
    // is down, leaving a pass — and its checkpoint — running against a ledger being torn down.
    //
    // `stopping` alone cannot see the second case: a stop that ESCAPED its ceiling here, followed
    // by a restart, has already reset the flag to false and installed the newer interval. This
    // start would then overwrite `this.timer` with its own, and the newer interval — the one the
    // supervisor believes is the live module — becomes an orphan no `clearTimer()` can reach.
    // Only the token distinguishes that, because only the chain knows a later transition escaped.
    if (this.stopping || token.superseded) {
      this.log.info("ledger retention module stopped during its startup pass");
      return;
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((err: unknown) => {
        this.log.warn({ err }, "ledger retention failed");
      });
    }, this.config.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.log.info("ledger retention module started");
  }

  /** Serialized against every other transition, so the LAST caller decides the final state. */
  stop(): Promise<void> {
    return this.lifecycle.run(() => this.executeStop(), {
      ms: LIFECYCLE_STOP_WAIT_MS,
      onExpired: () =>
        this.log.error(
          { waitMs: LIFECYCLE_STOP_WAIT_MS },
          "lifecycle transition never settled — stopping anyway",
        ),
    });
  }

  private async executeStop(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    // A pass is asynchronous — it yields between delete batches and awaits the checkpoint worker —
    // so clearing the timer does NOT mean the module is idle. Await the in-flight pass (it observes
    // `stopping` and stops at the next batch boundary) so the supervisor never tears the ledger
    // down underneath a resuming `setImmediate` — but only up to {@link STOP_PASS_WAIT_MS}, because
    // one branch of a pass answers to the checkpoint worker's ten-minute ceiling, not to `stopping`.
    const pass = this.inFlightPass;
    if (pass != null) {
      await waitAtMost(pass, {
        ms: STOP_PASS_WAIT_MS,
        onExpired: () =>
          this.log.warn(
            { waitMs: STOP_PASS_WAIT_MS },
            "retention pass still running (checkpoint worker) — stopping without it",
          ),
      });
    }
    this.log.info("ledger retention module stopped");
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Unhealthy whenever something that bounds ledger growth has stopped running, not merely when the
   * timer is gone. Both extra conditions below are states this module can sit in for the life of
   * the process while its own log line scrolls away: a retention horizon it refuses to apply, and a
   * WAL no checkpoint can reclaim. Reporting `ok: true` through either is what let the ledger grow
   * until the db-size-guard paused trading.
   */
  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    const parts = [this.lastRunAt ? `lastRunAt=${this.lastRunAt}` : "not run yet"];
    if (this.consecutiveFailedCheckpoints > 0) {
      parts.push(`failedCheckpoints=${this.consecutiveFailedCheckpoints}`);
    }
    if (this.signalFeedSweepDisabled) parts.push("signalFeedSweep=disabled(unusable horizon)");
    // An outstanding abandoned worker is the third such state, and the quietest: it is set only
    // after a worker blew the ten-minute deadline, and until that thread exits EVERY later attempt
    // takes the skip branch — which deliberately does not count as a failure, so the counter above
    // stays frozen at 1 and never reaches the starvation threshold. A worker that never returns
    // therefore means no checkpoint can even be ATTEMPTED, indefinitely, with `ok: true` throughout.
    const abandonedWorker = this.abandonedCheckpointExit != null;
    if (abandonedWorker) parts.push("checkpointWorker=abandoned(no attempt can run)");
    const starved = this.consecutiveFailedCheckpoints >= CHECKPOINT_STARVATION_ALERT_THRESHOLD;
    return {
      ok: this.timer !== null && !this.signalFeedSweepDisabled && !starved && !abandonedWorker,
      detail: parts.join(" "),
    };
  }

  runOnce(nowMs = Date.now()): Promise<LedgerRetentionResult> {
    if (this.running) {
      return Promise.resolve({
        ranAt: new Date(nowMs).toISOString(),
        deleted: {},
        checkpointed: false,
      });
    }
    this.running = true;
    // Held as a field, not just awaited by the caller: `stop()` has no other handle on a pass the
    // interval started.
    const pass = this.executePass(nowMs).finally(() => {
      this.running = false;
      this.inFlightPass = null;
    });
    this.inFlightPass = pass;
    return pass;
  }

  private async executePass(nowMs: number): Promise<LedgerRetentionResult> {
    const paused = this.deps.runtimeControl?.isPaused() ?? false;
    if (paused) {
      this.log.debug("ledger retention telemetry cleanup running while runtime is paused");
    }
    const ranAt = new Date(nowMs).toISOString();
    const deleted: Record<string, number> = {};
    let remaining = this.config.maxDeletedRowsPerRun;

    const deadlineMs = Date.now() + this.config.maxRunDurationMs;
    // Rotated, not fixed, order. One shared row/time budget consumed in a fixed order means a task
    // that always has `maxDeletedRowsPerRun` rows waiting exhausts every pass at the same position,
    // and the tasks behind it are not "swept by the next pass" — they never run at all. That is how
    // signal_feed_buckets, appended last, grew to 15.5 GB. Starting each pass where the previous one
    // ran out of budget bounds the wait for every task to `tasks.length` passes (~80 min at the
    // 5-minute cadence), whatever the backlog ahead of it, and needs no per-task budget to tune.
    const tasks = this.buildTasks(nowMs);
    const start = tasks.length === 0 ? 0 : this.taskCursor % tasks.length;
    let attempted = 0;
    for (; attempted < tasks.length; attempted++) {
      if (this.stopping || remaining <= 0 || Date.now() >= deadlineMs) break;
      const task = tasks[(start + attempted) % tasks.length];
      if (!task) break;
      // A throwing task is contained here, not propagated, and the reason is the rotation itself.
      // `task.run` is a raw better-sqlite3 statement — SQLITE_BUSY past the timeout, a disk error, a
      // corrupt index — and letting it out of the loop skips BOTH the cursor advance below and
      // `maybeCheckpoint`. The cursor is the worse half: the pass that throws leaves it pointing at
      // the task that threw, so every later pass re-enters the same statement and dies there, and
      // the tasks behind it never run at all — the starvation the rotation exists to close, reached
      // through the error path instead of the budget path. The checkpoint half is what turned a
      // ledger into 15.7 GB of un-truncated WAL in production. Logged at error with the key, so a
      // persistently broken table is visible rather than merely survived.
      try {
        const removed = await this.runTask(task, remaining, deadlineMs);
        if (removed > 0) {
          deleted[task.key] = removed;
          remaining -= removed;
        }
      } catch (err: unknown) {
        this.log.error({ err, task: task.key }, "ledger retention task failed — skipped this pass");
      }
    }
    // Points at the first task this pass did NOT get to, so the next pass opens with it.
    this.taskCursor = tasks.length === 0 ? 0 : (start + attempted) % tasks.length;

    const totalDeleted = Object.values(deleted).reduce((sum, count) => sum + count, 0);
    // Skipped while stopping: the checkpoint is the one part of a pass that can outlive the
    // supervisor's teardown, and losing one round costs a single cadence interval.
    const checkpointed = this.stopping ? false : await this.maybeCheckpoint(nowMs);
    this.lastRunAt = ranAt;

    if (totalDeleted > 0 || checkpointed) {
      this.log.info({ deleted, checkpointed }, "ledger retention complete");
    } else {
      this.log.debug("ledger retention complete");
    }

    return { ranAt, deleted, checkpointed };
  }

  /**
   * The row budget alone does NOT bound how long a pass blocks: better-sqlite3 is synchronous, so
   * a full budget is up to `maxDeletedRowsPerRun / batchSize` statements back to back with nothing
   * in between, and every deleted row rewrites the table plus its indexes. On the production
   * backlog that is minutes of frozen event loop — long enough to time out an established WSS
   * connection and to delay reconciliation of live exchange orders on startup.
   *
   * So: yield to the loop between batches (timers, sockets and the rest of the runtime get to run),
   * and stop at `deadlineMs`. Whatever is left is picked up on a later pass — the delete is
   * resumable by construction, since the cutoff is recomputed and the oldest rows are taken first.
   * "A later pass", not "the next one": `executePass` rotates the starting task, so a table with a
   * standing backlog resumes within `tasks.length` passes instead of monopolising every pass.
   */
  private async runTask(
    task: DeleteTask,
    remainingBudget: number,
    deadlineMs: number,
  ): Promise<number> {
    const budget = Math.min(remainingBudget, task.maxRowsPerRun ?? Infinity);
    let removedTotal = 0;
    while (removedTotal < budget) {
      const limit = Math.min(this.config.batchSize, budget - removedTotal);
      const removed = task.run(limit);
      removedTotal += removed;
      if (removed < limit) break;
      if (this.stopping || Date.now() >= deadlineMs) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return removedTotal;
  }

  private buildTasks(nowMs: number): DeleteTask[] {
    const db = this.deps.db;
    const latestMetricTasks = LATEST_ONLY_RUNTIME_METRICS.map((metricName) => ({
      key: `runtime_metrics.latest.${metricName}`,
      run: (limit: number) =>
        db
          .prepare(
            `DELETE FROM runtime_metrics
             WHERE id IN (
               SELECT id FROM runtime_metrics
               WHERE metric_name = ?
                 AND id != COALESCE((
                   SELECT id FROM runtime_metrics
                   WHERE metric_name = ?
                   ORDER BY captured_at DESC, id DESC
                   LIMIT 1
                 ), -1)
               ORDER BY captured_at ASC, id ASC
               LIMIT ?
             )`,
          )
          .run(metricName, metricName, limit).changes,
    }));

    const tasks: DeleteTask[] = [
      ...latestMetricTasks,
      this.deleteOlderThanTask(
        "runtime_metrics.high_volume_debug",
        "runtime_metrics",
        "captured_at",
        nowMs - this.config.highVolumeRuntimeMetricsTtlMs,
        `metric_name IN (${HIGH_VOLUME_RUNTIME_METRICS.map(() => "?").join(",")})`,
        [...HIGH_VOLUME_RUNTIME_METRICS],
      ),
      this.deleteOlderThanTask(
        "runtime_metrics.history",
        "runtime_metrics",
        "captured_at",
        nowMs - this.config.runtimeMetricsTtlMs,
        `metric_name NOT IN (${LATEST_ONLY_RUNTIME_METRICS.map(() => "?").join(",")})`,
        [...LATEST_ONLY_RUNTIME_METRICS],
      ),
      this.deleteOlderThanTask(
        "market_snapshots",
        "market_snapshots",
        "captured_at",
        nowMs - this.config.marketSnapshotsTtlMs,
      ),
      this.deleteOlderThanTask(
        "execution_policy_observations",
        "execution_policy_observations",
        "created_at",
        nowMs - this.config.executionPolicyObservationsTtlMs,
      ),
      this.deleteOlderThanTask(
        "decision_signal_log",
        "decision_signal_log",
        "signal_timestamp",
        nowMs - this.config.decisionSignalLogTtlMs,
      ),
      this.deleteOlderThanTask(
        "trading_state_snapshots",
        "trading_state_snapshots",
        "captured_at",
        nowMs - this.config.tradingStateSnapshotsTtlMs,
      ),
      this.deleteOlderThanTask(
        "portfolio_snapshots",
        "portfolio_snapshots",
        "captured_at",
        nowMs - this.config.portfolioSnapshotsTtlMs,
      ),
      this.deleteOlderThanTask(
        "risk_events.high_volume_debug",
        "risk_events",
        "created_at",
        nowMs - this.config.highVolumeRiskEventsTtlMs,
        `event_type IN (${HIGH_VOLUME_RISK_EVENTS.map(() => "?").join(", ")})`,
        [...HIGH_VOLUME_RISK_EVENTS],
      ),
      this.deleteOlderThanTask(
        "risk_events.signal_telemetry",
        "risk_events",
        "created_at",
        nowMs - this.config.signalTelemetryRiskEventsTtlMs,
        `event_type IN (${SIGNAL_TELEMETRY_RISK_EVENT_TYPES.map(() => "?").join(", ")})`,
        [...SIGNAL_TELEMETRY_RISK_EVENT_TYPES],
      ),
      this.deleteOlderThanTask(
        "risk_events.order_rejected",
        "risk_events",
        "created_at",
        nowMs - this.config.orderRejectedRiskEventsTtlMs,
        "event_type = 'order_rejected'",
      ),
      this.deleteOlderThanTask(
        "risk_events.non_critical",
        "risk_events",
        "created_at",
        nowMs - this.config.riskEventsTtlMs,
        "NOT (event_type = 'reconciliation_drift' AND payload LIKE '%\"severity\":\"critical\"%')" +
          ` AND event_type NOT IN (${[...SIGNAL_TELEMETRY_RISK_EVENT_TYPES, "order_rejected"]
            .map(() => "?")
            .join(", ")})`,
        [...SIGNAL_TELEMETRY_RISK_EVENT_TYPES, "order_rejected"],
      ),
      this.deleteOlderThanTask(
        "risk_events.critical",
        "risk_events",
        "created_at",
        nowMs - this.config.criticalRiskEventsTtlMs,
      ),
    ];

    // Granularity-agnostic on purpose: this table's only prior TTL attempt (in
    // signal-feed-manager.ts) filtered on a fixed bucket_granularity_ms and silently
    // matched zero rows because nothing is ever written at that granularity. Sweeping by
    // age alone, regardless of bucket_granularity_ms, avoids repeating that mistake —
    // migration 090 adds the bucket_start_ms index that keeps it a range seek rather
    // than the 2.3–3.9 s full scan measured before it existed.
    const signalFeedTtlMs = this.resolveSignalFeedBucketsTtlMs();
    // Remembered for `healthCheck`. A horizon that fails validation skips the sweep on every pass
    // for the life of the process, and this table is the largest in the ledger (15.5 GB with its
    // indexes on production) — reporting healthy while the only thing that bounds it never runs is
    // how the growth reaches a db-size-guard pause with nothing in the logs an operator watches.
    this.signalFeedSweepDisabled = signalFeedTtlMs == null;
    if (signalFeedTtlMs != null) {
      tasks.push(
        this.deleteOlderThanTask(
          "signal_feed_buckets",
          "signal_feed_buckets",
          "bucket_start_ms",
          nowMs - signalFeedTtlMs,
          undefined,
          [],
          { timestampFormat: "epochMs", rowIdColumn: "rowid" },
        ),
      );
    }

    // Last position can defer this task past the startup pass; the rotation in `executePass` keeps
    // that from hardening into starvation. `maxRowsPerRun` applies only once the task is reached.
    tasks.push(
      this.deleteOlderThanTask(
        "redeem_log",
        "redeem_log",
        "attempt_ts",
        nowMs - this.config.redeemLogChurnTtlMs,
        // Only the two churn reasons. Every other `skipped` reason is evidence (zero_balance_* is
        // what an accounting bug looks like), and every non-churn outcome is the audit trail the
        // /redeem-log API serves. retry_count/tx_hash/gas_used are redundant against today's census
        // ON PURPOSE:
        // they stop a future writer that stamps a hash or a retry onto a quarantine row from
        // silently enrolling it.
        //
        // The condition guard is not about the status list. findRecentActiveAttempts,
        // hasRecentActiveAttempt and markOrphanedActiveAttempts all define "latest" as "no strictly
        // newer row of ANY status", so deleting a newer skipped row would un-mask an older active row
        // and make the sweep report an 80-day-old attempt as orphaned. A condition holding no active
        // row has nothing to un-mask.
        `status = 'skipped'
           AND error_msg IN ('state_failed_quarantine','state_failed_cooldown')
           AND retry_count = 0
           AND tx_hash IS NULL
           AND gas_used IS NULL
           AND condition_id NOT IN (
             SELECT condition_id FROM redeem_log WHERE status IN (${ACTIVE_REDEEM_LOG_STATUS_SQL})
           )`,
        undefined,
        { timestampFormat: "epochMs", maxRowsPerRun: this.config.redeemLogMaxRowsPerRun },
      ),
    );
    return tasks;
  }

  /**
   * Resolve the signal-feed horizon, or null when there is no horizon that can be applied safely.
   *
   * The policy parser accepts any positive finite `retentionDays`, and `retentionDays * DAY_MS`
   * then covers a domain no sane operator means: `5e-324` days multiplies to a positive-but-
   * subnormal number of ms that subtracts to exactly `nowMs` (sweeping the entire table), and
   * `1e301` days overflows to `Infinity`. Validation lives HERE, at the only consumer that
   * destroys data with the value — the parser is shared by dozens of fields and only this caller
   * knows the result is irreversible.
   *
   * An unusable value FAILS CLOSED — the sweep is skipped, keeping every row — rather than
   * substituting the configured default. Falling back would answer "retain effectively forever"
   * (an overflowed horizon) with "delete everything older than seven days", which is the opposite
   * of the operator's intent and equally irreversible.
   */
  private resolveSignalFeedBucketsTtlMs(): number | null {
    const live = this.deps.resolveSignalFeedBucketsTtlMs?.() ?? null;
    return live == null
      ? this.validateRetentionMs(this.config.signalFeedBucketsTtlMs, "configured fallback")
      : this.validateRetentionMs(live, "execution policy");
  }

  private validateRetentionMs(candidate: number, source: string): number | null {
    if (!Number.isFinite(candidate) || candidate < MIN_SIGNAL_FEED_RETENTION_MS) {
      this.log.error(
        { source, retentionMs: candidate, minRetentionMs: MIN_SIGNAL_FEED_RETENTION_MS },
        "signal-feed retention horizon unusable — sweep skipped, no rows deleted",
      );
      return null;
    }
    return candidate;
  }

  private deleteOlderThanTask(
    key: string,
    table: string,
    timestampColumn: string,
    cutoffMs: number,
    extraWhere?: string,
    extraParams: unknown[] = [],
    options?: { timestampFormat?: "iso" | "epochMs"; rowIdColumn?: string; maxRowsPerRun?: number },
  ): DeleteTask {
    const rowIdColumn = options?.rowIdColumn ?? "id";
    const cutoff =
      options?.timestampFormat === "epochMs" ? cutoffMs : new Date(cutoffMs).toISOString();
    const where = [`${timestampColumn} < ?`, extraWhere].filter(Boolean).join(" AND ");
    const stmt = this.deps.db.prepare(
      `DELETE FROM ${table}
       WHERE ${rowIdColumn} IN (
         SELECT ${rowIdColumn} FROM ${table}
         WHERE ${where}
         ORDER BY ${timestampColumn} ASC, ${rowIdColumn} ASC
         LIMIT ?
       )`,
    );
    return {
      key,
      run: (limit: number) => stmt.run(cutoff, ...extraParams, limit).changes,
      ...(options?.maxRowsPerRun !== undefined ? { maxRowsPerRun: options.maxRowsPerRun } : {}),
    };
  }

  /**
   * Checkpoint the WAL on a fixed cadence regardless of how many rows the
   * current retention pass deleted. Previously this only fired when a large
   * batch was pruned, which never happens for a freshly-deployed ledger where
   * all data is younger than the TTL — leaving the WAL to grow unbounded
   * (observed 642 MB on a 7.3 GB main DB). `checkpointMinDeletedRows` is kept
   * in the config for backwards-compatibility but no longer gates the trigger.
   */
  private async maybeCheckpoint(nowMs: number): Promise<boolean> {
    if (nowMs - this.lastCheckpointAtMs < this.config.checkpointIntervalMs) return false;
    const dbPath = this.deps.checkpointDbPath;
    if (dbPath == null) {
      this.log.debug("no ledger path configured — wal checkpoint skipped");
      return false;
    }
    // The checkpoint runs on its OWN connection in a worker thread (see wal-checkpoint.ts): the
    // native TRUNCATE is synchronous and copying a multi-GB WAL takes minutes, which on the shared
    // runtime connection is minutes of frozen event loop. The pragma returns its own verdict —
    // [{busy, log, checkpointed}] — and `busy: 1` means a reader held the WAL back and NOTHING was
    // truncated. Reporting the ATTEMPT as success is what let a WAL reach 18.7 GB on production
    // while the log claimed `checkpointed: true`. `log` (frames in the WAL) and `checkpointed`
    // (frames moved) are the only numbers that show whether the file is actually shrinking.
    if (this.abandonedCheckpointExit != null) {
      this.log.warn("previous checkpoint worker has not exited yet — attempt skipped");
      return false;
    }
    const { result, error, abandoned, workerExit } = await runWalCheckpointOffThread(
      dbPath,
      this.config.checkpointBusyTimeoutMs,
      this.config.checkpointTimeoutMs,
    );
    // Only a worker the deadline gave up on is tracked. One that reported has already closed its
    // connection (the worker closes before it posts), so holding the guard for its thread teardown
    // would make the very next attempt skip itself over a thread that owns nothing.
    if (abandoned) {
      this.abandonedCheckpointExit = workerExit;
      void workerExit.finally(() => {
        if (this.abandonedCheckpointExit === workerExit) this.abandonedCheckpointExit = null;
      });
    }
    if (result == null || result.busy === 1 || !reclaimedFromWal(result)) {
      this.reportFailedCheckpoint(result, error, dbPath);
      return false;
    }
    this.consecutiveFailedCheckpoints = 0;
    // The mark is advanced ONLY on success. Advancing it on a failed attempt sells a full
    // `checkpointIntervalMs` of silence to a reader that held the WAL for one minute — at the
    // observed write volume the WAL grows by gigabytes inside that window, which is the exact
    // failure this cadence exists to prevent. Leaving it retries on the next pass (`intervalMs`).
    this.lastCheckpointAtMs = nowMs;
    this.log.info(
      { walFrames: result.log ?? null, checkpointedFrames: result.checkpointed ?? null },
      "wal checkpoint truncated",
    );
    return true;
  }

  /**
   * A single failed checkpoint is ordinary — some reader overlapped the attempt and the next pass
   * will get it. A RUN of them is not: the WAL can never be reclaimed no matter how patiently we
   * wait. Say so at ERROR with the WAL's real size, because that is the number an operator needs.
   *
   * The three failure modes must not share a message, because each sends the operator somewhere
   * else. `busy: 1` is the pragma's OWN verdict: a reader held the WAL back, and the fix is to find
   * that reader. A null result means the worker never produced a verdict at all — it threw, timed
   * out or died — and the fix is in `error`, nowhere near a reader. `log: -1` means the file we
   * opened has no WAL to check: the configured path is not the runtime's ledger, and the fix is the
   * path. Blaming a "persistent reader" for a crashed worker, or for a mis-pointed path, sends the
   * operator hunting a transaction that does not exist.
   */
  private reportFailedCheckpoint(
    result: CheckpointResult | null,
    error: string | null,
    dbPath: string,
  ): void {
    this.consecutiveFailedCheckpoints += 1;
    const detail = {
      walCheckpoint: result,
      error,
      consecutiveFailures: this.consecutiveFailedCheckpoints,
      walBytes: walFileBytes(dbPath),
    };
    const message = failedCheckpointMessage(result);
    if (this.consecutiveFailedCheckpoints >= CHECKPOINT_STARVATION_ALERT_THRESHOLD) {
      this.log.error(detail, `${message} — WAL cannot shrink`);
      return;
    }
    this.log.warn(detail, message);
  }
}

/**
 * `log` is the number of frames SQLite found in the WAL. It answers -1 when there is no WAL to check
 * at all, i.e. the database is not in WAL mode — including the EMPTY database better-sqlite3 used to
 * create silently for a path that did not exist. Verified empirically: such a file returns
 * `{busy: 0, log: -1, checkpointed: -1}` from both PASSIVE and TRUNCATE, which a `busy !== 1` test
 * reads as a clean truncate. Nothing was reclaimed, so nothing may be reported as reclaimed.
 */
function reclaimedFromWal(result: CheckpointResult): boolean {
  return (result.log ?? -1) >= 0;
}

function failedCheckpointMessage(result: CheckpointResult | null): string {
  if (result == null) return "wal checkpoint worker produced no verdict";
  if (result.busy === 1) return "wal checkpoint starved by a persistent reader";
  return "wal checkpoint found no WAL — checkpoint path is not the live ledger";
}

/** Best-effort: a missing/unreadable `-wal` is itself the answer (nothing to reclaim). */
function walFileBytes(dbPath: string): number | null {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch {
    return null;
  }
}
