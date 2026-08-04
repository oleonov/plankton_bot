import type Database from "better-sqlite3";
import { withShutdownBusyTimeout } from "@krabs/db";
import type { DepHealthRecorder, DepKey } from "@krabs/domain";
import type { TimerRegistry } from "./periodic-timers.js";

type CounterEntry = {
  metricName: string;
  labels: string | null;
  sum: number;
};

type DepAccumulator = { count: number; sumMs: number; maxMs: number; errors: number };

const counterKey = (metricName: string, labels: string | null): string =>
  labels === null ? `${metricName}-NULL-` : `${metricName}-LABELED-${labels}`;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export class RuntimeMetricWriter implements DepHealthRecorder {
  private readonly findLatest;
  private readonly insertMetric;
  private readonly updateMetric;
  private readonly deleteByName;
  private readonly replaceLatestTx;
  private readonly counterBuffer = new Map<string, CounterEntry>();
  private readonly depBuffer = new Map<DepKey, DepAccumulator>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs = 0;
  private shuttingDown = false;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.findLatest = db.prepare(
      "SELECT id FROM runtime_metrics WHERE metric_name = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
    );
    this.insertMetric = db.prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, ?, ?, ?)",
    );
    this.updateMetric = db.prepare(
      "UPDATE runtime_metrics SET value = ?, labels = ?, captured_at = ? WHERE id = ?",
    );
    this.deleteByName = db.prepare("DELETE FROM runtime_metrics WHERE metric_name = ?");
    this.replaceLatestTx = db.transaction(
      (metricName: string, value: number, labels: string | null, capturedAt: string) => {
        this.deleteByName.run(metricName);
        this.insertMetric.run(metricName, value, labels, capturedAt);
      },
    );
  }

  /**
   * From here on every metric write is bounded by the short teardown busy_timeout.
   *
   * The invariant this rests on is NOT that nothing else ever writes `runtime_metrics` — the
   * entrypoint's periodic flush prepares its own statements. It is narrower and checkable: every
   * write still REACHABLE during teardown goes through this class. The entrypoint's other raw
   * writers all live inside `periodicTimers`, which `stopAll()` kills before `enterShutdownMode()`
   * is called; the three that hang off permanent bus subscriptions — and therefore keep firing while
   * modules stop — use `replaceLatest`/`clearLatest` here for exactly that reason.
   *
   * Scoping the bound this way is what keeps trading state out of it: a module's final telemetry
   * flush and an exchange-accepted order's persistence share one connection, and only the first may
   * be dropped to two seconds. Modules that write orders, fills or positions during teardown keep
   * the full runtime timeout — an order the exchange already accepted must reach the ledger or the
   * next startup adoption fail-closes on it.
   */
  enterShutdownMode(): void {
    this.shuttingDown = true;
  }

  /** Identity until teardown — the pragma round-trip is not worth paying on the hot path. */
  private bounded<T>(write: () => T): T {
    return this.shuttingDown ? withShutdownBusyTimeout(this.db, write) : write();
  }

  writeLatest(
    metricName: string,
    value = 1,
    labels: string | null = null,
    capturedAt = this.now().toISOString(),
  ): void {
    this.bounded(() => {
      const latest = this.findLatest.get(metricName) as { id: number } | undefined;
      if (latest) {
        this.updateMetric.run(value, labels, capturedAt, latest.id);
        return;
      }
      this.insertMetric.run(metricName, value, labels, capturedAt);
    });
  }

  /**
   * Delete-all-then-insert, not the find-and-update of `writeLatest`. The difference matters for
   * metrics the API reads with a bare `LIMIT 1` and no ORDER BY (`market_data_poll_progress` at
   * apps/api/src/routes/status.ts:573): `writeLatest` refreshes only the newest row and leaves any
   * legacy duplicate for retention to prune later, so such a reader could pick up the stale one.
   * This is self-healing against duplicates instead.
   */
  replaceLatest(
    metricName: string,
    value = 1,
    labels: string | null = null,
    capturedAt = this.now().toISOString(),
  ): void {
    this.bounded(() => this.replaceLatestTx(metricName, value, labels, capturedAt));
  }

  /** Removes a latest-only metric entirely — the state it reports is no longer true of anything. */
  clearLatest(metricName: string): void {
    this.bounded(() => this.deleteByName.run(metricName));
  }

  writeEvent(
    metricName: string,
    value = 1,
    labels: string | null = null,
    capturedAt = this.now().toISOString(),
  ): void {
    this.bounded(() => this.insertMetric.run(metricName, value, labels, capturedAt));
  }

  // Buffered append-only counter. Multiple calls with the same (name, labels)
  // are aggregated in memory; one row is emitted per unique pair on flush.
  // Trades millisecond-level fidelity for ~30x lower write volume on hot
  // `*_total` metrics that the API never reads at sub-flush resolution.
  // State metrics use writeLatest; low-volume audit events use writeEvent.
  writeCounter(metricName: string, value = 1, labels: string | null = null): void {
    const key = counterKey(metricName, labels);
    const existing = this.counterBuffer.get(key);
    if (existing) {
      existing.sum += value;
      return;
    }
    this.counterBuffer.set(key, { metricName, labels, sum: value });
  }

  // Emits one row per buffered (name, labels) pair and clears the buffer.
  // capturedAt is the flush instant — individual event timestamps are not
  // preserved by design. Buffer is cleared only after the insert transaction
  // succeeds, so a thrown error leaves the buffer intact for the next retry.
  flushCounters(capturedAt = this.now().toISOString()): void {
    if (this.counterBuffer.size === 0) return;
    const entries = Array.from(this.counterBuffer.values());
    const insert = this.db.transaction((rows: CounterEntry[]) => {
      for (const row of rows) {
        this.insertMetric.run(row.metricName, row.sum, row.labels, capturedAt);
      }
    });
    this.bounded(() => insert(entries));
    this.counterBuffer.clear();
  }

  // DepHealthRecorder: accumulate one outbound gateway call (Phase 2a). Pure
  // arithmetic, never throws — telemetry must not affect the trading call.
  record(dep: DepKey, latencyMs: number, ok: boolean): void {
    const ms = Number.isFinite(latencyMs) && latencyMs > 0 ? latencyMs : 0;
    const acc = this.depBuffer.get(dep) ?? { count: 0, sumMs: 0, maxMs: 0, errors: 0 };
    acc.count += 1;
    acc.sumMs += ms;
    if (ms > acc.maxMs) acc.maxMs = ms;
    if (!ok) acc.errors += 1;
    this.depBuffer.set(dep, acc);
  }

  // Emits one APPEND-ONLY `dep_health` row per accumulated dep (NOT writeLatest,
  // which keys on metric_name alone and would overwrite across deps). Labels are
  // a bounded aggregate only — no endpoint URL / tokenId / conditionId / orderId.
  // Buffer is cleared only after the insert transaction succeeds.
  flushDepHealth(capturedAt = this.now().toISOString()): void {
    if (this.depBuffer.size === 0) return;
    const entries = Array.from(this.depBuffer.entries());
    const insert = this.db.transaction((rows: [DepKey, DepAccumulator][]) => {
      for (const [dep, acc] of rows) {
        const avgMs = acc.count > 0 ? acc.sumMs / acc.count : 0;
        const errorRatePct = acc.count > 0 ? (acc.errors / acc.count) * 100 : 0;
        const labels = JSON.stringify({
          dep,
          maxMs: round1(acc.maxMs),
          count: acc.count,
          errors: acc.errors,
          errorRatePct: round1(errorRatePct),
          windowMs: this.flushIntervalMs,
        });
        this.insertMetric.run("dep_health", round1(avgMs), labels, capturedAt);
      }
    });
    this.bounded(() => insert(entries));
    this.depBuffer.clear();
  }

  // Single flush point for the periodic timer: counters + dep_health together.
  flushAll(capturedAt = this.now().toISOString()): void {
    this.flushCounters(capturedAt);
    this.flushDepHealth(capturedAt);
  }

  /**
   * `timers` so teardown cancels this flush in the same call as every other entrypoint timer,
   * BEFORE the long supervisor wait rather than after it — otherwise it keeps writing telemetry
   * across a teardown whose whole purpose is to stop writing.
   */
  startPeriodicFlush(intervalMs: number, timers: TimerRegistry): void {
    if (this.flushTimer !== null) return;
    this.flushIntervalMs = intervalMs;
    this.flushTimer = timers.every("metrics_periodic_flush", intervalMs, () => {
      try {
        this.flushAll();
      } catch {
        // Periodic telemetry flush must never crash the runtime; the buffers
        // are preserved on failure so the next tick retries.
      }
    });
    this.flushTimer.unref?.();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer === null) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }
}
