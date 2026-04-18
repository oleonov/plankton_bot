/**
 * bootstrap-import.test.ts — Phase 6: family YAML bootstrap is a no-op.
 *
 * Only tests that do not depend on the removed bootstrapImport() / family
 * seeding flow are kept. The maybeBootstrapFromYaml stub always returns
 * bootstrapped: false so callers don't log misleading messages.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@plankton/db";
import {
  needsBootstrap,
  syncProfileInitialBalances,
  maybeBootstrapFromYaml,
} from "../bootstrap-import.js";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

function createControlDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(CONTROL_SQL);
  return conn;
}

describe("bootstrap-import (Phase 6 stubs)", () => {
  let conn: DbConnection;
  let db: import("better-sqlite3").Database;

  beforeEach(() => {
    conn = createControlDb();
    db = conn.db;
  });

  it("needsBootstrap returns true on empty DB", () => {
    expect(needsBootstrap(db)).toBe(true);
  });

  it("maybeBootstrapFromYaml is a no-op (Phase 6)", () => {
    const result = maybeBootstrapFromYaml(db, "/tmp/family_rules.yaml");
    expect(result.bootstrapped).toBe(false);
    expect(result.importedFamilies).toBe(0);
    // DB should still be empty — no family seeding
    expect(needsBootstrap(db)).toBe(true);
  });

  it("syncProfileInitialBalances fills missing balances after profiles exist", () => {
    // Create the profile_settings rows first (normally done by bootstrapImport)
    db.exec(`
      INSERT INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation'), ('paper', 'Paper'), ('live-lite', 'Live Lite')
      ON CONFLICT DO NOTHING;
      INSERT INTO profile_settings (profile_id) VALUES ('simulation'), ('paper'), ('live-lite')
      ON CONFLICT DO NOTHING;
    `);

    syncProfileInitialBalances(db, 100);

    const rows = db
      .prepare("SELECT profile_id, initial_balance_usdc FROM profile_settings ORDER BY profile_id")
      .all() as Array<{ profile_id: string; initial_balance_usdc: number | null }>;

    expect(rows).toEqual([
      { profile_id: "live-lite", initial_balance_usdc: 100 },
      { profile_id: "paper", initial_balance_usdc: 100 },
      { profile_id: "simulation", initial_balance_usdc: 100 },
    ]);
  });

  it("syncProfileInitialBalances does not overwrite explicit non-null balances", () => {
    db.exec(`
      INSERT INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation'), ('paper', 'Paper'), ('live-lite', 'Live Lite')
      ON CONFLICT DO NOTHING;
      INSERT INTO profile_settings (profile_id, initial_balance_usdc)
        VALUES ('simulation', 500), ('paper', 500), ('live-lite', 500)
      ON CONFLICT DO NOTHING;
    `);

    syncProfileInitialBalances(db, 100);

    const rows = db
      .prepare("SELECT profile_id, initial_balance_usdc FROM profile_settings ORDER BY profile_id")
      .all() as Array<{ profile_id: string; initial_balance_usdc: number | null }>;

    expect(rows.every((r) => r.initial_balance_usdc === 500)).toBe(true);
  });
});
