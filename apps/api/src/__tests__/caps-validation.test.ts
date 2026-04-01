import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-key-caps";

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS family_deployments (
      family_id TEXT NOT NULL, profile TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      operator_mode TEXT NOT NULL DEFAULT 'active', strategy_stage TEXT NOT NULL DEFAULT 'probe-only',
      deployment_stage TEXT NOT NULL DEFAULT 'disabled', priority INTEGER NOT NULL DEFAULT 999,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (family_id, profile)
    )
  `);
  const now = new Date().toISOString();

  // Seed candidate for accept tests
  db.prepare(
    `INSERT INTO family_candidates
       (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
        primary_category, strategy_profile, active_market_count,
        cluster_volume_24h, gate_recommendation, status, first_seen_at, last_seen_at)
     VALUES ('caps-test-1', 'caps-key', 'standard', 'daily', 'daily', 'high',
             'crypto', 'scalp', 2, 1000, 'probe-candidate', 'discovered', ?, ?)`,
  ).run(now, now);

  // Seed family + proposal for promote tests
  db.prepare(
    `INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
     VALUES ('fam-caps', 'fam-caps-key', 'crypto', 'standard', 'daily', 'daily', 'v1')`,
  ).run();
  db.prepare(
    `INSERT INTO family_rules (family_id, enabled, max_open_value_usdc, max_active_markets, max_dust_positions)
     VALUES ('fam-caps', 1, 10, 3, 2)`,
  ).run();
  db.prepare(
    `INSERT INTO promotion_proposals (family_id, current_state, proposed_state, reason, scores_snapshot, status)
     VALUES ('fam-caps', 'probe-only', 'scaled', 'test', '{}', 'pending')`,
  ).run();

  app = await buildServer({ config: testConfig(), controlDb: conn.db, ledgerDb: conn.db, ledgerPool: stubLedgerPool() });
});

afterAll(async () => {
  await app.close();
  conn.close();
});

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json" };
}

describe("accept caps validation", () => {
  it("rejects maxOpenValueUsdc = 0", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/candidates/caps-test-1/accept",
      headers: authHeaders(),
      payload: { maxOpenValueUsdc: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe("INVALID_CAPS");
  });

  it("rejects negative maxActiveMarkets", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/candidates/caps-test-1/accept",
      headers: authHeaders(),
      payload: { maxActiveMarkets: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-integer maxActiveMarkets", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/candidates/caps-test-1/accept",
      headers: authHeaders(),
      payload: { maxActiveMarkets: 2.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects negative maxDustPositions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/candidates/caps-test-1/accept",
      headers: authHeaders(),
      payload: { maxDustPositions: -1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts valid custom caps", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/candidates/caps-test-1/accept",
      headers: authHeaders(),
      payload: { maxOpenValueUsdc: 25, maxActiveMarkets: 4, maxDustPositions: 3 },
    });
    expect(res.statusCode).toBe(200);

    // Verify caps were written to family_rules
    const rules = conn.db
      .prepare("SELECT max_open_value_usdc, max_active_markets, max_dust_positions FROM family_rules WHERE family_id = 'caps-test-1'")
      .get() as { max_open_value_usdc: number; max_active_markets: number; max_dust_positions: number };
    expect(rules.max_open_value_usdc).toBe(25);
    expect(rules.max_active_markets).toBe(4);
    expect(rules.max_dust_positions).toBe(3);

    // Verify family_deployments were created for all profiles
    const deployments = conn.db
      .prepare("SELECT profile, enabled FROM family_deployments WHERE family_id = 'caps-test-1' ORDER BY profile")
      .all() as { profile: string; enabled: number }[];
    expect(deployments).toHaveLength(3);
    expect(deployments.find((d) => d.profile === "paper")?.enabled).toBe(1);
    expect(deployments.find((d) => d.profile === "simulation")?.enabled).toBe(1);
    expect(deployments.find((d) => d.profile === "live-lite")?.enabled).toBe(0);
  });
});

describe("promote caps validation", () => {
  it("rejects maxOpenValueUsdc = 0", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-caps/promote",
      headers: authHeaders(),
      payload: { maxOpenValueUsdc: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe("INVALID_CAPS");
  });

  it("rejects non-integer maxDustPositions", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-caps/promote",
      headers: authHeaders(),
      payload: { maxDustPositions: 1.5 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts valid custom caps", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-caps/promote",
      headers: authHeaders(),
      payload: { maxOpenValueUsdc: 75, maxActiveMarkets: 8, maxDustPositions: 4 },
    });
    expect(res.statusCode).toBe(200);

    // Caps are encoded in the command reason as JSON
    const cmd = conn.db
      .prepare("SELECT reason FROM operator_commands WHERE action = 'family_promote_scaled' AND target_id = 'fam-caps'")
      .get() as { reason: string };
    const parsed = JSON.parse(cmd.reason);
    expect(parsed.caps.maxOpenValueUsdc).toBe(75);
    expect(parsed.caps.maxActiveMarkets).toBe(8);
    expect(parsed.caps.maxDustPositions).toBe(4);
  });

  it("accepts promote without caps (uses defaults)", async () => {
    // Re-seed a pending proposal
    conn.db.prepare(
      `INSERT INTO promotion_proposals (family_id, current_state, proposed_state, reason, scores_snapshot, status)
       VALUES ('fam-caps', 'probe-only', 'scaled', 'test2', '{}', 'pending')`,
    ).run();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/fam-caps/promote",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    // Reason is plain text, no caps JSON
    const cmd = conn.db
      .prepare("SELECT reason FROM operator_commands WHERE action = 'family_promote_scaled' AND target_id = 'fam-caps' ORDER BY id DESC LIMIT 1")
      .get() as { reason: string | null };
    // No caps → reason is null or plain string
    expect(cmd.reason).toBeNull();
  });
});
