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

  it("deletes signal telemetry risk events past the 1-day TTL", async () => {
    // v063: TTL tightened from 7d → 1d. Rows from 2026-04-01 are 24 days old
    // at NOW (2026-04-25T00:00:00.000Z), well past both windows; the new test
    // below at the 1d boundary pins the v063 cutoff explicitly.
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

  it("deletes planner suppression rollups with the signal telemetry TTL", async () => {
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "planner_suppressed_rollup",
      '{"reasonCode":"sell-spread-too-wide-below-avg-entry","count":42}',
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

  it("deletes execution profile decision rollups with the signal telemetry TTL", async () => {
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "execution_profile_decision_chain_rollup",
      '{"kind":"scale_in","reason":"time_gate_blocked","count":42}',
      "2026-04-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "profile_health_check",
      '{"status":"ok"}',
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
    expect(rows).toEqual([{ event_type: "profile_health_check" }]);
  });

  it("v063: signal telemetry TTL boundary — keeps rows <1d old, deletes >1d", async () => {
    // NOW is 2026-04-25T00:00:00Z. 23h old (kept) vs 25h old (deleted).
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "signal_emitted",
      "{}",
      "2026-04-23T23:00:00.000Z", // 25h old → past 1d TTL
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "signal_suppressed",
      "{}",
      "2026-04-24T01:00:00.000Z", // 23h old → within 1d TTL
    );

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db
      .prepare("SELECT event_type, created_at FROM risk_events ORDER BY created_at")
      .all() as Array<{ event_type: string; created_at: string }>;
    expect(rows).toEqual([
      { event_type: "signal_suppressed", created_at: "2026-04-24T01:00:00.000Z" },
    ]);
  });

  it("keeps decision_signal_log rows <72h old and deletes older rows", async () => {
    // NOW is 2026-04-25T00:00:00Z. 71h old (kept) vs 73h old (deleted).
    db.prepare("INSERT INTO decision_signal_log (signal_timestamp) VALUES (?)").run(
      "2026-04-21T23:00:00.000Z", // 73h old → past 72h TTL
    );
    db.prepare("INSERT INTO decision_signal_log (signal_timestamp) VALUES (?)").run(
      "2026-04-22T01:00:00.000Z", // 71h old → within 72h TTL
    );

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db
      .prepare("SELECT signal_timestamp FROM decision_signal_log ORDER BY signal_timestamp")
      .all() as Array<{ signal_timestamp: string }>;
    expect(rows).toEqual([{ signal_timestamp: "2026-04-22T01:00:00.000Z" }]);
  });

  it("keeps execution_policy_observations rows <72h old and deletes older rows", async () => {
    db.prepare("INSERT INTO execution_policy_observations (created_at) VALUES (?)").run(
      "2026-04-21T23:00:00.000Z", // 73h old → past 72h TTL
    );
    db.prepare("INSERT INTO execution_policy_observations (created_at) VALUES (?)").run(
      "2026-04-22T01:00:00.000Z", // 71h old → within 72h TTL
    );

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db
      .prepare("SELECT created_at FROM execution_policy_observations ORDER BY created_at")
      .all() as Array<{ created_at: string }>;
    expect(rows).toEqual([{ created_at: "2026-04-22T01:00:00.000Z" }]);
  });

  it("deletes high-volume runtime metrics past the 1-day TTL", async () => {
    insertMetric("fee_schedule_active_period", "2026-04-23T23:00:00.000Z");
    insertMetric("fee_schedule_active_period", "2026-04-24T01:00:00.000Z");
    insertMetric("redeem_sweep_skipped_total", "2026-04-23T23:00:00.000Z");
    insertMetric("redeem_quarantine_skipped_total", "2026-04-24T01:00:00.000Z");

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db
      .prepare(
        "SELECT metric_name, captured_at FROM runtime_metrics ORDER BY metric_name, captured_at",
      )
      .all() as Array<{ metric_name: string; captured_at: string }>;
    expect(rows).toEqual([
      {
        metric_name: "fee_schedule_active_period",
        captured_at: "2026-04-24T01:00:00.000Z",
      },
      {
        metric_name: "redeem_quarantine_skipped_total",
        captured_at: "2026-04-24T01:00:00.000Z",
      },
    ]);
  });

  it("deletes high-volume risk events past the 1-day TTL", async () => {
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "track_r_margin_threshold_sampled",
      "{}",
      "2026-04-23T23:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "track_r_margin_threshold_sampled",
      "{}",
      "2026-04-24T01:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "d9_suppressed_on_profile_owned",
      "{}",
      "2026-04-23T23:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "d9_suppressed_on_profile_owned",
      "{}",
      "2026-04-24T01:00:00.000Z",
    );
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "signal_rejected",
      "{}",
      "2026-04-23T23:00:00.000Z",
    );

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db
      .prepare("SELECT event_type, created_at FROM risk_events ORDER BY event_type, created_at")
      .all() as Array<{ event_type: string; created_at: string }>;
    expect(rows).toEqual([
      {
        event_type: "d9_suppressed_on_profile_owned",
        created_at: "2026-04-24T01:00:00.000Z",
      },
      {
        event_type: "signal_rejected",
        created_at: "2026-04-23T23:00:00.000Z",
      },
      {
        event_type: "track_r_margin_threshold_sampled",
        created_at: "2026-04-24T01:00:00.000Z",
      },
    ]);
  });

  it("deletes order_rejected risk events after 14 days but keeps newer ones", async () => {
    // 24 days old — past the 14-day order_rejected TTL
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "order_rejected",
      "{}",
      "2026-04-01T00:00:00.000Z",
    );
    // 10 days old — within the 14-day window
    db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
      "order_rejected",
      "{}",
      "2026-04-15T00:00:00.000Z",
    );

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db
      .prepare("SELECT created_at FROM risk_events ORDER BY created_at")
      .all() as Array<{ created_at: string }>;
    expect(rows).toEqual([{ created_at: "2026-04-15T00:00:00.000Z" }]);
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

  it("runs telemetry retention while paused and keeps financial rows", async () => {
    insertMetric("market_data_last_update", "2026-04-24T00:00:00.000Z");
    insertMetric("market_data_last_update", "2026-04-24T01:00:00.000Z");
    db.prepare("INSERT INTO decision_signal_log (signal_timestamp) VALUES (?)").run(
      "2026-04-21T23:00:00.000Z",
    );
    db.prepare("INSERT INTO orders (order_id, created_at) VALUES ('ord-paused', ?)").run(
      "2025-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO positions (position_id, opened_at) VALUES ('pos-paused', ?)").run(
      "2025-01-01T00:00:00.000Z",
    );
    db.prepare("INSERT INTO fills (fill_id, filled_at) VALUES ('fill-paused', ?)").run(
      "2025-01-01T00:00:00.000Z",
    );

    const isPaused = vi.fn(() => true);
    const mod = new LedgerRetentionModule({
      db,
      log,
      config: {
        runOnStart: false,
        checkpointIntervalMs: Number.MAX_SAFE_INTEGER,
        checkpointMinDeletedRows: 99,
      },
      runtimeControl: { isPaused },
    });

    const result = await mod.runOnce(NOW);

    expect(isPaused).toHaveBeenCalledTimes(1);
    expect(result.deleted["runtime_metrics.latest.market_data_last_update"]).toBe(1);
    expect(result.deleted["decision_signal_log"]).toBe(1);
    expect(result.checkpointed).toBe(false);
    expect(count("runtime_metrics")).toBe(1);
    expect(count("orders")).toBe(1);
    expect(count("positions")).toBe(1);
    expect(count("fills")).toBe(1);
  });
});
