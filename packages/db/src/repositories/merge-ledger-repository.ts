import type { Database } from "better-sqlite3";
import type { MergeLedgerRepository, MergeRecord } from "@plankton/domain";

export class SqliteMergeLedgerRepository implements MergeLedgerRepository {
  constructor(private readonly db: Database) {}

  save(merge: MergeRecord): void {
    this.db
      .prepare(
        `INSERT INTO merge_ledger
           (merge_id, condition_id, merged_amount, spread_pnl, merged_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(merge.mergeId, merge.conditionId, merge.mergedAmount, merge.spreadPnl, merge.mergedAt);
  }
}
