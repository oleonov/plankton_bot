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
  return openDatabaseWithSchema(dbPath, readSchema("control.sql"));
}

export function bootstrapLedgerDb(dbPath: string): DbConnection {
  return openDatabaseWithSchema(dbPath, readSchema("ledger.sql"));
}
