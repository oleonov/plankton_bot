import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapDatabase, type DbConnection, SqliteRedeemLogRepository } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { MARKET_DATA_TEST_DEFAULTS, stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-key-redeem-log";

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
    executionSellBalanceRejectBlockMs: 60_000,
    executionSellExchangeReservedEnabled: true,
    trustProxy: false,
    ...MARKET_DATA_TEST_DEFAULTS,
  };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  const repo = new SqliteRedeemLogRepository(conn.db);
  repo.insert({
    conditionId: "cond-1",
    tokenIds: ["tok-1"],
    attemptTs: 1_000,
    status: "success",
    txHash: "0xabc",
    gasUsed: 123,
  });
  repo.insert({
    conditionId: "cond-2",
    tokenIds: ["tok-2"],
    attemptTs: 2_000,
    status: "failed",
    errorMsg: "boom",
  });
  repo.insert({
    conditionId: "cond-1",
    tokenIds: ["tok-1"],
    attemptTs: Date.now(),
    status: "attempting",
  });
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

function body(res: { json: () => unknown }): any {
  return res.json();
}

describe("redeem log routes", () => {
  it("returns recent entries", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/redeem-log",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const json = body(res);
    expect(json.ok).toBe(true);
    expect(json.data.total_count).toBe(3);
    expect(json.data.entries[0]).toMatchObject({
      condition_id: "cond-1",
      token_ids: ["tok-1"],
      status: "attempting",
    });
  });

  it("filters by status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/redeem-log?status=failed",
      headers: authHeaders(),
    });

    const json = body(res);
    expect(json.data.total_count).toBe(1);
    expect(json.data.entries[0]).toMatchObject({
      condition_id: "cond-2",
      status: "failed",
    });
  });

  it("filters by exact condition_id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/redeem-log?condition_id=cond-1",
      headers: authHeaders(),
    });

    const json = body(res);
    expect(json.data.total_count).toBe(2);
    expect(json.data.entries.every((entry: any) => entry.condition_id === "cond-1")).toBe(true);
  });

  it("returns summary fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/redeem-log/summary",
      headers: authHeaders(),
    });

    const json = body(res);
    expect(json.data).toMatchObject({
      total_attempts_24h: expect.any(Number),
      by_status: expect.objectContaining({
        attempting: expect.any(Number),
        success: expect.any(Number),
        failed: expect.any(Number),
        failed_orphaned: expect.any(Number),
      }),
      total_usdc_redeemed_24h: null,
      latest_attempt_ts: expect.any(Number),
    });
    expect(json.data.oldest_in_flight).toMatchObject({ condition_id: "cond-1" });
  });
});
