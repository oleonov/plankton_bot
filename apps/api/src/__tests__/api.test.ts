import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

function json(res: { json: () => unknown }): any {
  return res.json();
}

// ─── Test setup ─────────────────────────────────────────────────────

const TEST_API_KEY = "test-key-abc123";

function testConfig(overrides?: Partial<AppConfig>): AppConfig {
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
    ...overrides,
  };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");

  const db = conn.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS family_validation_scorecards (
      scorecard_id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      profile TEXT NOT NULL,
      evidence_status TEXT NOT NULL DEFAULT 'unknown',
      evidence_score REAL NOT NULL DEFAULT 0,
      recurrence_score REAL,
      recycle_score REAL,
      live_viability_score REAL,
      toxicity_penalty REAL,
      trade_count INTEGER NOT NULL DEFAULT 0,
      market_count INTEGER NOT NULL DEFAULT 0,
      realized_pnl REAL NOT NULL DEFAULT 0,
      tail_adjusted_pnl REAL NOT NULL DEFAULT 0,
      both_sided_eligible INTEGER NOT NULL DEFAULT 0,
      heavy_campaign_eligible INTEGER NOT NULL DEFAULT 0,
      active_window_edge_score REAL,
      summary_json TEXT,
      validated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS family_validation_latest (
      family_id TEXT NOT NULL,
      profile TEXT NOT NULL,
      scorecard_id TEXT NOT NULL,
      PRIMARY KEY (family_id, profile)
    );

    INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
    VALUES ('fam-1', 'test-family', 'politics', 'standard', 'medium', 'daily', 'v1');

    INSERT INTO family_runtime_state (family_id, runtime_mode, open_value_usdc, open_position_count, open_dust_count,
      active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
    VALUES ('fam-1', 'active', 50.0, 2, 0, 3, 10.0, 5.0, '2026-03-14T00:00:00Z');

    INSERT INTO family_rules (family_id, max_open_value_usdc, max_active_markets, max_dust_positions)
    VALUES ('fam-1', 50, 5, 3);

    INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc,
      current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES ('pos-1', 'tok-1', 'fam-1', 'buy', 100, 0.5, 50, 60, 0, 'open', '2026-03-14T00:00:00Z', '2026-03-14T01:00:00Z');

    INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc,
      current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES ('pos-dust', 'tok-2', 'fam-1', 'buy', 1, 0.02, 0.02, 0.01, 0, 'dust', '2026-03-14T00:00:00Z', '2026-03-14T01:00:00Z');

    INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc,
      status, exchange_order_id, bot_run_id, created_at, updated_at)
    VALUES ('ord-1', 'plk_abc', 'tok-1', 'fam-1', 'buy', 'GTC', 0.5, 100, 50, 'open', 'ex-1', 'run-1',
      '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

    INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc,
      status, exchange_order_id, bot_run_id, created_at, updated_at)
    VALUES ('ord-2', 'plk_def', 'tok-1', 'fam-1', 'sell', 'GTC', 0.6, 50, 30, 'filled', 'ex-2', 'run-1',
      '2026-03-14T01:00:00Z', '2026-03-14T01:00:00Z');

    INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee, filled_at, reconciled)
    VALUES ('fill-1', 'ord-1', 'tok-1', 'fam-1', 'buy', 0.5, 100, 50, 0.01, '2026-03-14T00:00:00Z', 0);

    INSERT INTO bot_runs (run_id, mode, started_at)
    VALUES ('run-1', 'simulation', '2026-03-14T00:00:00Z');

    INSERT INTO markets (token_id, condition_id, slug, question, outcome, family_id, family_key, active, tick_size, neg_risk, end_date, created_at, updated_at)
    VALUES ('tok-1', 'cond-1', 'will-btc-hit-100k', 'Will BTC hit 100k?', 'Yes', 'fam-1', 'test-family', 1, 0.01, 0, '2026-04-15T00:00:00Z', '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

    INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
    VALUES ('market_data_source', 1, '{"value":"simulation"}', '2026-03-14T00:00:00Z');
    INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
    VALUES ('execution_mode', 1, '{"value":"simulation"}', '2026-03-14T00:00:00Z');

    INSERT INTO market_resolutions (condition_id, resolution, resolved_at, detected_at, source, status)
    VALUES ('cond-1', 'YES', '2026-03-15T00:00:00Z', '2026-03-15T00:00:00Z', 'gamma-api', 'detected');
  `);

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

// ─── Auth tests ─────────────────────────────────────────────────────

describe("auth", () => {
  it("GET /health is unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
  });

  it("protected route returns 401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/status" });
    expect(res.statusCode).toBe(401);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("protected route returns 401 with wrong token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("protected route succeeds with correct token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);
  });

  it("fail-closed when PLANKTON_API_KEY is not configured", async () => {
    const noKeyApp = await buildServer({
      config: testConfig({ planktonApiKey: undefined }),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
    });
    const res = await noKeyApp.inject({
      method: "GET",
      url: "/api/v1/status",
    });
    expect(res.statusCode).toBe(401);
    expect(json(res).error.code).toBe("AUTH_NOT_CONFIGURED");
    await noKeyApp.close();
  });
});

// ─── Health ─────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns ok envelope with deploy metadata fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(body.data.uptime).toBeTypeOf("number");
    // Without deploy-meta.json, fields are null but present
    expect("sha" in body.data).toBe(true);
    expect("deployVersion" in body.data).toBe(true);
    expect("deployedAt" in body.data).toBe(true);
    expect(body.ts).toBeDefined();
  });
});

// ─── Status ─────────────────────────────────────────────────────────

describe("GET /status", () => {
  it("returns documented status fields including market data freshness", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(typeof body.data.runtimeMode).toBe("string");
    expect(typeof body.data.uptimeSeconds).toBe("number");
    expect(typeof body.data.ordersPlacedLastMin).toBe("number");
    expect(typeof body.data.positionsOpenedLastMin).toBe("number");
    expect(typeof body.data.paused).toBe("boolean");
    expect(typeof body.data.activeFamilyCount).toBe("number");
    expect(typeof body.data.openOrderCount).toBe("number");
    expect(typeof body.data.openPositionCount).toBe("number");
    expect(typeof body.data.totalOpenValueUsdc).toBe("number");
    expect(typeof body.data.totalTailCostUsdc).toBe("number");
    // Market data freshness fields
    expect(typeof body.data.marketDataStale).toBe("boolean");
    expect(body.data).toHaveProperty("marketDataLastUpdateAt");
    expect(body.data.marketDataSource).toBe("simulation");
    expect(body.data.executionMode).toBe("simulation");
  });

  it("status includes order and position throughput for the last minute", async () => {
    const now = new Date().toISOString();
    const older = new Date(Date.now() - 120_000).toISOString();

    conn.db.exec(`
      INSERT INTO orders (order_id, client_order_id, token_id, family_id, side, order_type, price, size, size_usdc,
        status, exchange_order_id, bot_run_id, created_at, updated_at)
      VALUES
        ('ord-last-min', 'plk_last_min', 'tok-1', 'fam-1', 'buy', 'GTC', 0.4, 10, 4, 'filled', 'ex-last-min', 'run-1',
          '${now}', '${now}'),
        ('ord-old', 'plk_old', 'tok-1', 'fam-1', 'buy', 'GTC', 0.4, 10, 4, 'filled', 'ex-old', 'run-1',
          '${older}', '${older}');

      INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price, cost_basis_usdc,
        current_value_usdc, realized_pnl, status, opened_at, updated_at)
      VALUES
        ('pos-last-min', 'tok-3', 'fam-1', 'buy', 10, 0.4, 4, 4, 0, 'open', '${now}', '${now}'),
        ('pos-old', 'tok-4', 'fam-1', 'buy', 10, 0.4, 4, 4, 0, 'open', '${older}', '${older}');
    `);

    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });
    const data = json(res).data;

    expect(data.ordersPlacedLastMin).toBe(1);
    expect(data.positionsOpenedLastMin).toBe(1);

    conn.db.exec(`
      DELETE FROM orders WHERE order_id IN ('ord-last-min', 'ord-old');
      DELETE FROM positions WHERE position_id IN ('pos-last-min', 'pos-old');
    `);
  });

  it("runtimeMode comes from bot_runs, not family_runtime_state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    const body = json(res);
    // bot_runs has mode='simulation', family_runtime_state has runtime_mode='active'
    expect(body.data.runtimeMode).toBe("simulation");
  });

  it("orders include postOnly execution metadata", async () => {
    conn.db.prepare("UPDATE orders SET post_only = 1 WHERE order_id = 'ord-1'").run();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders",
      headers: authHeaders(),
    });
    const body = json(res);

    expect(body.ok).toBe(true);
    const updatedOrder = body.data.items.find(
      (item: { orderId: string }) => item.orderId === "ord-1",
    );
    expect(updatedOrder?.postOnly).toBe(true);
  });

  it("paused reflects runtime_paused metric", async () => {
    // No runtime_paused metric yet → paused=false
    const res1 = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res1).data.paused).toBe(false);

    // Runtime persists paused=true
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, captured_at)
      VALUES ('runtime_paused', 1, '2026-03-14T02:00:00Z')
    `);

    const res2 = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res2).data.paused).toBe(true);

    // Runtime persists paused=false (resumed)
    conn.db.exec(`
      DELETE FROM runtime_metrics WHERE metric_name = 'runtime_paused';
      INSERT INTO runtime_metrics (metric_name, value, captured_at)
      VALUES ('runtime_paused', 0, '2026-03-14T03:00:00Z')
    `);

    const res3 = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res3).data.paused).toBe(false);
  });

  it("lastReconciliationAt reads from runtime_metrics", async () => {
    // No runtime_metrics yet → null
    const res1 = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res1).data.lastReconciliationAt).toBeNull();

    // Insert a reconciliation metric
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, captured_at)
      VALUES ('last_reconciliation', 1, '2026-03-14T01:30:00Z')
    `);

    const res2 = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res2).data.lastReconciliationAt).toBe("2026-03-14T01:30:00Z");
  });

  it("marketDataStale is true when no market data metric exists", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    const d = json(res).data;
    expect(d.marketDataStale).toBe(true);
    expect(d.marketDataLastUpdateAt).toBeNull();
  });

  it("marketDataStale reflects freshness from runtime_metrics", async () => {
    // Insert a recent market data metric
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, captured_at)
      VALUES ('market_data_last_update', 1, '${new Date().toISOString()}')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res).data.marketDataStale).toBe(false);
    expect(json(res).data.marketDataLastUpdateAt).toBeTruthy();
  });

  it("marketDataPoll is included when active progress exists for current bot run", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('market_data_poll_progress', 1, '{"active":true,"page":5,"botRunId":"run-1"}', '${new Date().toISOString()}')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    const d = json(res).data;
    expect(d.marketDataPoll).toEqual({ active: true, page: 5 });

    // Clean up
    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'market_data_poll_progress'`);
  });

  it("marketDataPoll is omitted when progress is inactive", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('market_data_poll_progress', 1, '{"active":false,"page":0,"botRunId":"run-1"}', '${new Date().toISOString()}')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res).data.marketDataPoll).toBeUndefined();

    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'market_data_poll_progress'`);
  });

  it("marketDataPoll is omitted when botRunId does not match current run", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('market_data_poll_progress', 1, '{"active":true,"page":3,"botRunId":"stale-run-999"}', '${new Date().toISOString()}')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res).data.marketDataPoll).toBeUndefined();

    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'market_data_poll_progress'`);
  });

  it("marketDataPoll is omitted when no progress row exists", async () => {
    // Ensure no progress row
    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'market_data_poll_progress'`);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    expect(json(res).data.marketDataPoll).toBeUndefined();
  });

  it("includes tradingState in status response", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/status",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.tradingState).toBeDefined();
    // No signal_activity metric exists in test DB, so state should be NO_SIGNALS or PAUSED
    expect(["NO_SIGNALS", "PAUSED"]).toContain(body.data.tradingState);
  });

  it("status includes 24h execution telemetry from recent fills", async () => {
    const now = new Date().toISOString();
    try {
      conn.db.exec(`
        INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, liquidity_role, fee, filled_at, reconciled)
        VALUES ('fill-maker-24h', 'ord-1', 'tok-1', 'fam-1', 'buy', 0.5, 20, 10, 'maker', 0, '${now}', 0);

        INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, liquidity_role, fee, filled_at, reconciled)
        VALUES ('fill-taker-24h', 'ord-2', 'tok-1', 'fam-1', 'sell', 0.5, 10, 5, 'taker', 0.25, '${now}', 0);
      `);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/status",
        headers: authHeaders(),
      });
      const telemetry = json(res).data.executionTelemetry24h;

      expect(telemetry.windowHours).toBe(24);
      expect(telemetry.totalFills).toBe(2);
      expect(telemetry.makerFills).toBe(1);
      expect(telemetry.takerFills).toBe(1);
      expect(telemetry.unknownFills).toBe(0);
      expect(telemetry.explicitFeesUsdc).toBe(0.25);
      expect(telemetry.makerRatio).toBe(0.5);
      expect(telemetry.feeLeakageRatio).toBeCloseTo(0.25 / 15, 6);
    } finally {
      conn.db.exec("DELETE FROM fills WHERE fill_id IN ('fill-maker-24h', 'fill-taker-24h')");
    }
  });

  it("status includes recent infra alerts deduped by code", async () => {
    const now = new Date().toISOString();
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES
        ('infra_alert', 1, '{"code":"POLYGON_RPC_RATE_LIMITED","severity":"error","source":"polygon-rpc","message":"Polygon RPC rate limited — settlement may stall until quota resets."}', '${now}'),
        ('infra_alert', 1, '{"code":"POLYGON_RPC_RATE_LIMITED","severity":"error","source":"polygon-rpc","message":"Polygon RPC rate limited — settlement may stall until quota resets."}', '${new Date(Date.now() - 1000).toISOString()}'),
        ('infra_alert', 1, '{"code":"POLYMARKET_RELAYER_UNAVAILABLE","severity":"warning","source":"polymarket-relayer","message":"Polymarket relayer unavailable — settlement will retry automatically."}', '${now}')
    `);

    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });
    const alerts = json(res).data.infraAlerts;

    expect(alerts).toHaveLength(2);
    expect(alerts.map((alert: { code: string }) => alert.code).sort()).toEqual([
      "POLYGON_RPC_RATE_LIMITED",
      "POLYMARKET_RELAYER_UNAVAILABLE",
    ]);

    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'infra_alert'`);
  });

  it("returns ACTIVELY_TRADING when entry signals approved", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('signal_activity', 1, '{"produced":10,"approved":3,"rejected":7,"entryApproved":2,"exitApproved":1,"windowStartMs":${Date.now()}}', '${new Date().toISOString()}')
    `);
    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });
    expect(json(res).data.tradingState).toBe("ACTIVELY_TRADING");
    // Clean up
    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'signal_activity'`);
  });

  it("status includes signal conversion telemetry when available", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES
        ('signal_activity', 1, '{"produced":10,"approved":3,"rejected":7,"entryApproved":2,"exitApproved":1,"windowStartMs":${Date.now()}}', '${new Date().toISOString()}'),
        ('scanner_activity', 1, '{"candidatesConsidered":20,"blockedByResolutionBuffer":2,"blockedByWindow":1,"blockedByPerFamilyTickLimit":0,"gammaFallbackDustSignalsProduced":4,"scanPrimeSkippedByPolicy":11,"windowStartMs":${Date.now()}}', '${new Date().toISOString()}'),
        ('signal_conversion_activity', 1, '{"converted":2,"marketabilityRejectedByReason":{"gamma-fallback-no-real-book":5},"cacheStatusByStatus":{"refresh-budget-exhausted":4,"fresh-cache":2},"exchangeAccepted":1,"exchangeRejectedByCode":{"UNKNOWN":2},"fills":1,"fillLatencyMs":{"count":1,"avgMs":1200,"minMs":1200,"p50Ms":1200,"p95Ms":1200,"maxMs":1200},"cooldownBypassByReason":{"price-moved":3},"hotQuoteRefreshes":7,"hotLaneActionsByType":{"entry-reprice-cancel":2},"hotLaneStatesByState":{"quote-active":3,"cooling":1},"queueJumpAccepted":1,"queueJumpFills":1,"gammaFallbackDustOrders":2,"gammaFallbackDustFills":1,"candidateBookRefreshAttempts":9,"candidateBookRefreshTimeouts":3,"windowStartMs":${Date.now()}}', '${new Date().toISOString()}')
    `);

    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });
    const signalActivity = json(res).data.signalActivity;

    expect(signalActivity.signalsConvertedLast10m).toBe(2);
    expect(signalActivity.marketabilityRejectedLast10mByReason).toEqual({
      "gamma-fallback-no-real-book": 5,
    });
    expect(signalActivity.cacheStatusLast10mByStatus).toEqual({
      "refresh-budget-exhausted": 4,
      "fresh-cache": 2,
    });
    expect(signalActivity.exchangeAcceptedLast10m).toBe(1);
    expect(signalActivity.exchangeRejectedLast10mByCode).toEqual({ UNKNOWN: 2 });
    expect(signalActivity.fillsLast10m).toBe(1);
    expect(signalActivity.fillLatencyMsLast10m).toEqual({
      count: 1,
      avgMs: 1200,
      minMs: 1200,
      p50Ms: 1200,
      p95Ms: 1200,
      maxMs: 1200,
    });
    expect(signalActivity.cooldownBypassLast10mByReason).toEqual({ "price-moved": 3 });
    expect(signalActivity.hotQuoteRefreshesLast10m).toBe(7);
    expect(signalActivity.hotLaneActionsLast10mByType).toEqual({ "entry-reprice-cancel": 2 });
    expect(signalActivity.hotLaneStatesLast10mByState).toEqual({
      "quote-active": 3,
      cooling: 1,
    });
    expect(signalActivity.queueJumpAcceptedLast10m).toBe(1);
    expect(signalActivity.queueJumpFillsLast10m).toBe(1);
    expect(signalActivity.gammaFallbackDustSignalsLast10m).toBe(4);
    expect(signalActivity.scanPrimeSkippedByPolicyLast10m).toBe(11);
    expect(signalActivity.gammaFallbackDustOrdersLast10m).toBe(2);
    expect(signalActivity.gammaFallbackDustFillsLast10m).toBe(1);
    expect(signalActivity.candidateBookRefreshAttemptsLast10m).toBe(9);
    expect(signalActivity.candidateBookRefreshTimeoutsLast10m).toBe(3);

    conn.db.exec(
      `DELETE FROM runtime_metrics WHERE metric_name IN ('signal_activity', 'scanner_activity', 'signal_conversion_activity')`,
    );
  });

  it("status includes risk event volume telemetry when available", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('risk_event_volume', 1, '{"last1h":1200,"last24h":5400,"warning":true,"thresholdPerHour":1000}', '${new Date().toISOString()}')
    `);

    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });

    expect(json(res).data.riskEventVolume).toEqual({
      last1h: 1200,
      last24h: 5400,
      warning: true,
      thresholdPerHour: 1000,
    });

    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'risk_event_volume'`);
  });

  it("status includes user websocket activity telemetry when available", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('user_order_stream_activity', 1, '{"wsEventsReceived":18,"wsEventsReceivedPerSec":0.3,"wsFills":5,"pollingFills":1,"wsLatencyMs":{"count":5,"avgMs":230,"minMs":120,"p50Ms":220,"p95Ms":400,"maxMs":420},"orphanBufferSize":2,"dedupeHits":3,"reconnectCount":1,"wsEventGapDetected":1,"windowStartMs":${Date.now() - 60_000}}', '${new Date().toISOString()}')
    `);

    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });

    expect(json(res).data.userOrderStreamActivity).toEqual({
      wsEventsReceived: 18,
      wsEventsReceivedPerSec: 0.3,
      wsFills: 5,
      pollingFills: 1,
      wsLatencyMs: {
        count: 5,
        avgMs: 230,
        minMs: 120,
        p50Ms: 220,
        p95Ms: 400,
        maxMs: 420,
      },
      orphanBufferSize: 2,
      dedupeHits: 3,
      reconnectCount: 1,
      wsEventGapDetected: 1,
      windowStartMs: expect.any(Number),
    });

    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'user_order_stream_activity'`);
  });

  it("status includes market data stream telemetry when available", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('market_data_stream_activity', 1, '{"wsEnabled":true,"windowStartMs":${Date.now() - 60_000},"wsEventsReceived":120,"wsEventsReceivedPerSec":2,"wsUpdatesApplied":95,"trackedTokenCount":320,"shardCount":1,"reconnectCount":2,"wsEventGapDetected":1,"wsLatencyMs":{"count":8,"avgMs":180,"minMs":75,"p50Ms":160,"p95Ms":290,"maxMs":320},"staleTokenCount":14,"fallbackPollCount":14}', '${new Date().toISOString()}')
    `);

    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });

    expect(json(res).data.marketDataStreamActivity).toEqual({
      wsEnabled: true,
      windowStartMs: expect.any(Number),
      wsEventsReceived: 120,
      wsEventsReceivedPerSec: 2,
      wsUpdatesApplied: 95,
      trackedTokenCount: 320,
      shardCount: 1,
      reconnectCount: 2,
      wsEventGapDetected: 1,
      wsLatencyMs: {
        count: 8,
        avgMs: 180,
        minMs: 75,
        p50Ms: 160,
        p95Ms: 290,
        maxMs: 320,
      },
      staleTokenCount: 14,
      fallbackPollCount: 14,
    });

    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'market_data_stream_activity'`);
  });
});

// ─── Families ───────────────────────────────────────────────────────

describe("families", () => {
  it("GET /families returns list with state", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.meta.scope).toBe("all");
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].familyId).toBe("fam-1");
    expect(body.data.items[0].state).toBeDefined();
    expect(body.data.items[0].state.runtimeMode).toBe("active");
  });

  it("GET /families includes caps from family_rules", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items[0].caps).toEqual({
      maxOpenValueUsdc: 50,
      maxActiveMarkets: 5,
      maxDustPositions: 3,
    });
  });

  it("GET /families includes per-family execution telemetry for recent fills", async () => {
    const now = new Date().toISOString();
    try {
      conn.db.exec(`
        INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, liquidity_role, fee, filled_at, reconciled)
        VALUES ('fill-family-maker-24h', 'ord-1', 'tok-1', 'fam-1', 'buy', 0.5, 20, 10, 'maker', 0, '${now}', 0);
      `);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/families",
        headers: authHeaders(),
      });
      const body = json(res);
      expect(body.data.items[0].executionTelemetry24h.totalFills).toBe(1);
      expect(body.data.items[0].executionTelemetry24h.makerFills).toBe(1);
      expect(body.data.items[0].executionTelemetry24h.explicitFeesUsdc).toBe(0);
    } finally {
      conn.db.exec("DELETE FROM fills WHERE fill_id = 'fill-family-maker-24h'");
    }
  });

  it("GET /families includes derived liveness", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items[0].liveness).toBe("active");
  });

  it("GET /families/:id returns detail", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families/fam-1",
      headers: authHeaders(),
    });
    expect(json(res).data.familyId).toBe("fam-1");
    expect(json(res).data.executionTelemetry24h).toBeDefined();
    expect(json(res).data.liveness).toBe("active");
  });

  it("GET /families/:id returns 404 with error object", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families/no-such",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FAMILY_NOT_FOUND");
  });

  it("GET /families/:id/positions returns positions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families/fam-1/positions",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /families/:id/orders returns orders", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families/fam-1/orders",
      headers: authHeaders(),
    });
    expect(json(res).data.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /families?scope=profile falls back to scope=all on monolithic DB", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families?scope=profile",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.meta.scope).toBe("all");
    expect(body.data.meta.profile).toBeNull();
    expect(body.data.items).toHaveLength(1);
  });

  it("GET /families/:id returns deployment=null on monolithic DB", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families/fam-1",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(res.statusCode).toBe(200);
    expect(body.data.deployment).toBeNull();
  });
});

// ─── Positions with filters ─────────────────────────────────────────

describe("positions", () => {
  it("GET /positions returns all statuses by default", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(2); // open + dust (only 2 seeded)
    expect(body.data.totalCount).toBe(2);
    expect(body.data.nextCursor).toBeNull(); // no more pages
  });

  it("GET /positions?family_id= filters by family", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?family_id=fam-1",
      headers: authHeaders(),
    });
    expect(json(res).data.items.length).toBe(2);
  });

  it("GET /positions?dust=true returns only dust positions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?dust=true",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items.length).toBe(1);
    expect(body.data.items[0].status).toBe("dust");
  });

  it("GET /positions?status=open returns only open", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?status=open",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items.length).toBe(1);
    expect(body.data.items[0].status).toBe("open");
  });

  it("GET /positions/:id returns single position", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions/pos-1",
      headers: authHeaders(),
    });
    expect(json(res).data.positionId).toBe("pos-1");
  });

  it("GET /positions/:id returns 404 for unknown", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions/no-such",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /positions enriches with resolution status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions",
      headers: authHeaders(),
    });
    const body = json(res);
    const pos = body.data.items.find((p: any) => p.tokenId === "tok-1");
    expect(pos.resolution).toBe("YES");
    expect(pos.resolutionStatus).toBe("detected");

    // tok-2 has no market row, so no resolution info
    const dust = body.data.items.find((p: any) => p.tokenId === "tok-2");
    expect(dust.resolution).toBeNull();
    expect(dust.resolutionStatus).toBeNull();
  });
});

// ─── Orders with filters ────────────────────────────────────────────

describe("orders", () => {
  it("GET /orders returns paginated items with nextCursor", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders?limit=10",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBeGreaterThanOrEqual(1);
    // nextCursor is null when fewer results than limit
    expect(body.data.nextCursor).toBeNull();
  });

  it("GET /orders?status=open filters by status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders?status=open",
      headers: authHeaders(),
    });
    const items = json(res).data.items;
    expect(items.length).toBe(1);
    expect(items[0].status).toBe("open");
  });

  it("GET /orders?family_id= filters by family", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders?family_id=fam-1",
      headers: authHeaders(),
    });
    expect(json(res).data.items.length).toBe(2);
  });

  it("GET /orders/:id returns single order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders/ord-1",
      headers: authHeaders(),
    });
    expect(json(res).data.orderId).toBe("ord-1");
  });
});

// ─── Fills with filters ─────────────────────────────────────────────

describe("fills", () => {
  it("GET /fills returns paginated items with nextCursor", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(body.data.items[0].explicitFeeUsdc).toBe(0.01);
    expect(body.data.items[0].liquidityRole).toBe("unknown");
  });

  it("GET /fills?family_id= filters by family", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills?family_id=fam-1",
      headers: authHeaders(),
    });
    expect(json(res).data.items.length).toBe(1);
  });

  it("GET /fills?since= filters by date", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills?since=2026-03-15T00:00:00Z",
      headers: authHeaders(),
    });
    expect(json(res).data.items.length).toBe(0);
  });
});

// ─── Market metadata enrichment ─────────────────────────────────────

describe("market metadata enrichment", () => {
  it("GET /orders enriches items with market metadata when market exists", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders?status=open",
      headers: authHeaders(),
    });
    const item = json(res).data.items[0];
    // tok-1 has a market row
    expect(item.slug).toBe("will-btc-hit-100k");
    expect(item.question).toBe("Will BTC hit 100k?");
    expect(item.outcome).toBe("Yes");
    expect(item.conditionId).toBe("cond-1");
    expect(item.endDate).toBe("2026-04-15T00:00:00Z");
  });

  it("GET /orders/:id enriches single order", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders/ord-1",
      headers: authHeaders(),
    });
    const item = json(res).data;
    expect(item.slug).toBe("will-btc-hit-100k");
    expect(item.question).toBe("Will BTC hit 100k?");
  });

  it("GET /fills enriches items with market metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills",
      headers: authHeaders(),
    });
    const item = json(res).data.items.find((f: any) => f.tokenId === "tok-1");
    expect(item.slug).toBe("will-btc-hit-100k");
    expect(item.question).toBe("Will BTC hit 100k?");
    expect(item.outcome).toBe("Yes");
    expect(item.conditionId).toBe("cond-1");
    expect(item.endDate).toBe("2026-04-15T00:00:00Z");
  });

  it("GET /positions enriches items with market metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions",
      headers: authHeaders(),
    });
    const enriched = json(res).data.items.find((p: any) => p.tokenId === "tok-1");
    expect(enriched.slug).toBe("will-btc-hit-100k");
    expect(enriched.question).toBe("Will BTC hit 100k?");
    expect(enriched.outcome).toBe("Yes");
    expect(enriched.conditionId).toBe("cond-1");
    expect(enriched.endDate).toBe("2026-04-15T00:00:00Z");
  });

  it("GET /positions/:id enriches single position", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions/pos-1",
      headers: authHeaders(),
    });
    const item = json(res).data;
    expect(item.slug).toBe("will-btc-hit-100k");
  });

  it("returns null metadata when no market row exists for token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions",
      headers: authHeaders(),
    });
    // tok-2 (pos-dust) has no market row
    const dust = json(res).data.items.find((p: any) => p.tokenId === "tok-2");
    expect(dust.slug).toBeNull();
    expect(dust.question).toBeNull();
    expect(dust.outcome).toBeNull();
    expect(dust.conditionId).toBeNull();
    expect(dust.endDate).toBeNull();
  });
});

// ─── Metrics ────────────────────────────────────────────────────────

describe("metrics", () => {
  it("GET /metrics returns aggregate metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.positions).toBeDefined();
    expect(body.data.orders).toBeDefined();
    expect(body.data.fills).toBeDefined();
    expect(body.data.fills.explicitFeesUsdc).toBeDefined();
    expect(body.data.fills.makerCount).toBeDefined();
    expect(body.data.fills.takerCount).toBeDefined();
  });

  it("GET /metrics/families returns per-family metrics", async () => {
    const fillId = "fill-family-metrics-24h";
    conn.db.exec(`
      INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, liquidity_role, fee, filled_at, reconciled)
      VALUES ('${fillId}', 'ord-2', 'tok-1', 'fam-1', 'sell', 0.55, 20, 11, 'taker', 0.12, '${new Date().toISOString()}', 0);
    `);

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metrics/families",
        headers: authHeaders(),
      });
      const body = json(res);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].familyId).toBe("fam-1");
      expect(body.data[0].familyKey).toBe("test-family");
      expect(body.data[0].executionTelemetry24h.totalFills).toBe(1);
      expect(body.data[0].executionTelemetry24h.takerFills).toBe(1);
      expect(body.data[0].executionTelemetry24h.explicitFeesUsdc).toBe(0.12);
    } finally {
      conn.db.prepare("DELETE FROM fills WHERE fill_id = ?").run(fillId);
    }
  });
});

// ─── Operator actions ───────────────────────────────────────────────

describe("operator actions", () => {
  it("POST /actions/pause inserts command", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/pause",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { reason: "test pause" },
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("enqueued");

    const row = conn.db
      .prepare("SELECT * FROM operator_commands WHERE id = ?")
      .get(body.data.commandId) as Record<string, unknown>;
    expect(row.action).toBe("pause");
    expect(row.status).toBe("pending");
    expect(row.reason).toBe("test pause");
    // Bearer API key → initiator is "api_key"
    expect(row.initiator).toBe("api_key");
  });

  it("POST /actions/resume inserts command", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/resume",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });
    expect(json(res).ok).toBe(true);
  });

  it("POST /actions/family/:id/quarantine validates family exists", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/no-such/quarantine",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /actions/family/:id/quarantine inserts command for valid family", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-1/quarantine",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { reason: "risk concern" },
    });
    const body = json(res);
    expect(body.ok).toBe(true);

    const row = conn.db
      .prepare("SELECT * FROM operator_commands WHERE id = ?")
      .get(body.data.commandId) as Record<string, unknown>;
    expect(row.action).toBe("family_quarantine");
    expect(row.target_id).toBe("fam-1");
    expect(row.initiator).toBe("api_key");
  });

  it("POST /actions/family/:id/reduce-only works", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-1/reduce-only",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });
    expect(json(res).ok).toBe(true);
  });

  it("POST /actions/family/:id/activate works", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-1/activate",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });
    expect(json(res).ok).toBe(true);
  });
});

// ─── Response envelope ──────────────────────────────────────────────

describe("response envelope", () => {
  it("success responses have ok/data/error/ts fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.error).toBeNull();
    expect(body.ts).toBeDefined();
  });

  it("error responses have error as {code, message} object", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions/nonexistent",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe("string");
    expect(typeof body.error.message).toBe("string");
  });
});

// ─── Risk Events ────────────────────────────────────────────

describe("GET /risk-events", () => {
  it("returns normalized risk events with summary and severity", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, family_id, payload, created_at)
      VALUES ('family_quarantined', 'fam-1', '{"reason":"max exposure"}', '2026-03-14T10:00:00Z')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBeGreaterThanOrEqual(1);

    const first = body.data.items[0];
    expect(first.summary).toContain("quarantined");
    expect(first.severity).toBe("critical");
    expect(first).not.toHaveProperty("payload");
    expect(first.createdAt).toBeDefined();
    expect(body.data.nextCursor).toBeDefined();
  });

  it("supports cursor pagination via integer id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events?limit=1",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items).toHaveLength(1);
    if (body.data.nextCursor) {
      const res2 = await app.inject({
        method: "GET",
        url: `/api/v1/risk-events?cursor=${body.data.nextCursor}`,
        headers: authHeaders(),
      });
      expect(json(res2).ok).toBe(true);
    }
  });

  it("filters by family_id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events?family_id=fam-1",
      headers: authHeaders(),
    });
    const items = json(res).data.items;
    for (const item of items) {
      expect(item.familyId).toBe("fam-1");
    }
  });

  it("filters by event_type", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events?event_type=family_quarantined",
      headers: authHeaders(),
    });
    const items = json(res).data.items;
    for (const item of items) {
      expect(item.eventType).toBe("family_quarantined");
    }
  });

  it("normalizes signal_rejected events", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, family_id, payload, created_at)
      VALUES ('signal_rejected', 'fam-1', '{"reasonCode":"max_dust_positions","rawReason":"dust 3 >= max 2"}', '2026-03-22T12:00:00Z')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items[0].severity).toBe("info");
    expect(body.data.items[0].summary).toContain("dust 3 >= max 2");
  });

  it("normalizes family_reduce_only events", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, family_id, payload, created_at)
      VALUES ('family_reduce_only', 'fam-1', '{"reason":"operator command"}', '2026-03-22T12:00:00Z')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items[0].severity).toBe("warning");
    expect(body.data.items[0].summary).toContain("reduce-only");
  });

  it("normalizes system family demotion events with previous state", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, family_id, payload, created_at)
      VALUES (
        'family_reduce_only',
        'fam-1',
        '{"reason":"Auto-demotion: execution canary breach","source":"system","previousState":"scaled","newState":"reduce-only"}',
        '2026-03-22T12:00:01Z'
      )
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items[0].summary).toContain("auto-demoted");
    expect(body.data.items[0].summary).toContain("scaled -> reduce-only");
  });

  it("normalizes family_activated events", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, family_id, payload, created_at)
      VALUES ('family_activated', 'fam-1', '{"reason":"resumed"}', '2026-03-22T12:00:00Z')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items[0].severity).toBe("info");
    expect(body.data.items[0].summary).toContain("activated");
  });

  it("normalizes reconciliation_drift with details (plural, not detail)", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, family_id, payload, created_at)
      VALUES ('reconciliation_drift', NULL, '{"details":"phantom order detected","severity":"warn"}', '2026-03-22T13:00:00Z')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events",
      headers: authHeaders(),
    });
    const body = json(res);
    const drift = body.data.items.find((e: any) => e.eventType === "reconciliation_drift");
    expect(drift.summary).toContain("phantom order detected");
    expect(drift.summary).not.toBe("Reconciliation drift: detected"); // regression: p.detail vs p.details
  });
});

// ─── PnL Series ─────────────────────────────────────────────────────

describe("GET /metrics/pnl-series", () => {
  it("returns empty series when no pnl_ledger rows exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/pnl-series",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toEqual([]);
  });

  it("prepends $0 baseline when no pre-window PnL exists", async () => {
    conn.db.exec(`
      DELETE FROM pnl_ledger;
      DELETE FROM fills WHERE fill_id LIKE 'f-%';
      INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee, filled_at, reconciled)
      VALUES ('f-baseline', 'ord-1', 'tok-1', 'fam-1', 'sell', 0.6, 10, 6, 0.01, '${new Date().toISOString()}', 0);
      INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
      VALUES ('f-baseline', 'pos-1', 'fam-1', 5.0, '${new Date().toISOString()}')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/pnl-series?days=14",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);

    const items = body.data.items;
    expect(items.length).toBe(2);
    expect(items[0].realizedPnl).toBe(0);
    expect(items[1].realizedPnl).toBeCloseTo(5.0);
    const dataDate = new Date(items[1].date);
    const baselineDate = new Date(items[0].date);
    expect(dataDate.getTime() - baselineDate.getTime()).toBe(86400000);

    conn.db.exec(`DELETE FROM pnl_ledger WHERE fill_id = 'f-baseline'`);
    conn.db.exec(`DELETE FROM fills WHERE fill_id = 'f-baseline'`);
  });

  it("returns cumulative realized PnL by day", async () => {
    // Use relative dates so the test doesn't drift out of the 14-day query window
    const day1 = new Date();
    day1.setUTCDate(day1.getUTCDate() - 3);
    const day2 = new Date();
    day2.setUTCDate(day2.getUTCDate() - 2);
    const d1Morning = day1.toISOString().slice(0, 10) + "T10:00:00Z";
    const d1Afternoon = day1.toISOString().slice(0, 10) + "T14:00:00Z";
    const d2Morning = day2.toISOString().slice(0, 10) + "T09:00:00Z";
    const d1Date = day1.toISOString().slice(0, 10);
    const d2Date = day2.toISOString().slice(0, 10);

    conn.db.exec(`
      INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee, filled_at, reconciled)
      VALUES
        ('f-1', 'ord-1', 'tok-1', 'fam-1', 'sell', 0.6, 10, 6, 0.01, '${d1Morning}', 0),
        ('f-2', 'ord-1', 'tok-1', 'fam-1', 'sell', 0.6, 10, 6, 0.01, '${d1Afternoon}', 0),
        ('f-3', 'ord-1', 'tok-1', 'fam-1', 'sell', 0.6, 10, 6, 0.01, '${d2Morning}', 0);

      INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
      VALUES
        ('f-1', 'pos-1', 'fam-1', 10.5, '${d1Morning}'),
        ('f-2', 'pos-1', 'fam-1', -3.2, '${d1Afternoon}'),
        ('f-3', 'pos-1', 'fam-1', 5.0,  '${d2Morning}')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/pnl-series?days=14",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);

    const items = body.data.items;
    // 3 items: baseline $0 point prepended + 2 data days
    expect(items.length).toBe(3);
    expect(items[0].realizedPnl).toBe(0); // baseline
    expect(items[1].date).toBe(d1Date);
    expect(items[1].realizedPnl).toBeCloseTo(7.3); // 10.5 + (-3.2) cumulative
    expect(items[2].date).toBe(d2Date);
    expect(items[2].realizedPnl).toBeCloseTo(12.3); // 7.3 + 5.0 cumulative
  });

  it("respects days parameter", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/pnl-series?days=1",
      headers: authHeaders(),
    });
    expect(json(res).ok).toBe(true);
  });
});

// ─── Promote proposal ───────────────────────────────────────────────

describe("POST /actions/family/:familyId/promote", () => {
  it("approves a pending proposal and enqueues a command", async () => {
    const now = new Date().toISOString();
    conn.db.exec(`
      INSERT INTO family_validation_scorecards
        (scorecard_id, family_id, profile, evidence_status, evidence_score,
         recurrence_score, recycle_score, live_viability_score, toxicity_penalty,
         trade_count, market_count, realized_pnl, tail_adjusted_pnl,
         both_sided_eligible, heavy_campaign_eligible, active_window_edge_score,
         summary_json, validated_at)
      VALUES (
        'sc-promote-ok', 'fam-1', 'simulation', 'confirmed', 0.9,
        0.7, 0.7, 0.6, 0.1,
        30, 8, 10, 5,
        0, 0, NULL,
        '{"executionTelemetry24h":{"totalFills":12,"volumeUsdc":24,"makerFills":12,"takerFills":0,"unknownFills":0,"makerRatio":1,"takerRatio":0,"explicitFeesUsdc":0,"feeLeakageRatio":0,"lastFillAt":"${now}"},"executionCanary24h":{"required":true,"eligible":true,"minTotalFills":10,"blockers":[]}}',
        '${now}'
      );
      INSERT INTO family_validation_latest (family_id, profile, scorecard_id)
      VALUES ('fam-1', 'simulation', 'sc-promote-ok')
      ON CONFLICT(family_id, profile) DO UPDATE SET scorecard_id = excluded.scorecard_id;
    `);

    // Seed a pending proposal for fam-1
    conn.db.exec(`
      INSERT OR IGNORE INTO promotion_proposals
        (family_id, current_state, proposed_state, reason, scores_snapshot, status)
      VALUES ('fam-1', 'probe-only', 'scaled', 'evidence passed', '{}', 'pending')
    `);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-1/promote",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: JSON.stringify({ reason: "manual approve" }),
    });

    const body = json(res);
    expect(res.statusCode).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.commandId).toBeDefined();
    expect(body.data.proposalId).toBeDefined();

    // Verify proposal status changed
    const proposal = conn.db
      .prepare(
        "SELECT status FROM promotion_proposals WHERE family_id = 'fam-1' AND status = 'approved'",
      )
      .get() as { status: string } | undefined;
    expect(proposal?.status).toBe("approved");

    // Verify command was enqueued
    const cmd = conn.db
      .prepare("SELECT action, target_id FROM operator_commands WHERE id = ?")
      .get(body.data.commandId) as { action: string; target_id: string };
    expect(cmd.action).toBe("family_promote_scaled");
    expect(cmd.target_id).toBe("fam-1");
  });

  it("blocks live-lite promote when execution canary fails", async () => {
    const now = new Date().toISOString();
    conn.db.exec(`
      INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
      VALUES ('fam-canary-block', 'canary-block', 'crypto', 'standard', 'daily', 'daily', 'v1');
      INSERT INTO family_validation_scorecards
        (scorecard_id, family_id, profile, evidence_status, evidence_score,
         recurrence_score, recycle_score, live_viability_score, toxicity_penalty,
         trade_count, market_count, realized_pnl, tail_adjusted_pnl,
         both_sided_eligible, heavy_campaign_eligible, active_window_edge_score,
         summary_json, validated_at)
      VALUES (
        'sc-promote-block', 'fam-canary-block', 'live-lite', 'confirmed', 0.7,
        0.6, 0.6, 0.5, 0.1,
        25, 7, 4, 3,
        0, 0, NULL,
        '{"executionTelemetry24h":{"totalFills":12,"volumeUsdc":20,"makerFills":10,"takerFills":2,"unknownFills":0,"makerRatio":0.8333,"takerRatio":0.1667,"explicitFeesUsdc":0.12,"feeLeakageRatio":0.006,"lastFillAt":"${now}"},"executionCanary24h":{"required":true,"eligible":false,"minTotalFills":10,"blockers":[{"metric":"Taker fills","current":2,"required":0,"passed":false},{"metric":"Explicit fees (USDC)","current":0.12,"required":0,"passed":false}]}}',
        '${now}'
      );
      INSERT INTO family_validation_latest (family_id, profile, scorecard_id)
      VALUES ('fam-canary-block', 'live-lite', 'sc-promote-block')
      ON CONFLICT(family_id, profile) DO UPDATE SET scorecard_id = excluded.scorecard_id;
      INSERT INTO promotion_proposals
        (family_id, profile, current_state, proposed_state, reason, scores_snapshot, status)
      VALUES ('fam-canary-block', 'live-lite', 'probe-only', 'scaled', 'execution pending', '{}', 'pending');
    `);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-canary-block/promote",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe("PROMOTION_BLOCKED_BY_EXECUTION_CANARY");
  });

  it("allows paper promote while execution canary is still warning-only", async () => {
    const now = new Date().toISOString();
    conn.db.exec(`
      INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
      VALUES ('fam-canary-paper', 'canary-paper', 'crypto', 'standard', 'daily', 'daily', 'v1');
      INSERT INTO family_validation_scorecards
        (scorecard_id, family_id, profile, evidence_status, evidence_score,
         recurrence_score, recycle_score, live_viability_score, toxicity_penalty,
         trade_count, market_count, realized_pnl, tail_adjusted_pnl,
         both_sided_eligible, heavy_campaign_eligible, active_window_edge_score,
         summary_json, validated_at)
      VALUES (
        'sc-promote-paper', 'fam-canary-paper', 'paper', 'confirmed', 0.7,
        0.6, 0.6, 0.5, 0.1,
        25, 7, 4, 3,
        0, 0, NULL,
        '{"executionTelemetry24h":{"totalFills":12,"volumeUsdc":20,"makerFills":0,"takerFills":0,"unknownFills":12,"makerRatio":0,"takerRatio":0,"explicitFeesUsdc":0,"feeLeakageRatio":0,"lastFillAt":"${now}"},"executionCanary24h":{"required":true,"eligible":false,"minTotalFills":10,"blockers":[{"metric":"Maker ratio %","current":0,"required":100,"passed":false},{"metric":"Unknown fills","current":12,"required":0,"passed":false}]}}',
        '${now}'
      );
      INSERT INTO family_validation_latest (family_id, profile, scorecard_id)
      VALUES ('fam-canary-paper', 'paper', 'sc-promote-paper')
      ON CONFLICT(family_id, profile) DO UPDATE SET scorecard_id = excluded.scorecard_id;
      INSERT INTO promotion_proposals
        (family_id, profile, current_state, proposed_state, reason, scores_snapshot, status)
      VALUES ('fam-canary-paper', 'paper', 'probe-only', 'scaled', 'execution pending', '{}', 'pending');
    `);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-canary-paper/promote",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    expect(json(res).data.commandId).toBeTypeOf("number");
    const proposal = conn.db
      .prepare(
        "SELECT status FROM promotion_proposals WHERE family_id = 'fam-canary-paper' AND profile = 'paper'",
      )
      .get() as { status: string } | undefined;
    expect(proposal?.status).toBe("approved");
  });
});
