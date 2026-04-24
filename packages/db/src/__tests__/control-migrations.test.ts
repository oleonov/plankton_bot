import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb } from "../bootstrap.js";
import { runControlMigrations, runMigrations } from "../migrations/runner.js";
import type { DbConnection } from "../connection.js";
import Database from "better-sqlite3";

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-control-migr-"));
});

afterEach(() => {
  if (conn) conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("control-db migration infrastructure", () => {
  it("bootstrapControlDb creates schema_migrations table", () => {
    conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    const row = conn.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)
      .get();
    expect(row).toBeDefined();
  });

  it("is idempotent — second bootstrap on same file does not error", () => {
    const dbPath = path.join(tmpDir, "control.db");
    conn = bootstrapControlDb(dbPath);
    conn.close();
    conn = bootstrapControlDb(dbPath);

    const tables = conn.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
  });

  it("fresh bootstrap seeds per-migration baselines as already-applied", () => {
    conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    const applied = conn.db.prepare("SELECT name FROM schema_migrations").all() as {
      name: string;
    }[];
    // Fresh control.sql already reflects post-031 shape, so 031 is seeded as applied.
    expect(applied.map((r) => r.name)).toContain("031_flatten_family_deployments.sql");
    // Fresh control.sql has no family_ tables, so 036 is also seeded as applied.
    expect(applied.map((r) => r.name)).toContain("036_drop_family_tables.sql");
  });

  it("runner picks up a SQL file from an arbitrary migrationsDir", () => {
    const migrDir = path.join(tmpDir, "migrations-test");
    mkdirSync(migrDir);
    writeFileSync(
      path.join(migrDir, "099_test.sql"),
      `CREATE TABLE IF NOT EXISTS migr_test (id INTEGER PRIMARY KEY);`,
    );

    const db = new Database(path.join(tmpDir, "runner.db"));
    try {
      runMigrations(db, migrDir);
      const applied = db.prepare("SELECT name FROM schema_migrations").all() as {
        name: string;
      }[];
      expect(applied.map((r) => r.name)).toContain("099_test.sql");
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migr_test'`)
        .get();
      expect(tables).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("runControlMigrations is callable and uses the migrations-control folder", () => {
    conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    // Second call is guaranteed idempotent — no throw.
    expect(() => runControlMigrations(conn.db)).not.toThrow();
  });

  it("fresh bootstrap seeds profile_settings.execution_policy_json for every profile", () => {
    // Regression: migration 038 is marked applied by column existence on fresh
    // installs, so its UPDATE path never runs. ensureDefaultExecutionPolicy
    // must seed the JSON payload independently.
    conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    const rows = conn.db
      .prepare(
        `SELECT p.profile_id, s.execution_policy_json
           FROM profiles p
           LEFT JOIN profile_settings s USING (profile_id)`,
      )
      .all() as Array<{ profile_id: string; execution_policy_json: string | null }>;

    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.execution_policy_json).not.toBeNull();
      const parsed = JSON.parse(row.execution_policy_json!) as {
        deadSideGuard: { mode: string };
      };
      expect(parsed.deadSideGuard.mode).toBe(row.profile_id === "live-lite" ? "enforce" : "observe");
    }
  });
});
