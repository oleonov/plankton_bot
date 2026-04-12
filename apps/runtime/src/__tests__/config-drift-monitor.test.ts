import { describe, expect, it } from "vitest";
import { computeConfigChecksum } from "@plankton/db";
import { evaluateConfigDrift } from "../config-drift-monitor.js";

const YAML = `
families:
  - family_id: "fam-1"
`;

describe("evaluateConfigDrift", () => {
  it("reports missing import metadata when control.db has no import record", () => {
    const result = evaluateConfigDrift({
      yamlRaw: YAML,
      latestConfigImport: null,
      loadedControlChecksum: null,
    });

    expect(result.warnings).toEqual(["missing-import-meta"]);
    expect(result.warningKey).not.toBeNull();
  });

  it("reports db-stale when YAML differs from the latest imported checksum", () => {
    const result = evaluateConfigDrift({
      yamlRaw: YAML,
      latestConfigImport: {
        importId: "imp-1",
        sourcePath: "config/family_rules.yaml",
        sourceChecksum: "old",
        sourceVersion: 1,
        importedAt: "2026-04-12T00:00:00.000Z",
        importedBy: "test",
      },
      loadedControlChecksum: "old",
    });

    expect(result.warnings).toEqual(["db-stale"]);
  });

  it("reports runtime-stale when control.db was updated after runtime boot", () => {
    const result = evaluateConfigDrift({
      yamlRaw: YAML,
      latestConfigImport: {
        importId: "imp-2",
        sourcePath: "config/family_rules.yaml",
        sourceChecksum: "new",
        sourceVersion: 1,
        importedAt: "2026-04-12T00:00:00.000Z",
        importedBy: "test",
      },
      loadedControlChecksum: "old",
    });

    expect(result.warnings).toEqual(["db-stale", "runtime-stale"]);
  });

  it("returns clean state when YAML, control.db, and loaded runtime checksum match", () => {
    const checksum = computeConfigChecksum(YAML);
    const result = evaluateConfigDrift({
      yamlRaw: YAML,
      latestConfigImport: {
        importId: "imp-3",
        sourcePath: "config/family_rules.yaml",
        sourceChecksum: checksum,
        sourceVersion: 1,
        importedAt: "2026-04-12T00:00:00.000Z",
        importedBy: "test",
      },
      loadedControlChecksum: checksum,
    });

    expect(result.warnings).toEqual([]);
    expect(result.warningKey).toBeNull();
  });
});
