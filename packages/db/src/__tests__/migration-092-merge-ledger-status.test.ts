import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../migrations/runner.js";

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

function indexesOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((r) => r.name);
}

describe("migration 092 merge_ledger.status", () => {
  it("adds the status column and the non-terminal partial index, idempotently", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    runMigrations(db); // idempotent second run must not throw

    expect(columnsOf(db, "merge_ledger")).toContain("status");
    expect(indexesOf(db, "merge_ledger")).toContain("idx_merge_ledger_status_pending");

    // DEFAULT 'applied' is what preserves the meaning of every pre-092 row: those were only ever
    // written after a merge had completed.
    db.prepare(
      `INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at)
       VALUES ('m-1', 'c-1', 1, 0, '2026-01-01T00:00:00.000Z')`,
    ).run();
    expect(db.prepare("SELECT status FROM merge_ledger WHERE merge_id = 'm-1'").get()).toEqual({
      status: "applied",
    });
  });

  it("upgrades a legacy ledger whose baseline skipped the migration that creates merge_ledger", () => {
    // `LEDGER_BASELINE_MIGRATIONS` marks 021/033 applied on every DB that already has a `markets`
    // table, so a legacy ledger that never actually got merge_ledger never gets it from a migration
    // — and `bootstrapLedgerDb` execs the canonical schema only AFTER runMigrations on that path.
    // Without 091 ensuring the table, 092 dies here with "no such table: merge_ledger" and the whole
    // bootstrap throws, taking every later migration with it.
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    const seed = db.prepare("INSERT INTO schema_migrations (name) VALUES (?)");
    seed.run("021_merge_ledger.sql");
    seed.run("033_drop_family_columns.sql");

    runMigrations(db);

    expect(columnsOf(db, "merge_ledger")).toContain("status");
    // The resurrected table must be the CURRENT shape: 033 dropped family_id and is baselined too,
    // so recreating it with that column would hand later code a schema the repositories never write.
    expect(columnsOf(db, "merge_ledger")).not.toContain("family_id");
    expect(indexesOf(db, "merge_ledger")).toContain("idx_merge_ledger_status_pending");
  });
});
