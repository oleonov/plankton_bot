import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LedgerRetentionModule } from "../ledger-retention-module.js";

const NOW = Date.parse("2026-04-25T00:00:00.000Z");

let db: Database.Database;

const log = {
  child: () => log,
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE runtime_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL,
      labels TEXT,
      captured_at TEXT NOT NULL
    );
    CREATE INDEX idx_runtime_metrics_name_ts
      ON runtime_metrics(metric_name, captured_at DESC);
    CREATE INDEX idx_runtime_metrics_captured_at
      ON runtime_metrics(captured_at);

    CREATE TABLE market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE execution_policy_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE decision_signal_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_timestamp TEXT NOT NULL
    );
    CREATE TABLE trading_state_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE portfolio_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE orders (order_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE positions (position_id TEXT PRIMARY KEY, opened_at TEXT NOT NULL);
    CREATE TABLE fills (fill_id TEXT PRIMARY KEY, filled_at TEXT NOT NULL);
  `);
});

afterEach(() => {
  db.close();
});

function insertMetric(metricName: string, capturedAt: string): void {
  db.prepare("INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES (?, 1, ?)").run(
    metricName,
    capturedAt,
  );
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe("LedgerRetentionModule", () => {
  it("compacts latest-only runtime metrics and keeps the newest row", async () => {
    insertMetric("market_data_last_update", "2026-04-24T00:00:00.000Z");
    insertMetric("market_data_last_update", "2026-04-24T01:00:00.000Z");
    insertMetric("market_data_last_update", "2026-04-24T02:00:00.000Z");

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, maxDeletedRowsPerRun: 10, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["runtime_metrics.latest.market_data_last_update"]).toBe(2);
    const rows = db.prepare("SELECT metric_name, captured_at FROM runtime_metrics").all() as Array<{
      metric_name: string;
      captured_at: string;
    }>;
    expect(rows).toEqual([
      {
        metric_name: "market_data_last_update",
        captured_at: "2026-04-24T02:00:00.000Z",
      },
    ]);
  });

  it("deletes old telemetry but keeps financial ledger rows", async () => {
    insertMetric("infra_alert", "2026-03-01T00:00:00.000Z");
    insertMetric("infra_alert", "2026-04-24T00:00:00.000Z");
    db.prepare("INSERT INTO market_snapshots (token_id, captured_at) VALUES ('tok', ?)").run(
      "2026-04-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO market_snapshots (token_id, captured_at) VALUES ('tok', ?)").run(
      "2026-04-24T00:00:00.000Z",
    );
    db.prepare("INSERT INTO decision_signal_log (signal_timestamp) VALUES (?)").run(
      "2025-12-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO decision_signal_log (signal_timestamp) VALUES (?)").run(
      "2026-04-24T00:00:00.000Z",
    );
    db.prepare("INSERT INTO orders (order_id, created_at) VALUES ('ord-old', ?)").run(
      "2025-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO positions (position_id, opened_at) VALUES ('pos-old', ?)").run(
      "2025-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO fills (fill_id, filled_at) VALUES ('fill-old', ?)").run(
      "2025-01-01T00:00:00.000Z",
    );

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    expect(count("runtime_metrics")).toBe(1);
    expect(count("market_snapshots")).toBe(1);
    expect(count("decision_signal_log")).toBe(1);
    expect(count("orders")).toBe(1);
    expect(count("positions")).toBe(1);
    expect(count("fills")).toBe(1);
  });

  it("caps critical and regular risk events at the same 90-day TTL", async () => {
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "signal_rejected",
      "{}",
      "2025-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "reconciliation_drift",
      '{"severity":"critical"}',
      "2025-10-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "reconciliation_drift",
      '{"severity":"critical"}',
      "2026-03-01T00:00:00.000Z",
    );

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db.prepare("SELECT event_type FROM risk_events").all() as Array<{
      event_type: string;
    }>;
    expect(rows).toEqual([{ event_type: "reconciliation_drift" }]);
  });

  it("deletes signal telemetry risk events after 14 days", async () => {
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "signal_suppressed",
      "{}",
      "2026-04-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "signal_emitted",
      "{}",
      "2026-04-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "signal_rejected",
      "{}",
      "2026-04-01T00:00:00.000Z",
    );

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db.prepare("SELECT event_type FROM risk_events").all() as Array<{
      event_type: string;
    }>;
    expect(rows).toEqual([{ event_type: "signal_rejected" }]);
  });

  it("runs retention immediately on start by default", async () => {
    insertMetric("market_data_last_update", "2026-04-24T00:00:00.000Z");
    insertMetric("market_data_last_update", "2026-04-24T01:00:00.000Z");

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { checkpointMinDeletedRows: 99 },
    });

    await mod.start();

    expect(count("runtime_metrics")).toBe(1);

    await mod.stop();
  });

  it("skips deletion sweeps while the runtime is paused", async () => {
    insertMetric("market_data_last_update", "2026-04-24T00:00:00.000Z");
    insertMetric("market_data_last_update", "2026-04-24T01:00:00.000Z");
    const before = count("runtime_metrics");

    const isPaused = vi.fn(() => true);
    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false },
      runtimeControl: { isPaused },
    });

    const result = await mod.runOnce(NOW);

    expect(isPaused).toHaveBeenCalledTimes(1);
    expect(result.deleted).toEqual({});
    expect(result.checkpointed).toBe(false);
    expect(count("runtime_metrics")).toBe(before);
  });
});
