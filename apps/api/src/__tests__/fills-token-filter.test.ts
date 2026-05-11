import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-fills-tokenid";

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

interface FillsResponse {
  ok: boolean;
  data: {
    items: Array<{ fillId: string; tokenId: string; filledAt: string }>;
    totalCount: number;
    nextCursor: string | null;
  };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  const db = conn.db;

  const seeds = [
    { id: "fill-a-1", tok: "tok-a", at: "2026-04-24T08:00:00Z" },
    { id: "fill-a-2", tok: "tok-a", at: "2026-04-24T09:00:00Z" },
    { id: "fill-b-1", tok: "tok-b", at: "2026-04-24T10:00:00Z" },
    { id: "fill-b-2", tok: "tok-b", at: "2026-04-24T11:00:00Z" },
    { id: "fill-c-1", tok: "tok-c", at: "2026-04-24T12:00:00Z" },
  ];
  const insertOrder = db.prepare(
    `INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type,
       price, size, size_usdc, status, bot_run_id, created_at, updated_at)
     VALUES (?, ?, ?, '', 'buy', 'limit', 0.5, 1, 0.5, 'filled', 'test-run', ?, ?)`,
  );
  const insertFill = db.prepare(
    `INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
       liquidity_role, fee, filled_at)
     VALUES (?, ?, ?, '', 'buy', 0.5, 1, 0.5, 'maker', 0, ?)`,
  );
  for (const s of seeds) {
    const orderId = `ord-${s.id}`;
    insertOrder.run(orderId, `c-${s.id}`, s.tok, s.at, s.at);
    insertFill.run(s.id, orderId, s.tok, s.at);
  }

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

describe("GET /fills?tokenId=...", () => {
  it("returns only fills for the requested tokenId", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills?tokenId=tok-a&limit=50",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: FillsResponse = res.json();
    const tokenIds = new Set(body.data.items.map((f) => f.tokenId));
    expect(tokenIds).toEqual(new Set(["tok-a"]));
    expect(body.data.totalCount).toBe(2);
  });

  it("totalCount reflects only the filtered token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills?tokenId=tok-b",
      headers: authHeaders(),
    });
    const body: FillsResponse = res.json();
    expect(body.data.totalCount).toBe(2);
  });

  it("unknown tokenId returns an empty set (not a 500)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills?tokenId=missing",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: FillsResponse = res.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.totalCount).toBe(0);
  });

  it("omitting tokenId still returns everything", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/fills",
      headers: authHeaders(),
    });
    const body: FillsResponse = res.json();
    expect(body.data.totalCount).toBe(5);
  });
});
