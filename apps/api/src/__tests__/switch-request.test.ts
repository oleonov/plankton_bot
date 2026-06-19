import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrapDatabase } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-switch";

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

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json" };
}

function json(res: { json: () => unknown }): any {
  return res.json();
}

function seedControl(db: DbConnection["db"], currentProfile = "live-lite"): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS runtime_control_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_profile TEXT, desired_profile TEXT, current_switch_id TEXT,
      current_run_id TEXT, current_instance_id TEXT,
      runtime_status TEXT NOT NULL DEFAULT 'stopped',
      paused INTEGER NOT NULL DEFAULT 1, schema_version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS profile_switch_requests (
      switch_id TEXT PRIMARY KEY, from_profile TEXT NOT NULL, to_profile TEXT NOT NULL,
      ledger_reset_policy TEXT NOT NULL DEFAULT 'preserve', deploy_plan_json TEXT,
      state TEXT NOT NULL DEFAULT 'requested', error_message TEXT, archive_path TEXT,
      requested_by TEXT, requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS service_heartbeats (
      service_name TEXT NOT NULL, instance_id TEXT NOT NULL,
      profile TEXT, run_id TEXT, last_heartbeat_at TEXT NOT NULL, status_json TEXT,
      PRIMARY KEY (service_name, instance_id)
    );
    INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES ('simulation', 'Sim');
    INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES ('paper', 'Paper');
    INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES ('live-lite', 'Live');
  `);
  db.prepare(
    `INSERT INTO runtime_control_state
       (id, current_profile, desired_profile, runtime_status, paused, schema_version, updated_at)
     VALUES (1, ?, ?, 'running', 0, 1, datetime('now'))`,
  ).run(currentProfile, currentProfile);
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

async function buildApp(): Promise<void> {
  app = await buildServer({
    config: testConfig(),
    controlDb: conn.db,
    ledgerDb: conn.db,
    ledgerPool: stubLedgerPool(),
  });
}

// Rebuild the server against a fresh control DB seeded with a given current profile.
async function rebuildWith(currentProfile: string): Promise<void> {
  await app.close();
  conn.close();
  conn = bootstrapDatabase(":memory:");
  seedControl(conn.db, currentProfile);
  await buildApp();
}

beforeEach(async () => {
  conn = bootstrapDatabase(":memory:");
  seedControl(conn.db);
  await buildApp();
});

afterEach(async () => {
  await app.close();
  conn.close();
});

describe("POST /actions/switch-profile", () => {
  it("returns 400 when toProfile is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe("MISSING_FIELD");
  });

  it.each(["paper", "simulation", "nonexistent"])(
    "rejects unsupported target %s before inserting a switch request",
    async (toProfile) => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/actions/switch-profile",
        headers: authHeaders(),
        payload: { toProfile },
      });

      expect(res.statusCode).toBe(409);
      expect(json(res).error.code).toBe("UNSUPPORTED_RUNTIME_PROFILE");
      const row = conn.db.prepare("SELECT COUNT(*) AS c FROM profile_switch_requests").get() as {
        c: number;
      };
      expect(row.c).toBe(0);
    },
  );

  it("returns 409 when switching to the current live-lite profile", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: { toProfile: "live-lite" },
    });

    expect(res.statusCode).toBe(409);
    expect(json(res).error.code).toBe("SAME_PROFILE");
  });

  it("creates a live-lite switch request from a historical non-runtime current profile", async () => {
    await rebuildWith("paper");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: { toProfile: "live-lite" },
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("requested");

    const row = conn.db
      .prepare("SELECT * FROM profile_switch_requests WHERE switch_id = ?")
      .get(body.data.switchId) as Record<string, unknown>;
    expect(row.from_profile).toBe("paper");
    expect(row.to_profile).toBe("live-lite");
    expect(row.ledger_reset_policy).toBe("preserve");
    expect(row.state).toBe("requested");
  });

  it("returns 409 SWITCH_IN_PROGRESS for a supported live-lite request when a switch is already active", async () => {
    // Current profile is historical (paper) so the supported live-lite target passes the
    // unsupported-profile precheck and reaches the in-progress precheck instead of being masked.
    await rebuildWith("paper");

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: { toProfile: "live-lite" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: { toProfile: "live-lite" },
    });

    expect(second.statusCode).toBe(409);
    expect(json(second).error.code).toBe("SWITCH_IN_PROGRESS");
  });
});
