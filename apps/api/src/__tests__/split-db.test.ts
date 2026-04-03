/**
 * Integration test that boots the API against REAL split schemas
 * (bootstrapControlDb + bootstrapLedgerDb) to catch "no such table" errors
 * that the legacy monolithic-DB tests cannot detect.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb, bootstrapLedgerDb } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-split-key";

function testConfig(): AppConfig {
  return {
    runtimeMode: "simulation",
    logLevel: "error",
    dbPath: "",
    familyRulesPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    executionMaxConcurrency: 4,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    planktonApiKey: TEST_API_KEY,
    planktonApiPort: 0,
    planktonAuthUsername: undefined,
    planktonAuthPassword: undefined,
    planktonSessionSecret: undefined,
    trustProxy: false,
  };
}

let tmpDir: string;
let controlConn: DbConnection;
let ledgerConn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-split-api-"));
  controlConn = bootstrapControlDb(path.join(tmpDir, "control.db"));
  ledgerConn = bootstrapLedgerDb(path.join(tmpDir, "ledger-sim.db"));

  // Seed minimal data in the CORRECT databases
  const cdb = controlConn.db;
  const ldb = ledgerConn.db;

  // Control: family catalog + rules + evidence
  cdb.exec(`
    INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, source_type)
    VALUES ('fam-1', 'test-family', 'politics', 'threshold', 'daily', 'daily-dated', 'standard', 'yaml_import');

    INSERT INTO family_rules (family_id, max_open_value_usdc, max_active_markets, max_dust_positions)
    VALUES ('fam-1', 50, 5, 3);

    INSERT INTO family_evidence (family_id) VALUES ('fam-1');

    INSERT INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation');
    INSERT INTO profiles (profile_id, display_name) VALUES ('paper', 'Paper');
    INSERT INTO runtime_control_state (id, current_profile, desired_profile, runtime_status, paused)
    VALUES (1, 'simulation', 'simulation', 'running', 0);

    INSERT INTO family_deployments (family_id, profile, enabled, operator_mode, strategy_stage, deployment_stage, priority, created_at, updated_at)
    VALUES ('fam-1', 'simulation', 1, 'active', 'probe-only', 'disabled', 999, datetime('now'), datetime('now'));
  `);

  // Ledger: runtime state, positions, orders, bot_runs, metrics, markets
  ldb.exec(`
    INSERT INTO family_runtime_state (family_id, runtime_mode, open_value_usdc, open_position_count, open_dust_count,
      active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
    VALUES ('fam-1', 'active', 50.0, 2, 0, 3, 10.0, 5.0, '2026-03-14T00:00:00Z');

    INSERT INTO bot_runs (run_id, mode, started_at)
    VALUES ('run-1', 'simulation', '2026-03-14T00:00:00Z');

    INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
    VALUES ('market_data_source', 1, '{"value":"simulation"}', '2026-03-14T00:00:00Z');
    INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
    VALUES ('execution_mode', 1, '{"value":"simulation"}', '2026-03-14T00:00:00Z');

    INSERT INTO markets (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk, end_date, created_at, updated_at)
    VALUES ('tok-1', 'cond-1', 'will-btc-hit-100k', 'Will BTC hit 100k?', 'Yes', 1, 0.01, 0, '2026-04-15T00:00:00Z', '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

    INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc,
      current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES ('pos-1', 'tok-1', 'fam-1', 'buy', 100, 0.5, 50, 60, 0, 'open', '2026-03-14T00:00:00Z', '2026-03-14T01:00:00Z');

    INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc,
      status, exchange_order_id, bot_run_id, created_at, updated_at)
    VALUES ('ord-1', 'plk_abc', 'tok-1', 'fam-1', 'buy', 'GTC', 0.5, 100, 50, 'open', 'ex-1', 'run-1',
      '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

    INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee, filled_at, reconciled)
    VALUES ('fill-1', 'ord-1', 'tok-1', 'fam-1', 'buy', 0.5, 100, 50, 0.01, '2026-03-14T00:00:00Z', 0);
  `);

  app = await buildServer({
    config: testConfig(),
    controlDb: cdb,
    ledgerDb: ldb,
    ledgerPool: stubLedgerPool(),
  });
});

afterAll(async () => {
  await app.close();
  controlConn.close();
  ledgerConn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function auth() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

describe("API against real split schemas", () => {
  it("GET /status succeeds (ledger: runtime_metrics, family_runtime_state, bot_runs)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.runtimeMode).toBe("simulation");
    expect(body.data.executionTelemetry24h).toBeDefined();
  });

  it("GET /families succeeds (control: catalog + rules + evidence; ledger: positions, orders)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/families", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(body.data.items[0].familyId).toBe("fam-1");
    expect(body.data.items[0].executionTelemetry24h).toBeDefined();
  });

  it("GET /families returns uniform wrapper with items and meta", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/families", headers: auth() });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toBeDefined();
    expect(body.data.meta).toBeDefined();
    expect(body.data.meta.scope).toBe("all");
    expect(body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(body.data.items[0].deployment).not.toBeNull();
  });

  it("GET /families?scope=profile filters to enabled=1 families for current profile", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families?scope=profile",
      headers: auth(),
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.meta.scope).toBe("profile");
    expect(body.data.meta.profile).toBe("simulation");
    expect(body.data.meta.totalCatalogCount).toBeGreaterThanOrEqual(1);
    expect(body.data.items).toHaveLength(body.data.meta.totalCatalogCount);
    expect(body.data.items[0].deployment).toEqual({
      enabled: true,
      operatorMode: "active",
      deploymentStage: "disabled",
      priority: 999,
    });
  });

  it("GET /families?scope=profile excludes disabled families", async () => {
    controlConn.db.exec(`
      INSERT OR IGNORE INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, source_type)
      VALUES ('fam-disabled', 'disabled-family', 'crypto', 'threshold', 'daily', 'daily-dated', 'standard', 'yaml_import');
      INSERT OR REPLACE INTO family_deployments (family_id, profile, enabled, operator_mode, strategy_stage, deployment_stage, priority, created_at, updated_at)
      VALUES ('fam-disabled', 'simulation', 0, 'active', 'probe-only', 'disabled', 999, datetime('now'), datetime('now'));
    `);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/families?scope=profile",
        headers: auth(),
      });
      const body = res.json();
      const ids = body.data.items.map((f: any) => f.familyId);
      expect(ids).not.toContain("fam-disabled");
      expect(body.data.meta.totalCatalogCount).toBeGreaterThan(body.data.items.length);
    } finally {
      controlConn.db.exec(`
        DELETE FROM family_deployments WHERE family_id = 'fam-disabled';
        DELETE FROM family_catalog WHERE family_id = 'fam-disabled';
      `);
    }
  });

  it("GET /families/:id includes deployment metadata for current profile", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families/fam-1",
      headers: auth(),
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.deployment).toEqual({
      enabled: true,
      operatorMode: "active",
      deploymentStage: "disabled",
      priority: 999,
    });
  });

  it("GET /families/:id/positions succeeds (ledger: positions)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families/fam-1/positions",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /positions succeeds (ledger-only)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/positions", headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it("GET /orders succeeds (ledger-only)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/orders", headers: auth() });
    expect(res.statusCode).toBe(200);
  });

  it("GET /fills succeeds (ledger-only)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/fills", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.items[0].explicitFeeUsdc).toBe(0.01);
    expect(body.data.items[0].liquidityRole).toBe("unknown");
  });

  it("GET /metrics succeeds with execution telemetry aggregates", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/metrics", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.fills.explicitFeesUsdc).toBe(0.01);
    expect(body.data.fills.unknownCount).toBe(1);
  });

  it("GET /metrics/families includes family metadata and execution telemetry", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/families",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data[0].familyId).toBe("fam-1");
    expect(body.data[0].familyKey).toBe("test-family");
    expect(body.data[0].executionTelemetry24h).toBeDefined();
    expect(body.data[0].executionTelemetry24h.windowHours).toBe(24);
  });

  it("GET /discovery/status succeeds (control-only)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/status",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
  });

  it("POST /actions/pause succeeds (control-only)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/pause",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /status reads from active profile's ledger after switch (not startup ledger)", async () => {
    // Create a paper ledger with different data
    const paperConn = bootstrapLedgerDb(path.join(tmpDir, "ledger-paper.db"));
    paperConn.db.exec(`
      INSERT INTO bot_runs (run_id, mode, started_at)
      VALUES ('run-paper', 'paper', '2026-03-15T00:00:00Z');

      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('runtime_paused', 0, NULL, '2026-03-15T00:00:00Z');

      INSERT INTO family_runtime_state (family_id, runtime_mode, open_value_usdc, open_position_count,
        open_dust_count, active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
      VALUES ('fam-1', 'active', 100.0, 5, 1, 4, 20.0, 10.0, '2026-03-15T00:00:00Z');
    `);

    // Update control.db to point to paper as current profile
    controlConn.db
      .prepare(
        "UPDATE runtime_control_state SET current_profile = 'paper', updated_at = datetime('now') WHERE id = 1",
      )
      .run();

    // Create a real LedgerPool that finds the paper ledger
    const { LedgerPool } = await import("../ledger-pool.js");
    const pool = new LedgerPool(path.join(tmpDir, "control.db"));

    // Build a fresh server with the pool
    const freshApp = await buildServer({
      config: testConfig(),
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db, // startup ledger is still simulation
      ledgerPool: pool,
    });

    const res = await freshApp.inject({ method: "GET", url: "/api/v1/status", headers: auth() });
    const body = res.json();

    expect(body.ok).toBe(true);
    // Should read from paper ledger, not simulation
    expect(body.data.runtimeMode).toBe("paper");
    expect(body.data.paused).toBe(false); // paper ledger has runtime_paused=0
    expect(body.data.totalOpenValueUsdc).toBe(100.0); // paper ledger has 100, sim has 50
    expect(body.data.activeFamilyCount).toBe(1);

    await freshApp.close();
    pool.closeAll();
    paperConn.close();

    // Restore control state for other tests
    controlConn.db
      .prepare(
        "UPDATE runtime_control_state SET current_profile = 'simulation', updated_at = datetime('now') WHERE id = 1",
      )
      .run();
  });

  it("GET /families?scope=all includes disabled family with deployment.enabled=false", async () => {
    controlConn.db.exec(`
      INSERT OR IGNORE INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, source_type)
      VALUES ('fam-disabled-all', 'disabled-all-family', 'crypto', 'threshold', 'daily', 'daily-dated', 'standard', 'yaml_import');
      INSERT OR REPLACE INTO family_deployments (family_id, profile, enabled, operator_mode, strategy_stage, deployment_stage, priority, created_at, updated_at)
      VALUES ('fam-disabled-all', 'simulation', 0, 'active', 'probe-only', 'disabled', 999, datetime('now'), datetime('now'));
    `);

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/families?scope=all",
        headers: auth(),
      });
      const body = res.json();
      const disabled = body.data.items.find((f: any) => f.familyId === "fam-disabled-all");
      expect(disabled).toBeDefined();
      expect(disabled.deployment).toEqual({
        enabled: false,
        operatorMode: "active",
        deploymentStage: "disabled",
        priority: 999,
      });
    } finally {
      controlConn.db.exec(`
        DELETE FROM family_deployments WHERE family_id = 'fam-disabled-all';
        DELETE FROM family_catalog WHERE family_id = 'fam-disabled-all';
      `);
    }
  });

  it("SSE /events reads from active profile's ledger after switch", async () => {
    // Create a paper ledger with a distinct position
    const paperConn = bootstrapLedgerDb(path.join(tmpDir, "ledger-paper.db"));
    paperConn.db.exec(`
      INSERT INTO bot_runs (run_id, mode, started_at) VALUES ('run-paper-sse', 'paper', '2026-03-15T00:00:00Z');
      INSERT INTO family_runtime_state (family_id, runtime_mode, open_value_usdc, open_position_count,
        open_dust_count, active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
      VALUES ('fam-sse', 'active', 200.0, 3, 0, 2, 5.0, 15.0, '2026-03-15T00:00:00Z');
      INSERT INTO markets (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk, end_date, created_at, updated_at)
      VALUES ('tok-sse', 'cond-sse', 'test-sse', 'SSE test?', 'Yes', 1, 0.01, 0, '2026-04-01T00:00:00Z', '2026-03-15T00:00:00Z', '2026-03-15T00:00:00Z');
      INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc,
        current_value_usdc, realized_pnl, status, opened_at, updated_at)
      VALUES ('pos-sse', 'tok-sse', 'fam-sse', 'buy', 50, 0.4, 20, 25, 0, 'open', '2026-03-15T00:00:00Z', '2026-03-15T01:00:00Z');
    `);

    // Switch to paper
    controlConn.db
      .prepare(
        "UPDATE runtime_control_state SET current_profile = 'paper', updated_at = datetime('now') WHERE id = 1",
      )
      .run();

    const { LedgerPool } = await import("../ledger-pool.js");
    const pool = new LedgerPool(path.join(tmpDir, "control.db"));

    const freshApp = await buildServer({
      config: testConfig(),
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db, // startup ledger is simulation
      ledgerPool: pool,
    });

    // Connect to SSE and read the first status event triggered by metrics tick
    // We can't easily test SSE streaming in inject, so test the underlying
    // buildStatusSnapshot with resolveActiveLedger instead
    const { buildStatusSnapshot, resolveActiveLedger } = await import("../routes/status.js");
    const active = resolveActiveLedger(ledgerConn.db, controlConn.db, pool);
    const snapshot = buildStatusSnapshot(active.db, 120_000, active.profile);

    expect(snapshot.runtimeMode).toBe("paper");
    // Paper ledger has data from both this test and previous test (shared file)
    expect(snapshot.totalOpenValueUsdc).toBeGreaterThanOrEqual(200.0);
    expect(snapshot.activeFamilyCount).toBeGreaterThanOrEqual(1);

    await freshApp.close();
    pool.closeAll();
    paperConn.close();

    // Restore
    controlConn.db
      .prepare(
        "UPDATE runtime_control_state SET current_profile = 'simulation', updated_at = datetime('now') WHERE id = 1",
      )
      .run();
  });
});
