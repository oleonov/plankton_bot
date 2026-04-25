import type Database from "better-sqlite3";

export class RuntimeMetricWriter {
  private readonly findLatest;
  private readonly insertMetric;
  private readonly updateMetric;

  constructor(db: Database.Database) {
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
    capturedAt = new Date().toISOString(),
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
    capturedAt = new Date().toISOString(),
  ): void {
    this.insertMetric.run(metricName, value, labels, capturedAt);
  }
}
