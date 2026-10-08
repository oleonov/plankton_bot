import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteRedeemLogRepository } from "@krabs/db";
import { LedgerRetentionModule } from "../ledger-retention-module.js";

const NOW = Date.parse("2026-04-25T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60_000;

/**
 * Production stores these two columns in SQLite's `datetime('now')` rendering — their only writer
 * is the column DEFAULT, no INSERT binds them. Fixtures must use the same rendering or the tests
 * silently stop covering the cutoff comparison the module actually performs.
 */
const sqliteSpace = (iso: string): string => iso.slice(0, 19).replace("T", " ");

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

    -- Mirrors packages/db/src/schemas/ledger.sql:407-428 — same columns, constraints and all three
    -- indexes, differing only in whitespace and in IF NOT EXISTS, which an in-memory per-test db
    -- does not need. The 9-value status CHECK matters: a misspelled status in a test row fails at
    -- insert time exactly as production would reject it. So does idx_redeem_log_condition_ts — the
    -- delete guard and markOrphanedActiveAttempts both key on condition_id, and a fixture without
    -- it would exercise a different query plan than the one this retention task ships against.
    CREATE TABLE redeem_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_id TEXT NOT NULL,
      token_ids TEXT NOT NULL,
      attempt_ts INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('attempting','success','submitted','pending','skipped',
        'failed','rejected','failed_max_retries','failed_orphaned')),
      tx_hash TEXT, gas_used INTEGER, error_msg TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0, details_json TEXT
    );
    CREATE INDEX idx_redeem_log_condition_ts ON redeem_log(condition_id, attempt_ts DESC);
    CREATE INDEX idx_redeem_log_status_ts ON redeem_log(status, attempt_ts DESC);
    CREATE UNIQUE INDEX idx_redeem_log_unique_in_flight
      ON redeem_log(condition_id) WHERE status IN ('attempting','submitted','pending');
  `);
});

afterEach(() => {
  db.close();
});

it.each([false, true])(
  "keeps the exact rolling three-day boundary while paused=%s across restart",
  async (paused) => {
    const cutoff = NOW - 3 * DAY_MS;
    const insert = db.prepare("INSERT INTO market_snapshots(token_id,captured_at) VALUES(?,?)");
    for (const token of ["active", "closed"]) {
      for (const delta of [-1, 0, 1]) insert.run(token, new Date(cutoff + delta).toISOString());
    }
    insert.run("invalid-old", "!invalid");
    insert.run("invalid-new", "malformed");
    const make = () =>
      new LedgerRetentionModule({
        db,
        log,
        config: { runOnStart: false },
        runtimeControl: { isPaused: () => paused } as any,
      });
    await make().runOnce(NOW);
    expect(
      db
        .prepare("SELECT token_id,captured_at FROM market_snapshots ORDER BY token_id,captured_at")
        .all(),
    ).toEqual(
      ["active", "closed"]
        .flatMap((token_id) =>
          [0, 1].map((delta) => ({
            token_id,
            captured_at: new Date(cutoff + delta).toISOString(),
          })),
        )
        .concat([{ token_id: "invalid-new", captured_at: "malformed" }]),
    );
    expect((await make().runOnce(NOW)).deleted.market_snapshots ?? 0).toBe(0);
  },
);

function insertMetric(metricName: string, capturedAt: string): void {
  db.prepare("INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES (?, 1, ?)").run(
    metricName,
    capturedAt,
  );
}

/** `created_at` is rendered in SQLite space format — see `sqliteSpace` above. */
function insertRiskEvent(eventType: string, payload: string, createdAtIso: string): void {
  db.prepare("INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)").run(
    eventType,
    payload,
    sqliteSpace(createdAtIso),
  );
}

/** `created_at` is rendered in SQLite space format — see `sqliteSpace` above. */
function insertExecutionPolicyObservation(createdAtIso: string): void {
  db.prepare("INSERT INTO execution_policy_observations (created_at) VALUES (?)").run(
    sqliteSpace(createdAtIso),
  );
}

/**
 * `captured_at` here is written verbatim, not always through `sqliteSpace()`: these two tables use
 * `timestampFormat: "mixed"` precisely because production carries BOTH renderings on the same
 * column (every INSERT binds ISO today, but the column DEFAULT that would fire on an omitted bind
 * is still `datetime('now')` — see `renderCutoff`'s doc comment). Callers pass whichever rendering
 * the case under test needs.
 */
function insertTradingStateSnapshot(capturedAt: string): void {
  db.prepare("INSERT INTO trading_state_snapshots (captured_at) VALUES (?)").run(capturedAt);
}

/** See {@link insertTradingStateSnapshot} — same mixed-rendering column, different table. */
function insertPortfolioSnapshot(capturedAt: string): void {
  db.prepare("INSERT INTO portfolio_snapshots (captured_at) VALUES (?)").run(capturedAt);
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function insertRedeemLog(row: {
  conditionId: string;
  attemptTs: number;
  status: string;
  errorMsg?: string | null;
  retryCount?: number;
  txHash?: string | null;
  gasUsed?: number | null;
}): void {
  db.prepare(
    `INSERT INTO redeem_log
     (condition_id, token_ids, attempt_ts, status, tx_hash, gas_used, error_msg, retry_count)
     VALUES (?, '[]', ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.conditionId,
    row.attemptTs,
    row.status,
    row.txHash ?? null,
    row.gasUsed ?? null,
    row.errorMsg ?? null,
    row.retryCount ?? 0,
  );
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
    insertRiskEvent("signal_rejected", "{}", "2025-01-01T00:00:00.000Z");
    insertRiskEvent("reconciliation_drift", '{"severity":"critical"}', "2025-10-01T00:00:00.000Z");
    insertRiskEvent("reconciliation_drift", '{"severity":"critical"}', "2026-03-01T00:00:00.000Z");

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
    insertRiskEvent("signal_suppressed", "{}", "2026-04-01T00:00:00.000Z");
    insertRiskEvent("signal_emitted", "{}", "2026-04-01T00:00:00.000Z");
    insertRiskEvent("signal_rejected", "{}", "2026-04-01T00:00:00.000Z");

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

  it("expires diagnostic risk events after 7 days but keeps operational events", async () => {
    insertRiskEvent("quote_motion_shadow_sample", "{}", "2026-04-23T00:00:00.000Z");
    insertRiskEvent("quote_motion_shadow_sample", "{}", "2026-04-10T00:00:00.000Z");
    insertRiskEvent("exit_downprice_reprice_held", "{}", "2026-04-23T00:00:00.000Z");
    insertRiskEvent("exit_downprice_reprice_held", "{}", "2026-04-10T00:00:00.000Z");
    insertRiskEvent("signal_rejected", "{}", "2026-04-10T00:00:00.000Z");

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    expect(
      db.prepare("SELECT event_type FROM risk_events ORDER BY event_type").all() as Array<{
        event_type: string;
      }>,
    ).toEqual([
      { event_type: "exit_downprice_reprice_held" },
      { event_type: "quote_motion_shadow_sample" },
      { event_type: "signal_rejected" },
    ]);
  });

  it("expires shadow decision telemetry after 30 days but keeps operational events", async () => {
    insertRiskEvent("track_q_shadow", '{"age":"20d"}', "2026-04-05T00:00:00.000Z");
    insertRiskEvent("track_q_shadow", '{"age":"40d"}', "2026-03-16T00:00:00.000Z");
    insertRiskEvent("maker_entry_shadow", '{"age":"20d"}', "2026-04-05T00:00:00.000Z");
    insertRiskEvent("maker_entry_shadow", '{"age":"40d"}', "2026-03-16T00:00:00.000Z");
    insertRiskEvent("signal_rejected", '{"age":"40d"}', "2026-03-16T00:00:00.000Z");

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    expect(
      db.prepare("SELECT event_type, payload FROM risk_events ORDER BY event_type").all(),
    ).toEqual([
      { event_type: "maker_entry_shadow", payload: '{"age":"20d"}' },
      { event_type: "signal_rejected", payload: '{"age":"40d"}' },
      { event_type: "track_q_shadow", payload: '{"age":"20d"}' },
    ]);
  });

  it("deletes planner suppression rollups with the signal telemetry TTL", async () => {
    insertRiskEvent(
      "planner_suppressed_rollup",
      '{"reasonCode":"sell-spread-too-wide-below-avg-entry","count":42}',
      "2026-04-01T00:00:00.000Z",
    );
    insertRiskEvent("signal_rejected", "{}", "2026-04-01T00:00:00.000Z");

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
    insertRiskEvent(
      "execution_profile_decision_chain_rollup",
      '{"kind":"scale_in","reason":"time_gate_blocked","count":42}',
      "2026-04-01T00:00:00.000Z",
    );
    insertRiskEvent("profile_health_check", '{"status":"ok"}', "2026-04-01T00:00:00.000Z");

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
    insertRiskEvent("signal_emitted", "{}", "2026-04-23T23:00:00.000Z"); // 25h old → past 1d TTL
    insertRiskEvent("signal_suppressed", "{}", "2026-04-24T01:00:00.000Z"); // 23h old → within 1d TTL

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
      { event_type: "signal_suppressed", created_at: sqliteSpace("2026-04-24T01:00:00.000Z") },
    ]);
  });

  it("[reversion pin] risk_events same-day boundary: keeps a row 1h before NOW, deletes a row 1h before the cutoff (sqliteSpace cutoff regression)", async () => {
    // Catches: reverting `risk_events.high_volume_debug`'s `timestampFormat: "sqliteSpace"` back to
    // the default "iso". Production stores `risk_events.created_at` in SQLite's `datetime('now')`
    // space-format rendering ("YYYY-MM-DD HH:MM:SS"); an ISO cutoff ("...T...Z") compares GREATER
    // than every space-format string on the cutoff's calendar day (' ' 0x20 < 'T' 0x54), so an ISO
    // bind would delete the "inside" row below even though it is only 1h old.
    insertRiskEvent("d9_suppressed_on_profile_owned", "{}", "2026-04-24T23:00:00.000Z"); // 1h old, inside TTL — must survive
    insertRiskEvent("d9_suppressed_on_profile_owned", "{}", "2026-04-23T23:00:00.000Z"); // 25h old, past cutoff — must be deleted

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db.prepare("SELECT created_at FROM risk_events").all() as Array<{
      created_at: string;
    }>;
    expect(rows).toEqual([{ created_at: sqliteSpace("2026-04-24T23:00:00.000Z") }]);
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
    insertExecutionPolicyObservation("2026-04-21T23:00:00.000Z"); // 73h old → past 72h TTL
    insertExecutionPolicyObservation("2026-04-22T01:00:00.000Z"); // 71h old → within 72h TTL

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db
      .prepare("SELECT created_at FROM execution_policy_observations ORDER BY created_at")
      .all() as Array<{ created_at: string }>;
    expect(rows).toEqual([{ created_at: sqliteSpace("2026-04-22T01:00:00.000Z") }]);
  });

  it("[reversion pin] execution_policy_observations same-day boundary: keeps a row on the cutoff's calendar day, deletes an older row (sqliteSpace cutoff regression)", async () => {
    // Catches: reverting the `execution_policy_observations` task's `timestampFormat: "sqliteSpace"`
    // back to the default "iso". Production stores `execution_policy_observations.created_at` in
    // SQLite's `datetime('now')` space-format rendering ("YYYY-MM-DD HH:MM:SS"). The 3-day TTL
    // cutoff for NOW falls on 2026-04-22; an ISO cutoff ("2026-04-22T00:00:00.000Z") compares
    // GREATER than every space-format string sharing that calendar day (' ' 0x20 < 'T' 0x54), so an
    // ISO bind would incorrectly delete the row below even though it is only 49h old, well within
    // the 72h TTL.
    insertExecutionPolicyObservation("2026-04-22T23:00:00.000Z"); // 49h old, inside TTL — must survive
    insertExecutionPolicyObservation("2026-04-21T23:00:00.000Z"); // 73h old, past TTL — must be deleted

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db.prepare("SELECT created_at FROM execution_policy_observations").all() as Array<{
      created_at: string;
    }>;
    expect(rows).toEqual([{ created_at: sqliteSpace("2026-04-22T23:00:00.000Z") }]);
  });

  it("[mixed-rendering] portfolio_snapshots same-day boundary: keeps a space-form row newer than the cutoff, deletes an ISO row genuinely older", async () => {
    // NOW is 2026-04-25T00:00:00Z, so the 90-day portfolioSnapshotsTtlMs cutoff is
    // 2026-01-25T00:00:00.000Z. A space-form row on that SAME calendar day but 23h AFTER the
    // cutoff must survive: it is production's dormant `DEFAULT (datetime('now'))` writer path
    // (see renderCutoff's doc comment), and a raw `captured_at < ?` compare against an ISO cutoff
    // would delete it anyway because ' ' (0x20) < 'T' (0x54) makes every space-form string of the
    // cutoff's calendar day sort below it, whatever its time-of-day. The ISO row is unambiguously
    // past the cutoff and must go regardless of rendering.
    insertPortfolioSnapshot("2026-01-25 23:00:00"); // 23h AFTER cutoff, space rendering — must survive
    insertPortfolioSnapshot("2026-01-01T00:00:00.000Z"); // genuinely older — must be deleted

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["portfolio_snapshots"]).toBe(1);
    const rows = db.prepare("SELECT captured_at FROM portfolio_snapshots").all() as Array<{
      captured_at: string;
    }>;
    expect(rows).toEqual([{ captured_at: "2026-01-25 23:00:00" }]);
  });

  it("[mixed-rendering] trading_state_snapshots same-day boundary: keeps a space-form row newer than the cutoff, deletes an ISO row genuinely older", async () => {
    // Mirrors the portfolio_snapshots case above at the 14-day tradingStateSnapshotsTtlMs TTL: the
    // cutoff for NOW (2026-04-25T00:00:00Z) is 2026-04-11T00:00:00.000Z.
    insertTradingStateSnapshot("2026-04-11 23:00:00"); // 23h AFTER cutoff, space rendering — must survive
    insertTradingStateSnapshot("2026-04-01T00:00:00.000Z"); // genuinely older — must be deleted

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["trading_state_snapshots"]).toBe(1);
    const rows = db.prepare("SELECT captured_at FROM trading_state_snapshots").all() as Array<{
      captured_at: string;
    }>;
    expect(rows).toEqual([{ captured_at: "2026-04-11 23:00:00" }]);
  });

  it("[mixed-rendering] trading_state_snapshots ORDER BY: a one-row deletion budget removes the chronologically-oldest eligible row, not the lexically-smallest string", async () => {
    // Both cases above only ever have ONE row past the cutoff, so a broken ORDER BY (sorting on the
    // raw column instead of the parsed instant) is unobservable — deleting "the only eligible row"
    // looks identical whichever comparator picked it. Here BOTH rows are eligible and share the SAME
    // calendar day, so only the comparator decides which one a `maxDeletedRowsPerRun: 1` budget
    // takes: the space-form row is chronologically LATER in the day (20:00) but ' ' (0x20) < 'T'
    // (0x54) sorts it lexically BELOW the ISO row (01:00), so a raw-column ORDER BY would delete the
    // younger row and keep the older one — backwards.
    insertTradingStateSnapshot("2026-04-01T01:00:00.000Z"); // chronologically OLDEST — must be deleted
    insertTradingStateSnapshot("2026-04-01 20:00:00"); // chronologically YOUNGER, lexically smaller — must survive

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99, maxDeletedRowsPerRun: 1 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["trading_state_snapshots"]).toBe(1);
    const rows = db.prepare("SELECT captured_at FROM trading_state_snapshots").all() as Array<{
      captured_at: string;
    }>;
    expect(rows).toEqual([{ captured_at: "2026-04-01 20:00:00" }]);
  });

  it("deletes high-volume runtime metrics past the 1-day TTL", async () => {
    const newlyBoundedMetrics = [
      "entry_lane_shadow_evaluated_total",
      "entry_lane_shadow_gate_component_total",
      "entry_lane_shadow_missing_component_total",
      "taker_disabled_min_size_total",
      "trade_count_fetch_ok",
      "trade_count_fetch_err",
    ];
    for (const metricName of newlyBoundedMetrics) {
      insertMetric(metricName, "2026-04-23T23:00:00.000Z");
      insertMetric(metricName, "2026-04-24T01:00:00.000Z");
    }
    insertMetric("unrelated_generic_metric", "2026-04-23T23:00:00.000Z");

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
      ...newlyBoundedMetrics.sort().map((metricName) => ({
        metric_name: metricName,
        captured_at: "2026-04-24T01:00:00.000Z",
      })),
      {
        metric_name: "unrelated_generic_metric",
        captured_at: "2026-04-23T23:00:00.000Z",
      },
    ]);
  });

  it("keeps the retired entry-lane event on the historical 1-day retention boundary", async () => {
    insertRiskEvent("entry_lane_shadow", "{}", "2026-04-23T23:00:00.000Z");
    insertRiskEvent("entry_lane_shadow", "{}", "2026-04-24T01:00:00.000Z");
    insertRiskEvent("profile_health_check", "{}", "2026-04-23T23:00:00.000Z");

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
        event_type: "entry_lane_shadow",
        created_at: sqliteSpace("2026-04-24T01:00:00.000Z"),
      },
      {
        event_type: "profile_health_check",
        created_at: sqliteSpace("2026-04-23T23:00:00.000Z"),
      },
    ]);
  });

  it("deletes high-volume risk events past the 1-day TTL", async () => {
    insertRiskEvent("track_r_margin_threshold_sampled", "{}", "2026-04-23T23:00:00.000Z");
    insertRiskEvent("track_r_margin_threshold_sampled", "{}", "2026-04-24T01:00:00.000Z");
    insertRiskEvent("d9_suppressed_on_profile_owned", "{}", "2026-04-23T23:00:00.000Z");
    insertRiskEvent("d9_suppressed_on_profile_owned", "{}", "2026-04-24T01:00:00.000Z");
    insertRiskEvent("signal_rejected", "{}", "2026-04-23T23:00:00.000Z");

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
        created_at: sqliteSpace("2026-04-24T01:00:00.000Z"),
      },
      {
        event_type: "signal_rejected",
        created_at: sqliteSpace("2026-04-23T23:00:00.000Z"),
      },
      {
        event_type: "track_r_margin_threshold_sampled",
        created_at: sqliteSpace("2026-04-24T01:00:00.000Z"),
      },
    ]);
  });

  it("deletes order_rejected risk events after 14 days but keeps newer ones", async () => {
    // 24 days old — past the 14-day order_rejected TTL
    insertRiskEvent("order_rejected", "{}", "2026-04-01T00:00:00.000Z");
    // 10 days old — within the 14-day window
    insertRiskEvent("order_rejected", "{}", "2026-04-15T00:00:00.000Z");

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    await mod.runOnce(NOW);

    const rows = db
      .prepare("SELECT created_at FROM risk_events ORDER BY created_at")
      .all() as Array<{ created_at: string }>;
    expect(rows).toEqual([{ created_at: sqliteSpace("2026-04-15T00:00:00.000Z") }]);
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

describe("LedgerRetentionModule — redeem_log churn retention", () => {
  it("deletes state_failed_quarantine and state_failed_cooldown rows past the 7-day TTL", async () => {
    const eightDaysAgo = NOW - 8 * DAY_MS;
    insertRedeemLog({
      conditionId: "cond-quarantine",
      attemptTs: eightDaysAgo,
      status: "skipped",
      errorMsg: "state_failed_quarantine",
    });
    insertRedeemLog({
      conditionId: "cond-cooldown",
      attemptTs: eightDaysAgo,
      status: "skipped",
      errorMsg: "state_failed_cooldown",
    });

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBe(2);
    expect(count("redeem_log")).toBe(0);
  });

  it("keeps a state_failed_quarantine row inside the 7-day TTL", async () => {
    const oneDayAgo = NOW - 1 * DAY_MS;
    insertRedeemLog({
      conditionId: "cond-fresh",
      attemptTs: oneDayAgo,
      status: "skipped",
      errorMsg: "state_failed_quarantine",
    });

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBeUndefined();
    expect(count("redeem_log")).toBe(1);
  });

  it("never deletes the success/failed/rejected audit trail, even 80 days old (v1 regression)", async () => {
    const eightyDaysAgo = NOW - 80 * DAY_MS;
    const auditStatuses = [
      "success",
      "failed",
      "rejected",
      "failed_max_retries",
      "failed_orphaned",
    ];
    for (const status of auditStatuses) {
      insertRedeemLog({ conditionId: `cond-${status}`, attemptTs: eightyDaysAgo, status });
    }

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBeUndefined();
    expect(count("redeem_log")).toBe(auditStatuses.length);
  });

  it("never deletes evidential skipped rows, even 80 days old (v2 regression)", async () => {
    // Must fail if the predicate is widened back to `status = 'skipped'`.
    const eightyDaysAgo = NOW - 80 * DAY_MS;
    insertRedeemLog({
      conditionId: "cond-zero-balance-quarantine",
      attemptTs: eightyDaysAgo,
      status: "skipped",
      errorMsg: "zero_balance_quarantine",
    });
    insertRedeemLog({
      conditionId: "cond-zero-balance-precheck",
      attemptTs: eightyDaysAgo,
      status: "skipped",
      errorMsg: "zero_balance_precheck_skip",
    });
    insertRedeemLog({
      conditionId: "cond-active-orders",
      attemptTs: eightyDaysAgo,
      status: "skipped",
      errorMsg: "active_orders_exist",
    });
    insertRedeemLog({
      conditionId: "cond-null-reason",
      attemptTs: eightyDaysAgo,
      status: "skipped",
      errorMsg: null,
    });
    // The census tuple `skipped / NULL / retry_count=1` (52 rows in production) — kept by the
    // error_msg term AND by the retry_count term, so it survives either one being relaxed alone.
    insertRedeemLog({
      conditionId: "cond-null-reason-retried",
      attemptTs: eightyDaysAgo,
      status: "skipped",
      errorMsg: null,
      retryCount: 1,
    });

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBeUndefined();
    expect(count("redeem_log")).toBe(5);
  });

  it("keeps a non-skipped row that carries a churn reason (isolates the status term)", async () => {
    // The v1 audit-trail rows all have error_msg NULL, and `NULL IN (...)` is UNKNOWN — so they stay
    // even if `status = 'skipped'` were widened, and that test alone does not pin the status term.
    // These rows differ from a deletable one in status ONLY: same reason, retry 0, no hash, no gas.
    const eightyDaysAgo = NOW - 80 * DAY_MS;
    insertRedeemLog({
      conditionId: "cond-failed-with-churn-reason",
      attemptTs: eightyDaysAgo,
      status: "failed",
      errorMsg: "state_failed_quarantine",
    });
    insertRedeemLog({
      conditionId: "cond-rejected-with-churn-reason",
      attemptTs: eightyDaysAgo,
      status: "rejected",
      errorMsg: "state_failed_cooldown",
    });
    // The production census tuple, which the v1 test approximates with retry_count 0.
    insertRedeemLog({
      conditionId: "cond-max-retries-census",
      attemptTs: eightyDaysAgo,
      status: "failed_max_retries",
      errorMsg: "retries exhausted",
      retryCount: 2,
    });

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBeUndefined();
    expect(count("redeem_log")).toBe(3);
  });

  it("keeps a churn row with retry_count, tx_hash or gas_used set, even 80 days old (belt-and-braces)", async () => {
    const eightyDaysAgo = NOW - 80 * DAY_MS;
    insertRedeemLog({
      conditionId: "cond-retried",
      attemptTs: eightyDaysAgo,
      status: "skipped",
      errorMsg: "state_failed_quarantine",
      retryCount: 1,
    });
    insertRedeemLog({
      conditionId: "cond-tx-hash",
      attemptTs: eightyDaysAgo,
      status: "skipped",
      errorMsg: "state_failed_quarantine",
      txHash: "0xabc",
    });
    insertRedeemLog({
      conditionId: "cond-gas-used",
      attemptTs: eightyDaysAgo,
      status: "skipped",
      errorMsg: "state_failed_quarantine",
      gasUsed: 21_000,
    });

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBeUndefined();
    expect(count("redeem_log")).toBe(3);
  });

  it("the promotion guard: a stale active row's condition keeps its churn row too, and nothing is orphaned", async () => {
    // T1 (attempting) < T2 (churn skip), both older than the 7-day cutoff. Deleting the T2 row would
    // un-mask the T1 attempting row as "latest" for findRecentActiveAttempts / hasRecentActiveAttempt
    // / markOrphanedActiveAttempts — all three define "latest" as "no strictly newer row of ANY
    // status". The guard must keep every row of this condition instead.
    // All three active statuses, not just `attempting` — the guard's subquery lists all three, and
    // markOrphanedActiveAttempts marks all three.
    const tenDaysAgo = NOW - 10 * DAY_MS;
    const nineDaysAgo = NOW - 9 * DAY_MS;
    const activeStatuses = ["attempting", "submitted", "pending"];
    for (const status of activeStatuses) {
      insertRedeemLog({
        conditionId: `cond-stale-${status}`,
        attemptTs: tenDaysAgo,
        status,
      });
      insertRedeemLog({
        conditionId: `cond-stale-${status}`,
        attemptTs: nineDaysAgo,
        status: "skipped",
        errorMsg: "state_failed_quarantine",
      });
    }

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBeUndefined();
    expect(count("redeem_log")).toBe(activeStatuses.length * 2);

    const repo = new SqliteRedeemLogRepository(db);
    const orphaned = repo.markOrphanedActiveAttempts(NOW, "test_orphan");
    expect(orphaned).toEqual([]);
  });

  it("never deletes an active row, regardless of age, even with no other rows for its condition", async () => {
    const eightyDaysAgo = NOW - 80 * DAY_MS;
    insertRedeemLog({
      conditionId: "cond-lone-active",
      attemptTs: eightyDaysAgo,
      status: "attempting",
    });

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBeUndefined();
    expect(count("redeem_log")).toBe(1);
  });

  it("epoch-ms cutoff: a row just past 7 days old is deleted, one just inside survives", async () => {
    // Fails loudly if `timestampFormat: "epochMs"` is dropped — attempt_ts is epoch ms, and the ISO
    // default would compare an INTEGER column against a TEXT cutoff. SQLite's type ordering puts
    // every integer below every string, so BOTH rows would be deleted, the one inside the TTL too.
    const justPastTtl = NOW - (7 * DAY_MS + 60_000);
    const justInsideTtl = NOW - (7 * DAY_MS - 60_000);
    insertRedeemLog({
      conditionId: "cond-just-past",
      attemptTs: justPastTtl,
      status: "skipped",
      errorMsg: "state_failed_quarantine",
    });
    insertRedeemLog({
      conditionId: "cond-just-inside",
      attemptTs: justInsideTtl,
      status: "skipped",
      errorMsg: "state_failed_quarantine",
    });

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBe(1);
    const rows = db.prepare("SELECT condition_id FROM redeem_log").all() as Array<{
      condition_id: string;
    }>;
    expect(rows).toEqual([{ condition_id: "cond-just-inside" }]);
  });

  it("caps redeem_log at the DEFAULT redeemLogMaxRowsPerRun across two passes", async () => {
    // No config override on purpose: the assertion is against the shipped default, so raising it to
    // the shared 500k budget would fail here.
    const eightDaysAgo = NOW - 8 * DAY_MS;
    const insert = db.prepare(
      `INSERT INTO redeem_log (condition_id, token_ids, attempt_ts, status, error_msg)
       VALUES (?, '[]', ?, 'skipped', 'state_failed_quarantine')`,
    );
    const insertMany = db.transaction(() => {
      for (let i = 0; i < 60_000; i++) {
        insert.run(`cond-bulk-${i}`, eightDaysAgo + i);
      }
    });
    insertMany();

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99 },
    });

    const first = await mod.runOnce(NOW);
    expect(first.deleted["redeem_log"]).toBe(50_000);
    expect(count("redeem_log")).toBe(10_000);

    const second = await mod.runOnce(NOW);
    expect(second.deleted["redeem_log"]).toBe(10_000);
    expect(count("redeem_log")).toBe(0);
  });

  it("the per-task cap binds redeem_log only, not a task that leaves maxRowsPerRun undefined", async () => {
    // Both tasks have MORE rows past their TTL than the cap allows, so a cap applied to the whole
    // pass instead of to one task would show up as decision_signal_log deleting 2 of 3.
    const eightDaysAgo = NOW - 8 * DAY_MS;
    for (let i = 0; i < 3; i++) {
      insertRedeemLog({
        conditionId: `cond-isolation-${i}`,
        attemptTs: eightDaysAgo + i,
        status: "skipped",
        errorMsg: "state_failed_quarantine",
      });
      db.prepare("INSERT INTO decision_signal_log (signal_timestamp) VALUES (?)").run(
        "2025-12-01T00:00:00.000Z",
      );
    }

    const mod = new LedgerRetentionModule({
      db,
      log,
      config: { runOnStart: false, checkpointMinDeletedRows: 99, redeemLogMaxRowsPerRun: 2 },
    });

    const result = await mod.runOnce(NOW);

    expect(result.deleted["redeem_log"]).toBe(2);
    expect(result.deleted["decision_signal_log"]).toBe(3);
    expect(count("redeem_log")).toBe(1);
    expect(count("decision_signal_log")).toBe(0);
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
