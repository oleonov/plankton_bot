import type Database from "better-sqlite3";
import type { RuntimeControl, RuntimeModule } from "@krabs/domain";
import type { Logger } from "../../logger.js";

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
  runtimeMetricsTtlMs?: number;
  marketSnapshotsTtlMs?: number;
  executionPolicyObservationsTtlMs?: number;
  decisionSignalLogTtlMs?: number;
  tradingStateSnapshotsTtlMs?: number;
  portfolioSnapshotsTtlMs?: number;
  signalTelemetryRiskEventsTtlMs?: number;
  orderRejectedRiskEventsTtlMs?: number;
  riskEventsTtlMs?: number;
  criticalRiskEventsTtlMs?: number;
  checkpointIntervalMs?: number;
  checkpointMinDeletedRows?: number;
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
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const DEFAULT_CONFIG: Required<LedgerRetentionConfig> = {
  intervalMs: 5 * 60 * 1000,
  batchSize: 5_000,
  maxDeletedRowsPerRun: 50_000,
  runtimeMetricsTtlMs: 30 * DAY_MS,
  marketSnapshotsTtlMs: 7 * DAY_MS,
  executionPolicyObservationsTtlMs: 90 * DAY_MS,
  decisionSignalLogTtlMs: 90 * DAY_MS,
  tradingStateSnapshotsTtlMs: 14 * DAY_MS,
  portfolioSnapshotsTtlMs: 90 * DAY_MS,
  // High-volume audit streams: signal_emitted/signal_suppressed (~17k/h) and
  // order_rejected (~19k/h) dominate risk_events size. Cap their retention
  // aggressively; debugging windows beyond a week are answered by logs, not by
  // SQLite row scans on a multi-GB ledger. Critical events keep the 90-day TTL.
  signalTelemetryRiskEventsTtlMs: 7 * DAY_MS,
  orderRejectedRiskEventsTtlMs: 14 * DAY_MS,
  riskEventsTtlMs: 90 * DAY_MS,
  criticalRiskEventsTtlMs: 90 * DAY_MS,
  // Unconditional checkpoint cadence (separate from the delete-driven trigger
  // below). Without this the WAL grows indefinitely for a freshly-deployed
  // ledger where retention has nothing to delete yet — observed at 642 MB on
  // a 7.3 GB main DB before this guard was added.
  checkpointIntervalMs: HOUR_MS,
  checkpointMinDeletedRows: 50_000,
  runOnStart: true,
};

type DeleteTask = {
  key: string;
  run: (limit: number) => number;
};

export class LedgerRetentionModule implements RuntimeModule {
  private readonly config: Required<LedgerRetentionConfig>;
  private readonly log: Logger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: string | null = null;
  private lastCheckpointAtMs = 0;

  constructor(private readonly deps: LedgerRetentionModuleDeps) {
    this.config = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
    this.log = deps.log.child({ module: "ledger-retention" });
  }

  async start(): Promise<void> {
    if (this.config.runOnStart) {
      await this.runOnce();
    }
    this.timer = setInterval(() => {
      this.runOnce().catch((err: unknown) => {
        this.log.warn({ err }, "ledger retention failed");
      });
    }, this.config.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.log.info("ledger retention module started");
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("ledger retention module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: this.timer !== null,
      detail: this.lastRunAt ? `lastRunAt=${this.lastRunAt}` : "not run yet",
    };
  }

  async runOnce(nowMs = Date.now()): Promise<LedgerRetentionResult> {
    if (this.running) {
      return { ranAt: new Date(nowMs).toISOString(), deleted: {}, checkpointed: false };
    }
    if (this.deps.runtimeControl?.isPaused()) {
      this.log.debug("ledger retention skipped while runtime is paused");
      return { ranAt: new Date(nowMs).toISOString(), deleted: {}, checkpointed: false };
    }
    this.running = true;
    try {
      const ranAt = new Date(nowMs).toISOString();
      const deleted: Record<string, number> = {};
      let remaining = this.config.maxDeletedRowsPerRun;

      for (const task of this.buildTasks(nowMs)) {
        if (remaining <= 0) break;
        const removed = this.runTask(task, remaining);
        if (removed > 0) {
          deleted[task.key] = removed;
          remaining -= removed;
        }
      }

      const totalDeleted = Object.values(deleted).reduce((sum, count) => sum + count, 0);
      const checkpointed = this.maybeCheckpoint(nowMs);
      this.lastRunAt = ranAt;

      if (totalDeleted > 0 || checkpointed) {
        this.log.info({ deleted, checkpointed }, "ledger retention complete");
      } else {
        this.log.debug("ledger retention complete");
      }

      return { ranAt, deleted, checkpointed };
    } finally {
      this.running = false;
    }
  }

  private runTask(task: DeleteTask, remainingBudget: number): number {
    let removedTotal = 0;
    while (removedTotal < remainingBudget) {
      const limit = Math.min(this.config.batchSize, remainingBudget - removedTotal);
      const removed = task.run(limit);
      removedTotal += removed;
      if (removed < limit) break;
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

    return [
      ...latestMetricTasks,
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
        "risk_events.signal_telemetry",
        "risk_events",
        "created_at",
        nowMs - this.config.signalTelemetryRiskEventsTtlMs,
        "event_type IN ('signal_suppressed', 'signal_emitted')",
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
          " AND event_type NOT IN ('signal_suppressed', 'signal_emitted', 'order_rejected')",
      ),
      this.deleteOlderThanTask(
        "risk_events.critical",
        "risk_events",
        "created_at",
        nowMs - this.config.criticalRiskEventsTtlMs,
      ),
    ];
  }

  private deleteOlderThanTask(
    key: string,
    table: string,
    timestampColumn: string,
    cutoffMs: number,
    extraWhere?: string,
    extraParams: unknown[] = [],
  ): DeleteTask {
    const cutoff = new Date(cutoffMs).toISOString();
    const where = [`${timestampColumn} < ?`, extraWhere].filter(Boolean).join(" AND ");
    const stmt = this.deps.db.prepare(
      `DELETE FROM ${table}
       WHERE id IN (
         SELECT id FROM ${table}
         WHERE ${where}
         ORDER BY ${timestampColumn} ASC, id ASC
         LIMIT ?
       )`,
    );
    return {
      key,
      run: (limit: number) => stmt.run(cutoff, ...extraParams, limit).changes,
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
  private maybeCheckpoint(nowMs: number): boolean {
    if (nowMs - this.lastCheckpointAtMs < this.config.checkpointIntervalMs) return false;
    this.deps.db.pragma("wal_checkpoint(TRUNCATE)");
    this.lastCheckpointAtMs = nowMs;
    return true;
  }
}
