import type { LatestConfigImportMeta } from "@plankton/db";
import { computeConfigChecksum } from "@plankton/db";

export interface ConfigDriftEvaluation {
  readonly yamlChecksum: string;
  readonly importedChecksum: string | null;
  readonly loadedControlChecksum: string | null;
  readonly warnings: readonly ("db-stale" | "runtime-stale" | "missing-import-meta")[];
  readonly warningKey: string | null;
}

export function evaluateConfigDrift(opts: {
  readonly yamlRaw: string;
  readonly latestConfigImport: LatestConfigImportMeta | null;
  readonly loadedControlChecksum: string | null;
}): ConfigDriftEvaluation {
  const yamlChecksum = computeConfigChecksum(opts.yamlRaw);
  const importedChecksum = opts.latestConfigImport?.sourceChecksum ?? null;
  const warnings: Array<"db-stale" | "runtime-stale" | "missing-import-meta"> = [];

  if (!opts.latestConfigImport) {
    warnings.push("missing-import-meta");
  } else if (importedChecksum !== yamlChecksum) {
    warnings.push("db-stale");
  }

  if (
    importedChecksum != null &&
    opts.loadedControlChecksum != null &&
    importedChecksum !== opts.loadedControlChecksum
  ) {
    warnings.push("runtime-stale");
  }

  return {
    yamlChecksum,
    importedChecksum,
    loadedControlChecksum: opts.loadedControlChecksum,
    warnings,
    warningKey:
      warnings.length === 0
        ? null
        : JSON.stringify({
            warnings,
            yamlChecksum,
            importedChecksum,
            loadedControlChecksum: opts.loadedControlChecksum,
          }),
  };
}
