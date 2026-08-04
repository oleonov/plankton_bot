import type {
  DecisionSignalLog,
  DecisionSignalLogRepository,
  RiskEventRepository,
} from "@krabs/domain";
import { Worker } from "node:worker_threads";
import { waitAtMost } from "../../lifecycle-chain.js";
import type { Logger } from "../../logger.js";

/**
 * How long `stop()` waits for the worker to acknowledge the shutdown message.
 *
 * The worker acknowledges only after `db.close()`, and it processes messages one at a time — so an
 * ack that is late means the worker is inside a synchronous better-sqlite3 transaction, waiting on
 * the ledger's write lock. Waiting longer does not help: the ack arrives when the lock is released,
 * on a timescale the shutdown budget cannot afford. Losing the tail of a telemetry batch is the
 * cheapest thing in this teardown.
 */
const WORKER_SHUTDOWN_ACK_WAIT_MS = 2_000;

/**
 * How long `stop()` waits for the worker THREAD to exit after `terminate()`.
 *
 * Only reachable once the worker HAS acknowledged — it is then idle behind a closed database, so
 * this bound is defensive, not load-bearing. The wedged case never terminates at all; see the
 * comment on the unref path in `stop()`. Both terms are cited by name in `docker-compose.yml`'s
 * `stop_grace_period` arithmetic.
 */
const WORKER_TERMINATE_WAIT_MS = 2_000;

type RiskEvent = { eventType: string; payload: Record<string, unknown> };
type QueuedWrite =
  | { kind: "decision_signal"; signal: DecisionSignalLog }
  | { kind: "risk_event"; event: RiskEvent };

export interface DecisionPersistenceOptions {
  readonly mode?: "sync" | "async" | "worker";
  readonly maxQueueSize?: number;
  readonly batchSize?: number;
  readonly workerDbPath?: string | undefined;
}

export class DecisionPersistenceBuffer {
  private readonly mode: "sync" | "async" | "worker";
  private readonly maxQueueSize: number;
  private readonly batchSize: number;
  private readonly queue: QueuedWrite[] = [];
  private readonly worker: Worker | null = null;
  private flushing = false;
  private flushScheduled = false;
  private droppedWrites = 0;
  private workerPersistedWrites = 0;
  private workerFailedWrites = 0;
  private shutdownAck: (() => void) | null = null;

  constructor(
    private readonly deps: {
      readonly decisionSignalLogRepo?: DecisionSignalLogRepository | undefined;
      readonly riskEventRepo?: RiskEventRepository | undefined;
      readonly log: Logger;
    },
    opts: DecisionPersistenceOptions = {},
  ) {
    this.mode = opts.mode === "worker" && !opts.workerDbPath ? "async" : (opts.mode ?? "sync");
    this.maxQueueSize = opts.maxQueueSize ?? 20_000;
    this.batchSize = opts.batchSize ?? 500;
    if (opts.mode === "worker" && !opts.workerDbPath) {
      this.deps.log.warn("decision persistence worker requested without db path; using async mode");
    }
    if (this.mode === "worker") {
      this.worker = new Worker(DECISION_PERSISTENCE_WORKER_SOURCE, {
        eval: true,
        workerData: { dbPath: opts.workerDbPath },
      });
      this.worker.on("message", (message: unknown) => this.handleWorkerMessage(message));
      this.worker.on("error", (err) =>
        this.deps.log.error({ err }, "decision persistence worker error"),
      );
      this.worker.on("exit", (code) => {
        if (code !== 0) {
          this.deps.log.error({ code }, "decision persistence worker exited unexpectedly");
        }
      });
    }
  }

  enqueueDecisionSignal(signal: DecisionSignalLog): void {
    this.enqueue({ kind: "decision_signal", signal });
  }

  enqueueRiskEvent(event: RiskEvent): void {
    this.enqueue({ kind: "risk_event", event });
  }

  async stop(): Promise<void> {
    if (this.mode !== "worker" || !this.worker) {
      this.flushSync();
      return;
    }
    const worker = this.worker;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      worker.postMessage({ type: "batch", writes: batch });
    }
    let acknowledged = true;
    await waitAtMost(
      new Promise<void>((resolve) => {
        this.shutdownAck = resolve;
        worker.postMessage({ type: "shutdown" });
      }),
      {
        ms: WORKER_SHUTDOWN_ACK_WAIT_MS,
        onExpired: () => {
          acknowledged = false;
          this.deps.log.warn(
            { waitMs: WORKER_SHUTDOWN_ACK_WAIT_MS },
            "decision persistence worker did not acknowledge shutdown — abandoning the wedged thread",
          );
        },
      },
    );
    this.shutdownAck = null;
    if (!acknowledged) {
      // A missing ack means the worker is INSIDE a synchronous better-sqlite3 call. `terminate()`
      // must not be called there: it puts the worker isolate into terminating state, and when the
      // wedged statement's `busy_timeout` finally expires better-sqlite3 has to ALLOCATE a JS Error
      // to throw SQLITE_BUSY. That allocation returns an empty MaybeLocal and Node aborts the whole
      // process — mid-shutdown, before the final metric flush and `process.exit(0)`. Reproduced.
      // Left alone the worker just throws SQLITE_BUSY normally into its own catch and goes idle.
      worker.unref();
      return;
    }
    await waitAtMost(worker.terminate(), {
      ms: WORKER_TERMINATE_WAIT_MS,
      onExpired: () =>
        this.deps.log.warn(
          { waitMs: WORKER_TERMINATE_WAIT_MS },
          "decision persistence worker did not exit — abandoning the thread to the process exit",
        ),
    });
  }

  getStats(): {
    queued: number;
    droppedWrites: number;
    mode: "sync" | "async" | "worker";
    workerPersistedWrites: number;
    workerFailedWrites: number;
  } {
    return {
      queued: this.queue.length,
      droppedWrites: this.droppedWrites,
      mode: this.mode,
      workerPersistedWrites: this.workerPersistedWrites,
      workerFailedWrites: this.workerFailedWrites,
    };
  }

  private enqueue(write: QueuedWrite): void {
    if (this.mode === "sync") {
      this.persist(write);
      return;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.droppedWrites++;
      if (this.droppedWrites === 1 || this.droppedWrites % 1000 === 0) {
        this.deps.log.warn(
          { droppedWrites: this.droppedWrites, maxQueueSize: this.maxQueueSize },
          "decision persistence queue full — dropping oldest telemetry write",
        );
      }
    }
    this.queue.push(write);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushing) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      this.flushBatch();
    });
  }

  private flushBatch(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const batch = this.queue.splice(0, this.batchSize);
      if (this.mode === "worker" && this.worker) {
        if (batch.length > 0) this.worker.postMessage({ type: "batch", writes: batch });
      } else {
        for (const write of batch) this.persist(write);
      }
    } finally {
      this.flushing = false;
    }
    if (this.queue.length > 0) this.scheduleFlush();
  }

  private flushSync(): void {
    while (this.queue.length > 0) {
      const write = this.queue.shift()!;
      this.persist(write);
    }
  }

  private persist(write: QueuedWrite): void {
    try {
      if (write.kind === "decision_signal") {
        this.deps.decisionSignalLogRepo?.insert(write.signal);
      } else {
        this.deps.riskEventRepo?.insert(write.event);
      }
    } catch (err) {
      const tokenId =
        write.kind === "decision_signal"
          ? String(write.signal.tokenId)
          : String(write.event.payload.tokenId ?? "");
      this.deps.log.warn(
        { err, kind: write.kind, tokenId },
        "failed to persist queued decision telemetry",
      );
    }
  }

  private handleWorkerMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const typed = message as {
      type?: string;
      persisted?: number;
      failed?: number;
      error?: string;
    };
    if (typed.type === "batch_result") {
      this.workerPersistedWrites += typed.persisted ?? 0;
      this.workerFailedWrites += typed.failed ?? 0;
      if ((typed.failed ?? 0) > 0) {
        this.deps.log.warn(
          { failedWrites: typed.failed, error: typed.error },
          "decision persistence worker failed to persist some writes",
        );
      }
      return;
    }
    if (typed.type === "shutdown_ack") {
      this.shutdownAck?.();
      this.shutdownAck = null;
    }
  }
}

const DECISION_SIGNAL_INSERT_SQL = `
INSERT INTO decision_signal_log
 (signal_id, token_id, condition_id, side, decision_rule_id, sizing_rule_id,
  notional_bucket, state, price, buy_count, time_since_last_seconds, signal_timestamp,
  is_add, add_age_ms, add_age_bucket, add_price_change_pct, add_price_change_bucket,
  nth_buy_at_emit,
  is_exit, is_first_sell, holding_time_ms, holding_time_bucket,
  exit_pnl_pct, exit_pnl_bucket, sold_bought_ratio, sold_bought_ratio_bucket,
  entry_fresh_edge_kind, entry_fresh_edge_shadow_class, entry_fresh_edge_payload_json,
  entry_category, entry_category_gate_class, entry_category_payload_json)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const DECISION_PERSISTENCE_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");

const db = new Database(workerData.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const insertSignal = db.prepare(${JSON.stringify(DECISION_SIGNAL_INSERT_SQL)});
const insertRiskEvent = db.prepare("INSERT INTO risk_events (event_type, payload) VALUES (?, ?)");

function persist(write) {
  if (write.kind === "decision_signal") {
    const signal = write.signal;
    insertSignal.run(
      signal.signalId,
      signal.tokenId,
      signal.conditionId,
      signal.side,
      signal.decisionRuleId,
      signal.sizingRuleId,
      signal.notionalBucket,
      signal.state,
      signal.price,
      signal.buyCount,
      signal.timeSinceLastSeconds,
      signal.signalTimestamp,
      signal.isAdd,
      signal.addAgeMs,
      signal.addAgeBucket,
      signal.addPriceChangePct,
      signal.addPriceChangeBucket,
      signal.nthBuyAtEmit,
      signal.isExit,
      signal.isFirstSell,
      signal.holdingTimeMs,
      signal.holdingTimeBucket,
      signal.exitPnlPct,
      signal.exitPnlBucket,
      signal.soldBoughtRatio,
      signal.soldBoughtRatioBucket,
      signal.entryFreshEdgeKind ?? null,
      signal.entryFreshEdgeShadowClass ?? null,
      signal.entryFreshEdgePayloadJson ?? null,
      signal.entryCategory ?? null,
      signal.entryCategoryGateClass ?? null,
      signal.entryCategoryPayloadJson ?? null
    );
    return;
  }
  insertRiskEvent.run(write.event.eventType, JSON.stringify(write.event.payload));
}

parentPort.on("message", (message) => {
  if (message.type === "batch") {
    let persisted = 0;
    let failed = 0;
    let error = null;
    const tx = db.transaction((writes) => {
      for (const write of writes) {
        try {
          persist(write);
          persisted++;
        } catch (err) {
          failed++;
          error = err && err.message ? err.message : String(err);
        }
      }
    });
    try {
      tx(message.writes || []);
    } catch (err) {
      failed += (message.writes || []).length - persisted;
      error = err && err.message ? err.message : String(err);
    }
    parentPort.postMessage({ type: "batch_result", persisted, failed, error });
    return;
  }
  if (message.type === "shutdown") {
    db.close();
    parentPort.postMessage({ type: "shutdown_ack" });
  }
});
`;
