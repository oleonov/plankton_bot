import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";

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
    expect(names).toContain("family_runtime_state");
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

  it("backfills legacy discovery directional-updown rows in monolithic DBs", () => {
    conn.db.prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, source_type)
       VALUES ('legacy-fast:directional-updown:deadline', 'legacy-fast', 'stocks', 'directional-updown', 'deadline', 'daily', 'scalp', 'discovery')`,
    ).run();
    conn.db.prepare(
      `INSERT INTO family_rules
         (family_id, min_entry_price, max_entry_price, high_price_threshold,
          require_proven_family_above_price, preferred_entry_band, fast_lane_enabled)
       VALUES ('legacy-fast:directional-updown:deadline', 0, 1, 0.2, 0.2, NULL, NULL)`,
    ).run();

    conn.close();
    conn = bootstrapDatabase(path.join(tmpDir, "test.db"));

    const row = conn.db.prepare(
      `SELECT min_entry_price, max_entry_price, high_price_threshold,
              require_proven_family_above_price, preferred_entry_band, fast_lane_enabled
         FROM family_rules
        WHERE family_id = 'legacy-fast:directional-updown:deadline'`,
    ).get() as {
      min_entry_price: number;
      max_entry_price: number;
      high_price_threshold: number;
      require_proven_family_above_price: number;
      preferred_entry_band: string | null;
      fast_lane_enabled: number | null;
    };

    expect(row).toEqual({
      min_entry_price: 0.03,
      max_entry_price: 0.35,
      high_price_threshold: 0.35,
      require_proven_family_above_price: 0.35,
      preferred_entry_band: "0.05-0.35",
      fast_lane_enabled: 1,
    });
  });
});
