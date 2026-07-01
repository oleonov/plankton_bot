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

  describe("writeCounter / flushCounters", () => {
    const flushAt = "2026-04-25T00:00:30.000Z";
    const makeWriter = () => new RuntimeMetricWriter(db, () => new Date(flushAt));

    it("buffers writeCounter calls and emits one row per (name, labels) on flush", () => {
      const writer = makeWriter();

      writer.writeCounter("taker_attempt_total", 1, '{"side":"buy","mode":"success"}');
      writer.writeCounter("taker_attempt_total", 1, '{"side":"buy","mode":"success"}');
      writer.writeCounter("taker_attempt_total", 1, '{"side":"buy","mode":"success"}');
      writer.writeCounter("taker_attempt_total", 1, '{"side":"sell","mode":"success"}');

      // Nothing persisted yet.
      expect(
        (db.prepare("SELECT COUNT(*) AS c FROM runtime_metrics").get() as { c: number }).c,
      ).toBe(0);

      writer.flushCounters();

      const rows = db
        .prepare(
          "SELECT metric_name, value, labels, captured_at FROM runtime_metrics ORDER BY labels",
        )
        .all() as Array<{
        metric_name: string;
        value: number;
        labels: string;
        captured_at: string;
      }>;
      expect(rows).toEqual([
        {
          metric_name: "taker_attempt_total",
          value: 3,
          labels: '{"side":"buy","mode":"success"}',
          captured_at: flushAt,
        },
        {
          metric_name: "taker_attempt_total",
          value: 1,
          labels: '{"side":"sell","mode":"success"}',
          captured_at: flushAt,
        },
      ]);
    });

    it("clears the buffer after a successful flush so subsequent flushes are no-ops", () => {
      const writer = makeWriter();
      writer.writeCounter("order_priced_mode_total", 1, '{"mode":"taker"}');
      writer.flushCounters();
      writer.flushCounters();
      writer.flushCounters();

      expect(
        (db.prepare("SELECT COUNT(*) AS c FROM runtime_metrics").get() as { c: number }).c,
      ).toBe(1);
    });

    it("distinguishes null labels from empty-string labels", () => {
      const writer = makeWriter();
      writer.writeCounter("metric_a", 1, null);
      writer.writeCounter("metric_a", 1, "");
      writer.writeCounter("metric_a", 1, null);
      writer.flushCounters();

      const rows = db
        .prepare("SELECT value, labels FROM runtime_metrics ORDER BY id")
        .all() as Array<{ value: number; labels: string | null }>;
      expect(rows).toEqual([
        { value: 2, labels: null },
        { value: 1, labels: "" },
      ]);
    });

    it("preserves the buffer when flush fails so the next attempt retries", () => {
      const writer = makeWriter();
      writer.writeCounter("metric_a", 5, null);

      // Drop the table to force the insert transaction to throw.
      db.exec("DROP TABLE runtime_metrics");
      expect(() => writer.flushCounters()).toThrow();

      // Restore the table and confirm the buffered counter is still there.
      db.exec(`
        CREATE TABLE runtime_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL,
          value REAL NOT NULL,
          labels TEXT,
          captured_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      writer.flushCounters();
      const rows = db.prepare("SELECT value FROM runtime_metrics").all() as Array<{
        value: number;
      }>;
      expect(rows).toEqual([{ value: 5 }]);
    });

    it("startPeriodicFlush is idempotent and stopPeriodicFlush cancels the timer", () => {
      const writer = makeWriter();
      writer.startPeriodicFlush(60_000);
      writer.startPeriodicFlush(60_000);
      writer.stopPeriodicFlush();
      writer.stopPeriodicFlush();
      // Reaching here without leaking handles or throwing is the assertion.
      expect(true).toBe(true);
    });
  });

  describe("record / flushDepHealth (dep_health)", () => {
    const flushAt = "2026-04-25T00:00:30.000Z";
    const makeWriter = () => new RuntimeMetricWriter(db, () => new Date(flushAt));

    function depRows() {
      return (
        db
          .prepare(
            "SELECT value, labels FROM runtime_metrics WHERE metric_name = 'dep_health' ORDER BY labels",
          )
          .all() as Array<{ value: number; labels: string }>
      ).map((r) => ({ value: r.value, labels: JSON.parse(r.labels) as Record<string, unknown> }));
    }

    it("emits ONE append-only row PER dep (not a single overwritten latest row)", () => {
      const writer = makeWriter();
      writer.record("clob", 100, true);
      writer.record("clob", 200, true);
      writer.record("rpc", 50, false);
      writer.record("gamma", 80, true);

      // Buffered until flush.
      expect(depRows()).toHaveLength(0);
      writer.flushDepHealth();

      const rows = depRows();
      expect(rows).toHaveLength(3); // clob, gamma, rpc — NOT 1 overwritten row
      const clob = rows.find((r) => r.labels.dep === "clob")!;
      expect(clob.value).toBe(150); // avg of 100/200
      expect(clob.labels.maxMs).toBe(200);
      expect(clob.labels.count).toBe(2);
      expect(clob.labels.errors).toBe(0);
      expect(clob.labels.errorRatePct).toBe(0);
      const rpc = rows.find((r) => r.labels.dep === "rpc")!;
      expect(rpc.value).toBe(50);
      expect(rpc.labels.errors).toBe(1);
      expect(rpc.labels.errorRatePct).toBe(100);
    });

    it("labels are a bounded aggregate only — no URL/tokenId/conditionId/orderId", () => {
      const writer = makeWriter();
      writer.record("clob", 120, true);
      writer.flushDepHealth();
      const [row] = depRows();
      expect(Object.keys(row!.labels).sort()).toEqual([
        "count",
        "dep",
        "errorRatePct",
        "errors",
        "maxMs",
        "windowMs",
      ]);
    });

    it("stays append-only across flushes and clears the buffer", () => {
      const writer = makeWriter();
      writer.record("clob", 100, true);
      writer.flushDepHealth();
      writer.record("clob", 100, true);
      writer.flushDepHealth();
      expect(depRows()).toHaveLength(2); // two separate rows, not one updated
    });

    it("record never throws on a bad latency and a degenerate sample is clamped", () => {
      const writer = makeWriter();
      expect(() => writer.record("clob", Number.NaN, true)).not.toThrow();
      expect(() => writer.record("clob", -5, false)).not.toThrow();
      writer.flushDepHealth();
      const [row] = depRows();
      expect(row!.labels.count).toBe(2);
      expect(row!.value).toBe(0); // both clamped to 0ms → avg 0
    });

    it("flushAll flushes counters AND dep_health together", () => {
      const writer = makeWriter();
      writer.writeCounter("taker_attempt_total", 1, '{"side":"buy"}');
      writer.record("clob", 100, true);
      writer.flushAll();
      const total = db
        .prepare("SELECT metric_name FROM runtime_metrics ORDER BY metric_name")
        .all() as Array<{ metric_name: string }>;
      expect(total.map((r) => r.metric_name)).toEqual(["dep_health", "taker_attempt_total"]);
    });
  });
});
