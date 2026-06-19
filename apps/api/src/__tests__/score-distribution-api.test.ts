/**
 * Score-distribution API tests (Step 3, audit doc §F6 / §F9 / §P4).
 *
 * Covers:
 *   - 503 when no snapshot row exists yet
 *   - 200 + parsed JSON envelope when a snapshot is present
 *   - Returns the latest snapshot when multiple rows exist
 *   - 503 + CORRUPT_SNAPSHOT when labels JSON is malformed
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { bootstrapControlDb, bootstrapLedgerDb } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-score-distribution";

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

const authHeaders = () => ({ authorization: `Bearer ${TEST_API_KEY}` });

let controlConn: DbConnection;
let ledgerConn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

function clearMetrics(): void {
  ledgerConn.db
    .prepare("DELETE FROM runtime_metrics WHERE metric_name = ?")
    .run("score_distribution");
}

function insertSnapshot(payload: unknown, capturedAt: string): void {
  ledgerConn.db
    .prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, ?, ?, ?)",
    )
    .run("score_distribution", 1, JSON.stringify(payload), capturedAt);
}

function insertRawLabels(labels: string, capturedAt: string): void {
  ledgerConn.db
    .prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, ?, ?, ?)",
    )
    .run("score_distribution", 1, labels, capturedAt);
}

beforeAll(async () => {
  controlConn = bootstrapControlDb(":memory:");
  ledgerConn = bootstrapLedgerDb(":memory:");
  app = await buildServer({
    config: testConfig(),
    controlDb: controlConn.db,
    ledgerDb: ledgerConn.db,
    ledgerPool: stubLedgerPool(),
  });
});

afterAll(async () => {
  await app.close();
  ledgerConn.close();
  controlConn.close();
});

beforeEach(() => {
  clearMetrics();
});

describe("GET /api/v1/scanner/score-distribution", () => {
  it("returns 503 NO_SNAPSHOT when no row has been written yet", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scanner/score-distribution",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(503);
    const body: { ok: boolean; error: { code: string } } = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NO_SNAPSHOT");
  });

  it("returns the latest persisted snapshot", async () => {
    const earlier = {
      modelVersion: "v1",
      scoredMarkets: 5,
      step2IncludedNoScore: 0,
      skippedNonStep2Included: 0,
      staleMarkets: 0,
      histogram: [{ decile: 1, count: 5 }],
      mean: 0.05,
      median: 0.05,
      capturedAt: "2026-05-05T11:00:00Z",
    };
    const later = { ...earlier, scoredMarkets: 7, capturedAt: "2026-05-05T12:00:00Z" };
    insertSnapshot(earlier, "2026-05-05T11:00:00Z");
    insertSnapshot(later, "2026-05-05T12:00:00Z");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scanner/score-distribution",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: { ok: boolean; data: typeof later } = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.scoredMarkets).toBe(7);
    expect(body.data.capturedAt).toBe("2026-05-05T12:00:00Z");
  });

  it("returns 503 CORRUPT_SNAPSHOT when labels JSON is malformed", async () => {
    insertRawLabels("{not-json", "2026-05-05T12:00:00Z");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scanner/score-distribution",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(503);
    const body: { ok: boolean; error: { code: string } } = res.json();
    expect(body.error.code).toBe("CORRUPT_SNAPSHOT");
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/scanner/score-distribution",
    });
    expect(res.statusCode).toBe(401);
  });
});
