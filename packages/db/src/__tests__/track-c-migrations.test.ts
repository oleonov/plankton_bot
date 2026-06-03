import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpDir: string;
let db: Database.Database;

function readMigration(filename: string): string {
  return readFileSync(path.join(import.meta.dirname, "..", "migrations", filename), "utf-8");
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-track-c-migr-"));
  db = new Database(path.join(tmpDir, "ledger.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("migration 062 - floor_intents", () => {
  function applyMigration(): void {
    db.exec(readMigration("062_floor_intents.sql"));
  }

  it("creates the floor_intents table and indexes", () => {
    applyMigration();

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='floor_intents'")
      .get();
    expect(table).toBeTruthy();

    const columns = db.prepare("PRAGMA table_info(floor_intents)").all() as Array<{
      name: string;
      notnull: 0 | 1;
      dflt_value: string | null;
    }>;
    const names = columns.map((column) => column.name);
    expect(names).toContain("token_id");
    expect(names).toContain("target_price");
    expect(names).toContain("created_at");
    expect(names).toContain("attempt_count");
    expect(names).toContain("status");

    const attemptCount = columns.find((column) => column.name === "attempt_count");
    expect(attemptCount?.notnull).toBe(1);
    expect(attemptCount?.dflt_value).toBe("0");

    const index = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_floor_intents_active_token'",
      )
      .get() as { name: string; sql: string } | undefined;
    expect(index?.sql).toContain("WHERE status = 'active'");
  });

  it("enforces one active floor intent per token via partial unique index", () => {
    applyMigration();

    const insert = db.prepare(
      `INSERT INTO floor_intents
        (id, token_id, status, target_price, created_at)
       VALUES (?, 'tok-1', ?, 0.1, '2026-06-02T00:00:00Z')`,
    );

    insert.run("intent-1", "active");
    expect(() => insert.run("intent-2", "active")).toThrow(/UNIQUE constraint failed/i);
    expect(() => insert.run("intent-3", "cancelled")).not.toThrow();
  });

  it("is idempotent", () => {
    applyMigration();
    expect(() => applyMigration()).not.toThrow();
  });
});

describe("migration 063 - hold_resolution_states", () => {
  function applyMigration(): void {
    db.exec(readMigration("063_hold_resolution_states.sql"));
  }

  it("creates the hold_resolution_states table and alert index", () => {
    applyMigration();

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='hold_resolution_states'")
      .get();
    expect(table).toBeTruthy();

    const columns = db.prepare("PRAGMA table_info(hold_resolution_states)").all() as Array<{
      name: string;
      notnull: 0 | 1;
      dflt_value: string | null;
    }>;
    const names = columns.map((column) => column.name);
    expect(names).toContain("token_id");
    expect(names).toContain("marker_created_at");
    expect(names).toContain("expected_resolution_at");
    expect(names).toContain("attempt_count_for_redeem");
    expect(names).toContain("status");

    const redeemAttempts = columns.find((column) => column.name === "attempt_count_for_redeem");
    expect(redeemAttempts?.notnull).toBe(1);
    expect(redeemAttempts?.dflt_value).toBe("0");

    const alertIndex = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_hold_resolution_status_marker_created'",
      )
      .get() as { name: string; sql: string } | undefined;
    expect(alertIndex?.sql).toContain("status, marker_created_at");
  });

  it("is idempotent", () => {
    applyMigration();
    expect(() => applyMigration()).not.toThrow();
  });
});
