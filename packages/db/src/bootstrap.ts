import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, openDatabaseWithSchema, type DbConnection } from "./connection.js";
import { runMigrations } from "./migrations/runner.js";

export function bootstrapDatabase(dbPath: string): DbConnection {
  const conn = openDatabase(dbPath);
  runMigrations(conn.db);
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

  // Backfill: ensure every family_catalog entry has family_deployments rows.
  // Fixes families materialized before the accept endpoint was updated to create deployments.
  backfillDeployments(conn.db);

  return conn;
}

/**
 * Repair family_deployments: ensure every (family_id, profile) pair exists.
 * Handles both fully missing families AND partially filled ones (e.g. interrupted bootstrap).
 * Idempotent — INSERT OR IGNORE skips existing rows. Wrapped in transaction for atomicity.
 */
function backfillDeployments(db: import("better-sqlite3").Database): void {
  const families = db
    .prepare("SELECT family_id FROM family_catalog")
    .all() as { family_id: string }[];

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

/** ALTER TABLE ADD COLUMN, ignoring "duplicate column" errors. */
function safeAddColumn(db: import("better-sqlite3").Database, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("duplicate column")) throw err;
  }
}

export function bootstrapLedgerDb(dbPath: string): DbConnection {
  return openDatabaseWithSchema(dbPath, readSchema("ledger.sql"));
}
