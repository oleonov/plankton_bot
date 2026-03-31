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
  return conn;
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
