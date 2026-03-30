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

  app = await buildServer({ config: testConfig(), controlDb: cdb, ledgerDb: ldb, ledgerPool: stubLedgerPool() });
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
  });

  it("GET /families succeeds (control: catalog + rules + evidence; ledger: positions, orders)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/families", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].familyId).toBe("fam-1");
  });

  it("GET /families/:id/positions succeeds (ledger: positions)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/families/fam-1/positions", headers: auth() });
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
  });

  it("GET /discovery/status succeeds (control-only)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/discovery/status", headers: auth() });
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
});
