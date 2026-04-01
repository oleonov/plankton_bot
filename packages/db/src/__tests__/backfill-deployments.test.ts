import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-backfill-"));
});

afterEach(() => {
  conn?.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedProfiles(c: DbConnection): void {
  const now = new Date().toISOString();
  for (const [id, name] of [["simulation", "Simulation"], ["paper", "Paper"], ["live-lite", "Live-Lite"]]) {
    c.db.prepare(
      "INSERT OR IGNORE INTO profiles (profile_id, display_name, description, created_at) VALUES (?, ?, '', ?)",
    ).run(id, name, now);
  }
}

describe("backfillDeployments", () => {
  it("creates deployments for catalog entries that have none", () => {
    const dbPath = path.join(tmpDir, "control.db");
    conn = bootstrapControlDb(dbPath);
    seedProfiles(conn);

    // Insert a family into catalog WITHOUT deployments (simulates pre-fix accept)
    conn.db.prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, created_at, updated_at)
       VALUES ('orphan-fam', 'orphan-key', 'crypto', 'threshold', 'daily', 'ad-hoc', 'scalp', datetime('now'), datetime('now'))`,
    ).run();

    // Close and re-bootstrap — backfill should run
    conn.close();
    conn = bootstrapControlDb(dbPath);

    const deps = conn.db
      .prepare("SELECT profile, enabled FROM family_deployments WHERE family_id = 'orphan-fam' ORDER BY profile")
      .all() as { profile: string; enabled: number }[];

    expect(deps).toHaveLength(3);
    expect(deps.find((d) => d.profile === "paper")?.enabled).toBe(1);
    expect(deps.find((d) => d.profile === "simulation")?.enabled).toBe(1);
    expect(deps.find((d) => d.profile === "live-lite")?.enabled).toBe(0);
  });

  it("does not duplicate deployments on repeated bootstrap", () => {
    const dbPath = path.join(tmpDir, "control.db");
    conn = bootstrapControlDb(dbPath);
    seedProfiles(conn);

    conn.db.prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, created_at, updated_at)
       VALUES ('dup-fam', 'dup-key', 'crypto', 'threshold', 'daily', 'ad-hoc', 'scalp', datetime('now'), datetime('now'))`,
    ).run();

    conn.close();
    conn = bootstrapControlDb(dbPath); // first backfill
    conn.close();
    conn = bootstrapControlDb(dbPath); // second backfill — should be idempotent

    const count = conn.db
      .prepare("SELECT COUNT(*) as cnt FROM family_deployments WHERE family_id = 'dup-fam'")
      .get() as { cnt: number };

    expect(count.cnt).toBe(3); // not 6
  });

  it("leaves existing deployments untouched", () => {
    const dbPath = path.join(tmpDir, "control.db");
    conn = bootstrapControlDb(dbPath);
    seedProfiles(conn);

    // Insert family with deployments already
    conn.db.prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, created_at, updated_at)
       VALUES ('existing-fam', 'existing-key', 'crypto', 'threshold', 'daily', 'ad-hoc', 'scalp', datetime('now'), datetime('now'))`,
    ).run();
    conn.db.prepare(
      `INSERT INTO family_deployments (family_id, profile, enabled) VALUES ('existing-fam', 'paper', 1)`,
    ).run();

    conn.close();
    conn = bootstrapControlDb(dbPath); // backfill should skip this family

    const count = conn.db
      .prepare("SELECT COUNT(*) as cnt FROM family_deployments WHERE family_id = 'existing-fam'")
      .get() as { cnt: number };

    expect(count.cnt).toBe(1); // not 3 — existing family already had deployment
  });
});
