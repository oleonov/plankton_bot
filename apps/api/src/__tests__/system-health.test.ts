import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import {
  collectSystemHealthSnapshot,
  readReconciliationHealth,
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
