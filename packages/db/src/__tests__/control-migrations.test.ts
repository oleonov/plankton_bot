import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb } from "../bootstrap.js";
import { runControlMigrations, runMigrations } from "../migrations/runner.js";
import type { DbConnection } from "../connection.js";
import Database from "better-sqlite3";

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-control-migr-"));
});

afterEach(() => {
  if (conn) conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("control-db migration infrastructure", () => {
  it("bootstrapControlDb creates schema_migrations table", () => {
    conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    const row = conn.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
      .get();
    expect(row).toBeDefined();
  });

  it("is idempotent — second bootstrap on same file does not error", () => {
    const dbPath = path.join(tmpDir, "control.db");
    conn = bootstrapControlDb(dbPath);
    conn.close();
    conn = bootstrapControlDb(dbPath);

    const tables = conn.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
  });

  it("fresh bootstrap seeds per-migration baselines as already-applied", () => {
    conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    const applied = conn.db.prepare("SELECT name FROM schema_migrations").all() as {
      name: string;
    }[];
    // Fresh control.sql already reflects post-031 shape, so 031 is seeded as applied.
    expect(applied.map((r) => r.name)).toContain("031_flatten_family_deployments.sql");
    // Fresh control.sql has no family_ tables, so 036 is also seeded as applied.
    expect(applied.map((r) => r.name)).toContain("036_drop_family_tables.sql");
    // Fresh control.sql has no legacy archive tables, so 039 is also seeded as applied.
    expect(applied.map((r) => r.name)).toContain("039_drop_legacy_archive_tables.sql");
  });

  it("runner picks up a SQL file from an arbitrary migrationsDir", () => {
    const migrDir = path.join(tmpDir, "migrations-test");
    mkdirSync(migrDir);
    writeFileSync(
      path.join(migrDir, "099_test.sql"),
      `CREATE TABLE IF NOT EXISTS migr_test (id INTEGER PRIMARY KEY);`,
    );

    const db = new Database(path.join(tmpDir, "runner.db"));
    try {
      runMigrations(db, migrDir);
      const applied = db.prepare("SELECT name FROM schema_migrations").all() as {
        name: string;
      }[];
      expect(applied.map((r) => r.name)).toContain("099_test.sql");
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migr_test'`)
        .get();
      expect(tables).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("runControlMigrations is callable and uses the migrations-control folder", () => {
    conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    // Second call is guaranteed idempotent — no throw.
    expect(() => runControlMigrations(conn.db)).not.toThrow();
  });

  it("migration 039 drops legacy archive tables", () => {
    const db = new Database(path.join(tmpDir, "archive-cleanup.db"));
    try {
      db.exec(`
        CREATE TABLE archive_candidate_observation_markets_034 (id INTEGER);
        CREATE TABLE archive_candidate_observations_034 (id INTEGER);
        CREATE TABLE archive_family_candidates_034 (id INTEGER);
        CREATE TABLE archive_discovery_runs_034 (id INTEGER);
        CREATE TABLE archive_promotion_proposals_034 (id INTEGER);
        CREATE TABLE archive_family_deployments_031 (id INTEGER);
        CREATE TABLE archive_family_deployments_033 (id INTEGER);
      `);

      const sql = readFileSync(
        path.join(
          import.meta.dirname,
          "..",
          "migrations-control",
          "039_drop_legacy_archive_tables.sql",
        ),
        "utf-8",
      );
      db.exec(sql);

      const archiveTables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'archive_%'")
        .all() as Array<{ name: string }>;
      expect(archiveTables).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("bootstrapControlDb applies migration 039 when any legacy archive table remains", () => {
    const dbPath = path.join(tmpDir, "control-partial-archives.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("039_drop_legacy_archive_tables.sql");
    conn.db.exec("CREATE TABLE archive_discovery_runs_034 (id INTEGER)");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const archiveTable = conn.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'archive_discovery_runs_034'",
      )
      .get();
    expect(archiveTable).toBeUndefined();
  });

  it("fresh bootstrap seeds profile_settings.execution_policy_json for every profile", () => {
    // Regression: migration 038 is marked applied by column existence on fresh
    // installs, so its UPDATE path never runs. ensureDefaultExecutionPolicy
    // must seed the JSON payload independently.
    conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    const rows = conn.db
      .prepare(
        `SELECT p.profile_id, s.execution_policy_json
           FROM profiles p
           LEFT JOIN profile_settings s USING (profile_id)`,
      )
      .all() as Array<{ profile_id: string; execution_policy_json: string | null }>;

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.execution_policy_json).not.toBeNull();
      const parsed = JSON.parse(row.execution_policy_json!) as {
        entryPriceCeiling: number;
        marketSelection: { maxMidPrice: number; minLiquidity: number };
        buyCapacity: {
          enabled: boolean;
          minNewEntryWalletHeadroomUsdc: number;
          minAddWalletHeadroomUsdc: number;
          maxOpenBuyOrders: number;
          maxOpenBuyOrdersPerToken: number;
        };
        sellCapacity: {
          enabled: boolean;
          maxOpenSellOrders: number;
          maxOpenSellOrdersPerToken: number;
        };
        orderCapacity: {
          enabled: boolean;
          maxOpenOrdersTotal: number;
        };
        exitBidAnchorTicks: number;
        opportunisticTaker: {
          enabled: boolean;
          maxSpreadTicks: number;
        };
        exitOrderTtlMs: number;
        exitTtlByLiquidity: {
          enabled: boolean;
          thinMs: number;
          mediumMs: number;
        };
        sellReplaceMinPriceDeltaTicks: number;
        multiBuyLadder: {
          enabled: boolean;
          maxLadderFillsPerToken: number;
          ladderGapMs: number;
          perTokenUsdcCap: number;
          maxPriceDriftTicks: number;
          minStepFillRate: number;
        };
        deadSideGuard: { mode: string };
      };
      expect(parsed.entryPriceCeiling).toBe(0.45);
      expect(parsed.marketSelection).toEqual({
        maxMidPrice: 0.5,
        minLiquidity: 100,
        shortLifetime: { enabled: false, thresholdHours: 1 },
      });
      expect(parsed.buyCapacity).toEqual({
        enabled: true,
        minNewEntryWalletHeadroomUsdc: 7,
        minAddWalletHeadroomUsdc: 5,
        minViableEntryUsdc: 1,
        maxOpenBuyOrders: 25,
        maxOpenBuyOrdersPerToken: 2,
      });
      expect(parsed.sellCapacity).toEqual({
        enabled: true,
        mode: "legacy_global",
        maxOpenSellOrders: 10,
        maxOpenSellOrdersPerToken: 2,
        profileLadderLiveRungsPerPosition: 2,
        minNonLadderReserve: 10,
        nonLadderReserveRatio: 0.25,
        hardMaxOpenSellOrders: 200,
      });
      expect(parsed.orderCapacity).toEqual({
        enabled: true,
        maxOpenOrdersTotal: 22,
      });
      expect(parsed.exitBidAnchorTicks).toBe(4);
      expect(parsed.exitOrderTtlMs).toBe(4 * 60 * 60_000);
      expect(parsed.exitTtlByLiquidity).toEqual({
        enabled: true,
        thinMs: 24 * 60 * 60_000,
        mediumMs: 6 * 60 * 60_000,
      });
      expect(parsed.sellReplaceMinPriceDeltaTicks).toBe(2);
      expect(parsed.opportunisticTaker).toEqual({
        enabled: true,
        maxSpreadTicks: 2,
        safetyBuffer: 1.05,
        fallbackMinNotionalUsdc: 1,
        marketableBuyMinNotionalUsdc: 1,
      });
      expect(parsed.multiBuyLadder).toEqual({
        enabled: true,
        maxLadderFillsPerToken: 15,
        ladderGapMs: 60_000,
        perTokenUsdcCap: 25,
        maxPriceDriftTicks: 5,
        minStepFillRate: 0.1,
      });
      expect(parsed.deadSideGuard.mode).toBe(
        row.profile_id === "live-lite" ? "enforce" : "observe",
      );
    }
  });

  it("migration 058 updates live-lite SELL execution policy without overwriting TTL overrides", () => {
    const dbPath = path.join(tmpDir, "control-mid-bucket-sell.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.exitOrderTtlMs',
              900000,
              '$.opportunisticTaker.sides',
              json('["buy","sell"]')
            )
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(
              execution_policy_json,
              '$.sellReplaceMinPriceDeltaTicks'
            )
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("058_mid_bucket_sell_execution_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const row = conn.db
      .prepare(
        "SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = 'live-lite'",
      )
      .get() as { json: string };
    const policy = JSON.parse(row.json) as {
      exitOrderTtlMs: number;
      sellReplaceMinPriceDeltaTicks: number;
      opportunisticTaker: { sides: Array<"buy" | "sell"> };
    };

    expect(policy.exitOrderTtlMs).toBe(900_000);
    expect(policy.sellReplaceMinPriceDeltaTicks).toBe(2);
    expect(policy.opportunisticTaker.sides).toEqual(["buy"]);
  });

  it("migration 041 updates existing control DB sizing constants and entry ceiling", () => {
    const dbPath = path.join(tmpDir, "control-r37.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare("UPDATE algo_size_rules SET size_usdc = ? WHERE action_type = ? AND rule_id = ?")
      .run(8.38, "BUY", "B1");
    conn.db
      .prepare("UPDATE algo_size_rules SET size_usdc = ? WHERE action_type = ? AND rule_id = ?")
      .run(1.62, "SELL", "FALLBACK");
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(execution_policy_json, '$.entryPriceCeiling', 0.75)
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("041_r37_sizing_and_entry_ceiling.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const buy = conn.db
      .prepare(
        "SELECT size_usdc AS v FROM algo_size_rules WHERE action_type = 'BUY' AND rule_id = 'B1'",
      )
      .get() as { v: number };
    const sell = conn.db
      .prepare(
        "SELECT size_usdc AS v FROM algo_size_rules WHERE action_type = 'SELL' AND rule_id = 'FALLBACK'",
      )
      .get() as { v: number };
    const policy = conn.db
      .prepare(
        "SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = 'live-lite'",
      )
      .get() as { json: string };

    expect(buy.v).toBe(8.41);
    expect(sell.v).toBe(2.63);
    expect(JSON.parse(policy.json).entryPriceCeiling).toBe(0.45);
  });

  it("migration 042 disables legacy prefix rules, removes algo-REDEEM, and holds D6", () => {
    const dbPath = path.join(tmpDir, "control-v511-admission.db");
    conn = bootstrapControlDb(dbPath);

    conn.db
      .prepare(
        `INSERT INTO selection_rules
          (rule_id, profile_id, rule_type, pattern, enabled, note, created_at, updated_at)
         VALUES
          ('legacy-btc', 'live-lite', 'include_prefix', 'bitcoin-', 1, NULL, datetime('now'), datetime('now')),
          ('legacy-eth', 'live-lite', 'include_prefix', 'ethereum-', 1, NULL, datetime('now'), datetime('now')),
          ('legacy-exclude', 'live-lite', 'exclude_prefix', 'btc-', 1, NULL, datetime('now'), datetime('now')),
          ('manual-slug', 'live-lite', 'include_slug', 'manual-market', 1, NULL, datetime('now'), datetime('now'))`,
      )
      .run();
    conn.db.prepare("UPDATE algo_decision_rules SET action = 'BUY' WHERE rule_id = 'D6'").run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(execution_policy_json, '$.marketSelection')
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO algo_decision_rules
          (priority, rule_id, state_condition, price_operator, price_value,
           time_since_last_operator, time_since_last_seconds, buy_count_min, buy_count_max,
           hold_duration_operator, hold_duration_seconds, action)
         VALUES
          (10, 'REDEEM', 'S1', '<', 0.05, NULL, NULL, NULL, NULL, '<=', 3600, 'REDEEM'),
          (11, 'REDEEM', 'S2', '<', 0.05, NULL, NULL, NULL, NULL, '<=', 3600, 'REDEEM')`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("042_v511_admission_disable_algo_redeem.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const legacyRules = conn.db
      .prepare(
        `SELECT pattern, enabled, note
           FROM selection_rules
          WHERE rule_type IN ('include_prefix', 'exclude_prefix')
            AND pattern IN ('bitcoin-', 'ethereum-', 'btc-')
          ORDER BY pattern`,
      )
      .all() as Array<{ pattern: string; enabled: number; note: string | null }>;
    const exactRule = conn.db
      .prepare("SELECT enabled FROM selection_rules WHERE rule_id = 'manual-slug'")
      .get() as { enabled: number };
    const redeemCount = conn.db
      .prepare("SELECT COUNT(*) AS c FROM algo_decision_rules WHERE action = 'REDEEM'")
      .get() as { c: number };
    const d6 = conn.db
      .prepare("SELECT action FROM algo_decision_rules WHERE rule_id = 'D6'")
      .get() as { action: string };
    const policy = conn.db
      .prepare(
        "SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = 'live-lite'",
      )
      .get() as { json: string };

    expect(legacyRules.map((r) => [r.pattern, r.enabled])).toEqual([
      ["bitcoin-", 0],
      ["btc-", 0],
      ["ethereum-", 0],
    ]);
    expect(legacyRules.every((r) => r.note?.includes("migration 042"))).toBe(true);
    expect(exactRule.enabled).toBe(1);
    expect(redeemCount.c).toBe(0);
    expect(d6.action).toBe("HOLD");
    expect(JSON.parse(policy.json).marketSelection).toEqual({
      maxMidPrice: 0.5,
      minLiquidity: 100,
    });
  });

  it("migration 044 backfills buy-capacity policy without overwriting existing values", () => {
    const dbPath = path.join(tmpDir, "control-buy-capacity.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(execution_policy_json, '$.buyCapacity')
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.buyCapacity',
              json('{"enabled":false,"minNewEntryWalletHeadroomUsdc":3,"minAddWalletHeadroomUsdc":2,"maxOpenBuyOrders":9}')
            )
          WHERE profile_id = 'paper'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("044_buy_capacity_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare("SELECT profile_id, execution_policy_json AS json FROM profile_settings")
      .all() as Array<{ profile_id: string; json: string }>;
    const byProfile = new Map(rows.map((row) => [row.profile_id, JSON.parse(row.json)]));

    expect(byProfile.get("live-lite").buyCapacity).toEqual({
      enabled: true,
      minNewEntryWalletHeadroomUsdc: 7,
      minAddWalletHeadroomUsdc: 5,
      maxOpenBuyOrders: 2,
    });
    expect(byProfile.get("paper").buyCapacity).toEqual({
      enabled: false,
      minNewEntryWalletHeadroomUsdc: 3,
      minAddWalletHeadroomUsdc: 2,
      maxOpenBuyOrders: 9,
    });
  });

  it("migration 045 applies historical live-lite order caps without overwriting custom profile caps", () => {
    const dbPath = path.join(tmpDir, "control-order-capacity.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              json_remove(execution_policy_json, '$.sellCapacity', '$.orderCapacity'),
              '$.buyCapacity',
              json(?)
            )
          WHERE profile_id = ?`,
      )
      .run(
        JSON.stringify({
          enabled: true,
          minNewEntryWalletHeadroomUsdc: 7,
          minAddWalletHeadroomUsdc: 5,
          maxOpenBuyOrders: 2,
        }),
        "live-lite",
      );
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              json_remove(execution_policy_json, '$.sellCapacity', '$.orderCapacity'),
              '$.buyCapacity',
              json(?)
            )
          WHERE profile_id = ?`,
      )
      .run(
        JSON.stringify({
          enabled: true,
          minNewEntryWalletHeadroomUsdc: 3,
          minAddWalletHeadroomUsdc: 2,
          maxOpenBuyOrders: 9,
        }),
        "paper",
      );
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("045_order_capacity_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare(
        `SELECT profile_id, execution_policy_json AS json
           FROM profile_settings
          WHERE profile_id IN ('live-lite', 'paper')`,
      )
      .all() as Array<{ profile_id: string; json: string }>;
    const byProfile = new Map(rows.map((row) => [row.profile_id, JSON.parse(row.json)]));

    expect(byProfile.get("live-lite").buyCapacity).toEqual({
      enabled: true,
      minNewEntryWalletHeadroomUsdc: 7,
      minAddWalletHeadroomUsdc: 5,
      maxOpenBuyOrders: 15,
      maxOpenBuyOrdersPerToken: 2,
    });
    expect(byProfile.get("paper").buyCapacity).toEqual({
      enabled: true,
      minNewEntryWalletHeadroomUsdc: 3,
      minAddWalletHeadroomUsdc: 2,
      maxOpenBuyOrders: 9,
      maxOpenBuyOrdersPerToken: 2,
    });
    expect(byProfile.get("live-lite").sellCapacity).toEqual({
      enabled: true,
      maxOpenSellOrders: 10,
      maxOpenSellOrdersPerToken: 2,
    });
    expect(byProfile.get("live-lite").orderCapacity).toEqual({
      enabled: true,
      maxOpenOrdersTotal: 22,
    });
  });

  it("migration 062 raises old default BUY cap from 15 to 25 without overwriting custom caps", () => {
    const dbPath = path.join(tmpDir, "control-buy-capacity-25.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.buyCapacity.maxOpenBuyOrders',
              ?
            )
          WHERE profile_id = ?`,
      )
      .run(15, "live-lite");
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.buyCapacity.maxOpenBuyOrders',
              ?
            )
          WHERE profile_id = ?`,
      )
      .run(9, "paper");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("062_buy_capacity_raise_25.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare(
        `SELECT profile_id, execution_policy_json AS json
           FROM profile_settings
          WHERE profile_id IN ('live-lite', 'paper')`,
      )
      .all() as Array<{ profile_id: string; json: string }>;
    const byProfile = new Map(rows.map((row) => [row.profile_id, JSON.parse(row.json)]));

    expect(byProfile.get("live-lite").buyCapacity.maxOpenBuyOrders).toBe(25);
    expect(byProfile.get("live-lite").buyCapacity.maxOpenBuyOrdersPerToken).toBe(2);
    expect(byProfile.get("paper").buyCapacity.maxOpenBuyOrders).toBe(9);
    expect(byProfile.get("paper").buyCapacity.maxOpenBuyOrdersPerToken).toBe(2);
  });

  it("migration 063 lifts only legacy live-lite active market cap to 250", () => {
    const dbPath = path.join(tmpDir, "control-active-market-cap-250.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET envelope_json = ?
          WHERE profile_id = ?`,
      )
      .run(
        JSON.stringify({
          maxFamilies: 100,
          maxOpenValueUsdc: 500,
          maxOrderUsdc: 25,
          maxActiveMarkets: 100,
        }),
        "live-lite",
      );
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET envelope_json = ?
          WHERE profile_id = ?`,
      )
      .run(JSON.stringify({ maxActiveMarkets: 300 }), "paper");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("063_live_lite_active_market_cap_250.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare(
        `SELECT profile_id, envelope_json
           FROM profile_settings
          WHERE profile_id IN ('live-lite', 'paper')`,
      )
      .all() as Array<{ profile_id: string; envelope_json: string | null }>;
    const byProfile = new Map(
      rows.map((row) => [row.profile_id, JSON.parse(row.envelope_json ?? "{}")]),
    );

    expect(byProfile.get("live-lite")).toMatchObject({
      maxFamilies: 100,
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 25,
      maxActiveMarkets: 250,
    });
    expect(byProfile.get("paper")).toEqual({ maxActiveMarkets: 300 });
  });

  it("migration 063 preserves operator-edited live-lite active market caps", () => {
    const dbPath = path.join(tmpDir, "control-active-market-cap-operator.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET envelope_json = ?
          WHERE profile_id = ?`,
      )
      .run(JSON.stringify({ maxActiveMarkets: 300 }), "live-lite");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("063_live_lite_active_market_cap_250.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const row = conn.db
      .prepare("SELECT envelope_json FROM profile_settings WHERE profile_id = 'live-lite'")
      .get() as { envelope_json: string };

    expect(JSON.parse(row.envelope_json)).toEqual({ maxActiveMarkets: 300 });
  });

  it("migration 043 removes non-exclusion selection rules from existing control DBs", () => {
    const dbPath = path.join(tmpDir, "control-exclusions-only.db");
    conn = bootstrapControlDb(dbPath);

    conn.db
      .prepare(
        `INSERT INTO selection_rules
          (rule_id, profile_id, rule_type, pattern, enabled, note, created_at, updated_at)
         VALUES
          ('legacy-prefix', 'live-lite', 'include_prefix', 'bitcoin-', 0, NULL, datetime('now'), datetime('now')),
          ('legacy-include', 'live-lite', 'include_slug', 'bitcoin-above-100k', 1, NULL, datetime('now'), datetime('now')),
          ('manual-exclude', 'live-lite', 'exclude_slug', 'bad-market', 1, NULL, datetime('now'), datetime('now'))`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("043_selection_exclusions_only.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare("SELECT rule_id, rule_type FROM selection_rules ORDER BY rule_id")
      .all() as Array<{ rule_id: string; rule_type: string }>;
    const applied = conn.db
      .prepare("SELECT name FROM schema_migrations WHERE name = ?")
      .get("043_selection_exclusions_only.sql");

    expect(rows).toEqual([{ rule_id: "manual-exclude", rule_type: "exclude_slug" }]);
    expect(applied).toBeDefined();
  });

  it("migration 046 enables multi-buy ladder and preserves its other knobs", () => {
    const dbPath = path.join(tmpDir, "control-r55-ladder.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              json_remove(execution_policy_json, '$.multiBuyLadder'),
              '$.multiBuyLadder',
              json(?)
            )
          WHERE profile_id = ?`,
      )
      .run(
        JSON.stringify({
          enabled: false,
          maxLadderFillsPerToken: 5,
          ladderGapMs: 90_000,
          perTokenUsdcCap: 25,
          maxPriceDriftTicks: 4,
          minStepFillRate: 0.25,
        }),
        "live-lite",
      );
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(execution_policy_json, '$.multiBuyLadder')
          WHERE profile_id = ?`,
      )
      .run("paper");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("046_enable_multi_buy_ladder.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare(
        `SELECT profile_id, execution_policy_json AS json
           FROM profile_settings
          WHERE profile_id IN ('live-lite', 'paper')`,
      )
      .all() as Array<{ profile_id: string; json: string }>;
    const byProfile = new Map(rows.map((row) => [row.profile_id, JSON.parse(row.json)]));

    expect(byProfile.get("live-lite").multiBuyLadder).toEqual({
      enabled: true,
      maxLadderFillsPerToken: 15,
      ladderGapMs: 90_000,
      perTokenUsdcCap: 25,
      maxPriceDriftTicks: 4,
      minStepFillRate: 0.25,
    });
    expect(byProfile.get("paper").multiBuyLadder).toEqual({
      enabled: true,
      maxLadderFillsPerToken: 15,
      ladderGapMs: 60_000,
      perTokenUsdcCap: 10,
      maxPriceDriftTicks: 5,
      minStepFillRate: 0.1,
    });
  });

  it("migration 047 applies R58 SELL downprice policy and passive TTLs", () => {
    const dbPath = path.join(tmpDir, "control-r58-sell-downprice.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(
              json_set(
                execution_policy_json,
                '$.orderLifetime.passive.lowTtlMs',
                21600000,
                '$.orderLifetime.passive.mediumTtlMs',
                86400000,
                '$.orderLifetime.passive.highTtlMs',
                259200000
              ),
              '$.exitRepriceOnDownprice'
            )
          WHERE profile_id = ?`,
      )
      .run("live-lite");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("047_sell_downprice_reprice_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const policy = JSON.parse(raw.json);

    expect(policy.orderLifetime.passive.lowTtlMs).toBe(2 * 60 * 60_000);
    expect(policy.orderLifetime.passive.mediumTtlMs).toBe(4 * 60 * 60_000);
    expect(policy.orderLifetime.passive.highTtlMs).toBe(6 * 60 * 60_000);
    expect(policy.exitRepriceOnDownprice).toEqual({
      enabled: true,
      thresholdTicks: 5,
      maxRepricesPerOrder: 10,
      stuckWarningEnabled: true,
      stuckWarningAgeMs: 4 * 60 * 60_000,
      stuckWarningGapPct: 0.1,
    });
  });

  it("migration 048 applies bid-anchored SELL pricing and lowers downprice cap", () => {
    const dbPath = path.join(tmpDir, "control-r58-bid-anchored-sell.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.exitPricingMode',
              'edge',
              '$.exitBidAnchorTicks',
              9,
              '$.exitRepriceOnDownprice.maxRepricesPerOrder',
              10
            )
          WHERE profile_id = ?`,
      )
      .run("live-lite");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("048_bid_anchored_sell_pricing.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const policy = JSON.parse(raw.json);

    expect(policy.exitPricingMode).toBe("bid-anchored");
    expect(policy.exitBidAnchorTicks).toBe(3);
    expect(policy.exitRepriceOnDownprice.maxRepricesPerOrder).toBe(3);
  });

  it("migration 049 applies R51 taker policy and bid-anchor calibration", () => {
    const dbPath = path.join(tmpDir, "control-r51-opportunistic-taker.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(
              json_set(execution_policy_json, '$.exitBidAnchorTicks', 3),
              '$.opportunisticTaker'
            )
          WHERE profile_id = ?`,
      )
      .run("live-lite");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("049_opportunistic_taker_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const policy = JSON.parse(raw.json);

    expect(policy.exitBidAnchorTicks).toBe(4);
    expect(policy.opportunisticTaker).toEqual({
      enabled: true,
      maxSpreadTicks: 2,
      sides: ["buy", "sell"],
      safetyBuffer: 1.05,
      fallbackMinNotionalUsdc: 1,
      marketableBuyMinNotionalUsdc: 1,
    });
  });

  it("migration 049 preserves explicit opportunistic taker custom fields", () => {
    const dbPath = path.join(tmpDir, "control-r51-opportunistic-taker-custom.db");
    conn = bootstrapControlDb(dbPath);
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.exitBidAnchorTicks',
              3,
              '$.opportunisticTaker',
              json('{"enabled":false,"maxSpreadTicks":1,"sides":["sell"]}')
            )
          WHERE profile_id = ?`,
      )
      .run("live-lite");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("049_opportunistic_taker_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const policy = JSON.parse(raw.json);

    expect(policy.exitBidAnchorTicks).toBe(4);
    expect(policy.opportunisticTaker).toEqual({
      enabled: false,
      maxSpreadTicks: 1,
      sides: ["sell"],
      safetyBuffer: 1.05,
      fallbackMinNotionalUsdc: 1,
      marketableBuyMinNotionalUsdc: 1,
    });
  });

  it("migration 053 disables redeem sweep and applies R62 safety cadence", () => {
    const dbPath = path.join(tmpDir, "control-r62-redeem-sweep-safety.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.redeemSweep.enabled',
              json('true'),
              '$.redeemSweep.intervalMs',
              600000
            )
          WHERE profile_id = ?`,
      )
      .run("live-lite");
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("053_redeem_sweep_safety_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    const policy = JSON.parse(raw.json);

    expect(policy.redeemSweep).toMatchObject({
      enabled: false,
      intervalMs: 14_400_000,
      minAgeAfterResolutionSec: 28_800,
    });
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("migration 054 raises ladder perTokenUsdcCap from 10 to 25 without touching operator edits", () => {
    const dbPath = path.join(tmpDir, "control-r55-ladder-cap-raise.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.multiBuyLadder.perTokenUsdcCap',
              10
            )
          WHERE profile_id IN ('live-lite', 'paper')`,
      )
      .run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.multiBuyLadder.perTokenUsdcCap',
              50
            )
          WHERE profile_id = ?`,
      )
      .run("simulation");
    conn.db.prepare("DELETE FROM schema_migrations WHERE name = ?").run("054_ladder_cap_raise.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare("SELECT profile_id, execution_policy_json AS json FROM profile_settings")
      .all() as Array<{ profile_id: string; json: string }>;
    const capByProfile = new Map(
      rows.map((row) => {
        const policy = JSON.parse(row.json) as {
          multiBuyLadder: { perTokenUsdcCap: number };
        };
        return [row.profile_id, policy.multiBuyLadder.perTokenUsdcCap];
      }),
    );
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };

    expect(capByProfile.get("live-lite")).toBe(25);
    expect(capByProfile.get("paper")).toBe(25);
    expect(capByProfile.get("simulation")).toBe(50);
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("migration 054 is a no-op when every profile is already off the legacy 10-cap", () => {
    const dbPath = path.join(tmpDir, "control-r55-ladder-cap-noop.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.multiBuyLadder.perTokenUsdcCap',
              25
            )`,
      )
      .run();
    conn.db.prepare("DELETE FROM schema_migrations WHERE name = ?").run("054_ladder_cap_raise.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };

    expect(after.version).toBe(before.version);
  });

  it("migration 055 removes the dead redeemSweep.minAgeAfterResolutionSec field", () => {
    const dbPath = path.join(tmpDir, "control-redeem-min-age-drop.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.redeemSweep.minAgeAfterResolutionSec',
              28800
            )`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("055_drop_redeem_min_age.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare("SELECT profile_id, execution_policy_json AS json FROM profile_settings")
      .all() as Array<{ profile_id: string; json: string }>;
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };

    for (const row of rows) {
      const policy = JSON.parse(row.json);
      expect(policy.redeemSweep).not.toHaveProperty("minAgeAfterResolutionSec");
    }
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("migration 055 is a no-op when no profile carries minAgeAfterResolutionSec", () => {
    const dbPath = path.join(tmpDir, "control-redeem-min-age-noop.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(
              execution_policy_json,
              '$.redeemSweep.minAgeAfterResolutionSec'
            )`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("055_drop_redeem_min_age.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };

    expect(after.version).toBe(before.version);
  });

  it("migration 056 re-enables redeemSweep on profiles where the safety net left it off", () => {
    const dbPath = path.join(tmpDir, "control-redeem-sweep-re-enable.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.redeemSweep.enabled',
              json('false')
            )`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("056_redeem_sweep_re_enable.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare("SELECT profile_id AS id, execution_policy_json AS json FROM profile_settings")
      .all() as Array<{ id: string; json: string }>;
    for (const row of rows) {
      const policy = JSON.parse(row.json);
      expect(policy.redeemSweep?.enabled).toBe(true);
    }
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("migration 061 re-asserts bid-anchored SELL pricing for live-lite only", () => {
    const dbPath = path.join(tmpDir, "control-live-lite-bid-anchored.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // Production live-lite drifted back to midpoint-anchored after migration 048
    // (operator edit), so re-assertion (same pattern as migration 060) is required.
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.exitPricingMode',
              'midpoint-anchored'
            )
          WHERE profile_id IN ('live-lite', 'paper')`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("061_live_lite_exit_pricing_bid_anchored.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare(
        `SELECT profile_id AS id, execution_policy_json AS json
           FROM profile_settings
          WHERE profile_id IN ('live-lite', 'paper')`,
      )
      .all() as Array<{ id: string; json: string }>;
    const modeByProfile = new Map(
      rows.map((row) => [row.id, JSON.parse(row.json).exitPricingMode as string]),
    );
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };

    expect(modeByProfile.get("live-lite")).toBe("bid-anchored");
    // Other profiles are left exactly as they were — migration 061 targets live-lite only.
    expect(modeByProfile.get("paper")).toBe("midpoint-anchored");
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("migration 061 is a no-op when live-lite is already bid-anchored", () => {
    const dbPath = path.join(tmpDir, "control-live-lite-bid-anchored-noop.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.exitPricingMode',
              'bid-anchored'
            )
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("061_live_lite_exit_pricing_bid_anchored.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };

    expect(JSON.parse(raw.json).exitPricingMode).toBe("bid-anchored");
    expect(after.version).toBe(before.version);
  });

  it("migration 067 upgrades old-default off/shadow row and bumps version", () => {
    const dbPath = path.join(tmpDir, "control-maker067-upgrade.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // Revert to pre-067 state: old defaults + remove new fields
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(
              json_set(
                execution_policy_json,
                '$.makerEntry.harvestGainPct', 0.5,
                '$.makerEntry.fillWaitMs', 300000
              ),
              '$.makerEntry.holdWindowMs',
              '$.makerEntry.maxScaleInLevels',
              '$.makerEntry.scaleInStepPct'
            )
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("067_maker_scalein_policy.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    const maker = JSON.parse(raw.json).makerEntry;

    expect(maker.harvestGainPct).toBe(0.2);
    expect(maker.fillWaitMs).toBe(7_200_000);
    expect(maker.holdWindowMs).toBe(10_800_000);
    expect(maker.maxScaleInLevels).toBe(4);
    expect(maker.scaleInStepPct).toBe(0.1);
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("migration 067 does NOT clobber an operator-customized harvestGainPct", () => {
    const dbPath = path.join(tmpDir, "control-maker067-preserve-custom.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // Operator set harvestGainPct to 0.35 (not the old default 0.5)
    // Also remove new fields + set old fillWaitMs default so migration runs on this row
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(
              json_set(
                execution_policy_json,
                '$.makerEntry.harvestGainPct', 0.35,
                '$.makerEntry.fillWaitMs', 300000
              ),
              '$.makerEntry.holdWindowMs',
              '$.makerEntry.maxScaleInLevels',
              '$.makerEntry.scaleInStepPct'
            )
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("067_maker_scalein_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const maker = JSON.parse(raw.json).makerEntry;

    // Operator value preserved
    expect(maker.harvestGainPct).toBe(0.35);
    // fillWaitMs was old default — should be upgraded
    expect(maker.fillWaitMs).toBe(7_200_000);
    // New fields added
    expect(maker.holdWindowMs).toBe(10_800_000);
    expect(maker.maxScaleInLevels).toBe(4);
    expect(maker.scaleInStepPct).toBe(0.1);
  });

  it("migration 067 does NOT touch a micro_live+non-empty-whitelist row", () => {
    const dbPath = path.join(tmpDir, "control-maker067-guard-live-active.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // Put ALL profiles back to pre-067 old defaults (so migration targets them all),
    // but make live-lite micro_live+non-empty-whitelist (the guard case).
    // paper and simulation get old defaults → will be upgraded → version bumps.
    // live-lite gets guarded → its harvestGainPct stays 0.5.
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(
              json_set(
                execution_policy_json,
                '$.makerEntry.harvestGainPct', 0.5,
                '$.makerEntry.fillWaitMs', 300000
              ),
              '$.makerEntry.holdWindowMs',
              '$.makerEntry.maxScaleInLevels',
              '$.makerEntry.scaleInStepPct'
            )`,
      )
      .run();
    // Promote live-lite to the guarded state
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.makerEntry.mode', 'micro_live',
              '$.makerEntry.whitelistConditionIds', json('["0xdeadbeef"]')
            )
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("067_maker_scalein_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const maker = JSON.parse(raw.json).makerEntry;

    // Guard fired — live-lite's makerEntry fields were NOT updated
    expect(maker.mode).toBe("micro_live");
    expect(maker.harvestGainPct).toBe(0.5);
    expect(maker.fillWaitMs).toBe(300000);
    expect(maker.holdWindowMs).toBeUndefined();
    expect(maker.maxScaleInLevels).toBeUndefined();
    expect(maker.scaleInStepPct).toBeUndefined();
  });

  it("migration 068 backfills default-off gateEntry + bounceExit and bumps version", () => {
    const dbPath = path.join(tmpDir, "control-gate-bounce-068-backfill.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // Revert to pre-068 state: remove the gateEntry/bounceExit keys entirely.
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(
              execution_policy_json,
              '$.gateEntry',
              '$.bounceExit'
            )`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("068_gate_entry_bounce_exit_policy.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    const policy = JSON.parse(raw.json);

    expect(policy.gateEntry).toEqual({
      enabled: false,
      mode: "off",
      minLifespanDays: 30,
      minPrice: 0.01,
      maxPrice: 0.15,
      whitelistConditionIds: [],
      microMaxOrderUsdc: 2,
    });
    expect(policy.bounceExit).toEqual({
      enabled: false,
      mode: "off",
      targetGainPct: 0.257,
      timeoutMs: 14_400_000,
      whitelistConditionIds: [],
      microMaxOrderUsdc: 2,
    });
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("migration 068 does NOT overwrite an already-present gateEntry/bounceExit block", () => {
    const dbPath = path.join(tmpDir, "control-gate-bounce-068-preserve-custom.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // Operator (or an earlier apply) already customized gateEntry on live-lite.
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.gateEntry.minLifespanDays', 45
            )
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("068_gate_entry_bounce_exit_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const policy = JSON.parse(raw.json);

    // Customized value preserved — migration only targets rows missing the key.
    expect(policy.gateEntry.minLifespanDays).toBe(45);
  });

  it("migration 069 adds the ladder shape to bounceExit, preserving legacy fields, and bumps version", () => {
    const dbPath = path.join(tmpDir, "control-bounce-ladder-069-backfill.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // Revert to the pre-069, migration-068 flat shape (targetGainPct/timeoutMs,
    // no ladder fields).
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.bounceExit',
              json('{"enabled":false,"mode":"off","targetGainPct":0.257,"timeoutMs":14400000,"whitelistConditionIds":[],"microMaxOrderUsdc":2}')
            )`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("069_bounce_exit_ladder_policy.sql");
    const before = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const after = conn.db
      .prepare("SELECT execution_policy_version AS version FROM runtime_control_state WHERE id = 1")
      .get() as { version: number };
    const policy = JSON.parse(raw.json);

    // Additive: legacy fields (still read by the shipped evaluateBounceExit)
    // are preserved exactly as they were pre-migration...
    expect(policy.bounceExit.enabled).toBe(false);
    expect(policy.bounceExit.mode).toBe("off");
    expect(policy.bounceExit.targetGainPct).toBe(0.257);
    expect(policy.bounceExit.timeoutMs).toBe(14_400_000);
    expect(policy.bounceExit.whitelistConditionIds).toEqual([]);
    expect(policy.bounceExit.microMaxOrderUsdc).toBe(2);
    // ...and the new ladder scaffolding fields are added alongside them.
    expect(policy.bounceExit.targetTiers).toEqual([
      { maxPrice: 0.02, gainPct: 0.36 },
      { maxPrice: 0.03, gainPct: 0.27 },
      { maxPrice: 0.05, gainPct: 0.19 },
      { maxPrice: 0.08, gainPct: 0.15 },
      { maxPrice: 0.15, gainPct: 0.15 },
      { maxPrice: 0.35, gainPct: 0.12 },
      { maxPrice: 1.0, gainPct: 0.08 },
    ]);
    expect(policy.bounceExit.ladderFractions).toEqual([0.3, 0.4, 0.3]);
    expect(policy.bounceExit.ladderStepPct).toBe(0.22);
    expect(policy.bounceExit.backstopTtcHours).toBe(24);
    expect(after.version).toBeGreaterThan(before.version);
  });

  it("migration 069 does NOT overwrite an already-migrated/custom ladder bounceExit block", () => {
    const dbPath = path.join(tmpDir, "control-bounce-ladder-069-preserve-custom.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // Operator (or an earlier apply) already customized ladderStepPct on live-lite.
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.bounceExit.ladderStepPct', 0.5
            )
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("069_bounce_exit_ladder_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const policy = JSON.parse(raw.json);

    // Customized value preserved — migration only targets rows missing targetTiers.
    expect(policy.bounceExit.ladderStepPct).toBe(0.5);
  });

  it("migration 069 forces enabled:false/mode:off when backfilling an old enabled:true legacy row (fail-closed, Codex Phase-2 fix)", () => {
    const dbPath = path.join(tmpDir, "control-bounce-ladder-069-fail-closed.db");
    conn = bootstrapControlDb(dbPath);
    conn.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    // An old, previously-live flat bounceExit block: enabled:true/mode:micro_live,
    // no ladder fields at all — exactly the shape this migration is about to
    // backfill ladder fields onto for the first time.
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(
              execution_policy_json,
              '$.bounceExit',
              json('{"enabled":true,"mode":"micro_live","targetGainPct":0.257,"timeoutMs":14400000,"whitelistConditionIds":["cond-1"],"microMaxOrderUsdc":2}')
            )`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("069_bounce_exit_ladder_policy.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const raw = conn.db
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id = ?")
      .get("live-lite") as { json: string };
    const policy = JSON.parse(raw.json);

    // Fail-closed: this migration is what makes the ladder fields
    // "legitimately present" for the first time, so it must NOT also carry
    // forward a pre-existing enabled:true/mode:micro_live from the old flat
    // shape — that would silently activate the ladder on unreviewed scaffold
    // defaults the moment this migration lands.
    expect(policy.bounceExit.enabled).toBe(false);
    expect(policy.bounceExit.mode).toBe("off");
    // Legacy fields (still read by evaluateBounceExit) and the whitelist are
    // preserved untouched — only enabled/mode are forced.
    expect(policy.bounceExit.targetGainPct).toBe(0.257);
    expect(policy.bounceExit.whitelistConditionIds).toEqual(["cond-1"]);
    expect(policy.bounceExit.targetTiers.length).toBeGreaterThan(0);
    expect(policy.bounceExit.ladderFractions).toEqual([0.3, 0.4, 0.3]);
  });

  it("migration 070 backfills bounceExit.applyToAllMarkets=false without clobbering an operator-set value or siblings", () => {
    const dbPath = path.join(tmpDir, "control-apply-all.db");
    conn = bootstrapControlDb(dbPath);

    // Simulate pre-070 state: one profile MISSING the field, one where an operator
    // already set it true. Then delete the migration marker so it re-runs.
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_remove(execution_policy_json, '$.bounceExit.applyToAllMarkets')
          WHERE profile_id = 'live-lite'`,
      )
      .run();
    conn.db
      .prepare(
        `UPDATE profile_settings
            SET execution_policy_json = json_set(execution_policy_json, '$.bounceExit.applyToAllMarkets', json('true'))
          WHERE profile_id = 'paper'`,
      )
      .run();
    conn.db
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run("070_bounce_exit_applyToAllMarkets.sql");
    conn.close();

    conn = bootstrapControlDb(dbPath);

    const rows = conn.db
      .prepare("SELECT profile_id, execution_policy_json AS json FROM profile_settings")
      .all() as Array<{ profile_id: string; json: string }>;
    const byProfile = new Map(rows.map((row) => [row.profile_id, JSON.parse(row.json)]));

    // Missing → backfilled to false.
    expect(byProfile.get("live-lite").bounceExit.applyToAllMarkets).toBe(false);
    // Operator-set true → preserved (idempotent, no clobber).
    expect(byProfile.get("paper").bounceExit.applyToAllMarkets).toBe(true);
    // Sibling bounceExit fields untouched on the backfilled row.
    expect(byProfile.get("live-lite").bounceExit.whitelistConditionIds).toBeDefined();
    expect(Array.isArray(byProfile.get("live-lite").bounceExit.targetTiers)).toBe(true);
  });
});
