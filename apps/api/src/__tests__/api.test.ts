import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";

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
    INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
    VALUES ('fam-1', 'test-family', 'politics', 'standard', 'medium', 'daily', 'v1');

    INSERT INTO family_runtime_state (family_id, runtime_mode, open_value_usdc, open_position_count, open_dust_count,
      active_market_count, current_tail_cost_usdc, tail_adjusted_pnl_live, updated_at)
    VALUES ('fam-1', 'active', 50.0, 2, 0, 3, 10.0, 5.0, '2026-03-14T00:00:00Z');

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

    INSERT INTO markets (token_id, condition_id, slug, question, outcome, active, tick_size, neg_risk, created_at, updated_at)
    VALUES ('tok-1', 'cond-1', 'will-btc-hit-100k', 'Will BTC hit 100k?', 'Yes', 1, 0.01, 0, '2026-03-14T00:00:00Z', '2026-03-14T00:00:00Z');

    INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
    VALUES ('market_data_source', 1, '{"value":"simulation"}', '2026-03-14T00:00:00Z');
    INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
    VALUES ('execution_mode', 1, '{"value":"simulation"}', '2026-03-14T00:00:00Z');
  `);

  app = await buildServer({ config: testConfig(), conn });
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
      conn,
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
  it("returns ok envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
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
    expect(body.data).toHaveLength(1);
    expect(body.data[0].familyId).toBe("fam-1");
    expect(body.data[0].state).toBeDefined();
    expect(body.data[0].state.runtimeMode).toBe("active");
  });

  it("GET /families/:id returns detail", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families/fam-1",
      headers: authHeaders(),
    });
    expect(json(res).data.familyId).toBe("fam-1");
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
});

// ─── Positions with filters ─────────────────────────────────────────

describe("positions", () => {
  it("GET /positions returns open+dust by default", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.length).toBe(2); // open + dust
  });

  it("GET /positions?family_id= filters by family", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?family_id=fam-1",
      headers: authHeaders(),
    });
    expect(json(res).data.length).toBe(2);
  });

  it("GET /positions?dust=true returns only dust positions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?dust=true",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].status).toBe("dust");
  });

  it("GET /positions?status=open returns only open", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?status=open",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].status).toBe("open");
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
  });

  it("GET /positions enriches items with market metadata", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions",
      headers: authHeaders(),
    });
    const enriched = json(res).data.find((p: any) => p.tokenId === "tok-1");
    expect(enriched.slug).toBe("will-btc-hit-100k");
    expect(enriched.question).toBe("Will BTC hit 100k?");
    expect(enriched.outcome).toBe("Yes");
    expect(enriched.conditionId).toBe("cond-1");
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
    const dust = json(res).data.find((p: any) => p.tokenId === "tok-2");
    expect(dust.slug).toBeNull();
    expect(dust.question).toBeNull();
    expect(dust.outcome).toBeNull();
    expect(dust.conditionId).toBeNull();
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
  });

  it("GET /metrics/families returns per-family metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/families",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].familyId).toBe("fam-1");
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
    expect(body.data.items[0].summary).toContain("max_dust_positions");
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

  it("returns cumulative realized PnL by day", async () => {
    conn.db.exec(`
      INSERT INTO fills (fill_id, order_id, token_id, family_id, side, price, size, size_usdc, fee, filled_at, reconciled)
      VALUES
        ('f-1', 'ord-1', 'tok-1', 'fam-1', 'sell', 0.6, 10, 6, 0.01, '2026-03-12T10:00:00Z', 0),
        ('f-2', 'ord-1', 'tok-1', 'fam-1', 'sell', 0.6, 10, 6, 0.01, '2026-03-12T14:00:00Z', 0),
        ('f-3', 'ord-1', 'tok-1', 'fam-1', 'sell', 0.6, 10, 6, 0.01, '2026-03-13T09:00:00Z', 0);

      INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
      VALUES
        ('f-1', 'pos-1', 'fam-1', 10.5, '2026-03-12T10:00:00Z'),
        ('f-2', 'pos-1', 'fam-1', -3.2, '2026-03-12T14:00:00Z'),
        ('f-3', 'pos-1', 'fam-1', 5.0,  '2026-03-13T09:00:00Z')
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
    expect(items[0].date).toBe("2026-03-12");
    expect(items[0].realizedPnl).toBeCloseTo(7.3); // 10.5 + (-3.2) cumulative
    expect(items[1].date).toBe("2026-03-13");
    expect(items[1].realizedPnl).toBeCloseTo(12.3); // 7.3 + 5.0 cumulative
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
