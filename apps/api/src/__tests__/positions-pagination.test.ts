import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-key-pagination";

function testConfig(): AppConfig {
  return {
    runtimeMode: "simulation", logLevel: "error", dbPath: "", familyRulesPath: "",
    marketDataPollIntervalMs: 30_000, marketDataStaleThresholdMs: 120_000,
    strategyScanIntervalMs: 5_000, fillPollIntervalMs: 5_000,
    executionMaxConcurrency: 4, polyApiKey: undefined, polyApiSecret: undefined,
    polyPassphrase: undefined, polyPrivateKey: undefined,
    planktonApiKey: TEST_API_KEY, planktonApiPort: 0,
    planktonAuthUsername: undefined, planktonAuthPassword: undefined,
    planktonSessionSecret: undefined, trustProxy: false,
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

  // Seed 5 positions with distinct updated_at and cost_basis
  for (let i = 1; i <= 5; i++) {
    db.prepare(
      `INSERT INTO positions (position_id, token_id, family_id, side, size, avg_entry_price,
        cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
       VALUES (?, ?, 'fam-1', 'buy', 10, 0.1, ?, 0, 'open', ?, ?)`,
    ).run(
      `pos-${i}`, `tok-${i}`,
      i * 10, // cost_basis: 10, 20, 30, 40, 50
      `2026-04-01T0${i}:00:00Z`,
      `2026-04-01T0${i}:00:00Z`,
    );
  }

  app = await buildServer({ config: testConfig(), controlDb: conn.db, ledgerDb: conn.db, ledgerPool: stubLedgerPool() });
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
    expect(body.data.totalCount).toBe(5);
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

  it("last page has null nextCursor", async () => {
    const res1 = await app.inject({
      method: "GET", url: "/api/v1/positions?limit=2", headers: authHeaders(),
    });
    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/positions?limit=2&cursor=${encodeURIComponent(json(res1).data.nextCursor)}`,
      headers: authHeaders(),
    });
    const res3 = await app.inject({
      method: "GET",
      url: `/api/v1/positions?limit=2&cursor=${encodeURIComponent(json(res2).data.nextCursor)}`,
      headers: authHeaders(),
    });
    const body3 = json(res3);
    expect(body3.data.items).toHaveLength(1); // 5 total, 2+2+1
    expect(body3.data.nextCursor).toBeNull();
  });

  it("sort=tail_cost uses cost_basis_usdc for cursor", async () => {
    const res1 = await app.inject({
      method: "GET",
      url: "/api/v1/positions?limit=2&sort=tail_cost",
      headers: authHeaders(),
    });
    const body1 = json(res1);
    // Sorted by cost_basis DESC: 50, 40 → next page starts after 40
    expect(body1.data.items[0].costBasisUsdc).toBe(50);
    expect(body1.data.items[1].costBasisUsdc).toBe(40);
    expect(body1.data.nextCursor).toBe("40"); // cost_basis_usdc of last row

    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/positions?limit=2&sort=tail_cost&cursor=${body1.data.nextCursor}`,
      headers: authHeaders(),
    });
    const body2 = json(res2);
    // Next: 30, 20
    expect(body2.data.items[0].costBasisUsdc).toBe(30);
    expect(body2.data.items[1].costBasisUsdc).toBe(20);
  });
});
