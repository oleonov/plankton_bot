import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb, bootstrapDatabase, bootstrapLedgerDb } from "../bootstrap.js";
import { RUNTIME_BUSY_TIMEOUT_MS, type DbConnection } from "../connection.js";

function readBusyTimeout(db: import("better-sqlite3").Database): number {
  const row = db.pragma("busy_timeout") as Array<{ timeout: number }>;
  return row[0]!.timeout;
}

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bootstrapDatabase", () => {
  it("creates an empty DB with all expected tables", () => {
    const tables = conn.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);

    expect(names).toContain("markets");
    expect(names).toContain("orders");
    expect(names).toContain("fills");
    expect(names).toContain("positions");
    expect(names).toContain("inventory_lots");
    expect(names).toContain("family_catalog");
    // family_runtime_state is dropped by migration 035
    expect(names).not.toContain("family_runtime_state");
    expect(names).toContain("operator_commands");
    expect(names).toContain("operator_actions");
    expect(names).toContain("schema_migrations");
  });

  it("is idempotent -- running bootstrap twice does not error", () => {
    const dbPath = path.join(tmpDir, "test.db");
    // conn was already bootstrapped with this path; bootstrap again on same file
    conn.close();
    conn = bootstrapDatabase(dbPath);

    const tables = conn.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];

    expect(tables.length).toBeGreaterThan(0);
  });

  it("records the migration in schema_migrations", () => {
    const rows = conn.db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.name).toBe("001_initial.sql");
  });

  it("migration 035 drops family_runtime_state so the table does not appear after bootstrap", () => {
    // bootstrapDatabase applies all ledger migrations in order. Migration 035
    // drops family_runtime_state (created by migration 001).
    const tables = conn.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'family_runtime_state'",
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(0);
  });

  it("returns a connection at the runtime busy_timeout (not the bootstrap budget)", () => {
    // The bootstrap window opens at 600s for DDL/CREATE INDEX, but the
    // returned connection is reused for the entire process lifetime — leaving
    // 600s in place would let a runtime/API query stall the event loop for
    // 10 minutes behind a write lock.
    expect(readBusyTimeout(conn.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
  });
});

describe("bootstrapControlDb busy_timeout scoping", () => {
  it("returns a connection at the runtime busy_timeout after bootstrap DDL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plankton-control-bootstrap-"));
    try {
      const c = bootstrapControlDb(path.join(dir, "control.db"));
      try {
        expect(readBusyTimeout(c.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
      } finally {
        c.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bootstrapLedgerDb busy_timeout scoping", () => {
  it("returns a connection at the runtime busy_timeout after bootstrap DDL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "plankton-ledger-bootstrap-"));
    try {
      const c = bootstrapLedgerDb(path.join(dir, "ledger.db"));
      try {
        expect(readBusyTimeout(c.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
      } finally {
        c.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
