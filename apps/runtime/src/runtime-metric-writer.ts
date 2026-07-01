import type Database from "better-sqlite3";
import type { DepHealthRecorder, DepKey } from "@krabs/domain";

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
  private readonly counterBuffer = new Map<string, CounterEntry>();
  private readonly depBuffer = new Map<DepKey, DepAccumulator>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs = 0;

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
  }

  writeLatest(
    metricName: string,
    value = 1,
    labels: string | null = null,
    capturedAt = this.now().toISOString(),
  ): void {
    const latest = this.findLatest.get(metricName) as { id: number } | undefined;
    if (latest) {
      this.updateMetric.run(value, labels, capturedAt, latest.id);
      return;
    }
    this.insertMetric.run(metricName, value, labels, capturedAt);
  }

  writeEvent(
    metricName: string,
    value = 1,
    labels: string | null = null,
    capturedAt = this.now().toISOString(),
  ): void {
    this.insertMetric.run(metricName, value, labels, capturedAt);
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
    insert(entries);
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
    insert(entries);
    this.depBuffer.clear();
  }

  // Single flush point for the periodic timer: counters + dep_health together.
  flushAll(capturedAt = this.now().toISOString()): void {
    this.flushCounters(capturedAt);
    this.flushDepHealth(capturedAt);
  }

  startPeriodicFlush(intervalMs: number): void {
    if (this.flushTimer !== null) return;
    this.flushIntervalMs = intervalMs;
    this.flushTimer = setInterval(() => {
      try {
        this.flushAll();
      } catch {
        // Periodic telemetry flush must never crash the runtime; the buffers
        // are preserved on failure so the next tick retries.
      }
    }, intervalMs);
    this.flushTimer.unref?.();
  }

  stopPeriodicFlush(): void {
    if (this.flushTimer === null) return;
    clearInterval(this.flushTimer);
    this.flushTimer = null;
  }
}
