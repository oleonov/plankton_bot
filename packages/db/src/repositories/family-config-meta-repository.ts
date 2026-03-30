import type Database from "better-sqlite3";
import type { FamilyConfigMetaRepository, FamilyConfigMeta } from "@plankton/domain";
import type { FamilyId } from "@plankton/domain";

export class SqliteFamilyConfigMetaRepository implements FamilyConfigMetaRepository {
  constructor(private readonly db: Database.Database) {}

  get(familyId: FamilyId): FamilyConfigMeta | null {
    const row = this.db
      .prepare("SELECT * FROM family_config_meta WHERE family_id = ?")
      .get(familyId) as Record<string, unknown> | undefined;
    return row ? rowToMeta(row) : null;
  }

  save(meta: FamilyConfigMeta): void {
    this.db
      .prepare(
        `INSERT INTO family_config_meta
         (family_id, last_imported_at, last_operator_edit_at, import_checksum)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(family_id) DO UPDATE SET
           last_imported_at = excluded.last_imported_at,
           last_operator_edit_at = excluded.last_operator_edit_at,
           import_checksum = excluded.import_checksum`,
      )
      .run(meta.familyId, meta.lastImportedAt, meta.lastOperatorEditAt, meta.importChecksum);
  }

  findOperatorEdited(): FamilyConfigMeta[] {
    const rows = this.db
      .prepare("SELECT * FROM family_config_meta WHERE last_operator_edit_at IS NOT NULL")
      .all() as Record<string, unknown>[];
    return rows.map(rowToMeta);
  }
}

function rowToMeta(row: Record<string, unknown>): FamilyConfigMeta {
  return {
    familyId: row.family_id as FamilyId,
    lastImportedAt: (row.last_imported_at as string) ?? null,
    lastOperatorEditAt: (row.last_operator_edit_at as string) ?? null,
    importChecksum: (row.import_checksum as string) ?? null,
  };
}
