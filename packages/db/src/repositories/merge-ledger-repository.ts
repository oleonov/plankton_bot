import type { Database } from "better-sqlite3";
import {
  createPositionId,
  createTokenId,
  type MergeLedgerRepository,
  type MergeRecord,
} from "@krabs/domain";

interface MergeLedgerRow {
  merge_id: string;
  condition_id: string;
  merged_amount: number;
  spread_pnl: number;
  merged_at: string;
  created_at: string;
  status: MergeRecord["status"];
  yes_token_id: string | null;
  no_token_id: string | null;
  yes_position_id: string | null;
  no_position_id: string | null;
}

function toMergeRecord(row: MergeLedgerRow): MergeRecord {
  return {
    mergeId: row.merge_id,
    conditionId: row.condition_id,
    mergedAmount: row.merged_amount,
    spreadPnl: row.spread_pnl,
    mergedAt: row.merged_at,
    status: row.status,
    yesTokenId: row.yes_token_id === null ? null : createTokenId(row.yes_token_id),
    noTokenId: row.no_token_id === null ? null : createTokenId(row.no_token_id),
    yesPositionId: row.yes_position_id === null ? null : createPositionId(row.yes_position_id),
    noPositionId: row.no_position_id === null ? null : createPositionId(row.no_position_id),
    createdAt: row.created_at,
  };
}

/**
 * better-sqlite3 does not throw when an UPDATE matches nothing, so without this the whole
 * write-ahead scheme degrades silently: `markApplied` would let `applyMerge`'s transaction commit
 * the position and lot mutations with no ledger row behind them — the exact untracked divergence
 * the 'pending'/'onchain'/'applied' states exist to make impossible, just in a new shape.
 *
 * Every transition below is therefore a compare-and-swap on the status it advances FROM, and this
 * is what makes zero matched rows meaningful rather than merely unlucky. Two processes can read the
 * same 'onchain' row at start-up — a rolling deploy, an overlapping restart — and both can decide
 * to settle it locally; only one `markApplied` can win the CAS, and the loser throws INSIDE
 * `MergeSettler.applyMerge`'s transaction, so its FIFO consumption and position writes roll back
 * instead of double-consuming inventory the chain only moved once.
 *
 * The message distinguishes "no such row" from "another process moved it": both are `changes = 0`,
 * but they call for opposite operator responses, and the row is re-read only on the failure path.
 */
function assertClaimedTransition(
  db: Database,
  changes: number,
  mergeId: string,
  from: MergeRecord["status"],
  to: MergeRecord["status"],
): void {
  if (changes === 1) return;
  const current = (
    db.prepare(`SELECT status FROM merge_ledger WHERE merge_id = ?`).get(mergeId) as
      | { status: MergeRecord["status"] }
      | undefined
  )?.status;
  throw new Error(
    current === undefined
      ? `merge_ledger has no row for mergeId=${mergeId} — cannot mark '${to}'`
      : `merge_ledger row mergeId=${mergeId} is '${current}', not '${from}' — refusing to mark ` +
          `'${to}' (another process moved it)`,
  );
}

export class SqliteMergeLedgerRepository implements MergeLedgerRepository {
  constructor(private readonly db: Database) {}

  recordPending(merge: {
    mergeId: string;
    conditionId: string;
    mergedAmount: number;
    recordedAt: string;
    yesTokenId: import("@krabs/domain").TokenId;
    noTokenId: import("@krabs/domain").TokenId;
    yesPositionId: import("@krabs/domain").PositionId;
    noPositionId: import("@krabs/domain").PositionId;
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
        `INSERT INTO merge_ledger (merge_id, condition_id, merged_amount, spread_pnl, merged_at, status, yes_token_id, no_token_id, yes_position_id, no_position_id)
         VALUES (?, ?, ?, 0, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT (condition_id) WHERE status != 'applied' DO NOTHING`,
      )
      .run(
        merge.mergeId,
        merge.conditionId,
        merge.mergedAmount,
        merge.recordedAt,
        merge.yesTokenId,
        merge.noTokenId,
        merge.yesPositionId,
        merge.noPositionId,
      );
    return changes === 1;
  }

  markOnchain(mergeId: string): void {
    // CAS from 'pending': without it this UPDATE can drag an already-'applied' row BACK to
    // 'onchain' — re-fencing a condition that was settled and inviting the recovery path to apply
    // the same merge a second time.
    const { changes } = this.db
      .prepare(
        `UPDATE merge_ledger SET status = 'onchain' WHERE merge_id = ? AND status = 'pending'`,
      )
      .run(mergeId);
    assertClaimedTransition(this.db, changes, mergeId, "pending", "onchain");
  }

  markApplied(
    merge: Pick<
      MergeRecord,
      "mergeId" | "conditionId" | "mergedAmount" | "spreadPnl" | "mergedAt" | "status"
    >,
  ): void {
    // CAS from 'onchain': this is the row-level lock that makes local settlement single-shot
    // across processes. See `assertClaimedTransition` for why losing it must throw rather than
    // no-op.
    const { changes } = this.db
      .prepare(
        `UPDATE merge_ledger
           SET merged_amount = ?, spread_pnl = ?, merged_at = ?, status = 'applied'
         WHERE merge_id = ? AND status = 'onchain'`,
      )
      .run(merge.mergedAmount, merge.spreadPnl, merge.mergedAt, merge.mergeId);
    assertClaimedTransition(this.db, changes, merge.mergeId, "onchain", "applied");
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
        `SELECT merge_id, condition_id, merged_amount, spread_pnl, merged_at, created_at, status, yes_token_id, no_token_id, yes_position_id, no_position_id
         FROM merge_ledger WHERE status != 'applied'`,
      )
      .all() as MergeLedgerRow[];
    return rows.map(toMergeRecord);
  }
}
