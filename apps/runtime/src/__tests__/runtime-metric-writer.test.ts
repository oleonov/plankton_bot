import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeMetricWriter } from "../runtime-metric-writer.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE runtime_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL,
      labels TEXT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_runtime_metrics_name_ts
      ON runtime_metrics(metric_name, captured_at DESC);
  `);
});

afterEach(() => {
  db.close();
});

describe("RuntimeMetricWriter", () => {
  it("updates the latest row instead of appending state metrics", () => {
    const writer = new RuntimeMetricWriter(db);

    writer.writeLatest("market_data_last_update", 1, null, "2026-04-25T00:00:00.000Z");
    writer.writeLatest("market_data_last_update", 1, null, "2026-04-25T00:00:01.000Z");

    const rows = db.prepare("SELECT * FROM runtime_metrics").all() as Array<{
      metric_name: string;
      captured_at: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metric_name).toBe("market_data_last_update");
    expect(rows[0]!.captured_at).toBe("2026-04-25T00:00:01.000Z");
  });

  it("keeps event metrics append-only", () => {
    const writer = new RuntimeMetricWriter(db);

    writer.writeEvent("infra_alert", 1, "one", "2026-04-25T00:00:00.000Z");
    writer.writeEvent("infra_alert", 1, "two", "2026-04-25T00:01:00.000Z");

    expect(db.prepare("SELECT COUNT(*) AS c FROM runtime_metrics").get()).toEqual({ c: 2 });
  });

  it("updates only the latest duplicate row so old prod duplicates can be pruned asynchronously", () => {
    db.prepare(
      "INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES (?, 1, ?)",
    ).run("runtime_paused", "2026-04-24T00:00:00.000Z");
    db.prepare(
      "INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES (?, 1, ?)",
    ).run("runtime_paused", "2026-04-24T01:00:00.000Z");

    const writer = new RuntimeMetricWriter(db);
    writer.writeLatest("runtime_paused", 0, null, "2026-04-25T00:00:00.000Z");

    const rows = db
      .prepare("SELECT value, captured_at FROM runtime_metrics ORDER BY id")
      .all() as Array<{ value: number; captured_at: string }>;
    expect(rows).toEqual([
      { value: 1, captured_at: "2026-04-24T00:00:00.000Z" },
      { value: 0, captured_at: "2026-04-25T00:00:00.000Z" },
    ]);
  });
});
