import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-positions-phase";

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
    planktonApiKey: TEST_API_KEY,
    planktonApiPort: 0,
    planktonAuthUsername: undefined,
    planktonAuthPassword: undefined,
    planktonSessionSecret: undefined,
    allowSellSizeClamp: true,
    trustProxy: false,
    ...MARKET_DATA_TEST_DEFAULTS,
  };
}

interface PositionResponse {
  data: {
    items: Array<{
      positionId: string;
      tokenId: string;
      phase: string;
      buyCount: number;
      sellCount: number;
      lastAction: string | null;
      lastActionAt: string | null;
      status: string;
    }>;
    totalCount: number;
  };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

function seedPosition(
  db: DbConnection["db"],
  opts: { id: string; tok: string; status?: string; ts?: string },
): void {
  db.prepare(
    `INSERT INTO positions (position_id, token_id, side, size, avg_entry_price,
      cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
     VALUES (?, ?, 'buy', 10, 0.1, 2.10, 0, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.tok,
    opts.status ?? "open",
    opts.ts ?? "2026-04-20T10:00:00Z",
    opts.ts ?? "2026-04-20T10:00:00Z",
  );
}

function seedLegState(
  db: DbConnection["db"],
  opts: {
    tok: string;
    buyCount: number;
    sellCount: number;
    lastAction: "BUY" | "SELL";
    lastTradeAt?: string;
  },
): void {
  const ts = opts.lastTradeAt ?? "2026-04-24T12:00:00Z";
  db.prepare(
    `INSERT INTO leg_states (token_id, buy_count, sell_count, last_action,
      first_trade_price, first_trade_at, last_trade_at, updated_at)
     VALUES (?, ?, ?, ?, 0.1, ?, ?, ?)`,
  ).run(opts.tok, opts.buyCount, opts.sellCount, opts.lastAction, ts, ts, ts);
}

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  const db = conn.db;

  // Scenario matrix covering each phase + edge cases.
  seedPosition(db, { id: "pos-s0-closed", tok: "tok-s0-closed", status: "closed" });
  seedLegState(db, { tok: "tok-s0-closed", buyCount: 1, sellCount: 1, lastAction: "SELL" });

  seedPosition(db, { id: "pos-s2-dust", tok: "tok-s2-dust", status: "dust" });
  seedLegState(db, { tok: "tok-s2-dust", buyCount: 2, sellCount: 0, lastAction: "BUY" });

  seedPosition(db, { id: "pos-s0-no-leg", tok: "tok-s0-no-leg", status: "open" });
  // intentionally no leg_state row for tok-s0-no-leg

  seedPosition(db, { id: "pos-s1", tok: "tok-s1", status: "open" });
  seedLegState(db, { tok: "tok-s1", buyCount: 1, sellCount: 0, lastAction: "BUY" });

  seedPosition(db, { id: "pos-s2", tok: "tok-s2", status: "open" });
  seedLegState(db, { tok: "tok-s2", buyCount: 3, sellCount: 0, lastAction: "BUY" });

  seedPosition(db, { id: "pos-s3", tok: "tok-s3", status: "open" });
  seedLegState(db, { tok: "tok-s3", buyCount: 2, sellCount: 1, lastAction: "SELL" });

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

describe("GET /positions — phase + leg state enrichment", () => {
  it("returns phase + buyCount + sellCount + lastAction + lastActionAt for every row", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?limit=20",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: PositionResponse = res.json();
    const byId = Object.fromEntries(body.data.items.map((p) => [p.positionId, p]));

    expect(byId["pos-s0-closed"]).toMatchObject({ phase: "S0" });
    expect(byId["pos-s2-dust"]).toMatchObject({ phase: "S2" });
    expect(byId["pos-s0-no-leg"]).toMatchObject({
      phase: "S0",
      buyCount: 0,
      sellCount: 0,
      lastAction: null,
      lastActionAt: null,
    });
    expect(byId["pos-s1"]).toMatchObject({
      phase: "S1",
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
    });
    expect(byId["pos-s1"]!.lastActionAt).toBe("2026-04-24T12:00:00Z");
    expect(byId["pos-s2"]).toMatchObject({
      phase: "S2",
      buyCount: 3,
      sellCount: 0,
      lastAction: "BUY",
    });
    expect(byId["pos-s3"]).toMatchObject({
      phase: "S3",
      buyCount: 2,
      sellCount: 1,
      lastAction: "SELL",
    });
  });

  it("GET /positions/:id also returns phase + leg state for a single lookup", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions/pos-s2",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body: { data: { phase: string; buyCount: number; lastAction: string } } = res.json();
    expect(body.data.phase).toBe("S2");
    expect(body.data.buyCount).toBe(3);
    expect(body.data.lastAction).toBe("BUY");
  });
});
