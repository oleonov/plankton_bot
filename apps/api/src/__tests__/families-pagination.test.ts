import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-key-fam-pagination";

function testConfig(): AppConfig {
  return {
    runtimeMode: "simulation",
    logLevel: "error",
    dbPath: "",
    familyRulesPath: "",
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

  // Seed 5 families with distinct family_keys (alphabetical order: alpha, bravo, charlie, delta, echo)
  const families = [
    { id: "fam-alpha", key: "alpha-family" },
    { id: "fam-bravo", key: "bravo-family" },
    { id: "fam-charlie", key: "charlie-family" },
    { id: "fam-delta", key: "delta-family" },
    { id: "fam-echo", key: "echo-family" },
  ];
  for (const f of families) {
    db.prepare(
      `INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
       VALUES (?, ?, 'politics', 'standard', 'medium', 'daily', 'v1')`,
    ).run(f.id, f.key);
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

describe("families pagination", () => {
  it("first page loads with limit items", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families?limit=2",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.meta.totalCatalogCount).toBe(5);
    expect(body.data.meta.hasMore).toBe(true);
    expect(body.data.meta.nextCursor).not.toBeNull();
    // Sorted by family_key: first two should be alpha, bravo
    expect(body.data.items[0].familyKey).toBe("alpha-family");
    expect(body.data.items[1].familyKey).toBe("bravo-family");
  });

  it("next cursor navigates to second page", async () => {
    const res1 = await app.inject({
      method: "GET",
      url: "/api/v1/families?limit=2",
      headers: authHeaders(),
    });
    const cursor = json(res1).data.meta.nextCursor;

    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/families?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: authHeaders(),
    });
    const body2 = json(res2);
    expect(body2.data.items).toHaveLength(2);
    expect(body2.data.items[0].familyKey).toBe("charlie-family");
    expect(body2.data.items[1].familyKey).toBe("delta-family");
    expect(body2.data.meta.hasMore).toBe(true);
    expect(body2.data.meta.nextCursor).not.toBeNull();
  });

  it("last page has hasMore=false and nextCursor=null", async () => {
    // Page through to the last page
    let cursor: string | null = null;
    let body: any;
    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/v1/families?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/families?limit=2";
      const res = await app.inject({ method: "GET", url, headers: authHeaders() });
      body = json(res);
      if (!body.data.meta.hasMore) break;
      cursor = body.data.meta.nextCursor;
    }
    expect(body.data.meta.hasMore).toBe(false);
    expect(body.data.meta.nextCursor).toBeNull();
    // Last page should have 1 item (echo)
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].familyKey).toBe("echo-family");
  });

  it("totalCatalogCount is full count, not page count", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families?limit=2",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.meta.totalCatalogCount).toBe(5);
  });

  it("paginates through all families without loss or duplicates", async () => {
    const allKeys: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const url = cursor
        ? `/api/v1/families?limit=2&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/families?limit=2";
      const res = await app.inject({ method: "GET", url, headers: authHeaders() });
      const body = json(res);
      allKeys.push(...body.data.items.map((f: any) => f.familyKey));
      if (!body.data.meta.hasMore) break;
      cursor = body.data.meta.nextCursor;
    }
    expect(allKeys).toHaveLength(5);
    expect(new Set(allKeys).size).toBe(5);
  });

  it("default limit returns all families when count < 50", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.data.items).toHaveLength(5);
    expect(body.data.meta.hasMore).toBe(false);
    expect(body.data.meta.nextCursor).toBeNull();
  });

  it("scope=profile falls back to all and includes pagination meta", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/families?scope=profile&limit=2",
      headers: authHeaders(),
    });
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.meta.scope).toBe("all");
    expect(body.data.meta).toHaveProperty("nextCursor");
    expect(body.data.meta).toHaveProperty("hasMore");
  });
});
