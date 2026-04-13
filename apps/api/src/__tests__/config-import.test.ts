import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapControlDb, bootstrapLedgerDb } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

// ─── Fixtures ──────────────────────────────────────────────────────────

const TEST_API_KEY = "test-key-config";

const FAMILY_YAML = `
version: 1
global:
  initial_balance_usdc: 100
families:
  - family_id: "test-fam:generic:daily"
    identity:
      family_key: "test-fam"
      primary_category: "crypto"
      regime: "generic"
      horizon: "daily"
      cadence: "daily-dated"
      strategy_profile: "scalp"
    evidence:
      evidence_status: "unknown"
      evidence_score: 0
      promotion_state: "probe-only"
      local_trade_count: 0
      local_market_count: 0
      local_realized_pnl_fifo: 0
      open_tail_cost_usdc: 0
      tail_adjusted_pnl: 0
      both_sided_eligible: false
      heavy_campaign_eligible: false
    rules:
      universe:
        enabled: true
        action: "trade"
        priority_rank: 10
        session_mode: "active-window"
      entry:
        entry_mode: "probe-first"
        min_entry_price: 0.02
        max_entry_price: 0.30
        max_initial_notional_usdc: 5
        allow_high_price_one_shot: false
        high_price_threshold: 0.20
        require_proven_family_above_price: 0.20
        probe_size_usdc: 5
        add_size_usdc: 4
      scale_in:
        scale_mode: "confirm-only"
        default_max_buys_per_leg: 3
        heavy_max_buys_per_leg: 6
        allow_heavy_campaigns: false
        require_positive_recycle_history_for_scale: true
      exit:
        exit_mode: "repricing-sell"
        primary_profit_model: "sell-into-strength"
        allow_runner_extension: false
        prefer_fast_recycle: true
        resolution_holding_allowed: false
        resolution_buffer_minutes: 60
      two_sided:
        allow_two_sided: false
        two_sided_mode: "disabled"
      tail_suppression:
        max_open_value_usdc: 50
        max_active_markets: 5
        max_dust_positions: 3
        tail_quarantine_threshold_usdc: 50
        tail_quarantine_threshold_ratio: 1.0
        stale_tail_prune_enabled: false
        threshold_cleanup_required: false
        auto_settle_resolved_markets: true
      session:
        active_windows_utc:
          - start: "14:00"
            end: "21:00"
        reduced_windows_utc: []
        weekday_bias: "normal"
`;

const DEFAULTED_FAMILY_YAML = FAMILY_YAML.replace(
  'family_id: "test-fam:generic:daily"',
  'family_id: "defaulted-fam:generic:daily"',
)
  .replace('family_key: "test-fam"', 'family_key: "defaulted-fam"')
  .replace(
    "global:\n  initial_balance_usdc: 100\n",
    [
      "global:",
      "  initial_balance_usdc: 100",
      "defaults:",
      "  entry:",
      "    min_entry_price: 0.02",
      "    max_entry_price: 0.30",
      "    high_price_threshold: 0.20",
      "    require_proven_family_above_price: 0.20",
      '    preferred_entry_band: "0.02-0.30"',
      "",
    ].join("\n"),
  )
  .replace(/^\s*max_entry_price: 0\.30\n/m, "");

function makeTwoFamilyYaml(secondId: string, secondKey: string): string {
  return (
    FAMILY_YAML +
    `
  - family_id: "${secondId}"
    identity:
      family_key: "${secondKey}"
      primary_category: "crypto"
      regime: "generic"
      horizon: "daily"
      cadence: "daily-dated"
      strategy_profile: "scalp"
    evidence:
      evidence_status: "unknown"
      evidence_score: 0
      promotion_state: "probe-only"
      local_trade_count: 0
      local_market_count: 0
      local_realized_pnl_fifo: 0
      open_tail_cost_usdc: 0
      tail_adjusted_pnl: 0
      both_sided_eligible: false
      heavy_campaign_eligible: false
    rules:
      universe:
        enabled: true
        action: "monitor"
        priority_rank: 20
        session_mode: "active-window"
      entry:
        entry_mode: "probe-first"
        min_entry_price: 0.02
        max_entry_price: 0.30
        max_initial_notional_usdc: 5
        allow_high_price_one_shot: false
        high_price_threshold: 0.20
        require_proven_family_above_price: 0.20
        probe_size_usdc: 5
        add_size_usdc: 4
      scale_in:
        scale_mode: "disabled"
        default_max_buys_per_leg: 3
        heavy_max_buys_per_leg: 6
        allow_heavy_campaigns: false
        require_positive_recycle_history_for_scale: true
      exit:
        exit_mode: "disabled"
        primary_profit_model: "sell-into-strength"
        allow_runner_extension: false
        prefer_fast_recycle: true
        resolution_holding_allowed: false
        resolution_buffer_minutes: 60
      two_sided:
        allow_two_sided: false
        two_sided_mode: "disabled"
      tail_suppression:
        max_open_value_usdc: 50
        max_active_markets: 5
        max_dust_positions: 3
        tail_quarantine_threshold_usdc: 50
        tail_quarantine_threshold_ratio: 1.0
        stale_tail_prune_enabled: false
        threshold_cleanup_required: false
        auto_settle_resolved_markets: true
      session:
        active_windows_utc: []
        reduced_windows_utc: []
        weekday_bias: "normal"
`
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────

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

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}`, "content-type": "application/json" };
}

function json(res: { json: () => unknown }): any {
  return res.json();
}

let controlConn: DbConnection;
let ledgerConn: DbConnection;
let conn: { db: DbConnection["db"] };
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  controlConn = bootstrapControlDb(":memory:");
  ledgerConn = bootstrapLedgerDb(":memory:");
  const db = controlConn.db;
  conn = { db };

  // Seed profiles (required by foreign keys in family_deployments)
  db.exec(`
    INSERT INTO profiles (profile_id, display_name) VALUES ('simulation', 'Sim');
    INSERT INTO profiles (profile_id, display_name) VALUES ('paper', 'Paper');
    INSERT INTO profiles (profile_id, display_name) VALUES ('live-lite', 'Live');
    INSERT INTO runtime_control_state (id, desired_profile, paused, runtime_status, schema_version, updated_at)
    VALUES (1, 'simulation', 1, 'stopped', 1, datetime('now'));
  `);

  app = await buildServer({
    config: testConfig(),
    controlDb: db,
    ledgerDb: ledgerConn.db,
    ledgerPool: stubLedgerPool(),
  });
});

afterAll(async () => {
  await app.close();
  controlConn.close();
  ledgerConn.close();
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe("POST /config/import", () => {
  it("adds a new family on first import", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers: authHeaders(),
      payload: { yaml: FAMILY_YAML },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.added).toEqual(["test-fam:generic:daily"]);
    expect(body.data.updated).toEqual([]);
    expect(body.data.skipped).toEqual([]);
    expect(body.data.dryRun).toBe(false);

    // Verify DB state
    const catalog = conn.db
      .prepare("SELECT * FROM family_catalog WHERE family_id = ?")
      .get("test-fam:generic:daily") as Record<string, unknown>;
    expect(catalog).toBeDefined();
    expect(catalog["family_key"]).toBe("test-fam");

    const rules = conn.db
      .prepare("SELECT * FROM family_rules WHERE family_id = ?")
      .get("test-fam:generic:daily") as Record<string, unknown>;
    expect(rules).toBeDefined();
    expect(rules["action"]).toBe("trade");

    const deployments = conn.db
      .prepare("SELECT * FROM family_deployments WHERE family_id = ?")
      .all("test-fam:generic:daily") as Record<string, unknown>[];
    expect(deployments).toHaveLength(3);
    expect(
      deployments.find((d) => d["profile"] === "live-lite") as Record<string, unknown>,
    ).toMatchObject({
      enabled: 1,
      deployment_stage: "live-probe",
    });

    const importRecord = conn.db
      .prepare("SELECT * FROM config_imports WHERE imported_by = 'api'")
      .get() as Record<string, unknown>;
    expect(importRecord).toBeDefined();
    expect(importRecord["families_added"]).toBe(1);
    expect(importRecord["source_checksum"]).toBe(
      createHash("sha256").update(FAMILY_YAML).digest("hex"),
    );
  });

  it("classifies identical re-import as unchanged", async () => {
    // Re-import the same family (no operator edit, no content change)
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers: authHeaders(),
      payload: { yaml: FAMILY_YAML },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.added).toEqual([]);
    expect(body.data.updated).toEqual([]);
    expect(body.data.unchanged).toEqual(["test-fam:generic:daily"]);
  });

  it("accepts defaults.entry.max_entry_price and persists the effective family value", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers: authHeaders(),
      payload: { yaml: DEFAULTED_FAMILY_YAML },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.added).toEqual(["defaulted-fam:generic:daily"]);

    const rules = conn.db
      .prepare("SELECT max_entry_price FROM family_rules WHERE family_id = ?")
      .get("defaulted-fam:generic:daily") as { max_entry_price: number };
    const defaultsRow = conn.db
      .prepare(
        "SELECT min_entry_price, max_entry_price, preferred_entry_band FROM family_rule_defaults WHERE scope = 'global'",
      )
      .get() as {
      min_entry_price: number;
      max_entry_price: number;
      preferred_entry_band: string | null;
    };
    expect(rules.max_entry_price).toBe(0.3);
    expect(defaultsRow).toEqual({
      min_entry_price: 0.02,
      max_entry_price: 0.3,
      preferred_entry_band: "0.02-0.30",
    });
  });

  it("skips operator-edited family", async () => {
    // Simulate operator edit
    conn.db
      .prepare(
        "UPDATE family_config_meta SET last_operator_edit_at = datetime('now') WHERE family_id = ?",
      )
      .run("test-fam:generic:daily");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers: authHeaders(),
      payload: { yaml: FAMILY_YAML },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.skipped).toEqual(["test-fam:generic:daily"]);
    expect(body.data.updated).toEqual([]);
  });

  it("fails on family_key mismatch", async () => {
    // Clear operator edit to test key mismatch path
    conn.db
      .prepare("UPDATE family_config_meta SET last_operator_edit_at = NULL WHERE family_id = ?")
      .run("test-fam:generic:daily");

    // YAML with same family_id but different family_key
    const badYaml = FAMILY_YAML.replace('family_key: "test-fam"', 'family_key: "wrong-key"');
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers: authHeaders(),
      payload: { yaml: badYaml },
    });
    expect(res.statusCode).toBe(409);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FAMILY_KEY_CONFLICT");
  });

  it("dry-run returns report without applying changes", async () => {
    const yaml = makeTwoFamilyYaml("new-fam:generic:daily", "new-fam");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers: authHeaders(),
      payload: { yaml, dryRun: true },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.dryRun).toBe(true);
    expect(body.data.added).toContain("new-fam:generic:daily");

    // Verify nothing was written to DB
    const row = conn.db
      .prepare("SELECT 1 FROM family_catalog WHERE family_id = ?")
      .get("new-fam:generic:daily");
    expect(row).toBeUndefined();
  });

  it("returns 400 for invalid YAML", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers: authHeaders(),
      payload: { yaml: "not: valid: yaml: [" },
    });
    expect(res.statusCode).toBe(400);
    const body = json(res);
    expect(body.ok).toBe(false);
  });

  it("returns 400 when yaml field is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/config/import",
      headers: authHeaders(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = json(res);
    expect(body.error.code).toBe("MISSING_FIELD");
  });
});

describe("GET /config/export", () => {
  it("returns JSON snapshot with correct structure", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/config/export?format=json",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.catalog).toBeDefined();
    expect(body.data.rules).toBeDefined();
    expect(body.data.deployments).toBeDefined();
    expect(body.data.profiles).toBeDefined();
    expect(Array.isArray(body.data.catalog)).toBe(true);
    expect(body.data.catalog.length).toBeGreaterThan(0);
  });

  it("returns actual YAML content", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/config/export?format=yaml",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/yaml");

    // Parse the YAML response body
    const { parse } = await import("yaml");
    const doc = parse(res.body) as { version: number; families: Record<string, unknown>[] };
    expect(doc.version).toBe(1);
    expect(Array.isArray(doc.families)).toBe(true);
    const fam = doc.families[0]!;
    expect(fam["family_id"]).toBeDefined();
    expect(fam["identity"]).toBeDefined();
    expect(fam["rules"]).toBeDefined();
    const rules = fam["rules"] as Record<string, unknown>;
    expect(rules["universe"]).toBeDefined();
    expect(rules["entry"]).toBeDefined();
  });

  it("defaults to JSON format", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/config/export",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.catalog).toBeDefined();
  });
});
