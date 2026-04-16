import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  applyFamilyConfigImport,
  computeConfigChecksum,
  getLatestConfigImportMeta,
} from "../family-config-import.js";

describe("family-config-import", () => {
  it("computeConfigChecksum returns stable sha256 hex", () => {
    const a = computeConfigChecksum("hello");
    const b = computeConfigChecksum("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getLatestConfigImportMeta returns null on empty db", () => {
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE config_imports (import_id TEXT, source_path TEXT, source_checksum TEXT, source_version INTEGER, imported_at TEXT, imported_by TEXT)",
    );
    expect(getLatestConfigImportMeta(db)).toBeNull();
    db.close();
  });

  it("applyFamilyConfigImport dry-run returns empty result for empty families list", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE IF NOT EXISTS family_catalog (family_id TEXT PRIMARY KEY, family_key TEXT);
      CREATE TABLE IF NOT EXISTS family_rules (family_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS family_config_meta (family_id TEXT PRIMARY KEY, last_operator_edit_at TEXT, last_imported_at TEXT);
    `);
    const result = applyFamilyConfigImport(
      db,
      { families: [], defaults: { entry: null } },
      {
        dryRun: true,
        sourceChecksum: "abc",
        importedBy: "test",
      },
    );
    expect(result.added).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.unchanged).toEqual([]);
    db.close();
  });
});
