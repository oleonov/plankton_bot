import type Database from "better-sqlite3";
import type { FamilyRulesSnapshotRepository, FamilyRulesSnapshot, FamilyId } from "@plankton/domain";
import { createFamilyId } from "@plankton/domain";

interface SnapshotRow {
  id: number;
  family_id: string;
  snapshot: string;
  reason: string;
  captured_at: string;
}

function rowToSnapshot(row: SnapshotRow): FamilyRulesSnapshot {
  return {
    id: row.id,
    familyId: createFamilyId(row.family_id),
    snapshot: row.snapshot,
    reason: row.reason,
    capturedAt: row.captured_at,
  };
}

export class SqliteFamilyRulesSnapshotRepository implements FamilyRulesSnapshotRepository {
  constructor(private readonly db: Database.Database) {}

  save(snapshot: Omit<FamilyRulesSnapshot, "id">): void {
    this.db
      .prepare(
        `INSERT INTO family_rules_snapshot
           (family_id, snapshot, reason, captured_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(snapshot.familyId, snapshot.snapshot, snapshot.reason, snapshot.capturedAt);
  }

  findLatest(familyId: FamilyId): FamilyRulesSnapshot | null {
    const row = this.db
      .prepare(
        `SELECT * FROM family_rules_snapshot
         WHERE family_id = ? ORDER BY captured_at DESC LIMIT 1`,
      )
      .get(familyId) as SnapshotRow | undefined;
    return row ? rowToSnapshot(row) : null;
  }
}
