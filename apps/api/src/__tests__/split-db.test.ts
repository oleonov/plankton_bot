/**
 * Integration test that boots the API against REAL split schemas
 * (bootstrapControlDb + bootstrapLedgerDb) to catch "no such table" errors
 * that the legacy monolithic-DB tests cannot detect.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb, bootstrapLedgerDb } from "@plankton/db";
import { DEFAULT_EXECUTION_POLICY } from "@plankton/domain";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-split-key";

function testConfig(): AppConfig {
  return {
    runtimeMode: "simulation",
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
    planktonApiKey: TEST_API_KEY,
    planktonApiPort: 0,
    planktonAuthUsername: undefined,
    planktonAuthPassword: undefined,
    planktonSessionSecret: undefined,
    allowSellSizeClamp: true,
    trustProxy: false,
    ...MARKET_DATA_TEST_DEFAULTS,
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

  // Control: profiles + runtime state
  cdb.exec(`
    INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation');
    INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES ('paper', 'Paper');
    INSERT INTO runtime_control_state (id, current_profile, desired_profile, runtime_status, paused)
    VALUES (1, 'simulation', 'simulation', 'running', 0)
    ON CONFLICT(id) DO UPDATE SET
      current_profile = excluded.current_profile,
      desired_profile = excluded.desired_profile,
      runtime_status = excluded.runtime_status,
      paused = excluded.paused;
  `);

  // Ledger: runtime state, positions, orders, bot_runs, metrics, markets
  ldb.exec(`
    INSERT INTO bot_runs (run_id, mode, started_at)
    VALUES ('run-1', 'simulation', '2026-03-14T00:00:00Z');

    INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
    VALUES ('market_data_source', 1, '{"value":"simulation"}', '2026-03-14T00:00:00Z');
    INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
    VALUES ('execution_mode', 1, '{"value":"simulation"}', '2026-03-14T00:00:00Z');

    INSERT INTO markets (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk, end_date, created_at, updated_at)
    VALUES ('tok-1', 'cond-1', 'will-btc-hit-100k', 'Will BTC hit 100k?', 'Yes', 1, 0.01, 0, '2026-04-15T00:00:00Z', '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

    INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc,
      current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES ('pos-1', 'tok-1', 'buy', 100, 0.5, 50, 60, 0, 'open', '2026-03-14T00:00:00Z', '2026-03-14T01:00:00Z');

    INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc,
      status, exchange_order_id, bot_run_id, created_at, updated_at)
    VALUES ('ord-1', 'plk_abc', 'tok-1', 'buy', 'GTC', 0.5, 100, 50, 'open', 'ex-1', 'run-1',
      '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

    INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, fee, filled_at, reconciled)
    VALUES ('fill-1', 'ord-1', 'tok-1', 'buy', 0.5, 100, 50, 0.01, '2026-03-14T00:00:00Z', 0);
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
  it("GET /status succeeds (ledger: runtime_metrics, positions, bot_runs)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: auth() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.runtimeMode).toBe("simulation");
    expect(body.data.executionTelemetry24h).toBeDefined();
  });

  it("GET /status derives live-lite envelope from current control state, not stale runtime metric", async () => {
    controlConn.db.exec(`
      INSERT OR REPLACE INTO profiles (profile_id, display_name) VALUES ('live-lite', 'Live Lite');
      INSERT OR REPLACE INTO profile_settings (profile_id, envelope_json, wallet_mode, min_order_usdc)
      VALUES ('live-lite', '{"maxFamilies":100,"maxOpenValueUsdc":500,"maxOrderUsdc":25,"maxActiveMarkets":10}', 'relayer', 1);

      UPDATE runtime_control_state
      SET current_profile = 'live-lite', desired_profile = 'live-lite', updated_at = datetime('now')
      WHERE id = 1;
    `);

    ledgerConn.db.exec(`
      INSERT INTO bot_runs (run_id, mode, started_at)
      VALUES ('run-live-lite-status', 'live-lite', '2026-03-16T00:00:00Z');

      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('live_lite_envelope', 1, '{"maxOpenValueUsdc":999,"maxOrderUsdc":999,"maxActiveMarkets":999,"walletMode":"eoa","minOrderUsdc":99}', '2026-03-16T00:00:00Z');
    `);

    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.runtimeMode).toBe("live-lite");
      expect(body.data.liveLite).toEqual({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: 10,
        walletMode: "relayer",
        minOrderUsdc: 1,
      });
    } finally {
      controlConn.db.exec(`
        UPDATE runtime_control_state
        SET current_profile = 'simulation', desired_profile = 'simulation', updated_at = datetime('now')
        WHERE id = 1;
        DELETE FROM profile_settings WHERE profile_id = 'live-lite';
        DELETE FROM profiles WHERE profile_id = 'live-lite';
      `);
      ledgerConn.db.exec(`
        DELETE FROM runtime_metrics WHERE metric_name = 'live_lite_envelope' AND captured_at = '2026-03-16T00:00:00Z';
        DELETE FROM bot_runs WHERE run_id = 'run-live-lite-status';
      `);
    }
  });

  it("GET /status uses Polymarket wallet positions for live-lite portfolio", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { asset: "tok-open", size: 10, currentValue: 4.25, initialValue: 3.5 },
          { asset: "tok-closed-locally", size: 20, currentValue: 8.5, initialValue: 7 },
          { asset: "tok-zero", size: 0, currentValue: 99, initialValue: 99 },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    controlConn.db.exec(`
      INSERT OR REPLACE INTO profiles (profile_id, display_name) VALUES ('live-lite', 'Live Lite');
      INSERT OR REPLACE INTO profile_settings (profile_id, relayer_json)
      VALUES ('live-lite', '{"walletType":"proxy","funderAddress":"0xf00df00df00df00df00df00df00df00df00df00d"}');
      INSERT OR REPLACE INTO profile_summaries
        (profile_id, paused, open_orders, open_positions, total_exposure_usdc, balance_usdc, wallet_balance_usdc)
      VALUES ('live-lite', 0, 0, 0, 0, NULL, 0.34);
    `);
    ledgerConn.db.exec(`
      INSERT INTO bot_runs (run_id, mode, started_at)
      VALUES ('run-live-lite-portfolio', 'live-lite', '2026-03-17T00:00:00Z');
    `);

    try {
      const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: auth() });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.data.polymarketPortfolio).toMatchObject({
        portfolioUsdc: 13.09,
        availableUsdc: 0.34,
        positionValueUsdc: 12.75,
        positionCount: 2,
        costBasisUsdc: 10.5,
        source: "polymarket",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toContain("data-api.polymarket.com/positions");
    } finally {
      globalThis.fetch = originalFetch;
      controlConn.db.exec(`
        DELETE FROM profile_summaries WHERE profile_id = 'live-lite';
        DELETE FROM profile_settings WHERE profile_id = 'live-lite';
        DELETE FROM profiles WHERE profile_id = 'live-lite';
      `);
      ledgerConn.db.exec(`
        DELETE FROM bot_runs WHERE run_id = 'run-live-lite-portfolio';
      `);
    }
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

      INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price,
        cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
      VALUES ('pos-paper-1', 'tok-paper-1', 'cond-paper-1', 'buy', 200, 0.5, 80, 100.0, 0, 'open',
        '2026-03-15T00:00:00Z', '2026-03-15T00:00:00Z');
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
    expect(body.data.openConditionCount).toBe(1);

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

  it("SSE /events reads from active profile's ledger after switch", async () => {
    // Create a paper ledger with a distinct position
    const paperConn = bootstrapLedgerDb(path.join(tmpDir, "ledger-paper.db"));
    paperConn.db.exec(`
      INSERT INTO bot_runs (run_id, mode, started_at) VALUES ('run-paper-sse', 'paper', '2026-03-15T00:00:00Z');
      INSERT INTO markets (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk, end_date, created_at, updated_at)
      VALUES ('tok-sse', 'cond-sse', 'test-sse', 'SSE test?', 'Yes', 1, 0.01, 0, '2026-04-01T00:00:00Z', '2026-03-15T00:00:00Z', '2026-03-15T00:00:00Z');
      INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc,
        current_value_usdc, realized_pnl, status, opened_at, updated_at)
      VALUES ('pos-sse', 'tok-sse', 'cond-sse', 'buy', 50, 0.4, 20, 200.0, 0, 'open', '2026-03-15T00:00:00Z', '2026-03-15T01:00:00Z');
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
    expect(snapshot.openConditionCount).toBeGreaterThanOrEqual(1);

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

  // ── ADR-015 — GET /profiles/:id/execution-policy ─────────────────────────
  //
  // Regression: the handler used to 404 when `profile_settings` had no row,
  // even though the profile existed in `profiles`. On a fresh control.db the
  // seed helper fills the rows, so a baseline GET must return the seeded
  // policy. And if an operator ever deletes the settings row, the handler
  // must still return DEFAULT_EXECUTION_POLICY rather than 404.

  it("GET /execution-policy returns seeded policy on fresh control.db", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/simulation/execution-policy",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.policy.deadSideGuard.mode).toBe("observe");
    expect(body.data.issues).toEqual([]);
  });

  it("GET /execution-policy falls back to defaults when profile_settings row is missing", async () => {
    // Wipe the settings row for paper but keep the profile — mimics a broken
    // upgrade that skipped the seed. Handler must return defaults, not 404.
    controlConn.db.prepare("DELETE FROM profile_settings WHERE profile_id = 'paper'").run();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/profiles/paper/execution-policy",
        headers: auth(),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.policy.deadSideGuard.mode).toBe("observe");
    } finally {
      // Re-seed so later tests don't see a NULL row.
      controlConn.db
        .prepare(
          `INSERT OR IGNORE INTO profile_settings (profile_id, execution_policy_json, updated_at)
             VALUES ('paper', ?, datetime('now'))`,
        )
        .run(
          JSON.stringify({
            version: 1,
            entryPriceCeiling: 0.45,
            exitOrderTtlMs: 15000,
            deadSideGuard: { mode: "observe", askCeiling: 0.02, maxTimeToEndMs: 120000 },
            pricing: {
              mode: "edge",
              maxEntrySpreadTicks: 10,
              maxExitSpreadTicks: 10,
              maxImprovementTicks: 1,
              minExitPriceSignalRatio: 0.5,
              wideSpreadPolicy: "edge",
              oneSidedPolicy: "edge",
            },
            telemetry: { deadSideCanary: true, pricingShadow: true },
          }),
        );
    }
  });

  it("GET /execution-policy still returns 404 when the profile itself does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/unknown-profile/execution-policy",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /execution-policy deep-merges PR2 policy objects", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/profiles/simulation/execution-policy",
      headers: auth(),
      payload: {
        dropTrigger: { thresholdPct: -0.05 },
        multiBuyLadder: { maxLadderFillsPerToken: 4 },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.policy.dropTrigger).toEqual({
      ...DEFAULT_EXECUTION_POLICY.dropTrigger,
      thresholdPct: -0.05,
    });
    expect(body.data.policy.multiBuyLadder).toEqual({
      ...DEFAULT_EXECUTION_POLICY.multiBuyLadder,
      enabled: true,
      maxLadderFillsPerToken: 4,
    });
    expect(body.data.policy.repriceOnOutbid).toEqual(DEFAULT_EXECUTION_POLICY.repriceOnOutbid);
  });
});
