import { openDatabase, type DbConnection } from "./connection.js";
import { runMigrations } from "./migrations/runner.js";

export function bootstrapDatabase(dbPath: string): DbConnection {
  const conn = openDatabase(dbPath);
  runMigrations(conn.db);
  return conn;
}
