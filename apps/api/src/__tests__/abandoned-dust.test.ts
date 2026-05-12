import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapControlDb, bootstrapLedgerDb, SqliteLegStateRepository } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { createTokenId } from "@krabs/domain";
import { buildServer } from "../server.js";
import { MARKET_DATA_TEST_DEFAULTS, stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-key-abandoned-dust";

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

const authHeaders = () => ({
  authorization: `Bearer ${TEST_API_KEY}`,
  "content-type": "application/json",
});

describe("POST /abandoned-dust/reset", () => {
  let controlConn: DbConnection;
  let ledgerConn: DbConnection;
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeEach(async () => {
    controlConn = bootstrapControlDb(":memory:");
    ledgerConn = bootstrapLedgerDb(":memory:");
    app = await buildServer({
      config: testConfig(),
      controlDb: controlConn.db,
      ledgerDb: ledgerConn.db,
      ledgerPool: stubLedgerPool(),
    });
  });

  afterEach(async () => {
    await app.close();
    controlConn.close();
    ledgerConn.close();
  });

  it("integration: manual reset clears abandoned state and audits dust-recovered:manual", async () => {
    const tokenId = createTokenId("tok-abandoned-manual");
    const repo = new SqliteLegStateRepository(ledgerConn.db);
    repo.upsert({
      tokenId,
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: "2026-01-01T00:00:00Z",
      lastTradeAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      consecutiveSellResidualRejects: 10,
      abandonedAtPrice: 0.1,
      abandonedAtTs: "2026-01-01T00:10:00Z",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/abandoned-dust/reset",
      headers: authHeaders(),
      payload: { tokenId: String(tokenId), reason: "operator_review" },
    });

    expect(res.statusCode).toBe(200);
    const state = repo.get(tokenId);
    expect(state?.consecutiveSellResidualRejects).toBe(0);
    expect(state?.abandonedAtPrice).toBeNull();
    expect(state?.abandonedAtTs).toBeNull();

    const row = ledgerConn.db
      .prepare("SELECT payload FROM risk_events ORDER BY id DESC LIMIT 1")
      .get() as { payload: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.payload)).toMatchObject({
      tokenId: String(tokenId),
      reasonCode: "dust-recovered:manual",
      source: "manual_api_reset",
      actor: "api_key",
      reason: "operator_review",
    });
  });

  it("integration: manual reset requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/abandoned-dust/reset",
      payload: { tokenId: "tok-abandoned-manual" },
    });

    expect(res.statusCode).toBe(401);
  });
});
