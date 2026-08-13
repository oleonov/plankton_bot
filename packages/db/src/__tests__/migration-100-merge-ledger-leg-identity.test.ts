import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";

const migrations = new URL("../migrations/", import.meta.url).pathname;
const targetColumns = [
  "merge_id",
  "condition_id",
  "merged_amount",
  "spread_pnl",
  "merged_at",
  "created_at",
  "status",
  "yes_token_id",
  "no_token_id",
  "yes_position_id",
  "no_position_id",
];
const targetIndexes = {
  idx_merge_ledger_merged_at: { unique: 0, partial: 0, columns: ["merged_at"] },
  idx_merge_ledger_one_non_terminal_per_condition: {
    unique: 1,
    partial: 1,
    columns: ["condition_id"],
  },
  idx_merge_ledger_status_pending: { unique: 0, partial: 1, columns: ["status"] },
  sqlite_autoindex_merge_ledger_1: { unique: 1, partial: 0, columns: ["merge_id"] },
};
const legacyFamilyIndexes = {
  ...targetIndexes,
  idx_merge_ledger_family: { unique: 0, partial: 0, columns: ["family_id"] },
};

function legacy(family = false): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE merge_ledger (
    merge_id TEXT PRIMARY KEY, condition_id TEXT NOT NULL${family ? ", family_id TEXT NOT NULL" : ""},
    merged_amount REAL NOT NULL, spread_pnl REAL NOT NULL, merged_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('pending','onchain','applied'))
  )`);
  if (family) {
    db.exec(`
      CREATE INDEX idx_merge_ledger_family ON merge_ledger(family_id);
      CREATE INDEX idx_merge_ledger_merged_at ON merge_ledger(merged_at);
      CREATE INDEX idx_merge_ledger_status_pending ON merge_ledger(status) WHERE status != 'applied';
      CREATE UNIQUE INDEX idx_merge_ledger_one_non_terminal_per_condition
        ON merge_ledger(condition_id) WHERE status != 'applied';
    `);
  }
  db.exec(
    "CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  const marker = db.prepare("INSERT INTO schema_migrations(name) VALUES (?)");
  for (const file of readdirSync(migrations)) {
    if (file.endsWith(".sql") && file !== "100_merge_ledger_leg_identity.sql") marker.run(file);
  }
  return db;
}

function indexShapes(db: Database.Database) {
  return Object.fromEntries(
    (
      db.prepare("PRAGMA index_list(merge_ledger)").all() as Array<{
        name: string;
        unique: number;
        partial: number;
      }>
    ).map(({ name, unique, partial }) => [
      name,
      {
        unique,
        partial,
        columns: (db.prepare(`PRAGMA index_info('${name}')`).all() as Array<{ name: string }>).map(
          (row) => row.name,
        ),
      },
    ]),
  );
}

function assertTargetShape(db: Database.Database): void {
  expect(
    db
      .prepare("PRAGMA table_info(merge_ledger)")
      .all()
      .map((row) => (row as { name: string }).name),
  ).toEqual(targetColumns);
  expect(indexShapes(db)).toEqual(targetIndexes);
}

function assertIdentityCheckSemantics(db: Database.Database): void {
  const insert = db.prepare(
    "INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at, status, yes_token_id, no_token_id, yes_position_id, no_position_id) VALUES (?, ?, 1, 0, 'x', ?, ?, ?, ?, ?)",
  );
  insert.run("applied-null", "applied-null", "applied", null, null, null, null);
  expect(() => insert.run("bad-status", "bad-status", "invalid", "y", "n", "py", "pn")).toThrow();
  for (const values of [
    [null, "n", "py", "pn"],
    ["y", null, "py", "pn"],
    ["y", "n", null, "pn"],
    ["y", "n", "py", null],
    ["", "n", "py", "pn"],
    ["y", "", "py", "pn"],
    ["y", "n", "", "pn"],
    ["y", "n", "py", ""],
    ["same", "same", "py", "pn"],
    ["y", "n", "same", "same"],
  ]) {
    expect(() =>
      insert.run(`bad-${values.join("-")}`, `c-${values.join("-")}`, "pending", ...values),
    ).toThrow();
  }
  insert.run("complete", "complete", "pending", "y", "n", "py", "pn");
  expect(() => insert.run("duplicate", "complete", "onchain", "y2", "n2", "py2", "pn2")).toThrow();
  insert.run("applied-same-condition", "complete", "applied", null, null, null, null);
}

describe("migration 100 merge ledger leg identity", () => {
  it("converges canonical and legacy-family applied history", () => {
    for (const family of [false, true]) {
      const db = legacy(family);
      if (family) expect(indexShapes(db)).toEqual(legacyFamilyIndexes);
      db.prepare(
        `INSERT INTO merge_ledger (merge_id, condition_id${family ? ", family_id" : ""}, merged_amount, spread_pnl, merged_at, status) VALUES ('m','c'${family ? ", 'f'" : ""},1,0,'2026-01-01T00:00:00.000Z','applied')`,
      ).run();
      runMigrations(db, migrations);
      runMigrations(db, migrations);
      assertTargetShape(db);
      expect(indexShapes(db)).not.toHaveProperty("idx_merge_ledger_family");
      expect(
        db
          .prepare(
            "SELECT yes_token_id, no_token_id, yes_position_id, no_position_id FROM merge_ledger",
          )
          .get(),
      ).toEqual({
        yes_token_id: null,
        no_token_id: null,
        yes_position_id: null,
        no_position_id: null,
      });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = '100_merge_ledger_leg_identity.sql'",
          )
          .get(),
      ).toEqual({ count: 1 });
      assertIdentityCheckSemantics(db);
    }
  });

  it("rolls back an unidentified nonterminal row and its marker", () => {
    const db = legacy();
    db.prepare(
      "INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at, status) VALUES ('m','c',1,0,'2026-01-01T00:00:00.000Z','onchain')",
    ).run();
    expect(() => runMigrations(db, migrations)).toThrow();
    expect(
      db
        .prepare("PRAGMA table_info(merge_ledger)")
        .all()
        .map((row) => (row as { name: string }).name),
    ).not.toContain("yes_token_id");
    expect(
      db
        .prepare("SELECT 1 FROM schema_migrations WHERE name='100_merge_ledger_leg_identity.sql'")
        .get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT status FROM merge_ledger WHERE merge_id = 'm'").get()).toEqual({
      status: "onchain",
    });
  });

  it("matches the fresh canonical shape and constraints", () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(new URL("../schemas/ledger.sql", import.meta.url), "utf8"));
    assertTargetShape(db);
    assertIdentityCheckSemantics(db);
  });
});
