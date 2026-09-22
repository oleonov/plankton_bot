import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { bootstrapDatabase } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import {
  collectSystemHealthSnapshot,
  readReconciliationHealth,
  RUNTIME_HEARTBEAT_STALE_MS,
} from "../system-health-snapshot.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-sys-health";

function testConfig(): AppConfig {
  return {
    runtimeMode: undefined,
    logLevel: "error",
    dbPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    marketScanIntervalMs: 300_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    enableInventoryAutoMerge: false,
    executionMaxConcurrency: 4,
    executionWalletBufferPct: 0.03,
    executionWalletBufferMinUsdc: 0.25,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    krabsApiKey: TEST_API_KEY,
    krabsApiPort: 0,
    krabsAuthUsername: undefined,
    krabsAuthPassword: undefined,
    krabsSessionSecret: undefined,
    allowSellSizeClamp: true,
    executionSellBalanceRejectBlockEnabled: true,
    executionSellBalanceRejectBlockMs: 60000,
    executionSellExchangeReservedEnabled: true,
    trustProxy: false,
    ...MARKET_DATA_TEST_DEFAULTS,
  } as AppConfig;
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  app = await buildServer({
    config: testConfig(),
    controlDb: conn.db,
    ledgerDb: conn.db,
    ledgerPool: stubLedgerPool(),
  });
});

afterAll(async () => {
  await app.close();
  conn.close();
});

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

describe("GET /api/v1/system-health", () => {
  it("requires matching lifecycle, run, profile, instance, and timestamps for runtime liveness", () => {
    conn.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_control_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        current_profile TEXT,
        desired_profile TEXT,
        current_run_id TEXT,
        current_instance_id TEXT,
        runtime_status TEXT NOT NULL DEFAULT 'stopped',
        paused INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS service_heartbeats (
        service_name TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        profile TEXT,
        run_id TEXT,
        last_heartbeat_at TEXT NOT NULL,
        status_json TEXT,
        PRIMARY KEY (service_name, instance_id)
      )
    `);
    const now = Date.parse("2026-09-22T12:00:00.000Z");
    const runId = "health-runtime-run";
    const instanceId = "health-runtime-instance";
    const setControl = (status: string, currentInstanceId = instanceId) =>
      conn.db
        .prepare(
          `INSERT INTO runtime_control_state
             (id, current_profile, desired_profile, current_run_id, current_instance_id,
              runtime_status, paused)
           VALUES (1, 'simulation', 'simulation', ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             current_profile = excluded.current_profile,
             current_run_id = excluded.current_run_id,
             current_instance_id = excluded.current_instance_id,
             runtime_status = excluded.runtime_status,
             paused = excluded.paused`,
        )
        .run(runId, currentInstanceId, status, status === "ready_paused" ? 1 : 0);
    const setHeartbeat = (at: string, profile = "simulation") =>
      conn.db
        .prepare(
          `INSERT OR REPLACE INTO service_heartbeats
             (service_name, instance_id, profile, run_id, last_heartbeat_at, status_json)
           VALUES ('runtime', ?, ?, ?, ?, NULL)`,
        )
        .run(instanceId, profile, runId, at);
    const readSnapshot = () => collectSystemHealthSnapshot(conn.db, conn.db, 120_000, now).snapshot;

    try {
      conn.db
        .prepare(
          "INSERT INTO bot_runs (run_id, mode, started_at, finished_at) VALUES (?, 'simulation', ?, NULL)",
        )
        .run(runId, new Date(now - 3_600_000).toISOString());
      setControl("running");
      setHeartbeat(new Date(now - 1_000).toISOString());

      expect(readSnapshot()).toMatchObject({
        runtimeState: "running",
        runtimeAlive: true,
        runtimeHeartbeatFreshnessMs: RUNTIME_HEARTBEAT_STALE_MS,
        runtimeUptimeSeconds: 3_600,
      });

      setControl("ready_paused");
      expect(readSnapshot()).toMatchObject({
        runtimeState: "ready_paused",
        runtimeAlive: true,
        runtimeUptimeSeconds: 3_600,
      });

      setControl("failed");
      expect(readSnapshot()).toMatchObject({
        runtimeState: "failed",
        runtimeAlive: false,
        runtimeHeartbeatAtMs: null,
        runtimeUptimeSeconds: null,
      });

      setControl("running", "replacement-instance");
      expect(readSnapshot().runtimeAlive).toBe(false);

      setControl("running");
      setHeartbeat(new Date(now + 1_000).toISOString());
      expect(readSnapshot()).toMatchObject({
        runtimeAlive: false,
        runtimeUptimeSeconds: null,
      });

      setHeartbeat(new Date(now - RUNTIME_HEARTBEAT_STALE_MS).toISOString());
      expect(readSnapshot()).toMatchObject({
        runtimeAlive: false,
        runtimeUptimeSeconds: null,
      });

      setHeartbeat(new Date(now - 1_000).toISOString(), "paper");
      expect(readSnapshot().runtimeAlive).toBe(false);

      setHeartbeat(new Date(now - 1_000).toISOString());
      conn.db
        .prepare("UPDATE bot_runs SET finished_at = ? WHERE run_id = ?")
        .run(new Date(now).toISOString(), runId);
      expect(readSnapshot()).toMatchObject({
        runtimeAlive: false,
        runtimeHeartbeatAtMs: null,
        runtimeUptimeSeconds: null,
      });
    } finally {
      conn.db.prepare("DELETE FROM service_heartbeats WHERE instance_id = ?").run(instanceId);
      conn.db.prepare("DELETE FROM bot_runs WHERE run_id = ?").run(runId);
      conn.db
        .prepare(
          `UPDATE runtime_control_state
              SET current_run_id = NULL, current_instance_id = NULL,
                  runtime_status = 'stopped', paused = 1
            WHERE id = 1`,
        )
        .run();
    }
  });

  it("counts aggregate Pino values beyond 500 rows with clock-hour buckets and explicit coverage", async () => {
    const now = Date.parse("2026-09-09T02:00:10.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const insert = conn.db.prepare(
      "INSERT INTO runtime_metrics(metric_name, value, labels, captured_at) VALUES (?, ?, ?, ?)",
    );
    const read = async () =>
      (
        await app.inject({ method: "GET", url: "/api/v1/system-health", headers: authHeaders() })
      ).json().data.errors;
    try {
      expect((await read()).coverage).toMatchObject({
        fresh: false,
        complete1h: false,
        complete24h: false,
      });
      for (let i = 0; i < 601; i++)
        insert.run(
          "runtime_pino_total",
          2,
          JSON.stringify({ level: 50, source: "execution" }),
          "2026-09-09T02:00:00.000Z",
        );
      insert.run(
        "runtime_pino_total",
        3,
        JSON.stringify({ level: 60, source: "other" }),
        "2026-09-09T01:59:59.000Z",
      );
      insert.run(
        "infra_alert",
        999,
        JSON.stringify({ severity: "error", code: "not-a-pino-record", source: "test" }),
        "2026-09-09T02:00:00.000Z",
      );
      insert.run(
        "runtime_pino_coverage",
        1,
        JSON.stringify({
          startedAt: "2026-09-09T01:50:00.000Z",
          continuousSince: "2026-09-09T01:50:00.000Z",
          lastFlushAt: "2026-09-09T02:00:00.000Z",
        }),
        "2026-09-09T02:00:00.000Z",
      );
      const errors = await read();
      expect(errors).toMatchObject({ l50_1h: 1202, l50_24h: 1202, l60_1h: 3, l60_24h: 3 });
      expect(errors.hist.slice(-2)).toEqual([
        { t: Date.parse("2026-09-09T01:00:00.000Z"), n: 3, crit: true },
        { t: Date.parse("2026-09-09T02:00:00.000Z"), n: 1202, crit: false },
      ]);
      expect(errors.top[0]).toMatchObject({ lv: "l50", code: "execution", cnt: 1202 });
      expect(errors.coverage).toMatchObject({ fresh: true, complete1h: false, complete24h: false });
      clock.mockReturnValue(now + 60_000);
      expect((await read()).coverage.fresh).toBe(false);
    } finally {
      clock.mockRestore();
      conn.db
        .prepare(
          "DELETE FROM runtime_metrics WHERE metric_name IN ('runtime_pino_total', 'runtime_pino_coverage') OR labels LIKE '%not-a-pino-record%'",
        )
        .run();
    }
  });
  it("returns the required UI-facing fields without failing on missing probes", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/system-health",
      headers: authHeaders(),
    });
    // In-memory DB has no file on disk; file-size/statfs probes must degrade
    // gracefully (safe defaults) rather than 500 the whole endpoint.
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; data: Record<string, unknown> }>();
    expect(body.ok).toBe(true);
    const d = body.data as {
      version: unknown;
      tradingState: unknown;
      paused: unknown;
      modules: unknown[];
      resources: unknown[];
      deps: unknown[];
      errors: Record<string, unknown>;
      db: Record<string, unknown>;
      shadow: unknown[];
    };
    expect(typeof d.version).toBe("string");
    expect(["RUNNING", "PAUSED"]).toContain(d.tradingState);
    expect(typeof d.paused).toBe("boolean");
    expect(d.modules).toHaveLength(8);
    expect(d.resources).toHaveLength(4);
    expect(d.deps).toHaveLength(4);
    expect(d.errors).toHaveProperty("hist");
    expect(d.errors).toHaveProperty("top");
    expect(d.db).toHaveProperty("migration");
    expect(d.db.ledger).toBe(0); // :memory: has no file size — safe default
    expect(Array.isArray(d.shadow)).toBe(true);
  });

  it("reports unmeasured fields as explicit unknown (null), never as healthy zero", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/system-health",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200); // partial probe failure must not 500
    const d = res.json<{
      data: {
        dirty: unknown;
        marketDataStale: unknown;
        deps: { err: unknown }[];
        reconDrift: boolean;
        modules: { nm: string; s: string }[];
        db: { locked: unknown; acctWarnings: unknown; unknownAcct: unknown };
      };
    }>().data;
    // Nothing is tracked for these in a fresh in-memory DB — must be null, not 0/false.
    expect(d.dirty).toBeNull();
    expect(d.db.locked).toBeNull();
    expect(d.db.acctWarnings).toBeNull();
    expect(d.db.unknownAcct).toBeNull();
    for (const dep of d.deps) expect(dep.err).toBeNull();
    // No market_data_last_update metric => freshness is unknown, not "fresh".
    expect(d.marketDataStale).toBeNull();
    expect(d.reconDrift).toBe(false);
    expect(d.modules.find((module) => module.nm === "reconciliation")?.s).toBe("warn");
  });

  it("correlates reconciliation evidence only to the exact latest run", () => {
    const now = Date.now();
    const at = new Date(now - 1_000).toISOString();
    const insert = conn.db.prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, ?, NULL, ?)",
    );
    const reset = () =>
      conn.db
        .prepare(
          "DELETE FROM runtime_metrics WHERE metric_name LIKE 'reconciliation_%' OR metric_name = 'last_reconciliation'",
        )
        .run();
    reset();
    insert.run(
      "reconciliation_unresolved_missing_on_exchange",
      4,
      new Date(now - 60_000).toISOString(),
    );
    insert.run("last_reconciliation", 1, at);
    insert.run("reconciliation_clean", 1, at);
    expect(readReconciliationHealth(conn.db, now).kind).toBe("ok");

    insert.run("reconciliation_skipped_unreliable", 1, at);
    expect(readReconciliationHealth(conn.db, now).kind).toBe("unknown");
    reset();
    insert.run("last_reconciliation", 1, at);
    insert.run("reconciliation_acknowledged_external_state_unknown", 1, at);
    expect(readReconciliationHealth(conn.db, now)).toEqual({
      kind: "acknowledged_external_state_unknown",
      detail: "startup quarantine — external state unknown",
    });
    expect(collectSystemHealthSnapshot(conn.db, undefined, 120_000, now).snapshot.reconDrift).toBe(
      false,
    );
    reset();
    insert.run("last_reconciliation", 1, at);
    insert.run("reconciliation_unresolved_missing_on_exchange", 2, at);
    expect(readReconciliationHealth(conn.db, now).kind).toBe("unresolved_missing");
    expect(readReconciliationHealth(conn.db, now + 91_000).kind).toBe("unknown");

    reset();
    insert.run("last_reconciliation", 1, at);
    insert.run("reconciliation_clean", 1, at);
    conn.db.exec("PRAGMA foreign_keys = OFF");
    conn.db
      .prepare(
        `INSERT INTO position_drifts
          (settlement_id, token_id, condition_id, detected_at, on_chain_balance, last_checked_at, status)
         VALUES ('health-drift', 'health-token', 'health-condition', ?, '1', ?, 'open')`,
      )
      .run(at, at);
    expect(readReconciliationHealth(conn.db, now).kind).toBe("position_drift");
    conn.db.prepare("DELETE FROM position_drifts WHERE settlement_id = 'health-drift'").run();
    conn.db.exec("PRAGMA foreign_keys = ON");
    reset();
  });

  it("returns history bars as a bounded window of objects with a numeric uptimePct", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/system-health",
      headers: authHeaders(),
    });
    const d = res.json<{
      data: {
        uptimePct: number | null;
        uptodayHist: { t: number; s: string }[];
        modules: { hist: { t: number; s: string }[] }[];
        errors: { hist: { t: number }[] };
      };
    }>().data;
    // No status_history table in the in-memory DB → uptime is unknown (null),
    // never a fabricated 100%.
    expect(d.uptimePct).toBeNull();
    // Bounded rolling window (45 daily bars). Every day is the honest "nodata"
    // state — never a fake green.
    expect(d.uptodayHist).toHaveLength(45);
    expect(d.uptodayHist[0]).toHaveProperty("t");
    expect(d.uptodayHist.every((p) => p.s === "nodata")).toBe(true);
    expect(d.modules[0]!.hist).toHaveLength(45);
    // error bars now carry an hour timestamp for the tooltip
    expect(d.errors.hist[0]).toHaveProperty("t");
  });

  it("returns the shadow registry as plain name/date items (no verdict/badge)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/system-health",
      headers: authHeaders(),
    });
    const body = res.json<{ data: { shadow: Record<string, unknown>[] } }>();
    expect(body.data.shadow.length).toBeGreaterThan(0);
    expect(body.data.shadow).not.toContainEqual(
      expect.objectContaining({ nm: "Two-lane entry shadow" }),
    );
    for (const item of body.data.shadow) {
      expect(Object.keys(item).sort()).toEqual(["added", "nm"]);
      expect(typeof item.nm).toBe("string");
      expect(typeof item.added).toBe("string");
    }
  });
});
