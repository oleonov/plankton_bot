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
  ensureColumn("positions", "consecutive_state_failed_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("positions", "redeem_quarantine_until_ts", "INTEGER");
  ensureColumn("positions", "last_state_failed_ts", "INTEGER");
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
  const quarantineUntil = Date.now() + 60 * 60_000;
  const lastStateFailed = Date.now() - 30 * 60_000;
  conn.db
    .prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, status, opened_at, updated_at,
          consecutive_state_failed_count, redeem_quarantine_until_ts, last_state_failed_ts)
       VALUES
         ('pos-quarantine', 'tok-quarantine', 'cond-quarantine', 'buy', 1, 0.5,
          0.5, 0, 'open', datetime('now'), datetime('now'), 5, ?, ?)`,
    )
    .run(quarantineUntil, lastStateFailed);
  conn.db
    .prepare("INSERT INTO risk_events (event_type, payload) VALUES (?, ?)")
    .run("redeem_quarantine_expired", "{}");
  conn.db
    .prepare("INSERT INTO risk_events (event_type, payload) VALUES (?, ?)")
    .run("redeem_quarantine_manual_reset", "{}");
  app = await buildServer({
    config: testConfig(),
    controlDb: conn.db,
    ledgerDb: conn.db,
    ledgerPool: stubLedgerPool(),
  });
});

afterAll(async () => {
  await app?.close();
  conn?.close();
});

function ensureColumn(table: string, column: string, definition: string): void {
  const columns = conn.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  conn.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

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

  it("returns quarantine summary fields", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/redeem-log/quarantine-summary",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const json = body(res);
    expect(json.data).toMatchObject({
      quarantined_count: 1,
      total_basis_usdc: 0.5,
      oldest_quarantine_age_hours: expect.any(Number),
      expired_24h: 1,
      manual_resets_24h: 1,
    });
    expect(json.data.oldest_quarantine_age_hours).toBeGreaterThan(0);
  });
});
