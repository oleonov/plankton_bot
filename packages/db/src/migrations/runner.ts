import type Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function runMigrations(
  db: Database.Database,
  migrationsDir: string = import.meta.dirname,
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((row: unknown) => (row as { name: string }).name),
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
    db.transaction(() => {
      db.exec(applySafeAddColumnStatements(db, sql));
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    })();
  }
}

export function applySafeAddColumnStatements(db: Database.Database, sql: string): string {
  // `safe_add_column` is a migration-runner macro, not a SQLite UDF. Keeping it
  // out of db.exec avoids re-entering the same better-sqlite3 connection from a
  // custom function while still making split-ledger replay idempotent.
  return sql.replace(
    /^\s*SELECT\s+safe_add_column\('([A-Za-z_][A-Za-z0-9_]*)',\s*'([A-Za-z_][A-Za-z0-9_]*)',\s*'((?:[^']|'')*)'\);\s*$/gm,
    (_match, table: string, column: string, definition: string) => {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition.replace(/''/g, "'")}`);
      }
      return "";
    },
  );
}

export function listControlMigrationFiles(): string[] {
  return readdirSync(path.join(import.meta.dirname, "..", "migrations-control"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function runControlMigrations(db: Database.Database): void {
  runMigrations(db, path.join(import.meta.dirname, "..", "migrations-control"));
}
