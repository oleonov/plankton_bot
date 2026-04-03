import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveFamilyLiveTradingPolicy } from "@plankton/domain";
import { openDatabase, openDatabaseWithSchema, type DbConnection } from "./connection.js";
import { runMigrations } from "./migrations/runner.js";

export function bootstrapDatabase(dbPath: string): DbConnection {
  const conn = openDatabase(dbPath);
  runMigrations(conn.db);
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
  return conn;
}

function readSchema(filename: string): string {
  return readFileSync(join(import.meta.dirname, "schemas", filename), "utf-8");
}

export function bootstrapControlDb(dbPath: string): DbConnection {
  const conn = openDatabaseWithSchema(dbPath, readSchema("control.sql"));
  // Schema evolution: add columns that may be missing in existing DBs.
  // CREATE TABLE IF NOT EXISTS won't add new columns to existing tables.
  safeAddColumn(conn.db, "profile_summaries", "wallet_balance_usdc", "REAL");
  safeAddColumn(conn.db, "runtime_control_state", "resume_intent_at", "TEXT");
  safeAddColumn(conn.db, "promotion_proposals", "applied_command_id", "INTEGER");
  safeAddColumn(conn.db, "profile_settings", "wallet_mode", "TEXT");
  safeAddColumn(conn.db, "profile_settings", "min_order_usdc", "REAL");
  safeAddColumn(conn.db, "profile_settings", "relayer_json", "TEXT");
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

  // Backfill: ensure every family_catalog entry has family_deployments rows.
  // Fixes families materialized before the accept endpoint was updated to create deployments.
  backfillDeployments(conn.db);
  backfillLiveProfileSettings(conn.db);
  backfillFamilyLivePolicy(conn.db);

  return conn;
}

/**
 * Repair family_deployments: ensure every (family_id, profile) pair exists.
 * Handles both fully missing families AND partially filled ones (e.g. interrupted bootstrap).
 * Idempotent — INSERT OR IGNORE skips existing rows. Wrapped in transaction for atomicity.
 */
function backfillDeployments(db: import("better-sqlite3").Database): void {
  const families = db.prepare("SELECT family_id FROM family_catalog").all() as {
    family_id: string;
  }[];

  if (families.length === 0) return;

  const profiles = [
    { profile: "simulation", enabled: 1 },
    { profile: "paper", enabled: 1 },
    { profile: "live-lite", enabled: 0 },
  ];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO family_deployments
       (family_id, profile, enabled, operator_mode, strategy_stage,
        deployment_stage, priority, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 'probe-only', 'disabled', 999, datetime('now'), datetime('now'))`,
  );

  db.transaction(() => {
    for (const { family_id } of families) {
      for (const { profile, enabled } of profiles) {
        insert.run(family_id, profile, enabled);
      }
    }
  })();
}

function backfillLiveProfileSettings(db: import("better-sqlite3").Database): void {
  try {
    db.prepare(
      `UPDATE profile_settings
       SET wallet_mode = COALESCE(wallet_mode, 'eoa'),
           min_order_usdc = COALESCE(min_order_usdc, 3)
       WHERE profile_id = 'live-lite'`,
    ).run();
  } catch {
    // Legacy test DBs may not have the profile_settings table.
  }
}

function backfillFamilyLivePolicy(db: import("better-sqlite3").Database): void {
  let rows: Array<{ family_id: string; primary_category: string; fee_tier: string | null }>;
  try {
    rows = db.prepare(
      `SELECT family_id, primary_category, fee_tier
       FROM family_catalog`,
    ).all() as Array<{ family_id: string; primary_category: string; fee_tier: string | null }>;
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
  return conn;
}
