import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ensureControlProfiles, ensureDefaultExecutionPolicy } from "./control-profiles.js";
import {
  BOOTSTRAP_BUSY_TIMEOUT_MS,
  openDatabase,
  openDatabaseWithSchema,
  setRuntimeBusyTimeout,
  type DbConnection,
} from "./connection.js";
import { runControlMigrations, runMigrations } from "./migrations/runner.js";

export function bootstrapDatabase(dbPath: string): DbConnection {
  const conn = openDatabase(dbPath, { busyTimeoutMs: BOOTSTRAP_BUSY_TIMEOUT_MS });
  runMigrations(conn.db);
  ensureBootstrapBackfillsTable(conn.db);
  safeAddColumn(conn.db, "markets", "tradable", "INTEGER NOT NULL DEFAULT 1");
  // Step 0 §1.2 — capture Gamma createdAt; legacy merged-DB path mirrors the
  // ledger column added in bootstrapLedgerDb so tests and old installs stay
  // in sync. Distinct from `markets.created_at` (DB write moment).
  safeAddColumn(conn.db, "markets", "gamma_created_at", "TEXT");
  ensureAlgoRulesDefaults(conn.db);
  backfillBuySizePrecedence(conn.db);
  setRuntimeBusyTimeout(conn);
  return conn;
}

function readSchema(filename: string): string {
  return readFileSync(join(import.meta.dirname, "schemas", filename), "utf-8");
}

export function bootstrapControlDb(dbPath: string): DbConnection {
  const conn = openDatabaseWithSchema(dbPath, readSchema("control.sql"), {
    busyTimeoutMs: BOOTSTRAP_BUSY_TIMEOUT_MS,
  });
  ensureControlProfiles(conn.db);
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
  safeAddColumn(conn.db, "profile_settings", "execution_policy_json", "TEXT");
  safeAddColumn(
    conn.db,
    "runtime_control_state",
    "execution_policy_version",
    "INTEGER NOT NULL DEFAULT 0",
  );

  backfillLiveProfileSettings(conn.db);
  ensureDefaultExecutionPolicy(conn.db);
  ensureAlgoRulesDefaults(conn.db);
  backfillBuySizePrecedence(conn.db);

  setRuntimeBusyTimeout(conn);
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
    // Post-031 shape: disabled_at column exists on family_deployments.
    // Post-036 shape: family_deployments is gone entirely — also satisfied.
    // Fresh bootstrap (no family_deployments) and upgrade post-036 are both handled.
    isAlreadyApplied: (db) =>
      !hasTable(db, "family_deployments") || hasColumn(db, "family_deployments", "disabled_at"),
  },
  {
    name: "033_drop_legacy_governance.sql",
    // Post-033 shape: strategy_stage column is gone from family_deployments.
    // Post-036 shape: family_deployments is gone entirely — also satisfied.
    isAlreadyApplied: (db) =>
      !hasTable(db, "family_deployments") || !hasColumn(db, "family_deployments", "strategy_stage"),
  },
  {
    name: "034_drop_discovery_tables.sql",
    // Post-034 shape: discovery tables are gone. Fresh bootstrap never creates
    // them; upgrade installs drop them via migration 034.
    isAlreadyApplied: (db) => !hasTable(db, "family_candidates"),
  },
  {
    name: "035_drop_family_rollup_effective_mode.sql",
    // Post-035 shape: effective_mode is gone from family_profile_rollups.
    // Post-036 shape: family_profile_rollups is gone entirely — also satisfied.
    isAlreadyApplied: (db) =>
      !hasTable(db, "family_profile_rollups") ||
      !hasColumn(db, "family_profile_rollups", "effective_mode"),
  },
  {
    name: "036_drop_family_tables.sql",
    // Post-036 shape: family_catalog is gone. Fresh bootstrap never creates it;
    // upgrade installs drop all family_ tables when migration 036 runs.
    isAlreadyApplied: (db) => !hasTable(db, "family_catalog"),
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
  {
    name: "038_execution_policy.sql",
    // Post-038 shape: profile_settings has execution_policy_json and
    // runtime_control_state has execution_policy_version. Fresh bootstrap
    // creates both directly; upgrade installs gain them when migration 038
    // runs. Seed of initial JSON payloads is idempotent on re-run.
    isAlreadyApplied: (db) =>
      hasColumn(db, "profile_settings", "execution_policy_json") &&
      hasColumn(db, "runtime_control_state", "execution_policy_version"),
  },
  {
    name: "039_drop_legacy_archive_tables.sql",
    // Post-039 shape: rollback archive tables created by old family/discovery
    // migrations are gone. Fresh bootstrap never creates them.
    isAlreadyApplied: (db) =>
      !hasTable(db, "archive_candidate_observation_markets_034") &&
      !hasTable(db, "archive_candidate_observations_034") &&
      !hasTable(db, "archive_family_candidates_034") &&
      !hasTable(db, "archive_discovery_runs_034") &&
      !hasTable(db, "archive_promotion_proposals_034") &&
      !hasTable(db, "archive_family_deployments_031") &&
      !hasTable(db, "archive_family_deployments_033"),
  },
  {
    name: "040_continuation_mode.sql",
    // Post-040 shape: runtime_control_state has continuation_mode +
    // continuation_mode_version. Fresh bootstrap creates both directly
    // via control.sql; upgrade installs gain them via this migration.
    isAlreadyApplied: (db) =>
      hasColumn(db, "runtime_control_state", "continuation_mode") &&
      hasColumn(db, "runtime_control_state", "continuation_mode_version"),
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
  // Upgrade an existing ledger before exec'ing the full schema: the schema
  // declares CREATE INDEX on columns (selection_status, tradable, …) that
  // pre-selection-rules DBs don't have yet. ALTER TABLE ADD COLUMN first so
  // `openDatabaseWithSchema` doesn't fail the index build on a missing column.
  const conn = openDatabase(dbPath, { busyTimeoutMs: BOOTSTRAP_BUSY_TIMEOUT_MS });
  safeAddColumn(conn.db, "markets", "outcome_index", "INTEGER");
  safeAddColumn(conn.db, "markets", "tradable", "INTEGER NOT NULL DEFAULT 1");
  safeAddColumn(conn.db, "markets", "event_market_count", "INTEGER NOT NULL DEFAULT 1");
  safeAddColumn(
    conn.db,
    "markets",
    "selection_status",
    "TEXT NOT NULL DEFAULT 'unknown' " +
      "CHECK (selection_status IN " +
      "('unknown','matched_include','matched_exclude','step2_fallback_include','fallback_exclude'))",
  );
  safeAddColumn(conn.db, "markets", "selection_winning_rule_id", "TEXT");
  // Step 0 §1.2/§1.3 — capture Gamma `createdAt` to compute `age_at_entry`
  // (spec §1.7 R14). Distinct from `markets.created_at` (DB write moment).
  safeAddColumn(conn.db, "markets", "gamma_created_at", "TEXT");
  // Step 3 §D3 — soft-ranking score columns. The schema source-of-truth
  // (ledger.sql) declares these inside the markets CREATE TABLE plus a
  // partial index on `score IS NOT NULL`; existing DBs need them added
  // before the schema re-exec runs the index build.
  safeAddColumn(conn.db, "markets", "score", "REAL");
  safeAddColumn(conn.db, "markets", "score_model_version", "TEXT");
  safeAddColumn(conn.db, "markets", "scored_at", "TEXT");
  safeAddColumn(conn.db, "markets", "features_captured_at", "TEXT");
  conn.db.exec(readSchema("ledger.sql"));
  safeAddColumn(conn.db, "orders", "decision_rule_id", "TEXT");
  safeAddColumn(conn.db, "orders", "signal_timestamp", "TEXT");
  safeAddColumn(conn.db, "orders", "exchange_error_code", "TEXT");
  safeAddColumn(conn.db, "orders", "exchange_error_message", "TEXT");
  safeAddColumn(conn.db, "orders", "exchange_error_payload", "TEXT");
  safeAddColumn(conn.db, "orders", "post_only", "INTEGER NOT NULL DEFAULT 0");
  safeAddColumn(conn.db, "orders", "cancel_reason", "TEXT");
  safeAddColumn(conn.db, "fills", "signal_id", "TEXT");
  safeAddColumn(conn.db, "fills", "decision_rule_id", "TEXT");
  safeAddColumn(conn.db, "fills", "signal_timestamp", "TEXT");
  safeAddColumn(conn.db, "fills", "liquidity_role", "TEXT NOT NULL DEFAULT 'unknown'");
  safeAddColumn(conn.db, "fills", "fee_rate_bps", "REAL NOT NULL DEFAULT 0");
  safeAddColumn(conn.db, "execution_policy_observations", "decision_rule_id", "TEXT");
  safeAddColumn(conn.db, "execution_policy_observations", "pricing_delta_ticks", "REAL");
  safeAddColumn(conn.db, "execution_policy_observations", "round_level_hit", "TEXT");
  safeAddColumn(conn.db, "positions", "entry_style", "TEXT");
  ensureUniqueOpenPositionIndex(conn.db);
  setRuntimeBusyTimeout(conn);
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
