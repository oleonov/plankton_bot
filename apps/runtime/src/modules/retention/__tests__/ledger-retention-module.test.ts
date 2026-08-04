import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

    -- Mirrors packages/db/src/migrations/071_signal_feed_buckets.sql: no integer
    -- "id" column, so retention must delete by the implicit rowid.
    CREATE TABLE signal_feed_buckets (
      token_id TEXT NOT NULL,
      bucket_start_ms BIGINT NOT NULL,
      bucket_granularity_ms INTEGER NOT NULL,
      open_mid REAL NOT NULL,
      high_mid REAL NOT NULL,
      low_mid REAL NOT NULL,
      close_mid REAL NOT NULL,
      sample_count INTEGER NOT NULL,
      trade_count INTEGER NOT NULL DEFAULT 0,
      notional_sum REAL NOT NULL DEFAULT 0.0,
      created_at_ms BIGINT NOT NULL,
      PRIMARY KEY (token_id, bucket_granularity_ms, bucket_start_ms)
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

function insertBucket(bucketStartMs: number, bucketGranularityMs: number): void {
  db.prepare(
    `INSERT INTO signal_feed_buckets
     (token_id, bucket_start_ms, bucket_granularity_ms, open_mid, high_mid, low_mid,
      close_mid, sample_count, created_at_ms)
     VALUES ('tok', ?, ?, 0.5, 0.5, 0.5, 0.5, 1, ?)`,
  ).run(bucketStartMs, bucketGranularityMs, bucketStartMs);
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

  it("deletes signal_feed_buckets rows past the 7-day TTL regardless of bucket_granularity_ms", async () => {
    // Root-cause regression pin (2026-07-30 db-size-guard incident): the table grew to
    // 35.1M rows because the only prior prune matched a single bucket_granularity_ms and
    // never matched the 60_000ms rows actually written. Seed BOTH the real-world
    // granularity (60_000, warm buckets) and the never-written one (3_600_000, cold
    // archive) to prove the new rule sweeps by age alone, not by granularity.
    const eightDaysAgo = NOW - 8 * 24 * 60 * 60_000;
    const oneDayAgo = NOW - 1 * 24 * 60 * 60_000;
    insertBucket(eightDaysAgo, 60_000);
    insertBucket(eightDaysAgo, 3_600_000);
    insertBucket(oneDayAgo, 60_000);
    insertBucket(oneDayAgo, 3_600_000);

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["signal_feed_buckets"]).toBe(2);
    const rows = db
      .prepare(
        "SELECT bucket_start_ms, bucket_granularity_ms FROM signal_feed_buckets ORDER BY bucket_granularity_ms",
      )
      .all() as Array<{ bucket_start_ms: number; bucket_granularity_ms: number }>;
    expect(rows).toEqual([
      { bucket_start_ms: oneDayAgo, bucket_granularity_ms: 60_000 },
      { bucket_start_ms: oneDayAgo, bucket_granularity_ms: 3_600_000 },
    ]);
  });

  it("keeps signal_feed_buckets rows <7d old and deletes older rows at the exact boundary", async () => {
    // NOW is 2026-04-25T00:00:00Z. 6d23h old (kept) vs 7d1h old (deleted).
    const justInsideTtl = NOW - (7 * 24 * 60 * 60_000 - 60 * 60_000);
    const justPastTtl = NOW - (7 * 24 * 60 * 60_000 + 60 * 60_000);
    insertBucket(justInsideTtl, 60_000);
    insertBucket(justPastTtl, 60_000);

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db.prepare("SELECT bucket_start_ms FROM signal_feed_buckets").all() as Array<{
      bucket_start_ms: number;
    }>;
    expect(rows).toEqual([{ bucket_start_ms: justInsideTtl }]);
  });

  it("does NOT delete signal_feed_buckets rows when all rows are within the TTL (negative control)", async () => {
    // Guards against the rule silently being a no-op (e.g. a predicate that never
    // matches, same failure mode as the bug this task fixes): if nothing is actually
    // past the TTL, the task must report no deletions and leave every row in place.
    insertBucket(NOW - 60_000, 60_000);
    insertBucket(NOW - 60_000, 3_600_000);

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["signal_feed_buckets"]).toBeUndefined();
    expect(count("signal_feed_buckets")).toBe(2);
  });

  it("honours a configured signalFeedBucketsTtlMs instead of the built-in default", async () => {
    // index.ts feeds this from the operator's `executionProfile.signalFeed.retentionDays`,
    // which is the single source of truth. Pin that wiring: with a 2-day TTL the 3-day-old
    // row must go even though the 7-day fallback would have kept it.
    const threeDaysAgo = NOW - 3 * 24 * 60 * 60_000;
    const oneDayAgo = NOW - 1 * 24 * 60 * 60_000;
    insertBucket(threeDaysAgo, 60_000);
    insertBucket(oneDayAgo, 60_000);

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: {
        runOnStart: false,
        checkpointMinDeletedRows: 99,
        signalFeedBucketsTtlMs: 2 * 24 * 60 * 60_000,
      },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["signal_feed_buckets"]).toBe(1);
    const rows = db.prepare("SELECT bucket_start_ms FROM signal_feed_buckets").all() as Array<{
      bucket_start_ms: number;
    }>;
    expect(rows).toEqual([{ bucket_start_ms: oneDayAgo }]);
  });

  it("rotates the starting task so a table with a standing backlog cannot starve the ones behind it", async () => {
    // r27-M4: every pass shares ONE row budget and signal_feed_buckets is appended last. With a
    // fixed order, any earlier task that always has a full budget of expired rows waiting ends
    // every pass before the tail is reached — not "swept by the next pass", but never swept. That
    // is precisely how signal_feed_buckets reached 15.5 GB with a retention rule already in place.
    const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60_000).toISOString();
    for (let i = 0; i < 20; i++) {
      // In HIGH_VOLUME_RUNTIME_METRICS (1-day TTL) but not LATEST_ONLY: only the high-volume task
      // claims these rows, so it is the single budget-eating task ahead of the tail.
      insertMetric("fee_schedule_active_period", twoDaysAgo);
    }
    const eightDaysAgo = NOW - 8 * 24 * 60 * 60_000;
    insertBucket(eightDaysAgo, 60_000);
    insertBucket(eightDaysAgo, 3_600_000);

    const mod = new LedgerRetentionModule({
      db,
      log,
      // A budget far smaller than the backlog is the whole point: it is what makes the earlier
      // task exhaust the pass. Production hits the same state with 500k rows and a 15.5 GB table.
      config: {
        runOnStart: false,
        maxDeletedRowsPerRun: 4,
        batchSize: 2,
        checkpointMinDeletedRows: 99,
      },
    });

    const first = await mod.runOnce(NOW);
    expect(first.deleted["runtime_metrics.high_volume_debug"]).toBe(4);
    expect(first.deleted["signal_feed_buckets"]).toBeUndefined();

    // The backlog is still there (16 rows left), so a fixed order would spend this pass on it too
    // and the tail would stay untouched forever. Rotation opens the pass past the backlog, so the
    // tail is reached first; the leftover budget then wraps back onto the backlog, which is the
    // intent — no task is skipped, only the ORDER of first claim rotates.
    const second = await mod.runOnce(NOW);
    expect(second.deleted["signal_feed_buckets"]).toBe(2);
    expect(count("signal_feed_buckets")).toBe(0);
    expect(second.deleted["runtime_metrics.high_volume_debug"] ?? 0).toBeLessThan(4);
  });

  it("keeps sweeping the tasks behind one whose delete throws", async () => {
    // The rotation above closes starvation on the BUDGET path only. `task.run` is a raw
    // better-sqlite3 statement — SQLITE_BUSY past the timeout, a disk error, a corrupt index — and
    // an uncontained throw leaves the pass before the cursor advances AND before the checkpoint,
    // so every later pass re-enters the same statement, the tasks behind it never run at all, and
    // the WAL stops being truncated. That is the same starvation, reached through the error path.
    // A BEFORE DELETE trigger is the deterministic stand-in: `prepare` still succeeds, so the task
    // is built normally and fails only when it actually deletes.
    db.exec(`
      CREATE TRIGGER market_snapshots_boom BEFORE DELETE ON market_snapshots
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
    `);
    // Past BOTH 3-day TTLs, so the throwing task actually attempts its delete and the witness
    // behind it actually has a row to claim.
    const fourDaysAgo = new Date(NOW - 4 * 24 * 60 * 60_000).toISOString();
    db.prepare("INSERT INTO market_snapshots (token_id, captured_at) VALUES ('tok', ?)").run(
      fourDaysAgo,
    );
    // Ordered AFTER market_snapshots in buildTasks, so it is only reached if the pass survives.
    db.prepare("INSERT INTO decision_signal_log (signal_timestamp) VALUES (?)").run(fourDaysAgo);

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["decision_signal_log"]).toBe(1);
    expect(count("decision_signal_log")).toBe(0);
    // The failure is real, not swallowed into a no-op delete.
    expect(count("market_snapshots")).toBe(1);
    // Logged with the key: a table that is persistently broken has to be findable, not merely
    // survived. The pass-level `.catch` on the interval logs neither the key nor at error level.
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ task: "market_snapshots" }),
      expect.stringContaining("ledger retention task failed"),
    );
  });

  it("re-reads the signal-feed horizon every pass instead of snapshotting it at construction", async () => {
    // The execution policy reloads live on a version bump. An operator who RAISES retentionDays
    // through the API to protect history must not keep losing rows at the old horizon until the
    // next restart — and lowering it must not be a no-op either.
    const threeDaysAgo = NOW - 3 * 24 * 60 * 60_000;
    const oneDayAgo = NOW - 1 * 24 * 60 * 60_000;
    insertBucket(threeDaysAgo, 60_000);
    insertBucket(oneDayAgo, 60_000);

    let liveTtlMs = 7 * 24 * 60 * 60_000;
    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false },
      resolveSignalFeedBucketsTtlMs: () => liveTtlMs,
    });

    const wide = await mod.runOnce(NOW);
    expect(wide.deleted["signal_feed_buckets"]).toBeUndefined();

    // The operator tightens the policy; the very next pass must obey it.
    liveTtlMs = 2 * 24 * 60 * 60_000;
    const narrow = await mod.runOnce(NOW);

    expect(narrow.deleted["signal_feed_buckets"]).toBe(1);
    expect(db.prepare("SELECT bucket_start_ms FROM signal_feed_buckets").all()).toEqual([
      { bucket_start_ms: oneDayAgo },
    ]);
  });

  it("skips the sweep entirely when the live policy value is unusable", async () => {
    // A retention horizon is irreversible, so an unusable value must fail CLOSED — delete nothing —
    // rather than quietly answering it with the configured fallback. The 10-day-old row is the
    // discriminator: a silent fall back to the 7-day fallback horizon would destroy it, which is
    // "shorten retention to a week" dressed up as a safe default.
    const tenDaysAgo = NOW - 10 * 24 * 60 * 60_000;
    insertBucket(tenDaysAgo, 60_000);

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, signalFeedBucketsTtlMs: 7 * 24 * 60 * 60_000 },
      resolveSignalFeedBucketsTtlMs: () => 0,
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["signal_feed_buckets"]).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM signal_feed_buckets").get()).toEqual({ n: 1 });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ source: "execution policy", retentionMs: 0 }),
      "signal-feed retention horizon unusable — sweep skipped, no rows deleted",
    );
  });

  it("skips the sweep when the horizon underflows to a cutoff of now", async () => {
    // `retentionDays * 86_400_000` is what the policy actually feeds in, and the parser accepts any
    // positive finite number. A subnormal retentionDays (5e-324) yields a horizon so small that
    // `nowMs - horizon` rounds back to exactly nowMs in float64 — a cutoff of "now", i.e. DELETE
    // every bucket in the table including the one written a minute ago.
    const oneMinuteAgo = NOW - 60_000;
    insertBucket(oneMinuteAgo, 60_000);
    const subnormalHorizonMs = Number.MIN_VALUE * 24 * 60 * 60_000;
    expect(subnormalHorizonMs).toBeGreaterThan(0);
    expect(NOW - subnormalHorizonMs).toBe(NOW);

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false },
      resolveSignalFeedBucketsTtlMs: () => subnormalHorizonMs,
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["signal_feed_buckets"]).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM signal_feed_buckets").get()).toEqual({ n: 1 });
  });

  it("skips the sweep when the horizon overflows to Infinity", async () => {
    // The mirror case: a huge retentionDays overflows the multiply to Infinity, so `nowMs - horizon`
    // is -Infinity. That cutoff deletes nothing today, but it is not a horizon anyone declared —
    // treat it as unusable and say so, instead of letting an unbounded value through unremarked.
    insertBucket(NOW - 10 * 24 * 60 * 60_000, 60_000);

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false },
      resolveSignalFeedBucketsTtlMs: () => Number.POSITIVE_INFINITY,
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["signal_feed_buckets"]).toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ retentionMs: Number.POSITIVE_INFINITY }),
      "signal-feed retention horizon unusable — sweep skipped, no rows deleted",
    );
  });

  it("yields to the event loop between delete batches", async () => {
    // better-sqlite3 is synchronous, so a full-budget pass is up to 100 statements back to back.
    // On the production backlog that froze the loop long enough to time out the WSS connection and
    // delay reconciliation of live exchange orders. Observing the table MID-sweep is what proves
    // the loop actually gets a turn: a synchronous sweep finishes before any callback can run, so
    // the probe below would see zero rows left.
    const old = NOW - 3 * 24 * 60 * 60_000;
    insertBucket(old, 60_000);
    insertBucket(old + 1, 60_000);
    insertBucket(old + 2, 60_000);

    const countRows = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM signal_feed_buckets").get() as { n: number }).n;

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: {
        runOnStart: false,
        batchSize: 1,
        signalFeedBucketsTtlMs: 2 * 24 * 60 * 60_000,
      },
    });

    let remainingMidSweep = -1;
    const run = mod.runOnce(NOW);
    setImmediate(() => {
      remainingMidSweep = countRows();
    });
    const result = await run;

    expect(result.deleted["signal_feed_buckets"]).toBe(3);
    expect(remainingMidSweep).toBeGreaterThan(0);
    expect(countRows()).toBe(0);
  });
});

// The pass became asynchronous (it yields between batches and awaits the checkpoint worker), which
// silently broke what `stop()` used to guarantee: clearing the interval no longer means the module
// is idle.
describe("LedgerRetentionModule — shutdown while a pass is in flight", () => {
  const startupSweepModule = () => {
    // Three rows at batchSize 1 guarantee the startup pass suspends on a `setImmediate` — that
    // suspension is the window a supervisor teardown lands in.
    const old = Date.now() - 30 * 24 * 60 * 60_000;
    insertBucket(old, 60_000);
    insertBucket(old + 1, 60_000);
    insertBucket(old + 2, 60_000);
    return new LedgerRetentionModule({
      db,
      log,
      config: {
        runOnStart: true,
        batchSize: 1,
        intervalMs: 60_000,
        signalFeedBucketsTtlMs: 2 * 24 * 60 * 60_000,
      },
    });
  };

  it("waits for the in-flight pass before reporting stopped", async () => {
    const mod = startupSweepModule();
    // Not awaited: `start()` runs synchronously into the sweep and suspends there.
    const started = mod.start();

    await mod.stop();

    // Awaiting `stop()` drains microtasks only, so a `stop()` that did not await the pass would
    // return here with the sweep still suspended on its pending `setImmediate` — i.e. the
    // supervisor tearing the ledger down underneath a delete that is about to resume.
    expect((mod as unknown as { running: boolean }).running).toBe(false);
    await started;
  });

  it("stops without the in-flight pass once it is parked in the checkpoint worker", async () => {
    // A pass bounds itself everywhere but here: the delete loop breaks at the next batch boundary
    // once `stopping` is set, but `executePass` reads `stopping` BEFORE `maybeCheckpoint`, so a pass
    // already parked inside it answers to the worker's CHECKPOINT_TIMEOUT_MS — ten minutes. A
    // `stop()` that awaits that unbounded turns SIGTERM into a ten-minute shutdown, which the
    // container resolves with SIGKILL: no database closed, no later module stopped at all.
    const mod = new LedgerRetentionModule({ db, log, config: { runOnStart: false } });
    let reachedCheckpoint!: () => void;
    const atCheckpoint = new Promise<void>((r) => (reachedCheckpoint = r));
    (mod as unknown as { maybeCheckpoint: () => Promise<boolean> }).maybeCheckpoint = () => {
      reachedCheckpoint();
      return new Promise<boolean>(() => undefined);
    };

    // Deliberately not awaited — this pass is the wedged one, and it never settles.
    void mod.runOnce(NOW);
    await atCheckpoint;

    vi.useFakeTimers();
    try {
      let stopped = false;
      void mod.stop().then(() => {
        stopped = true;
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(stopped).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
      // Walking away from a running checkpoint is safe but invisible; the warn is the only trace.
      expect(log.warn).toHaveBeenCalledWith(
        { waitMs: 5_000 },
        "retention pass still running (checkpoint worker) — stopping without it",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not install the interval when stop lands during the startup pass", async () => {
    const mod = startupSweepModule();
    const started = mod.start();

    await mod.stop();
    await started;

    // A timer installed after the supervisor believes the module is down resurrects it: passes —
    // and their checkpoints — keep running against a ledger being closed.
    expect(await mod.healthCheck()).toMatchObject({ ok: false });
  });

  it("a start superseded by an escaped stop does not install a second interval", async () => {
    // `stopping` cannot see this one. A stop that gives up waiting for a parked startup pass, then
    // a restart, leaves `stopping` back at false and the NEWER interval installed. When the old
    // pass finally returns, its `if (this.stopping)` guard passes and it overwrites `this.timer` —
    // the newer interval, the one the supervisor believes is the live module, becomes an orphan
    // no `clearTimer()` can reach, sweeping and checkpointing a ledger being torn down.
    vi.useFakeTimers();
    try {
      const mod = new LedgerRetentionModule({
        db,
        log,
        config: { runOnStart: true, intervalMs: 60_000 },
      });
      let releaseFirstPass!: () => void;
      let passes = 0;
      (mod as unknown as { runOnce: () => Promise<unknown> }).runOnce = () => {
        passes += 1;
        if (passes === 1) return new Promise<void>((resolve) => (releaseFirstPass = resolve));
        return Promise.resolve();
      };

      const superseded = mod.start();
      const escapedStop = mod.stop();
      // The stop's own ceiling: it stops waiting for the parked start and proceeds without it.
      await vi.advanceTimersByTimeAsync(5_000);
      await escapedStop;

      await mod.start();
      expect(vi.getTimerCount()).toBe(1);

      releaseFirstPass();
      await superseded;

      expect(vi.getTimerCount()).toBe(1);

      await mod.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a repeat start leaves exactly one interval, and stop clears it", async () => {
    // `this.timer` is a single handle: a second start that merely overwrites it strands the first
    // interval with nothing left holding its handle. `stop()` then clears the survivor and reports
    // stopped while the orphan keeps sweeping and checkpointing a ledger being torn down — a module
    // the supervisor believes is down, with no way left to reach it.
    vi.useFakeTimers();
    try {
      const mod = new LedgerRetentionModule({
        db,
        log,
        config: { runOnStart: false, intervalMs: 60_000 },
      });

      await mod.start();
      const afterFirstStart = vi.getTimerCount();
      await mod.start();

      expect(afterFirstStart).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      await mod.stop();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// A file-backed WAL database, because the shared in-memory one above cannot be
// opened by a second connection — and a second connection is exactly what makes
// `wal_checkpoint(TRUNCATE)` report `busy: 1` instead of truncating.
describe("LedgerRetentionModule — WAL checkpoint truthfulness", () => {
  let dir: string;
  let dbPath: string;
  let walDb: Database.Database;
  let reader: Database.Database;

  const checkpointModule = (config: Record<string, unknown> = {}, ledgerPath?: string) =>
    new LedgerRetentionModule({
      db: walDb,
      log,
      checkpointDbPath: ledgerPath ?? dbPath,
      // A short busy timeout keeps the blocked-reader cases fast; production waits a minute.
      config: {
        runOnStart: false,
        checkpointIntervalMs: 0,
        checkpointBusyTimeoutMs: 50,
        ...config,
      },
    });

  const checkpoint = (mod: LedgerRetentionModule, nowMs: number): Promise<boolean> =>
    (mod as unknown as { maybeCheckpoint(nowMs: number): Promise<boolean> }).maybeCheckpoint(nowMs);

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "krabs-retention-wal-"));
    dbPath = path.join(dir, "ledger.db");
    walDb = new Database(dbPath);
    walDb.pragma("journal_mode = WAL");
    walDb.exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t (id) VALUES (1);");
    reader = new Database(dbPath, { readonly: true });
  });

  afterEach(() => {
    reader.close();
    walDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports checkpointed:false when a concurrent reader blocks the truncate", async () => {
    // Hold an open read transaction: TRUNCATE cannot reclaim the WAL while any
    // reader may still need those frames, so the pragma returns busy: 1.
    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM t").all();

    const busyResult = await checkpoint(checkpointModule(), NOW);

    expect(busyResult).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ walCheckpoint: expect.objectContaining({ busy: 1 }) }),
      "wal checkpoint starved by a persistent reader",
    );

    reader.exec("ROLLBACK");
  });

  it("reports checkpointed:true when the truncate actually completes", async () => {
    const okResult = await checkpoint(checkpointModule(), NOW);

    expect(okResult).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("retries on the next pass after a busy checkpoint instead of waiting a full interval", async () => {
    // The cadence mark is the whole defence against unbounded WAL growth. Advancing it on a FAILED
    // attempt sells a full hour of silence to a reader that held the WAL for one second — at the
    // observed write volume the WAL gains gigabytes inside that window, and a persistent reader
    // makes every scheduled attempt lose forever. That is how a WAL reached 18.7 GB on production.
    const mod = checkpointModule({ checkpointIntervalMs: 60 * 60_000 });

    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM t").all();
    expect(await checkpoint(mod, NOW)).toBe(false);
    reader.exec("ROLLBACK");

    // One retention cadence later — far inside the one-hour checkpoint interval.
    expect(await checkpoint(mod, NOW + 5 * 60_000)).toBe(true);
  });

  it("never touches the shared runtime connection", async () => {
    // The checkpoint owns its own connection in a worker thread. Bounding the wait by mutating THIS
    // connection's busy_timeout — as it used to — put a 1 s timeout on every other module for the
    // duration, and stranded it there if the restore threw.
    walDb.pragma("busy_timeout = 30000");

    await checkpoint(checkpointModule(), NOW);

    expect(walDb.pragma("busy_timeout", { simple: true })).toBe(30000);
  });

  it("escalates to error once a reader has starved several checkpoints in a row", async () => {
    // One busy attempt is an overlapping reader and resolves itself. A RUN of them means a held
    // read transaction that no amount of waiting clears — the operator has to act, so it must stop
    // looking like a routine warn line and must carry the WAL's real size.
    const mod = checkpointModule();
    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM t").all();

    expect(await checkpoint(mod, NOW)).toBe(false);
    expect(await checkpoint(mod, NOW + 5 * 60_000)).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
    expect(await checkpoint(mod, NOW + 10 * 60_000)).toBe(false);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 3, walBytes: expect.any(Number) }),
      "wal checkpoint starved by a persistent reader — WAL cannot shrink",
    );
    reader.exec("ROLLBACK");
  });

  it("still moves frames into the main database when a writer blocks the truncate", async () => {
    // A held write transaction is the ordinary production condition — the runtime writes
    // continuously — so it must not cost us the whole checkpoint. It does not: the frames reach the
    // main file anyway, and the pass reports `false` so the WAL is retried rather than assumed
    // reclaimed.
    //
    // This does NOT prove the worker's PASSIVE-before-TRUNCATE ordering, and nothing can: under
    // writer contention SQLite silently downgrades TRUNCATE to PASSIVE itself
    // (`sqlite3WalCheckpoint`: WAL_WRITE_LOCK busy → `eMode2 = PASSIVE`), so both shapes return the
    // identical row (`busy: 1, log: N, checkpointed: N`) and move the identical bytes — measured.
    // The PASSIVE call earns its place on the UNCONTENDED path, where TRUNCATE would hold the
    // writer lock for the whole copy; that is a latency property, and the measurement backing it is
    // in the worker's own comment.
    walDb.pragma("wal_autocheckpoint = 0");
    const insert = walDb.prepare("INSERT INTO t (id) VALUES (?)");
    const insertMany = walDb.transaction(() => {
      for (let id = 2; id <= 5_000; id += 1) insert.run(id);
    });
    insertMany();
    const mainBytesBeforeCheckpoint = statSync(dbPath).size;

    walDb.exec("BEGIN IMMEDIATE");
    try {
      expect(await checkpoint(checkpointModule(), NOW)).toBe(false);

      expect(statSync(dbPath).size).toBeGreaterThan(mainBytesBeforeCheckpoint);
    } finally {
      walDb.exec("ROLLBACK");
    }
  });

  it("gives up on a wedged worker instead of hanging the pass forever", async () => {
    // Without a ceiling on the WAIT, a worker stuck on an unresponsive filesystem never posts, never
    // errors and never exits — and `stop()`, which awaits the pass, hangs with it for the life of
    // the process. 1 ms cannot outlive worker startup, so the deadline always wins here.
    const mod = checkpointModule({ checkpointTimeoutMs: 1 });

    expect(await checkpoint(mod, NOW)).toBe(false);

    // A missing verdict is NOT a starved reader: blaming one sends the operator hunting a
    // transaction that does not exist, when the answer is in `error`.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        walCheckpoint: null,
        error: expect.stringContaining("did not finish within 1ms"),
        consecutiveFailures: 1,
      }),
      "wal checkpoint worker produced no verdict",
    );
  });

  it("does not start a second checkpoint on top of an abandoned worker", async () => {
    // The abandoned worker still holds an open connection to the ledger, i.e. it is a READER. A
    // second checkpoint started on top of it adds one more thing for that checkpoint to be starved
    // by — on the exact file the first one already failed to reclaim.
    const mod = checkpointModule({ checkpointTimeoutMs: 1 });
    expect(await checkpoint(mod, NOW)).toBe(false);

    expect(await checkpoint(mod, NOW + 5 * 60_000)).toBe(false);

    expect(log.warn).toHaveBeenCalledWith(
      "previous checkpoint worker has not exited yet — attempt skipped",
    );
    // The skip must not look like a failed attempt: counting it would escalate to the starvation
    // error without a single reader involved.
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 2 }),
      expect.anything(),
    );
  });

  it("resumes checkpointing once the abandoned worker has exited", async () => {
    // The guard is a wait, not a latch. Left permanently set it would silence every future
    // checkpoint — the WAL would grow forever behind a thread that died minutes ago.
    const mod = checkpointModule({ checkpointTimeoutMs: 1 });
    expect(await checkpoint(mod, NOW)).toBe(false);

    await vi.waitFor(() => {
      expect(
        (mod as unknown as { abandonedCheckpointExit: Promise<void> | null })
          .abandonedCheckpointExit,
      ).toBeNull();
    });
    log.warn.mockClear();
    expect(await checkpoint(mod, NOW + 5 * 60_000)).toBe(false);

    // consecutiveFailures reaching 2 is the proof a real attempt ran — a skipped one never counts.
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 2 }),
      "wal checkpoint worker produced no verdict",
    );
  });

  it("reports unhealthy once starved checkpoints mean the WAL cannot be reclaimed", async () => {
    // A started module with a live timer is otherwise healthy by definition, which is exactly how a
    // WAL that no checkpoint can reclaim stayed invisible: the one log line scrolled away and
    // `healthCheck` kept answering ok. The starvation run has to reach the supervisor.
    const mod = checkpointModule({ intervalMs: 60_000 });
    await mod.start();
    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM t").all();

    expect(await checkpoint(mod, NOW)).toBe(false);
    expect(await checkpoint(mod, NOW + 5 * 60_000)).toBe(false);
    expect(await mod.healthCheck()).toMatchObject({ ok: true });

    expect(await checkpoint(mod, NOW + 10 * 60_000)).toBe(false);

    expect(await mod.healthCheck()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("failedCheckpoints=3"),
    });
    reader.exec("ROLLBACK");
    await mod.stop();
  });

  it("reports unhealthy while a worker it gave up on is still holding the ledger", async () => {
    // The abandoned-worker guard sends every later attempt down the SKIP branch, which deliberately
    // does not count as a failure — so `consecutiveFailedCheckpoints` freezes and the starvation
    // threshold above is structurally unreachable. A worker that never exits therefore means no
    // checkpoint can even be ATTEMPTED, indefinitely, with the module answering ok the whole time.
    const mod = checkpointModule({ intervalMs: 60_000 });
    await mod.start();
    expect(await mod.healthCheck()).toMatchObject({ ok: true });

    // Set directly: the real timeout race resolves in milliseconds, and the state under test is
    // precisely the one that does NOT resolve.
    (mod as unknown as { abandonedCheckpointExit: Promise<void> | null }).abandonedCheckpointExit =
      new Promise<void>(() => undefined);

    expect(await checkpoint(mod, NOW)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "previous checkpoint worker has not exited yet — attempt skipped",
    );
    expect(await mod.healthCheck()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("checkpointWorker=abandoned"),
    });
    await mod.stop();
  });

  it("does not report a truncate for a database that has no WAL at all", async () => {
    // A path pointing at a non-WAL file answers `{busy: 0, log: -1, checkpointed: -1}`: no reader
    // held anything back, and nothing was reclaimed either, because there is no WAL to reclaim.
    // Read as success it resets the failure counter and advances the cadence mark, buying a full
    // interval of silence while the runtime's real WAL keeps growing.
    const plainPath = path.join(dir, "not-wal.db");
    const plain = new Database(plainPath);
    plain.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    plain.close();

    expect(await checkpoint(checkpointModule({}, plainPath), NOW)).toBe(false);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ walCheckpoint: expect.objectContaining({ log: -1 }) }),
      "wal checkpoint found no WAL — checkpoint path is not the live ledger",
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.anything(), "wal checkpoint truncated");
  });

  it("refuses to checkpoint a ledger path that does not exist instead of creating one", async () => {
    // better-sqlite3 CREATES a missing path by default, so a typo'd or moved ledger used to yield an
    // empty database, a `log: -1` row and "wal checkpoint truncated" in the log — while the
    // runtime's actual WAL was never touched by anything.
    const missingPath = path.join(dir, "does-not-exist.db");

    expect(await checkpoint(checkpointModule({}, missingPath), NOW)).toBe(false);

    expect(existsSync(missingPath)).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        walCheckpoint: null,
        error: expect.stringContaining("unable to open database file"),
      }),
      "wal checkpoint worker produced no verdict",
    );
  });

  it("skips the checkpoint entirely when no ledger path is configured", async () => {
    const mod = new LedgerRetentionModule({
      db: walDb,
      log,
      config: { runOnStart: false, checkpointIntervalMs: 0 },
    });

    expect(await checkpoint(mod, NOW)).toBe(false);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
