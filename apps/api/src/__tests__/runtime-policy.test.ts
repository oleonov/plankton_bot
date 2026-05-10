import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapControlDb, bootstrapLedgerDb } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import type { LedgerPool } from "../ledger-pool.js";
import { buildServer } from "../server.js";
import { MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-runtime-policy";

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
    trustProxy: false,
    ...MARKET_DATA_TEST_DEFAULTS,
  };
}

const authHeaders = () => ({ authorization: `Bearer ${TEST_API_KEY}` });

function makeTestLedgerPool(ledger: DbConnection): LedgerPool {
  return {
    get(profileId: string) {
      return profileId === "simulation" ? ledger.db : null;
    },
    closeAll() {},
  } as unknown as LedgerPool;
}

let controlConn: DbConnection;
let ledgerConn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  controlConn = bootstrapControlDb(":memory:");
  controlConn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
  ledgerConn = bootstrapLedgerDb(":memory:");
  app = await buildServer({
    config: testConfig(),
    controlDb: controlConn.db,
    ledgerDb: ledgerConn.db,
    ledgerPool: makeTestLedgerPool(ledgerConn),
  });
});

afterAll(async () => {
  await app.close();
  controlConn.close();
  ledgerConn.close();
});

describe("GET /runtime/policy", () => {
  it("returns leg_local default with version 0", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/runtime/policy",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ continuationMode: "leg_local", continuationModeVersion: 0 });
  });
});

describe("PATCH /runtime/policy", () => {
  it("flips to market_wide and bumps version", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/runtime/policy",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { continuationMode: "market_wide", reason: "test flip" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.continuationMode).toBe("market_wide");
    expect(body.data.continuationModeVersion).toBeGreaterThanOrEqual(1);
    expect(body.data.changed).toBe(true);

    const recorded = controlConn.db
      .prepare(
        "SELECT action, reason FROM operator_commands WHERE action LIKE 'set_continuation_mode:%' ORDER BY id DESC LIMIT 1",
      )
      .get() as { action: string; reason: string } | undefined;
    expect(recorded?.action).toBe("set_continuation_mode:market_wide");
    expect(recorded?.reason).toBe("test flip");
  });

  it("is idempotent on same value", async () => {
    const first = await app.inject({
      method: "PATCH",
      url: "/api/v1/runtime/policy",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { continuationMode: "leg_local" },
    });
    const v1 = first.json().data.continuationModeVersion;
    const second = await app.inject({
      method: "PATCH",
      url: "/api/v1/runtime/policy",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { continuationMode: "leg_local" },
    });
    expect(second.json().data.changed).toBe(false);
    expect(second.json().data.continuationModeVersion).toBe(v1);
  });

  it("rejects invalid continuationMode", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/runtime/policy",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { continuationMode: "yolo" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_CONTINUATION_MODE");
  });
});
