import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProfileId,
  PROBE_DEFAULTS,
  resolveFamilyDeploymentSeed,
  resolveFamilyLiveTradingPolicy,
} from "@plankton/domain";

import { ensureControlProfiles } from "./control-profiles.js";
import { ensureFamilyRuleDefaultsTable } from "./family-rule-defaults.js";
import { openDatabase, openDatabaseWithSchema, type DbConnection } from "./connection.js";
import { runControlMigrations, runMigrations } from "./migrations/runner.js";

export function bootstrapDatabase(dbPath: string): DbConnection {
  const conn = openDatabase(dbPath);
  runMigrations(conn.db);
  ensureBootstrapBackfillsTable(conn.db);
  safeAddColumn(conn.db, "markets", "tradable", "INTEGER NOT NULL DEFAULT 1");
  safeAddColumn(conn.db, "family_catalog", "source_type", "TEXT NOT NULL DEFAULT 'yaml_import'");
  safeAddColumn(conn.db, "family_catalog", "origin_checksum", "TEXT");
  safeAddColumn(conn.db, "family_catalog", "fee_tier", "TEXT NOT NULL DEFAULT 'unknown'");
  safeAddColumn(
    conn.db,
    "family_catalog",
    "live_wallet_requirement",
    "TEXT NOT NULL DEFAULT 'relayer-required'",
  );
  safeAddColumn(
    conn.db,
    "family_catalog",
    "requires_post_only_for_live",
    "INTEGER NOT NULL DEFAULT 1",
  );
  backfillFamilyLivePolicy(conn.db);
  backfillFamilyLimitUnification(conn.db);
  ensureAlgoRulesDefaults(conn.db);
  backfillBuySizePrecedence(conn.db);
  return conn;
}

function readSchema(filename: string): string {
  return readFileSync(join(import.meta.dirname, "schemas", filename), "utf-8");
}

export function bootstrapControlDb(dbPath: string): DbConnection {
  const conn = openDatabaseWithSchema(dbPath, readSchema("control.sql"));
  ensureControlProfiles(conn.db);
  ensureFamilyRuleDefaultsTable(conn.db);
  ensureBootstrapBackfillsTable(conn.db);
  seedControlMigrationsBaseline(conn.db);
  runControlMigrations(conn.db);
  // Schema evolution: add columns that may be missing in existing DBs.
  // CREATE TABLE IF NOT EXISTS won't add new columns to existing tables.
  safeAddColumn(conn.db, "profile_summaries", "wallet_balance_usdc", "REAL");
  safeAddColumn(conn.db, "runtime_control_state", "resume_intent_at", "TEXT");
  safeAddColumn(conn.db, "profile_settings", "wallet_mode", "TEXT");
  safeAddColumn(conn.db, "profile_settings", "min_order_usdc", "REAL");
  safeAddColumn(conn.db, "profile_settings", "relayer_json", "TEXT");
  safeAddColumn(conn.db, "family_catalog", "source_type", "TEXT NOT NULL DEFAULT 'yaml_import'");
  safeAddColumn(conn.db, "family_catalog", "origin_checksum", "TEXT");
  safeAddColumn(conn.db, "family_catalog", "fee_tier", "TEXT NOT NULL DEFAULT 'unknown'");
  safeAddColumn(conn.db, "family_rules", "max_concurrent_orders_per_family", "INTEGER");
  safeAddColumn(conn.db, "family_rules", "max_probe_in_flight_per_token", "INTEGER");
  safeAddColumn(conn.db, "family_rules", "max_entry_signals_per_tick_per_family", "INTEGER");
  safeAddColumn(conn.db, "family_rules", "fast_lane_enabled", "INTEGER");
  safeAddColumn(conn.db, "family_rules", "dust_lane_enabled", "INTEGER");
  safeAddColumn(conn.db, "family_rules", "queue_jump_canary_enabled", "INTEGER");
  safeAddColumn(
    conn.db,
    "family_catalog",
    "live_wallet_requirement",
    "TEXT NOT NULL DEFAULT 'relayer-required'",
  );
  safeAddColumn(
    conn.db,
    "family_catalog",
    "requires_post_only_for_live",
    "INTEGER NOT NULL DEFAULT 1",
  );

  // Backfill: ensure every family_catalog entry has family_deployments rows.
  // Fixes families materialized before the accept endpoint was updated to create deployments.
  backfillDeployments(conn.db);
  backfillLiveProfileSettings(conn.db);
  backfillFamilyLivePolicy(conn.db);
  backfillFamilyLimitUnification(conn.db);
  ensureAlgoRulesDefaults(conn.db);
  backfillBuySizePrecedence(conn.db);

  return conn;
}

/**
 * Per-migration fresh-install detector for control-db migrations. Each
 * migration declares a predicate that returns true when the DB already
 * reflects that migration's target shape. Fresh installs (created from the
 * latest control.sql) satisfy all predicates → all migrations get seeded as
 * applied → runner skips them. Upgrade installs satisfy none (or only some,
 * for partial upgrades) → the runner applies the rest in order.
 */
function hasColumn(db: import("better-sqlite3").Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

type ControlMigrationBaseline = {
  name: string;
  isAlreadyApplied: (db: import("better-sqlite3").Database) => boolean;
};

function hasTable(db: import("better-sqlite3").Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

const CONTROL_MIGRATION_BASELINES: ControlMigrationBaseline[] = [
  {
    name: "031_flatten_family_deployments.sql",
    // Post-031 shape: disabled_at column exists. Fresh bootstrap creates it
    // directly; upgrade installs gain it when migration 031 runs.
    isAlreadyApplied: (db) => hasColumn(db, "family_deployments", "disabled_at"),
  },
  {
    name: "033_drop_legacy_governance.sql",
    // Post-033 shape: strategy_stage column is gone. Fresh bootstrap creates
    // the slim table directly; upgrade installs rebuild via migration 033.
    isAlreadyApplied: (db) => !hasColumn(db, "family_deployments", "strategy_stage"),
  },
  {
    name: "034_drop_discovery_tables.sql",
    // Post-034 shape: discovery tables are gone. Fresh bootstrap never creates
    // them; upgrade installs drop them via migration 034.
    isAlreadyApplied: (db) => !hasTable(db, "family_candidates"),
  },
  {
    name: "035_drop_family_rollup_effective_mode.sql",
    // Post-035 shape: effective_mode is gone from family_profile_rollups. Fresh
    // bootstrap creates the slim table directly; upgrade installs drop the
    // column via migration 035.
    isAlreadyApplied: (db) => !hasColumn(db, "family_profile_rollups", "effective_mode"),
  },
  {
    name: "037_selection_rules.sql",
    // Post-037 shape: selection_rules table exists and runtime_control_state
    // has selection_rules_version. Fresh bootstrap creates both directly;
    // upgrade installs gain them when migration 037 runs.
    isAlreadyApplied: (db) =>
      hasTable(db, "selection_rules") &&
      hasColumn(db, "runtime_control_state", "selection_rules_version"),
  },
];

function seedControlMigrationsBaseline(db: import("better-sqlite3").Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const seed = db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)");
  for (const baseline of CONTROL_MIGRATION_BASELINES) {
    if (baseline.isAlreadyApplied(db)) {
      seed.run(baseline.name);
    }
  }
}

const BOOTSTRAP_BACKFILL_FAMILY_LIMIT_UNIFICATION = "2026-04-13-family-limit-unification-v1";
const BOOTSTRAP_BACKFILL_BUY_SIZE_PRECEDENCE_V22 = "2026-04-17-buy-size-precedence-v2.2";

function ensureBootstrapBackfillsTable(db: import("better-sqlite3").Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS bootstrap_backfills (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

function hasBootstrapBackfill(db: import("better-sqlite3").Database, name: string): boolean {
  try {
    const row = db.prepare("SELECT 1 FROM bootstrap_backfills WHERE name = ? LIMIT 1").get(name) as
      | { 1: number }
      | undefined;
    return Boolean(row);
  } catch {
    return false;
  }
}

function markBootstrapBackfill(db: import("better-sqlite3").Database, name: string): void {
  db.prepare("INSERT OR IGNORE INTO bootstrap_backfills (name) VALUES (?)").run(name);
}

function maxNumber(current: unknown, target: number): number {
  if (typeof current !== "number" || Number.isNaN(current)) return target;
  return Math.max(current, target);
}

function backfillFamilyLimitUnification(db: import("better-sqlite3").Database): void {
  if (hasBootstrapBackfill(db, BOOTSTRAP_BACKFILL_FAMILY_LIMIT_UNIFICATION)) return;

  try {
    const hasFamilyRuleState = Boolean(
      db
        .prepare(
          `SELECT 1
             FROM family_rules
            UNION ALL
           SELECT 1
             FROM family_rules_snapshot
            LIMIT 1`,
        )
        .get(),
    );
    if (!hasFamilyRuleState) return;

    db.transaction(() => {
      db.prepare(
        `UPDATE family_rules
         SET max_active_markets = CASE
               WHEN max_active_markets < @maxActiveMarkets THEN @maxActiveMarkets
               ELSE max_active_markets
             END,
             max_dust_positions = CASE
               WHEN max_dust_positions < @maxDustPositions THEN @maxDustPositions
               ELSE max_dust_positions
             END,
             tail_quarantine_threshold_usdc = CASE
               WHEN tail_quarantine_threshold_usdc < @tailThresholdUsdc THEN @tailThresholdUsdc
               ELSE tail_quarantine_threshold_usdc
             END,
             tail_quarantine_threshold_ratio = CASE
               WHEN tail_quarantine_threshold_ratio < @tailThresholdRatio THEN @tailThresholdRatio
               ELSE tail_quarantine_threshold_ratio
             END,
             updated_at = datetime('now')
         WHERE max_active_markets < @maxActiveMarkets
            OR max_dust_positions < @maxDustPositions
            OR tail_quarantine_threshold_usdc < @tailThresholdUsdc
            OR tail_quarantine_threshold_ratio < @tailThresholdRatio`,
      ).run({
        maxActiveMarkets: PROBE_DEFAULTS.maxActiveMarkets,
        maxDustPositions: PROBE_DEFAULTS.maxDustPositions,
        tailThresholdUsdc: PROBE_DEFAULTS.tailQuarantineThresholdUsdc,
        tailThresholdRatio: PROBE_DEFAULTS.tailQuarantineThresholdRatio,
      });

      const latestSnapshots = db
        .prepare(
          `SELECT s.id, s.family_id, s.snapshot, s.reason
             FROM family_rules_snapshot s
             JOIN (
               SELECT family_id, MAX(captured_at) AS max_captured_at
                 FROM family_rules_snapshot
                GROUP BY family_id
             ) latest
               ON latest.family_id = s.family_id
              AND latest.max_captured_at = s.captured_at`,
        )
        .all() as Array<{ id: number; family_id: string; snapshot: string; reason: string }>;

      const insertSnapshot = db.prepare(
        `INSERT INTO family_rules_snapshot (family_id, snapshot, reason, captured_at)
         VALUES (?, ?, ?, datetime('now'))`,
      );

      for (const row of latestSnapshots) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(row.snapshot) as Record<string, unknown>;
        } catch {
          continue;
        }

        const updated = {
          ...parsed,
          maxActiveMarkets: maxNumber(parsed.maxActiveMarkets, PROBE_DEFAULTS.maxActiveMarkets),
          maxDustPositions: maxNumber(parsed.maxDustPositions, PROBE_DEFAULTS.maxDustPositions),
          tailQuarantineThresholdUsdc: maxNumber(
            parsed.tailQuarantineThresholdUsdc,
            PROBE_DEFAULTS.tailQuarantineThresholdUsdc,
          ),
          tailQuarantineThresholdRatio: maxNumber(
            parsed.tailQuarantineThresholdRatio,
            PROBE_DEFAULTS.tailQuarantineThresholdRatio,
          ),
        };

        if (
          updated.maxActiveMarkets === parsed.maxActiveMarkets &&
          updated.maxDustPositions === parsed.maxDustPositions &&
          updated.tailQuarantineThresholdUsdc === parsed.tailQuarantineThresholdUsdc &&
          updated.tailQuarantineThresholdRatio === parsed.tailQuarantineThresholdRatio
        ) {
          continue;
        }

        insertSnapshot.run(
          row.family_id,
          JSON.stringify(updated),
          `${row.reason}: family-limit-unification-backfill`,
        );
      }

      markBootstrapBackfill(db, BOOTSTRAP_BACKFILL_FAMILY_LIMIT_UNIFICATION);
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) return;
    throw err;
  }
}

/**
 * Repair family_deployments: ensure every (family_id, profile) pair exists.
 * Handles both fully missing families AND partially filled ones (e.g. interrupted bootstrap).
 * Idempotent — INSERT OR IGNORE skips existing rows. Wrapped in transaction for atomicity.
 */
function backfillDeployments(db: import("better-sqlite3").Database): void {
  const families = db.prepare("SELECT family_id, source_type FROM family_catalog").all() as {
    family_id: string;
    source_type: string | null;
  }[];

  if (families.length === 0) return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO family_deployments
       (family_id, profile, enabled, priority, created_at, updated_at)
     VALUES (?, ?, ?, 999, datetime('now'), datetime('now'))`,
  );

  db.transaction(() => {
    for (const { family_id, source_type } of families) {
      for (const profile of [ProfileId.Simulation, ProfileId.Paper, ProfileId.LiveLite]) {
        const seed = resolveFamilyDeploymentSeed({
          profile,
          sourceType: source_type,
        });
        insert.run(family_id, profile, seed.enabled ? 1 : 0);
      }
    }
  })();
}

function backfillLiveProfileSettings(db: import("better-sqlite3").Database): void {
  try {
    db.prepare(
      `UPDATE profile_settings
       SET wallet_mode = COALESCE(wallet_mode, 'relayer'),
           min_order_usdc = COALESCE(min_order_usdc, 1)
       WHERE profile_id = 'live-lite'`,
    ).run();
  } catch {
    // Legacy test DBs may not have the profile_settings table.
  }
}

function backfillFamilyLivePolicy(db: import("better-sqlite3").Database): void {
  let rows: Array<{ family_id: string; primary_category: string; fee_tier: string | null }>;
  try {
    rows = db
      .prepare(
        `SELECT family_id, primary_category, fee_tier
       FROM family_catalog`,
      )
      .all() as Array<{ family_id: string; primary_category: string; fee_tier: string | null }>;
  } catch {
    return;
  }

  const update = db.prepare(
    `UPDATE family_catalog
     SET fee_tier = ?,
         live_wallet_requirement = ?,
         requires_post_only_for_live = ?
     WHERE family_id = ?`,
  );

  db.transaction(() => {
    for (const row of rows) {
      if (row.fee_tier && row.fee_tier !== "unknown") continue;
      const policy = resolveFamilyLiveTradingPolicy({
        primaryCategory: row.primary_category,
      });
      update.run(
        policy.feeTier,
        policy.liveWalletRequirement,
        policy.requiresPostOnlyForLive ? 1 : 0,
        row.family_id,
      );
    }
  })();
}

export function ensureAlgoRulesDefaults(db: import("better-sqlite3").Database): void {
  const count = (db.prepare("SELECT COUNT(*) as c FROM algo_decision_rules").get() as { c: number })
    .c;
  if (count > 0) return; // Already seeded

  const insertDecision = db.prepare(
    `INSERT INTO algo_decision_rules (priority, rule_id, state_condition, price_operator, price_value, time_since_last_operator, time_since_last_seconds, buy_count_min, buy_count_max, hold_duration_operator, hold_duration_seconds, action)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertSize = db.prepare(
    `INSERT INTO algo_size_rules (action_type, priority, rule_id, state_condition, price_operator, price_value, nth_buy, buy_count_min, buy_count_max, size_usdc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    // Decision rules (priority order)
    insertDecision.run(10, "REDEEM", "S1", "<", 0.05, null, null, null, null, "<=", 3600, "REDEEM");
    insertDecision.run(11, "REDEEM", "S2", "<", 0.05, null, null, null, null, "<=", 3600, "REDEEM");
    insertDecision.run(20, "D1", "S2", "<", 0.05, "<=", 60, null, null, null, null, "BUY");
    insertDecision.run(30, "D2", "S3", "<", 0.05, "<=", 60, null, null, null, null, "SELL");
    insertDecision.run(40, "D3", "S1", "<", 0.05, null, null, null, null, null, null, "BUY");
    insertDecision.run(50, "D4", "S2", ">=", 0.2, ">", 60, null, null, null, null, "SELL");
    insertDecision.run(60, "D5", "S1", ">=", 0.2, null, null, null, null, null, null, "SELL");
    insertDecision.run(70, "D6", "S2", null, null, null, null, 4, null, null, null, "BUY");
    insertDecision.run(80, "D7", "S3", null, null, null, null, null, null, null, null, "SELL");
    insertDecision.run(
      999,
      "FALLBACK",
      "ANY",
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "BUY",
    );

    // Size rules — BUY (spec v2.2 §2: state+price rules B1–B4 override nth_buy rules B5–B7)
    insertSize.run("BUY", 10, "B1", "OTHER", ">=", 0.2, null, null, null, 8.38);
    insertSize.run("BUY", 20, "B2", "S1", ">=", 0.2, null, null, null, 4.17);
    insertSize.run("BUY", 30, "B3", "S3", "<", 0.05, null, null, null, 0.76);
    insertSize.run("BUY", 40, "B4", "S2", "<", 0.05, null, null, null, 0.12);
    insertSize.run("BUY", 50, "B5", "ANY", null, null, 1, null, null, 2.1);
    insertSize.run("BUY", 60, "B6", "ANY", null, null, 2, null, null, 1.17);
    insertSize.run("BUY", 70, "B7", "ANY", null, null, 3, null, null, 0.92);
    insertSize.run("BUY", 999, "FALLBACK", "ANY", null, null, null, null, null, 0.44);

    // Size rules — SELL
    insertSize.run("SELL", 10, "S1", "S2", ">=", 0.2, null, null, null, 6.48);
    insertSize.run("SELL", 20, "S2", "S1", ">=", 0.2, null, null, null, 6.31);
    insertSize.run("SELL", 30, "S3", "OTHER", ">=", 0.2, null, null, null, 3.4);
    insertSize.run("SELL", 40, "S4", "S2", "<", 0.05, null, null, null, 1.01);
    insertSize.run("SELL", 50, "S5", "S3", "<", 0.05, null, null, null, 0.59);
    insertSize.run("SELL", 60, "S6", "ANY", null, null, null, 1, 1, 2.85);
    insertSize.run("SELL", 70, "S7", "ANY", null, null, null, 2, 3, 2.14);
    insertSize.run("SELL", 999, "FALLBACK", "ANY", null, null, null, null, null, 1.62);
  })();
}

/**
 * Spec v2.2 §2 BUY Size Precedence: state+price rules (B1–B4) override
 * nth_buy rules (B5–B7). Pre-v2.2 seed used the inverted order; this backfill
 * re-priorities existing rows in place. Idempotent via bootstrap_backfills.
 *
 * Must run against control.db (which holds algo rules in the split layout) —
 * migrations only run against the legacy merged DB via bootstrapDatabase().
 */
function backfillBuySizePrecedence(db: import("better-sqlite3").Database): void {
  try {
    if (hasBootstrapBackfill(db, BOOTSTRAP_BACKFILL_BUY_SIZE_PRECEDENCE_V22)) return;
    db.transaction(() => {
      const stmt = db.prepare(
        "UPDATE algo_size_rules SET priority = ? WHERE action_type = 'BUY' AND rule_id = ?",
      );
      stmt.run(10, "B1");
      stmt.run(20, "B2");
      stmt.run(30, "B3");
      stmt.run(40, "B4");
      stmt.run(50, "B5");
      stmt.run(60, "B6");
      stmt.run(70, "B7");
      markBootstrapBackfill(db, BOOTSTRAP_BACKFILL_BUY_SIZE_PRECEDENCE_V22);
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) return;
    throw err;
  }
}

/** ALTER TABLE ADD COLUMN, ignoring "duplicate column" errors. */
function safeAddColumn(
  db: import("better-sqlite3").Database,
  table: string,
  column: string,
  definition: string,
): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("duplicate column") || msg.includes("no such table")) return;
    throw err;
  }
}

export function bootstrapLedgerDb(dbPath: string): DbConnection {
  const conn = openDatabaseWithSchema(dbPath, readSchema("ledger.sql"));
  safeAddColumn(conn.db, "orders", "post_only", "INTEGER NOT NULL DEFAULT 0");
  safeAddColumn(conn.db, "fills", "liquidity_role", "TEXT NOT NULL DEFAULT 'unknown'");
  safeAddColumn(conn.db, "fills", "fee_rate_bps", "REAL NOT NULL DEFAULT 0");
  safeAddColumn(conn.db, "positions", "entry_style", "TEXT");
  // Existing DBs predate tradable. Default to 1 so preserved rows stay eligible
  // until the next scan cycle rewrites them with the authoritative clob flag.
  safeAddColumn(conn.db, "markets", "tradable", "INTEGER NOT NULL DEFAULT 1");
  ensureUniqueOpenPositionIndex(conn.db);
  return conn;
}

/**
 * Enforce "at most one open row per token" at the DB layer.
 *
 * Repairs any pre-existing duplicate-open rows first (idempotent: closes all
 * but the canonical winner per PositionRepository.findByTokenId ordering —
 * opened_at DESC, position_id DESC as tie-breaker) and then creates the
 * partial UNIQUE index. Fresh DBs skip the repair (empty positions).
 *
 * Kept in bootstrapLedgerDb rather than ledger.sql because db.exec() cannot
 * repair before creating the index — the CREATE UNIQUE INDEX would fail on
 * upgrade DBs with pre-existing duplicates.
 */
function ensureUniqueOpenPositionIndex(db: import("better-sqlite3").Database): void {
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE positions
            SET status = 'closed',
                closed_at = COALESCE(closed_at, datetime('now')),
                updated_at = datetime('now')
          WHERE position_id IN (
            SELECT p1.position_id
              FROM positions p1
              JOIN positions p2
                ON p1.token_id = p2.token_id
               AND p1.status = 'open'
               AND p2.status = 'open'
               AND (
                     p1.opened_at < p2.opened_at
                  OR (p1.opened_at = p2.opened_at AND p1.position_id < p2.position_id)
               )
          )`,
      ).run();
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_unique_open_per_token
           ON positions(token_id) WHERE status = 'open'`,
      );
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such table")) return;
    throw err;
  }
}
