import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface FamilyConfigImportResult {
  added: string[];
  updated: string[];
  skipped: string[];
  conflicts: string[];
  unchanged: string[];
}

export interface ApplyFamilyConfigImportOptions {
  readonly dryRun: boolean;
  readonly sourcePath?: string | null;
  readonly sourceChecksum: string;
  readonly sourceVersion?: number | null;
  readonly importedBy: string;
}

export interface LatestConfigImportMeta {
  readonly importId: string;
  readonly sourcePath: string | null;
  readonly sourceChecksum: string;
  readonly sourceVersion: number | null;
  readonly importedAt: string;
  readonly importedBy: string | null;
}

export function computeConfigChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function getLatestConfigImportMeta(db: Database.Database): LatestConfigImportMeta | null {
  const row = db
    .prepare(
      `SELECT import_id, source_path, source_checksum, source_version, imported_at, imported_by
         FROM config_imports
        ORDER BY imported_at DESC
        LIMIT 1`,
    )
    .get() as
    | {
        import_id: string;
        source_path: string | null;
        source_checksum: string;
        source_version: number | null;
        imported_at: string;
        imported_by: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    importId: row.import_id,
    sourcePath: row.source_path,
    sourceChecksum: row.source_checksum,
    sourceVersion: row.source_version,
    importedAt: row.imported_at,
    importedBy: row.imported_by,
  };
}

/**
 * Disabled: family_rules / family_deployments tables have been dropped.
 * The new algorithm uses algo_decision_rules / algo_size_rules.
 */
export function applyFamilyConfigImport(
  _db: Database.Database,
  _loaded: unknown,
  _opts: ApplyFamilyConfigImportOptions,
): FamilyConfigImportResult {
  throw new Error(
    "applyFamilyConfigImport is disabled — family_rules / family_deployments tables have been dropped.",
  );
}
