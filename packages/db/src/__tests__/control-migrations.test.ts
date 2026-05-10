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
      expect(parsed.marketSelection).toEqual({ maxMidPrice: 0.5, minLiquidity: 100 });
      expect(parsed.buyCapacity).toEqual({
        enabled: true,
        minNewEntryWalletHeadroomUsdc: 7,
        minAddWalletHeadroomUsdc: 5,
        maxOpenBuyOrders: 15,
        maxOpenBuyOrdersPerToken: 2,
      });
      expect(parsed.sellCapacity).toEqual({
        enabled: true,
        maxOpenSellOrders: 10,
        maxOpenSellOrdersPerToken: 2,
      });
      expect(parsed.orderCapacity).toEqual({
        enabled: true,
        maxOpenOrdersTotal: 22,
      });
      expect(parsed.multiBuyLadder).toEqual({
        enabled: true,
        maxLadderFillsPerToken: 15,
        ladderGapMs: 60_000,
        perTokenUsdcCap: 10,
        maxPriceDriftTicks: 5,
        minStepFillRate: 0.1,
      });
      expect(parsed.deadSideGuard.mode).toBe(
        row.profile_id === "live-lite" ? "enforce" : "observe",
      );
    }
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

  it("migration 045 widens live-lite order caps without overwriting custom profile caps", () => {
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
});
