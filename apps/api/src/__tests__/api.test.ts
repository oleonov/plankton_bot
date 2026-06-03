import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

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
    ...overrides,
  };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");

  const db = conn.db;
  db.exec(`
    INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc,
      current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES ('pos-1', 'tok-1', 'buy', 100, 0.5, 50, 60, 0, 'open', '2026-03-14T00:00:00Z', '2026-03-14T01:00:00Z');

    INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc,
      current_value_usdc, realized_pnl, status, opened_at, updated_at)
    VALUES ('pos-dust', 'tok-2', 'buy', 1, 0.02, 0.02, 0.01, 0, 'dust', '2026-03-14T00:00:00Z', '2026-03-14T01:00:00Z');

    INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc,
      status, exchange_order_id, bot_run_id, created_at, updated_at)
    VALUES ('ord-1', 'plk_abc', 'tok-1', 'buy', 'GTC', 0.5, 100, 50, 'open', 'ex-1', 'run-1',
      '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

    INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc,
      status, exchange_order_id, bot_run_id, created_at, updated_at)
    VALUES ('ord-2', 'plk_def', 'tok-1', 'sell', 'GTC', 0.6, 50, 30, 'filled', 'ex-2', 'run-1',
      '2026-03-14T01:00:00Z', '2026-03-14T01:00:00Z');

    INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, fee, filled_at, reconciled)
    VALUES ('fill-1', 'ord-1', 'tok-1', 'buy', 0.5, 100, 50, 0.01, '2026-03-14T00:00:00Z', 0);

    INSERT INTO bot_runs (run_id, mode, started_at)
    VALUES ('run-1', 'simulation', '2026-03-14T00:00:00Z');

    INSERT INTO markets (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk, end_date, created_at, updated_at)
    VALUES ('tok-1', 'cond-1', 'will-btc-hit-100k', 'Will BTC hit 100k?', 'Yes', 1, 0.01, 0, '2026-04-15T00:00:00Z', '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

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

  it("fail-closed when KRABS_API_KEY is not configured", async () => {
    const noKeyApp = await buildServer({
      config: testConfig({ krabsApiKey: undefined }),
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
    expect(typeof body.data.openConditionCount).toBe("number");
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
      INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size, size_usdc,
        status, exchange_order_id, bot_run_id, created_at, updated_at)
      VALUES
        ('ord-last-min', 'plk_last_min', 'tok-1', 'buy', 'GTC', 0.4, 10, 4, 'filled', 'ex-last-min', 'run-1',
          '${now}', '${now}'),
        ('ord-old', 'plk_old', 'tok-1', 'buy', 'GTC', 0.4, 10, 4, 'filled', 'ex-old', 'run-1',
          '${older}', '${older}');

      INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc,
        current_value_usdc, realized_pnl, status, opened_at, updated_at)
      VALUES
        ('pos-last-min', 'tok-3', 'buy', 10, 0.4, 4, 4, 0, 'open', '${now}', '${now}'),
        ('pos-old', 'tok-4', 'buy', 10, 0.4, 4, 4, 0, 'open', '${older}', '${older}');
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
    // bot_runs has mode='simulation' — runtimeMode is derived from bot_runs.mode
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

  it("orders include cancellation reason metadata", async () => {
    conn.db
      .prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ? WHERE order_id = 'ord-2'")
      .run("stale_entry_ttl");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/orders?status=cancelled",
      headers: authHeaders(),
    });
    const body = json(res);

    expect(body.ok).toBe(true);
    const updatedOrder = body.data.items.find(
      (item: { orderId: string }) => item.orderId === "ord-2",
    );
    expect(updatedOrder?.cancelReason).toBe("stale_entry_ttl");
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
        INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, liquidity_role, fee, filled_at, reconciled)
        VALUES ('fill-maker-24h', 'ord-1', 'tok-1', 'buy', 0.5, 20, 10, 'maker', 0, '${now}', 0);

        INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, liquidity_role, fee, filled_at, reconciled)
        VALUES ('fill-taker-24h', 'ord-2', 'tok-1', 'sell', 0.5, 10, 5, 'taker', 0.25, '${now}', 0);
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

  it("returns EXITS_ONLY when only exit approvals exist alongside rejected signals", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('signal_activity', 1, '{"produced":12,"approved":1,"rejected":11,"entryApproved":0,"exitApproved":1,"windowStartMs":${Date.now()}}', '${new Date().toISOString()}')
    `);
    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });
    expect(json(res).data.tradingState).toBe("EXITS_ONLY");
    expect(json(res).data.signalActivity.topBlockingLayer).toBeNull();
    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'signal_activity'`);
  });

  it("status includes signal conversion telemetry when available", async () => {
    conn.db.exec(`
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES
        ('signal_activity', 1, '{"produced":10,"approved":3,"rejected":7,"entryApproved":2,"exitApproved":1,"windowStartMs":${Date.now()}}', '${new Date().toISOString()}'),
        ('scanner_activity', 1, '{"candidatesConsidered":20,"blockedByResolutionBuffer":2,"blockedByWindow":1,"scanPrimeSkippedByPolicy":11,"windowStartMs":${Date.now()}}', '${new Date().toISOString()}'),
        ('signal_conversion_activity', 1, '{"converted":2,"conversionSkippedByReason":{"token-cooling-down":5},"cacheStatusByStatus":{"refresh-budget-exhausted":4,"fresh-cache":2},"exchangeAccepted":1,"exchangeRejectedByCode":{"UNKNOWN":2},"exchangeRejectedByReason":{"rejection_min_size":2},"fills":1,"fillLatencyMs":{"count":1,"avgMs":1200,"minMs":1200,"p50Ms":1200,"p95Ms":1200,"maxMs":1200},"cooldownBypassByReason":{"price-moved":3},"hotQuoteRefreshes":7,"hotLaneActionsByType":{"entry-reprice-cancel":2},"hotLaneStatesByState":{"quote-active":3,"cooling":1},"queueJumpAccepted":1,"queueJumpFills":1,"windowStartMs":${Date.now()}}', '${new Date().toISOString()}')
    `);

    const res = await app.inject({ method: "GET", url: "/api/v1/status", headers: authHeaders() });
    const signalActivity = json(res).data.signalActivity;

    expect(signalActivity.signalsConvertedLast10m).toBe(2);
    expect(signalActivity.conversionSkippedLast10mByReason).toEqual({
      "token-cooling-down": 5,
    });
    expect(signalActivity.cacheStatusLast10mByStatus).toEqual({
      "refresh-budget-exhausted": 4,
      "fresh-cache": 2,
    });
    expect(signalActivity.exchangeAcceptedLast10m).toBe(1);
    expect(signalActivity.exchangeRejectedLast10mByCode).toEqual({ UNKNOWN: 2 });
    expect(signalActivity.exchangeRejectedLast10mByReason).toEqual({ rejection_min_size: 2 });
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
    expect(signalActivity.scanPrimeSkippedByPolicyLast10m).toBe(11);

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
      VALUES ('market_data_stream_activity', 1, '{"wsEnabled":true,"windowStartMs":${Date.now() - 60_000},"wsEventsReceived":120,"wsEventsReceivedPerSec":2,"wsUpdatesApplied":95,"trackedTokenCount":320,"shardCount":1,"reconnectCount":2,"wsEventGapDetected":1,"wsLatencyMs":{"count":8,"avgMs":180,"minMs":75,"p50Ms":160,"p95Ms":290,"maxMs":320},"trackedRoleCounts":{"executionCritical":4,"entryCandidate":316,"legacy":0,"unassigned":0},"trackedBookSourceCounts":{"unknown":14,"clob":290,"gamma":12,"gammaFallback":4,"other":0},"staleTokenCount":14,"silentTrackedTokenCount":27,"fallbackPollCount":14,"fallbackReasonCounts":{"pendingGap":2,"missingCache":3,"unknownSourceRefresh":5,"knownSourceRefresh":4,"forceFullPoll":0,"streamUnavailable":0,"featureFreshness":0},"fallbackRoleCounts":{"executionCritical":1,"entryCandidate":13,"legacy":0,"unassigned":0},"trackedDiffCounts":{"added":7,"removed":3,"unchanged":313},"cachedTrackedTokenCountAtPollStart":317,"pricingHitCountLastPoll":11,"gammaFallbackCount":4,"gammaFallbackTrackedTokenCount":4,"gammaFallbackExecutionCriticalCount":1,"gammaFallbackEntryCandidateCount":3}', '${new Date().toISOString()}')
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
      trackedRoleCounts: {
        executionCritical: 4,
        entryCandidate: 316,
        legacy: 0,
        unassigned: 0,
      },
      trackedBookSourceCounts: {
        unknown: 14,
        clob: 290,
        gamma: 12,
        gammaFallback: 4,
        other: 0,
      },
      staleTokenCount: 14,
      silentTrackedTokenCount: 27,
      fallbackPollCount: 14,
      fallbackReasonCounts: {
        pendingGap: 2,
        missingCache: 3,
        unknownSourceRefresh: 5,
        knownSourceRefresh: 4,
        forceFullPoll: 0,
        streamUnavailable: 0,
        featureFreshness: 0,
      },
      fallbackRoleCounts: {
        executionCritical: 1,
        entryCandidate: 13,
        legacy: 0,
        unassigned: 0,
      },
      trackedDiffCounts: {
        added: 7,
        removed: 3,
        unchanged: 313,
      },
      cachedTrackedTokenCountAtPollStart: 317,
      pricingHitCountLastPoll: 11,
      gammaFallbackCount: 4,
      gammaFallbackTrackedTokenCount: 4,
      gammaFallbackExecutionCriticalCount: 1,
      gammaFallbackEntryCandidateCount: 3,
    });

    conn.db.exec(`DELETE FROM runtime_metrics WHERE metric_name = 'market_data_stream_activity'`);
  });

  it("GET /metrics/coverage exposes WS coverage against active/tradable universe", async () => {
    conn.db.exec(`
      INSERT OR IGNORE INTO markets (token_id, condition_id, slug, question, outcome, active, tradable, tick_size, neg_risk, end_date, created_at, updated_at)
      VALUES
        ('coverage-tok-1', 'coverage-cond-1', 'coverage-1', 'Coverage 1?', 'Yes', 1, 1, 0.01, 0, '2026-06-01T00:00:00Z', '2026-05-18T00:00:00Z', '2026-05-18T00:00:00Z'),
        ('coverage-tok-2', 'coverage-cond-2', 'coverage-2', 'Coverage 2?', 'Yes', 1, 1, 0.01, 0, '2026-06-01T00:00:00Z', '2026-05-18T00:00:00Z', '2026-05-18T00:00:00Z');
      DELETE FROM runtime_metrics WHERE metric_name = 'market_data_stream_activity';
      DELETE FROM runtime_metrics WHERE metric_name IN ('algo_decision_latency', 'r23_cache_activity', 'runtime_diagnostics', 'http_error_class', 'signal_path_activity', 'exit_order_ttl_cancel_total', 'exit_order_ttl_cancel_near_resolution_total', 'exit_anchor_mode_total', 'exit_ttl_resolved_total', 'exit_reprice_suppressed_threshold_total', 'exit_chain_cap_resolved_total');
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('market_data_stream_activity', 1, '{"trackedTokenCount":2,"wsEventsReceivedPerSec":7.5,"rawWsRecords":120,"rawWsRecordsPerSec":2,"parsedUpdates":90,"parsedUpdatesPerSec":1.5,"emittedUpdates":15,"emittedUpdatesPerSec":0.25,"noopUpdates":30,"noopUpdatesPerSec":0.5,"suppressedTradingNoopCountTotal":75,"suppressedTradingNoopPerSec":1.25,"suppressedTradingNoopByReason":{"topOfBookOnly":70,"bookOnly":1,"lastTradeOnly":2,"tickSizeOnly":0,"mixedNonCritical":2},"hubFilterChecked":450,"hubFilterCheckedPerSec":7.5,"hubFilterPassed":90,"hubFilterPassedPerSec":1.5,"shardCount":2,"wsHeartbeat":{"pingSent":4,"pongReceived":3,"timeoutFired":1,"timeoutSuppressedByInbound":2,"workerEventLoopLagMaxMs":11,"byShard":{"0":{"pingSent":2,"pongReceived":2,"timeoutFired":0,"timeoutSuppressedByInbound":1,"lastPingSentAt":1779292800000,"lastPongAt":1779292800010,"lastInboundMessageAt":1779292800010,"workerEventLoopLagMaxMs":5}}},"v4AdmissionTelemetry":{"evaluatedTotal":10,"admitCountTotal":2,"rejectCountTotal":8,"admitRate":0.2,"admitCountByCategory":{"crypto-btc":2},"seenCountByCategory":{"crypto-btc":3},"admitRateByCategory":{"crypto-btc":0.6666666667},"rejectCountByReason":{"rejected_category_not_in_hot_cats":5,"rejected_liquidity_below_100":2,"rejected_volume_below_5":1,"rejected_no_orderbook_proxy":0}}}', '2026-05-18T00:00:00Z');
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES
        ('algo_decision_latency', 123, '{"p95Ms":123,"p99Ms":456}', '2026-05-18T00:00:00Z'),
        ('r23_cache_activity', 0.5, '{"hitRate":0.5,"hits":1,"misses":1,"invocations":2}', '2026-05-18T00:00:00Z'),
        ('runtime_diagnostics', 12, '{"eventLoopLagMs":{"p95Ms":12,"maxMs":37},"gcPauseMs":{"maxMs":4},"stageTimers":{"ipc_decode":{"maxMs":1.2,"p95Ms":0.8},"handle_worker_batch":{"maxMs":2.2,"p95Ms":1.8},"hub_dispatch":{"maxMs":3.2,"p95Ms":2.8},"coalescing_flush":{"maxMs":4.2,"p95Ms":3.8},"latency_summary":{"maxMs":5.2,"p95Ms":4.8},"diagnostics_write":{"maxMs":6.2,"p95Ms":5.8},"metrics_flush_total":{"maxMs":7.2,"p95Ms":6.8},"metrics_flush_sqlite_writes":{"maxMs":8.2,"p95Ms":7.8},"metrics_flush_snapshot_serialize":{"maxMs":9.2,"p95Ms":8.8},"risk_signal_approval":{"maxMs":10.2,"p95Ms":9.8},"signal_to_order_bridge":{"maxMs":11.2,"p95Ms":10.8},"worker_non_update_events":{"maxMs":12.2,"p95Ms":11.8},"discovery_poll_publish":{"maxMs":13.2,"p95Ms":12.8},"signal_path_aggregate":{"maxMs":14.2,"p95Ms":13.8},"cooldown_registry_sweep":{"maxMs":15.2,"p95Ms":14.8}}}', '2026-05-18T00:00:00Z');
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('signal_path_activity', 1, '{"cooldown":{"signalsSuppressedEarlyCooldownTotal":12,"signalsSuppressedEarlyCooldownByToken":{"tok-a":10,"tok-b":2},"cooldownRegistrySize":3},"cooldownSignalDedupe":{"total":9,"earlyOnly":5,"lateOnly":3,"earlyAndLate":1,"duplicateEarly":2,"duplicateLate":4},"cooldownPriceDedupe":{"total":8,"earlyOnly":2,"lateOnly":3,"earlyAndLate":3,"duplicateEarly":1,"duplicateLate":2,"skippedNoPrice":6}}', '2026-05-18T00:00:00Z');
    `);
    const nowIso = new Date().toISOString();
    const insertMetric = conn.db.prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, ?, ?, ?)",
    );
    insertMetric.run("exit_order_ttl_cancel_total", 2, "{}", nowIso);
    insertMetric.run("exit_order_ttl_cancel_near_resolution_total", 1, "{}", nowIso);
    insertMetric.run("exit_anchor_mode_total", 3, '{"mode":"ask_undercut"}', nowIso);
    insertMetric.run("exit_anchor_mode_total", 2, '{"mode":"midpoint"}', nowIso);
    insertMetric.run("exit_ttl_resolved_total", 7, '{"tier":"thin"}', nowIso);
    insertMetric.run("exit_ttl_resolved_total", 2, '{"tier":"liquid"}', nowIso);
    insertMetric.run("exit_reprice_suppressed_threshold_total", 4, "{}", nowIso);
    insertMetric.run("exit_chain_cap_resolved_total", 5, '{"bucket":"50"}', nowIso);
    insertMetric.run("exit_chain_cap_resolved_total", 1, '{"bucket":"13"}', nowIso);
    conn.db
      .prepare(
        "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        "http_error_class",
        2,
        '{"source":"gamma-pricing","errorClass":"timeout"}',
        new Date().toISOString(),
      );

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/coverage",
      headers: authHeaders(),
    });
    const body = json(res);

    expect(body.ok).toBe(true);
    expect(body.data.ws_tracked).toBe(2);
    expect(body.data.universe_active).toBe(3);
    expect(body.data.coverage_pct).toBeCloseTo(66.666, 2);
    expect(body.data.events_per_sec).toBe(7.5);
    expect(body.data.raw_ws_records).toBe(120);
    expect(body.data.raw_ws_records_per_sec).toBe(2);
    expect(body.data.parsed_updates).toBe(90);
    expect(body.data.parsed_updates_per_sec).toBe(1.5);
    expect(body.data.emitted_updates).toBe(15);
    expect(body.data.emitted_updates_per_sec).toBe(0.25);
    expect(body.data.noop_updates).toBe(30);
    expect(body.data.noop_updates_per_sec).toBe(0.5);
    expect(body.data.suppressed_trading_noop_count_total).toBe(75);
    expect(body.data.suppressed_trading_noop_per_sec).toBe(1.25);
    expect(body.data.suppressed_trading_noop_by_reason).toEqual({
      top_of_book_only: 70,
      book_only: 1,
      last_trade_only: 2,
      tick_size_only: 0,
      mixed_non_critical: 2,
    });
    expect(body.data.hub_filter_checked).toBe(450);
    expect(body.data.hub_filter_checked_per_sec).toBe(7.5);
    expect(body.data.hub_filter_passed).toBe(90);
    expect(body.data.hub_filter_passed_per_sec).toBe(1.5);
    expect(body.data.shard_count).toBe(2);
    expect(body.data.discovery_batch_size).toBe(200);
    expect(body.data.discovery_poll_interval_ms).toBe(60_000);
    expect(body.data.rotation_cycle_hours).toBeCloseTo(1 / 200 / 60, 8);
    expect(body.data.plankton_reference_weekly).toBe(2450);
    expect(body.data.decision_tick_latency_p95_ms).toBe(123);
    expect(body.data.decision_tick_latency_p99_ms).toBe(456);
    expect(body.data.r23_cache_hit_rate).toBe(0.5);
    expect(body.data.event_loop_lag_p95_ms).toBe(12);
    expect(body.data.event_loop_lag_max_ms).toBe(37);
    expect(body.data.gc_pause_max_ms).toBe(4);
    expect(body.data.stage_ipc_decode_max_ms).toBe(1.2);
    expect(body.data.stage_handle_worker_batch_p95_ms).toBe(1.8);
    expect(body.data.stage_hub_dispatch_max_ms).toBe(3.2);
    expect(body.data.stage_coalescing_flush_p95_ms).toBe(3.8);
    expect(body.data.stage_latency_summary_max_ms).toBe(5.2);
    expect(body.data.stage_diagnostics_write_p95_ms).toBe(5.8);
    expect(body.data.stage_metrics_flush_total_max_ms).toBe(7.2);
    expect(body.data.stage_metrics_flush_sqlite_writes_p95_ms).toBe(7.8);
    expect(body.data.stage_metrics_flush_snapshot_serialize_max_ms).toBe(9.2);
    expect(body.data.stage_risk_signal_approval_p95_ms).toBe(9.8);
    expect(body.data.stage_signal_to_order_bridge_max_ms).toBe(11.2);
    expect(body.data.stage_worker_non_update_events_p95_ms).toBe(11.8);
    expect(body.data.stage_discovery_poll_publish_max_ms).toBe(13.2);
    expect(body.data.stage_signal_path_aggregate_p95_ms).toBe(13.8);
    expect(body.data.stage_cooldown_registry_sweep_max_ms).toBe(15.2);
    expect(body.data.signals_suppressed_early_cooldown_total).toBe(12);
    expect(body.data.signals_suppressed_early_cooldown_by_token).toEqual({
      "tok-a": 10,
      "tok-b": 2,
    });
    expect(body.data.cooldown_registry_size).toBe(3);
    expect(body.data.cooldown_signal_dedupe_total).toBe(9);
    expect(body.data.cooldown_signal_dedupe_early_only).toBe(5);
    expect(body.data.cooldown_signal_dedupe_late_only).toBe(3);
    expect(body.data.cooldown_signal_dedupe_early_and_late).toBe(1);
    expect(body.data.cooldown_signal_dedupe_duplicate_early).toBe(2);
    expect(body.data.cooldown_signal_dedupe_duplicate_late).toBe(4);
    expect(body.data.cooldown_signal_unique_signals_total).toBe(9);
    expect(body.data.cooldown_signal_early_only_total).toBe(5);
    expect(body.data.cooldown_signal_late_only_total).toBe(3);
    expect(body.data.cooldown_signal_early_and_late_total).toBe(1);
    expect(body.data.cooldown_signal_duplicate_early_total).toBe(2);
    expect(body.data.cooldown_signal_duplicate_late_total).toBe(4);
    expect(body.data.cooldown_price_dedupe_total).toBe(8);
    expect(body.data.cooldown_price_dedupe_early_only).toBe(2);
    expect(body.data.cooldown_price_dedupe_late_only).toBe(3);
    expect(body.data.cooldown_price_dedupe_early_and_late).toBe(3);
    expect(body.data.cooldown_price_dedupe_duplicate_early).toBe(1);
    expect(body.data.cooldown_price_dedupe_duplicate_late).toBe(2);
    expect(body.data.cooldown_price_dedupe_skipped_no_price).toBe(6);
    expect(body.data.cooldown_price_unique_price_keys_total).toBe(8);
    expect(body.data.cooldown_price_early_only_total).toBe(2);
    expect(body.data.cooldown_price_late_only_total).toBe(3);
    expect(body.data.cooldown_price_early_and_late_total).toBe(3);
    expect(body.data.cooldown_price_duplicate_early_total).toBe(1);
    expect(body.data.cooldown_price_duplicate_late_total).toBe(2);
    expect(body.data.cooldown_price_skipped_no_price_total).toBe(6);
    expect(body.data.exit_order_ttl_cancel_total).toBe(2);
    expect(body.data.exit_order_ttl_cancel_near_resolution_total).toBe(1);
    expect(body.data.exit_anchor_mode_total).toEqual({
      midpoint: 2,
      ask_undercut: 3,
      ask_fallback: 0,
    });
    expect(body.data.exit_ttl_resolved_total).toEqual({
      thin: 7,
      medium: 0,
      liquid: 2,
      default: 0,
      disabled: 0,
    });
    expect(body.data.exit_reprice_suppressed_threshold_total).toBe(4);
    expect(body.data.exit_chain_cap_resolved_total).toEqual({ "50": 5, "13": 1 });
    expect(body.data.http_errors_by_class_1h).toEqual({ "gamma-pricing:timeout": 2 });
    expect(body.data.ws_heartbeat.pingSent).toBe(4);
    expect(body.data.ws_heartbeat.workerEventLoopLagMaxMs).toBe(11);
    expect(body.data.v4_evaluated_total).toBe(10);
    expect(body.data.v4_admit_count_total).toBe(2);
    expect(body.data.v4_reject_count_total).toBe(8);
    expect(body.data.v4_admit_rate).toBe(0.2);
    expect(body.data.v4_admit_count_by_category).toEqual({ "crypto-btc": 2 });
    expect(body.data.v4_seen_count_by_category).toEqual({ "crypto-btc": 3 });
    expect(body.data.v4_admit_rate_by_category).toEqual({ "crypto-btc": 0.6666666667 });
    expect(body.data.v4_reject_count_by_reason).toEqual({
      rejected_category_not_in_hot_cats: 5,
      rejected_liquidity_below_100: 2,
      rejected_volume_below_5: 1,
      rejected_no_orderbook_proxy: 0,
    });

    conn.db.exec(
      `DELETE FROM runtime_metrics WHERE metric_name IN ('market_data_stream_activity', 'algo_decision_latency', 'r23_cache_activity', 'runtime_diagnostics', 'http_error_class', 'signal_path_activity', 'exit_order_ttl_cancel_total', 'exit_order_ttl_cancel_near_resolution_total', 'exit_anchor_mode_total', 'exit_ttl_resolved_total', 'exit_reprice_suppressed_threshold_total', 'exit_chain_cap_resolved_total')`,
    );
  });

  it("GET /metrics/r23 exposes R23 counters, hourly buckets, cache stats, and fills", async () => {
    const eventAt = new Date(Date.now() - 60 * 60_000);
    const eventIso = eventAt.toISOString();
    const eventSql = eventIso.replace("T", " ").slice(0, 19);
    const expectedHour = new Date(
      Date.UTC(
        eventAt.getUTCFullYear(),
        eventAt.getUTCMonth(),
        eventAt.getUTCDate(),
        eventAt.getUTCHours(),
      ),
    )
      .toISOString()
      .replace(".000Z", "Z");
    conn.db.exec(`
      DELETE FROM runtime_metrics WHERE metric_name = 'algo_decision_eval_counters';
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES ('algo_decision_eval_counters', 10, '{"r23DipChecked":10,"r23DipFired":2,"r23NoHistory":3,"r23NoDip":5,"r23Cache":{"hitRate":0.25,"hits":1,"misses":3,"invocations":4},"decisionTickLatency":{"p95Ms":99,"p99Ms":120}}', '${eventIso}');
      INSERT INTO decision_signal_log
        (signal_id, token_id, condition_id, side, decision_rule_id, state, price, buy_count, signal_timestamp)
      VALUES
        ('sig-r23-1', 'tok-r23', 'cond-r23', 'buy', 'R23_DIP_TRIGGER', 'OTHER', 0.1, 0, '${eventIso}'),
        ('sig-r23-2', 'tok-r23', 'cond-r23', 'buy', 'R23_DIP_TRIGGER', 'OTHER', 0.1, 0, '${eventIso}');
      INSERT INTO risk_events (event_type, payload, created_at)
      VALUES
        ('signal_suppressed', '{"decisionRuleId":"R23_DIP_TRIGGER","reasonCode":"r23-no-history"}', '${eventSql}'),
        ('signal_suppressed', '{"decisionRuleId":"R23_DIP_TRIGGER","reasonCode":"r23-no-dip"}', '${eventSql}');
      INSERT INTO orders
        (order_id, client_order_id, token_id, condition_id, side, order_type, post_only, price, size, size_usdc, status, decision_rule_id, bot_run_id, created_at, updated_at)
      VALUES
        ('ord-r23', 'client-r23', 'tok-r23', 'cond-r23', 'buy', 'limit', 1, 0.1, 10, 1, 'filled', 'R23_DIP_TRIGGER', 'run-r23', '${eventSql}', '${eventSql}');
      INSERT INTO fills
        (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, decision_rule_id, filled_at)
      VALUES
        ('fill-r23', 'ord-r23', 'tok-r23', 'cond-r23', 'buy', 0.1, 10, 1, 'R23_DIP_TRIGGER', '${eventSql}');
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/r23",
      headers: authHeaders(),
    });
    const body = json(res);

    expect(body.ok).toBe(true);
    expect(body.data.current).toMatchObject({
      checked: 10,
      fired: 2,
      no_history: 3,
      no_dip: 5,
      cache_hit_rate: 0.25,
      cache_hits: 1,
      cache_misses: 3,
      cache_invocations: 4,
      decision_tick_latency_p95_ms: 99,
      decision_tick_latency_p99_ms: 120,
    });
    expect(body.data.hourly.fires).toContainEqual({ hour: expectedHour, count: 2 });
    expect(body.data.hourly.skips).toEqual(
      expect.arrayContaining([
        { hour: expectedHour, reason: "r23-no-history", count: 1 },
        { hour: expectedHour, reason: "r23-no-dip", count: 1 },
      ]),
    );
    expect(body.data.orders_24h).toBe(1);
    expect(body.data.fills_24h).toBe(1);
    expect(body.data.fill_notional_usdc_24h).toBe(1);

    conn.db.exec(`
      DELETE FROM runtime_metrics WHERE metric_name = 'algo_decision_eval_counters';
      DELETE FROM decision_signal_log WHERE signal_id LIKE 'sig-r23-%';
      DELETE FROM risk_events WHERE payload LIKE '%R23_DIP_TRIGGER%';
      DELETE FROM fills WHERE fill_id = 'fill-r23';
      DELETE FROM orders WHERE order_id = 'ord-r23';
    `);
  });

  it("GET /dashboard/kpi exposes operator KPI fields", async () => {
    const nowIso = new Date().toISOString();
    const openedIso = new Date(Date.now() - 60 * 60_000).toISOString();
    const oldOpenedIso = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
    const cleanupKpiFixture = () => {
      conn.db.exec(`
        DELETE FROM runtime_metrics WHERE metric_name IN (
          'market_data_stream_activity',
          'runtime_diagnostics',
          'runtime_paused',
          'runtime_restart',
          'oom_kill'
        );
        DELETE FROM settlement_ledger WHERE settlement_id LIKE 'settle-kpi-%';
        DELETE FROM market_resolutions WHERE condition_id LIKE 'cond-kpi-%';
        DELETE FROM leg_states WHERE token_id = 'tok-kpi-stuck';
        DELETE FROM hold_resolution_states WHERE token_id LIKE 'tok-kpi-%';
        DELETE FROM fills WHERE fill_id LIKE 'fill-kpi-%';
        DELETE FROM orders WHERE order_id LIKE 'ord-kpi-%';
        DELETE FROM positions WHERE position_id LIKE 'pos-kpi-%';
      `);
    };
    try {
      conn.db.exec(`
      INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price,
        cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, closed_at, updated_at)
      VALUES
        ('pos-kpi-sell-win-1', 'tok-kpi-sell-win-1', 'cond-kpi-sell-win-1', 'buy', 10, 0.10, 1, 3, 2, 'closed', '${openedIso}', '${nowIso}', '${nowIso}'),
        ('pos-kpi-sell-win-2', 'tok-kpi-sell-win-2', 'cond-kpi-sell-win-2', 'buy', 10, 0.10, 1, 6, 5, 'closed', '${openedIso}', '${nowIso}', '${nowIso}'),
        ('pos-kpi-sell-loss', 'tok-kpi-sell-loss', 'cond-kpi-sell-loss', 'buy', 10, 0.20, 2, 1, -1, 'closed', '${openedIso}', '${nowIso}', '${nowIso}'),
        ('pos-kpi-res-win', 'tok-kpi-res-win', 'cond-kpi-res-win', 'buy', 10, 0.40, 4, 10, 6, 'closed', '${openedIso}', '${nowIso}', '${nowIso}'),
        ('pos-kpi-res-loss', 'tok-kpi-res-loss', 'cond-kpi-res-loss', 'buy', 10, 0.40, 4, 0, -4, 'closed', '${openedIso}', '${nowIso}', '${nowIso}'),
        ('pos-kpi-hybrid', 'tok-kpi-hybrid', 'cond-kpi-hybrid', 'buy', 10, 0.10, 1, 5, 3, 'closed', '${openedIso}', '${nowIso}', '${nowIso}'),
        ('pos-kpi-stuck', 'tok-kpi-stuck', 'cond-kpi-stuck', 'buy', 10, 0.10, 1, 2, 0, 'open', '${oldOpenedIso}', NULL, '${nowIso}'),
        ('pos-kpi-held', 'tok-kpi-held', 'cond-kpi-held', 'buy', 10, 0.10, 1, 1, 0, 'open', '${oldOpenedIso}', NULL, '${nowIso}');

      INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type,
        price, size, size_usdc, status, exchange_order_id, bot_run_id, created_at, updated_at)
      VALUES
        ('ord-kpi-sell-win-1', 'client-kpi-sell-win-1', 'tok-kpi-sell-win-1', 'cond-kpi-sell-win-1', 'sell', 'GTC', 0.30, 10, 3, 'filled', 'ex-kpi-sell-win-1', 'run-1', '${openedIso}', '${openedIso}'),
        ('ord-kpi-sell-win-2', 'client-kpi-sell-win-2', 'tok-kpi-sell-win-2', 'cond-kpi-sell-win-2', 'sell', 'GTC', 0.60, 10, 6, 'filled', 'ex-kpi-sell-win-2', 'run-1', '${openedIso}', '${openedIso}'),
        ('ord-kpi-sell-loss', 'client-kpi-sell-loss', 'tok-kpi-sell-loss', 'cond-kpi-sell-loss', 'sell', 'GTC', 0.10, 10, 1, 'filled', 'ex-kpi-sell-loss', 'run-1', '${openedIso}', '${openedIso}'),
        ('ord-kpi-hybrid', 'client-kpi-hybrid', 'tok-kpi-hybrid', 'cond-kpi-hybrid', 'sell', 'GTC', 0.30, 5, 1.5, 'filled', 'ex-kpi-hybrid', 'run-1', '${openedIso}', '${openedIso}');

      INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
        liquidity_role, fee, filled_at, reconciled)
      VALUES
        ('fill-kpi-sell-win-1', 'ord-kpi-sell-win-1', 'tok-kpi-sell-win-1', 'cond-kpi-sell-win-1', 'sell', 0.30, 10, 3, 'maker', 0, '${nowIso}', 1),
        ('fill-kpi-sell-win-2', 'ord-kpi-sell-win-2', 'tok-kpi-sell-win-2', 'cond-kpi-sell-win-2', 'sell', 0.60, 10, 6, 'maker', 0, '${nowIso}', 1),
        ('fill-kpi-sell-loss', 'ord-kpi-sell-loss', 'tok-kpi-sell-loss', 'cond-kpi-sell-loss', 'sell', 0.10, 10, 1, 'taker', 0, '${nowIso}', 1),
        ('fill-kpi-hybrid', 'ord-kpi-hybrid', 'tok-kpi-hybrid', 'cond-kpi-hybrid', 'sell', 0.30, 5, 1.5, 'maker', 0, '${nowIso}', 1);

      INSERT INTO market_resolutions (condition_id, resolution, resolved_at, detected_at, source, status)
      VALUES
        ('cond-kpi-res-win', 'YES', '${nowIso}', '${nowIso}', 'test', 'settled'),
        ('cond-kpi-res-loss', 'NO', '${nowIso}', '${nowIso}', 'test', 'settled'),
        ('cond-kpi-hybrid', 'YES', '${nowIso}', '${nowIso}', 'test', 'settled');

      INSERT INTO settlement_ledger (settlement_id, condition_id, position_id, token_id, resolution,
        settlement_price, size, delta, settled_at)
      VALUES
        ('settle-kpi-res-win', 'cond-kpi-res-win', 'pos-kpi-res-win', 'tok-kpi-res-win', 'YES', 1, 10, 6, '${nowIso}'),
        ('settle-kpi-res-loss', 'cond-kpi-res-loss', 'pos-kpi-res-loss', 'tok-kpi-res-loss', 'NO', 0, 10, -4, '${nowIso}'),
        ('settle-kpi-hybrid', 'cond-kpi-hybrid', 'pos-kpi-hybrid', 'tok-kpi-hybrid', 'YES', 1, 5, 5, '${nowIso}');

      INSERT INTO leg_states (token_id, buy_count, sell_count, last_action, first_trade_price,
        first_trade_at, last_trade_at, updated_at, reprice_chain_count_24h)
      VALUES ('tok-kpi-stuck', 1, 0, 'buy', 0.10, '${oldOpenedIso}', '${oldOpenedIso}', '${nowIso}', 13);

      INSERT INTO hold_resolution_states (id, token_id, condition_id, position_id, status,
        marker_created_at, expected_resolution_at, attempt_count_for_redeem, exit_pnl_pct,
        stale_reason, liveness_verdict, metadata_json)
      VALUES ('hold-kpi-active', 'tok-kpi-held', 'cond-kpi-held', 'pos-kpi-held', 'active',
        '${oldOpenedIso}', NULL, 0, -0.25, 'chain', 'dead', '{"source":"test"}');

      DELETE FROM runtime_metrics WHERE metric_name IN (
        'market_data_stream_activity',
        'runtime_diagnostics',
        'runtime_paused',
        'runtime_restart',
        'oom_kill'
      );
      INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
      VALUES
        ('market_data_stream_activity', 1, '{"trackedTokenCount":4999,"universeTokenCount":5000}', '${nowIso}'),
        ('runtime_diagnostics', 1, '{"eventLoopLagMs":{"p95Ms":321}}', '${nowIso}'),
        ('runtime_paused', 1, NULL, '${nowIso}'),
        ('runtime_restart', 2, NULL, '${nowIso}'),
        ('oom_kill', 1, NULL, '${nowIso}');
    `);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/dashboard/kpi",
        headers: authHeaders(),
      });
      const body = json(res);

      expect(body.ok).toBe(true);
      expect(body.data.winrate_7d).toMatchObject({
        wins: 4,
        losses: 2,
        total: 6,
      });
      expect(body.data.winrate_7d.value).toBeCloseTo(66.666, 2);
      expect(body.data.winrate_7d.sell_closed_pct).toBeCloseTo(66.666, 2);
      expect(body.data.winrate_7d.resolved_closed_pct).toBeCloseTo(66.666, 2);
      expect(body.data.exit_multiple_7d.median).toBeCloseTo(3, 6);
      expect(body.data.exit_multiple_7d.p90).toBeCloseTo(6, 6);
      expect(body.data.exit_multiple_7d.count).toBe(3);
      expect(body.data.fills_24h).toMatchObject({ total: 4, maker: 3, taker: 1, unknown: 0 });
      expect(body.data.fills_24h.maker_ratio).toBeCloseTo(75, 3);
      expect(body.data.fills_24h.volume_usd).toBeCloseTo(11.5, 5);
      expect(body.data.open_positions_count).toBeGreaterThanOrEqual(1);
      expect(body.data.fills_24h.rate_per_position).toBeCloseTo(
        4 / body.data.open_positions_count,
        5,
      );
      expect(body.data.stuck_positions_count).toBe(2);
      expect(body.data.hold_resolution_active_count).toBe(1);
      expect(body.data.health).toMatchObject({
        severity: "crit",
        ws_tracked: 4999,
        ws_total: 5000,
        lag_p95_ms: 321,
        restarts_24h: 2,
        oom_24h: 1,
        mode: "simulation",
        paused: true,
      });
      expect(body.data.health.checks).toHaveLength(5);
      expect(body.data.health.checks[0]).toMatchObject({ key: "stuck", severity: "warn" });
      expect(body.data.health.checks[1]).toMatchObject({ key: "lag", severity: "warn" });
      expect(body.data.health.checks[2]).toMatchObject({ key: "restart", severity: "crit" });
      expect(body.data.health.checks[3]).toMatchObject({ key: "mode", severity: "warn" });
      expect(body.data.health.checks[4]).toMatchObject({
        key: "hold_resolution",
        severity: "warn",
      });
    } finally {
      cleanupKpiFixture();
    }
  });

  it("GET /hold-resolution returns active hold markers with filtering", async () => {
    const nowIso = new Date().toISOString();
    conn.db.exec(`
      DELETE FROM hold_resolution_states WHERE token_id LIKE 'tok-hold-api-%';
      INSERT INTO hold_resolution_states (id, token_id, condition_id, position_id, status,
        marker_created_at, expected_resolution_at, attempt_count_for_redeem, exit_pnl_pct,
        stale_reason, liveness_verdict, metadata_json)
      VALUES
        ('hold-api-active', 'tok-hold-api-active', 'cond-hold-api-active', 'pos-hold-api-active',
         'active', '${nowIso}', NULL, 0, -0.2, 'chain', 'dead', '{"note":"active"}'),
        ('hold-api-cancelled', 'tok-hold-api-cancelled', 'cond-hold-api-cancelled',
         'pos-hold-api-cancelled', 'cancelled', '${nowIso}', NULL, 0, -0.1, 'chain', 'dead',
         '{"note":"cancelled"}');
    `);

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/hold-resolution?status=active",
        headers: authHeaders(),
      });
      const body = json(res);

      expect(body.ok).toBe(true);
      expect(body.data.rows).toHaveLength(1);
      expect(body.data.rows[0]).toMatchObject({
        token_id: "tok-hold-api-active",
        status: "active",
        stale_reason: "chain",
        liveness_verdict: "dead",
        metadata: { note: "active" },
      });
    } finally {
      conn.db.exec("DELETE FROM hold_resolution_states WHERE token_id LIKE 'tok-hold-api-%'");
    }
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

  it("GET /positions default sort stays stable when only updated_at changes", async () => {
    conn.db.exec(`
      INSERT INTO positions (position_id, token_id, side, size, avg_entry_price, cost_basis_usdc,
        current_value_usdc, realized_pnl, status, opened_at, updated_at)
      VALUES ('pos-stable-order', 'tok-stable', 'buy', 10, 0.1, 1, 1, 0, 'open',
        '2026-03-13T00:00:00Z', '2026-03-20T00:00:00Z');
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?status=open",
      headers: authHeaders(),
    });
    const body = json(res);

    expect(body.data.items.map((p: any) => p.positionId)).toEqual(["pos-1", "pos-stable-order"]);

    conn.db.exec(`DELETE FROM positions WHERE position_id = 'pos-stable-order'`);
  });

  it("GET /positions/:id returns single position", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions/pos-1",
      headers: authHeaders(),
    });
    expect(json(res).data.positionId).toBe("pos-1");
  });

  it("GET /positions/:id/phase-transitions returns phase audit trail", async () => {
    conn.db.exec(`
      INSERT INTO leg_state_transitions
        (token_id, position_id, fill_id, order_id, client_order_id, condition_id,
         from_phase, to_phase, action, price, size, size_usdc,
         from_buy_count, from_sell_count, to_buy_count, to_sell_count,
         reason, occurred_at)
      VALUES
        ('tok-1', 'pos-1', 'fill-audit-1', 'ord-1', 'coid-audit-1', 'cond-1',
         'S0', 'S1', 'BUY', 0.05, 10, 0.5, 0, 0, 1, 0, 'test', '2026-03-14T00:00:00Z');
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions/pos-1/phase-transitions",
      headers: authHeaders(),
    });
    const body = json(res);

    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      fromPhase: "S0",
      toPhase: "S1",
      action: "BUY",
      fillId: "fill-audit-1",
    });

    conn.db.exec(`DELETE FROM leg_state_transitions WHERE fill_id = 'fill-audit-1'`);
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

  it("GET /fills?since= filters by date", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills?since=2026-03-15T00:00:00Z",
      headers: authHeaders(),
    });
    expect(json(res).data.items.length).toBe(0);
  });

  it("GET /fills exposes decisionRuleId and signalId (null when unset)", async () => {
    conn.db.exec(`
      INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, fee,
                        filled_at, reconciled, decision_rule_id, signal_id)
      VALUES ('fill-attr', 'ord-1', 'tok-1', 'sell', 0.6, 10, 6, 0.01,
              '2026-03-14T02:00:00Z', 0, 'D8_PROFIT_RATIO', 'sig-attr-1');
    `);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/fills",
        headers: authHeaders(),
      });
      const items = json(res).data.items;
      const attr = items.find((f: { fillId: string }) => f.fillId === "fill-attr");
      expect(attr).toBeTruthy();
      expect(attr.decisionRuleId).toBe("D8_PROFIT_RATIO");
      expect(attr.signalId).toBe("sig-attr-1");
      const baseline = items.find((f: { fillId: string }) => f.fillId === "fill-1");
      expect(baseline).toBeTruthy();
      expect(baseline.decisionRuleId).toBeNull();
      expect(baseline.signalId).toBeNull();
    } finally {
      conn.db.exec(`DELETE FROM fills WHERE fill_id = 'fill-attr'`);
    }
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
      INSERT INTO risk_events (event_type, payload, created_at)
      VALUES ('max_exposure_breach', '{"currentExposure":612.5,"limit":500}', '2026-03-14T10:00:00Z')
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
    expect(first.summary).toContain("Exposure breach");
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

  it("filters by event_type", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events?event_type=max_exposure_breach",
      headers: authHeaders(),
    });
    const items = json(res).data.items;
    for (const item of items) {
      expect(item.eventType).toBe("max_exposure_breach");
    }
  });

  it("normalizes signal_rejected events", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, payload, created_at)
      VALUES ('signal_rejected', '{"reasonCode":"max_dust_positions","rawReason":"dust 3 >= max 2"}', '2026-03-22T12:00:00Z')
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

  it("falls back to info severity and a generic summary for unknown event types", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, payload, created_at)
      VALUES ('future_event_type', '{"note":"whatever"}', '2026-03-22T12:00:00Z')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events?event_type=future_event_type",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items[0].severity).toBe("info");
    expect(body.data.items[0].summary).toBe("future_event_type on system");
  });

  it("preserves legacy family auto-demotion (source:system) transitions in summary", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, payload, created_at)
      VALUES (
        'family_reduce_only',
        '{"source":"system","previousState":"scaled","newState":"reduce-only","reason":"execution canary breach"}',
        '2026-03-22T14:00:00Z'
      )
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events?event_type=family_reduce_only",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items[0].severity).toBe("warning");
    expect(body.data.items[0].summary).toContain("auto-demoted");
    expect(body.data.items[0].summary).toContain("scaled -> reduce-only");
    expect(body.data.items[0].summary).toContain("execution canary breach");
  });

  it("renders legacy family_reduce_only rows without source as operator-triggered", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, payload, created_at)
      VALUES ('family_reduce_only', '{"reason":"operator command"}', '2026-03-22T14:01:00Z')
    `);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/risk-events?event_type=family_reduce_only",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items[0].summary).toContain("reduce-only");
    expect(body.data.items[0].summary).not.toContain("auto-demoted");
  });

  it("normalizes reconciliation_drift with details (plural, not detail)", async () => {
    conn.db.exec(`
      INSERT INTO risk_events (event_type, payload, created_at)
      VALUES ('reconciliation_drift', '{"details":"phantom order detected","severity":"warn"}', '2026-03-22T13:00:00Z')
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
      INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, fee, filled_at, reconciled)
      VALUES ('f-baseline', 'ord-1', 'tok-1', 'sell', 0.6, 10, 6, 0.01, '${new Date().toISOString()}', 0);
      INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
      VALUES ('f-baseline', 'pos-1', 5.0, '${new Date().toISOString()}')
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
      INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc, fee, filled_at, reconciled)
      VALUES
        ('f-1', 'ord-1', 'tok-1', 'sell', 0.6, 10, 6, 0.01, '${d1Morning}', 0),
        ('f-2', 'ord-1', 'tok-1', 'sell', 0.6, 10, 6, 0.01, '${d1Afternoon}', 0),
        ('f-3', 'ord-1', 'tok-1', 'sell', 0.6, 10, 6, 0.01, '${d2Morning}', 0);

      INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
      VALUES
        ('f-1', 'pos-1', 10.5, '${d1Morning}'),
        ('f-2', 'pos-1', -3.2, '${d1Afternoon}'),
        ('f-3', 'pos-1', 5.0,  '${d2Morning}')
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

// ─── /promote route removed in Phase 3 — collapsed to enable/disable ─────
