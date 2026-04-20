import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

// ─── Test setup ─────────────────────────────────────────────────────

const TEST_API_KEY = "test-key-switch";

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

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json" };
}

function json(res: { json: () => unknown }): any {
  return res.json();
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  const db = conn.db;

  // Phase 1 control tables needed for switch-profile
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
    INSERT INTO runtime_control_state (id, current_profile, desired_profile, runtime_status, paused, schema_version, updated_at)
    VALUES (1, 'simulation', 'simulation', 'running', 0, 1, datetime('now'));
  `);

  app = await buildServer({
    config: testConfig(),
    controlDb: db,
    ledgerDb: db,
    ledgerPool: stubLedgerPool(),
  });
});

afterAll(async () => {
  await app.close();
  conn.close();
});

// ─── Switch-profile tests ───────────────────────────────────────────

describe("POST /actions/switch-profile", () => {
  it("returns 400 when toProfile is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("MISSING_FIELD");
  });

  it("returns 404 for nonexistent profile", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: { toProfile: "nonexistent" },
    });
    expect(res.statusCode).toBe(404);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("PROFILE_NOT_FOUND");
  });

  it("returns 409 when switching to the current profile", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: { toProfile: "simulation" },
    });
    expect(res.statusCode).toBe(409);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("SAME_PROFILE");
  });

  it("creates a switch request for a valid target profile", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: { toProfile: "paper" },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("requested");
    expect(typeof body.data.switchId).toBe("string");

    // Verify row in DB
    const row = conn.db
      .prepare("SELECT * FROM profile_switch_requests WHERE switch_id = ?")
      .get(body.data.switchId) as Record<string, unknown>;
    expect(row.from_profile).toBe("simulation");
    expect(row.to_profile).toBe("paper");
    expect(row.ledger_reset_policy).toBe("preserve");
    expect(row.state).toBe("requested");
    // Bearer API key auth → actor is "api_key"
    expect(row.requested_by).toBe("api_key");
  });

  it("returns 409 when a switch is already in progress", async () => {
    // Previous test left a 'requested' row in profile_switch_requests
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/switch-profile",
      headers: authHeaders(),
      payload: { toProfile: "live-lite" },
    });
    expect(res.statusCode).toBe(409);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("SWITCH_IN_PROGRESS");
  });
});
