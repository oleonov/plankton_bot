import type Database from "better-sqlite3";
import type { ConfigImportRepository, ConfigImport } from "@plankton/domain";
import { createImportId } from "@plankton/domain";
import type { ImportId } from "@plankton/domain";

export class SqliteConfigImportRepository implements ConfigImportRepository {
  constructor(private readonly db: Database.Database) {}

  save(importRecord: ConfigImport): void {
    this.db
      .prepare(
        `INSERT INTO config_imports
         (import_id, source_path, source_checksum, source_version,
          result_json, imported_at, imported_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(import_id) DO UPDATE SET
           source_path = excluded.source_path,
           source_checksum = excluded.source_checksum,
           source_version = excluded.source_version,
           result_json = excluded.result_json,
           imported_by = excluded.imported_by`,
      )
      .run(
        importRecord.importId,
        importRecord.sourcePath,
        importRecord.sourceChecksum,
        importRecord.sourceVersion,
        importRecord.resultJson,
        importRecord.importedAt,
        importRecord.importedBy,
      );
  }

  findById(importId: ImportId): ConfigImport | null {
    const row = this.db
      .prepare("SELECT * FROM config_imports WHERE import_id = ?")
      .get(importId) as Record<string, unknown> | undefined;
    return row ? rowToImport(row) : null;
  }

  findLatest(): ConfigImport | null {
    const row = this.db
      .prepare("SELECT * FROM config_imports ORDER BY imported_at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? rowToImport(row) : null;
  }
}

function rowToImport(row: Record<string, unknown>): ConfigImport {
  return {
    importId: createImportId(row.import_id as string),
    sourcePath: (row.source_path as string) ?? null,
    sourceChecksum: row.source_checksum as string,
    sourceVersion: (row.source_version as number) ?? null,
    resultJson: (row.result_json as string) ?? null,
    importedAt: row.imported_at as string,
    importedBy: (row.imported_by as string) ?? null,
  };
}
