import type { Database } from "better-sqlite3";
import type { MergeLedgerRepository, MergeRecord, FamilyId } from "@plankton/domain";

export class SqliteMergeLedgerRepository implements MergeLedgerRepository {
  constructor(private readonly db: Database) {}

  save(merge: MergeRecord): void {
    this.db
      .prepare(
        `INSERT INTO merge_ledger
           (merge_id, condition_id, family_id, merged_amount, spread_pnl, merged_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        merge.mergeId,
        merge.conditionId,
        merge.familyId,
        merge.mergedAmount,
        merge.spreadPnl,
        merge.mergedAt,
      );
  }

  findByFamily(familyId: FamilyId): MergeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM merge_ledger WHERE family_id = ? ORDER BY merged_at DESC`)
      .all(String(familyId));

    return rows.map((row: any) => ({
      mergeId: row.merge_id,
      conditionId: row.condition_id,
      familyId: row.family_id,
      mergedAmount: row.merged_amount,
      spreadPnl: row.spread_pnl,
      mergedAt: row.merged_at,
      createdAt: row.created_at,
    }));
  }
}
