import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-key-pagination";

function testConfig(): AppConfig {
  return {
    runtimeMode: "simulation",
    logLevel: "error",
    dbPath: "",
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
  };
}

function json(res: { json: () => unknown }): any {
  return res.json();
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  const db = conn.db;

  // Seed 7 positions: 5 with distinct costs + 2 with duplicate cost (40)
  const seeds = [
    { id: "pos-1", tok: "tok-1", cost: 10, ts: "2026-04-01T01:00:00Z" },
    { id: "pos-2", tok: "tok-2", cost: 20, ts: "2026-04-01T02:00:00Z" },
    { id: "pos-3", tok: "tok-3", cost: 30, ts: "2026-04-01T03:00:00Z" },
    { id: "pos-4", tok: "tok-4", cost: 40, ts: "2026-04-01T04:00:00Z" },
    { id: "pos-5", tok: "tok-5", cost: 50, ts: "2026-04-01T05:00:00Z" },
    { id: "pos-6", tok: "tok-6", cost: 40, ts: "2026-04-01T06:00:00Z" }, // duplicate cost
    { id: "pos-7", tok: "tok-7", cost: 40, ts: "2026-04-01T07:00:00Z" }, // duplicate cost
  ];
  for (const s of seeds) {
    db.prepare(
      `INSERT INTO positions (position_id, token_id, side, size, avg_entry_price,
        cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
       VALUES (?, ?, 'buy', 10, 0.1, ?, 0, 'open', ?, ?)`,
    ).run(s.id, s.tok, s.cost, s.ts, s.ts);
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

describe("positions pagination", () => {
  it("returns first page with nextCursor and totalCount", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/positions?limit=2",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.totalCount).toBe(7);
    expect(body.data.nextCursor).not.toBeNull();
  });

  it("second page uses cursor from first page", async () => {
    const res1 = await app.inject({
      method: "GET",
      url: "/api/v1/positions?limit=2",
      headers: authHeaders(),
    });
    const cursor = json(res1).data.nextCursor;

    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/positions?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: authHeaders(),
    });
    const body2 = json(res2);
    expect(body2.data.items).toHaveLength(2);

    // No overlap with first page
    const ids1 = json(res1).data.items.map((p: any) => p.positionId);
    const ids2 = body2.data.items.map((p: any) => p.positionId);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });

  it("paginates through all positions without loss or duplicates", async () => {
    const allIds: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/v1/positions?limit=3&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/positions?limit=3";
      const res = await app.inject({ method: "GET", url, headers: authHeaders() });
      const body = json(res);
      allIds.push(...body.data.items.map((p: any) => p.positionId));
      if (!body.data.nextCursor) break;
      cursor = body.data.nextCursor;
    }
    // All 7 positions collected, no duplicates
    expect(allIds).toHaveLength(7);
    expect(new Set(allIds).size).toBe(7);
  });

  it("sort=tail_cost paginates through all positions including duplicate costs", async () => {
    const allIds: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/v1/positions?limit=2&sort=tail_cost&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/positions?limit=2&sort=tail_cost";
      const res = await app.inject({ method: "GET", url, headers: authHeaders() });
      const body = json(res);
      allIds.push(...body.data.items.map((p: any) => p.positionId));
      if (!body.data.nextCursor) break;
      cursor = body.data.nextCursor;
    }
    // All 7 positions collected, no duplicates — including the three with cost=40
    expect(allIds).toHaveLength(7);
    expect(new Set(allIds).size).toBe(7);
  });
});
