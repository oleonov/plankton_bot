import type Database from "better-sqlite3";

type CounterEntry = {
  metricName: string;
  labels: string | null;
  sum: number;
};

const counterKey = (metricName: string, labels: string | null): string =>
  labels === null ? `${metricName}-NULL-` : `${metricName}-LABELED-${labels}`;

export class RuntimeMetricWriter {
  private readonly findLatest;
  private readonly insertMetric;
  private readonly updateMetric;
  private readonly counterBuffer = new Map<string, CounterEntry>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

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

  startPeriodicFlush(intervalMs: number): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setInterval(() => {
      try {
        this.flushCounters();
      } catch {
        // Periodic telemetry flush must never crash the runtime; the buffer
        // is preserved on failure so the next tick retries.
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
