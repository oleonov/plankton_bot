import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-fills-pnl";

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
  };
}

interface PnlFill {
  fillId: string;
  side: string;
  pnlUsd: number | null;
  pnlPct: number | null;
}

interface FillsResponse {
  ok: boolean;
  data: { items: PnlFill[]; totalCount: number };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  const db = conn.db;

  const insertOrder = db.prepare(
    `INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type,
       price, size, size_usdc, status, bot_run_id, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, 'limit', ?, ?, ?, 'filled', 'test-run', ?, ?)`,
  );
  const insertFill = db.prepare(
    `INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
       liquidity_role, fee, filled_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, 'maker', 0, ?)`,
  );
  const insertPosition = db.prepare(
    `INSERT INTO positions (position_id, token_id, side, opened_at, updated_at)
     VALUES (?, ?, 'buy', ?, ?)`,
  );
  const insertPnl = db.prepare(
    `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at) VALUES (?, ?, ?, ?)`,
  );

  // 1) BUY fill — entry event, no realized P&L row.
  insertOrder.run("ord-buy", "c-buy", "tok-buy", "buy", 0.044, 22.5, 0.99, "t0", "t0");
  insertFill.run(
    "fill-buy",
    "ord-buy",
    "tok-buy",
    "buy",
    0.044,
    22.5,
    0.99,
    "2026-04-24T08:00:00Z",
  );

  // 2) Profitable SELL — entry 0.044, exit 0.108, size 17.5 → delta +1.12, +145.45%.
  insertPosition.run("pos-win", "tok-win", "t0", "t0");
  insertOrder.run("ord-win", "c-win", "tok-win", "sell", 0.108, 17.5, 1.89, "t1", "t1");
  insertFill.run(
    "fill-sell-win",
    "ord-win",
    "tok-win",
    "sell",
    0.108,
    17.5,
    1.89,
    "2026-04-24T09:00:00Z",
  );
  insertPnl.run("fill-sell-win", "pos-win", 1.12, "2026-04-24T09:00:00Z");

  // 3) Losing SELL — entry 0.05, exit 0.03, size 20 → delta -0.40, -40.0%.
  insertPosition.run("pos-loss", "tok-loss", "t0", "t0");
  insertOrder.run("ord-loss", "c-loss", "tok-loss", "sell", 0.03, 20, 0.6, "t2", "t2");
  insertFill.run(
    "fill-sell-loss",
    "ord-loss",
    "tok-loss",
    "sell",
    0.03,
    20,
    0.6,
    "2026-04-24T10:00:00Z",
  );
  insertPnl.run("fill-sell-loss", "pos-loss", -0.4, "2026-04-24T10:00:00Z");

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

async function fetchFills(): Promise<Map<string, PnlFill>> {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/fills?limit=50",
    headers: { authorization: `Bearer ${TEST_API_KEY}` },
  });
  expect(res.statusCode).toBe(200);
  const body: FillsResponse = res.json();
  return new Map(body.data.items.map((f) => [f.fillId, f]));
}

describe("GET /fills — per-SELL realized P&L", () => {
  it("BUY fills carry no P&L (entry event)", async () => {
    const buy = (await fetchFills()).get("fill-buy")!;
    expect(buy.side).toBe("buy");
    expect(buy.pnlUsd).toBeNull();
    expect(buy.pnlPct).toBeNull();
  });

  it("profitable SELL reports positive P&L (USD + %)", async () => {
    const win = (await fetchFills()).get("fill-sell-win")!;
    expect(win.pnlUsd).toBeGreaterThan(0);
    expect(win.pnlPct).toBeGreaterThan(0);
  });

  it("losing SELL reports negative P&L (USD + %)", async () => {
    const loss = (await fetchFills()).get("fill-sell-loss")!;
    expect(loss.pnlUsd).toBeLessThan(0);
    expect(loss.pnlPct).toBeLessThan(0);
  });

  it("computes P&L from realized delta: sell 0.108 / entry 0.044 / size 17.5 → +$1.12, +145%", async () => {
    const win = (await fetchFills()).get("fill-sell-win")!;
    expect(win.pnlUsd!).toBeCloseTo(1.12, 2);
    expect(win.pnlPct!).toBeCloseTo(145.45, 1);
  });
});
