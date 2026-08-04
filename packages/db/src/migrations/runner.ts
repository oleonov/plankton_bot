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

  const isApplied = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?");
  const markApplied = db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)");

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
    // Two guards, and they close DIFFERENT halves of the concurrent-bootstrap race. Neither alone
    // is enough, and `INSERT OR IGNORE` was never either of them.
    //
    // (1) IMMEDIATE, not the default DEFERRED. `safe_add_column` is a check-then-ALTER macro
    // (`PRAGMA table_info`, then `ALTER TABLE`), not atomic `IF NOT EXISTS` DDL. Under DEFERRED the
    // PRAGMA opens a READ snapshot; if the other bootstrap commits the same ALTER in the gap, the
    // upgrade to a write lock fails with SQLITE_BUSY_SNAPSHOT — which busy_timeout does NOT retry.
    // BEGIN IMMEDIATE takes the write lock UP FRONT, so the whole body is indivisible against every
    // other connection and a loser WAITS on the lock (busy_timeout DOES cover that).
    //
    // (2) The marker is re-read INSIDE that lock. `applied` was read once before this loop, so the
    // loser still believes the migration is outstanding; waiting on the lock does not change its
    // mind. Running the body again is only harmless for a `safe_add_column` migration — a raw
    // `ALTER TABLE` (e.g. migrations-control/038_execution_policy.sql) fails with "duplicate column
    // name" and takes the whole bootstrap down before the marker insert is ever reached. The
    // re-read is what makes the body genuinely run at most once; without it (1) only guarantees
    // that the two runs do not interleave, not that the second one is skipped.
    //
    // OR IGNORE is a backstop, not a guard: after the re-read no duplicate insert is reachable
    // (same transaction, same connection, write lock held, and no migration body opens or commits
    // a transaction of its own — the only BEGINs in the .sql files are CREATE TRIGGER bodies).
    db.transaction(() => {
      if (isApplied.get(file)) return;
      db.exec(applySafeAddColumnStatements(db, sql));
      markApplied.run(file);
    }).immediate();
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
