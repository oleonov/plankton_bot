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

  it("applyFamilyConfigImport throws (disabled — dropped tables)", () => {
    const db = new Database(":memory:");
    expect(() =>
      applyFamilyConfigImport(
        db,
        {},
        {
          dryRun: false,
          sourceChecksum: "abc",
          importedBy: "test",
        },
      ),
    ).toThrow("disabled");
    db.close();
  });
});
