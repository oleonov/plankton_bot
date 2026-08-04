import type { Database } from "better-sqlite3";
import type { MergeLedgerRepository, MergeRecord } from "@krabs/domain";

interface MergeLedgerRow {
  merge_id: string;
  condition_id: string;
  merged_amount: number;
  spread_pnl: number;
  merged_at: string;
  created_at: string;
  status: MergeRecord["status"];
}

function toMergeRecord(row: MergeLedgerRow): MergeRecord {
  return {
    mergeId: row.merge_id,
    conditionId: row.condition_id,
    mergedAmount: row.merged_amount,
    spreadPnl: row.spread_pnl,
    mergedAt: row.merged_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * better-sqlite3 does not throw when an UPDATE matches nothing, so without this the whole
 * write-ahead scheme degrades silently: `markApplied` would let `applyMerge`'s transaction commit
 * the position and lot mutations with no ledger row behind them — the exact untracked divergence
 * the 'pending'/'onchain'/'applied' states exist to make impossible, just in a new shape.
 */
function assertMatchedOneRow(changes: number, mergeId: string, target: string): void {
  if (changes !== 1) {
    throw new Error(
      `merge_ledger has no row for mergeId=${mergeId} — cannot mark '${target}' (matched ${changes} rows)`,
    );
  }
}

export class SqliteMergeLedgerRepository implements MergeLedgerRepository {
  constructor(private readonly db: Database) {}

  recordPending(merge: {
    mergeId: string;
    conditionId: string;
    mergedAmount: number;
    recordedAt: string;
  }): boolean {
    // spread_pnl/merged_at are NOT NULL but unknowable until settlement — markApplied overwrites
    // both with the real numbers once the merge actually completes. This call must run outside any
    // ambient transaction so it commits (autocommit) before the caller submits the on-chain merge.
    //
    // The conflict clause names migration 093's partial index EXACTLY (column + predicate), which
    // is what makes this the atomic claim: only "this condition already has an in-flight merge"
    // is absorbed into a `false`. Every other constraint — the merge_id primary key, the status
    // CHECK, a NOT NULL — still throws, because those are bugs, not contention. A blanket
    // `INSERT OR IGNORE` would swallow them and hand the caller a silent no-op instead.
    const { changes } = this.db
      .prepare(
        `INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at, status)
         VALUES (?, ?, ?, 0, ?, 'pending')
         ON CONFLICT (condition_id) WHERE status != 'applied' DO NOTHING`,
      )
      .run(merge.mergeId, merge.conditionId, merge.mergedAmount, merge.recordedAt);
    return changes === 1;
  }

  markOnchain(mergeId: string): void {
    const { changes } = this.db
      .prepare(`UPDATE merge_ledger SET status = 'onchain' WHERE merge_id = ?`)
      .run(mergeId);
    assertMatchedOneRow(changes, mergeId, "onchain");
  }

  markApplied(merge: MergeRecord): void {
    const { changes } = this.db
      .prepare(
        `UPDATE merge_ledger
           SET merged_amount = ?, spread_pnl = ?, merged_at = ?, status = 'applied'
         WHERE merge_id = ?`,
      )
      .run(merge.mergedAmount, merge.spreadPnl, merge.mergedAt, merge.mergeId);
    assertMatchedOneRow(changes, merge.mergeId, "applied");
  }

  deletePending(mergeId: string): void {
    // The `status = 'pending'` predicate is the safety, not a caller's promise: an intent that has
    // already advanced to 'onchain'/'applied' records a merge that really happened, and no failure
    // path may erase it. A zero-row delete here is therefore a legitimate outcome, not an error.
    this.db
      .prepare(`DELETE FROM merge_ledger WHERE merge_id = ? AND status = 'pending'`)
      .run(mergeId);
  }

  findNonTerminal(): MergeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status
         FROM merge_ledger WHERE status != 'applied'`,
      )
      .all() as MergeLedgerRow[];
    return rows.map(toMergeRecord);
  }
}
