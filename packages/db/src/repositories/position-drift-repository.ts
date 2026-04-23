import type { Database } from "better-sqlite3";
import type { PositionDrift, PositionDriftRepository } from "@plankton/domain";

interface PositionDriftRow {
  settlement_id: string;
  token_id: string;
  condition_id: string;
  detected_at: string;
  on_chain_balance: string;
  last_checked_at: string;
  status: "open" | "resolved";
  created_at: string;
}

function rowToDrift(row: PositionDriftRow): PositionDrift {
  return {
    settlementId: row.settlement_id,
    tokenId: row.token_id,
    conditionId: row.condition_id,
    detectedAt: row.detected_at,
    onChainBalance: row.on_chain_balance,
    lastCheckedAt: row.last_checked_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

export class SqlitePositionDriftRepository implements PositionDriftRepository {
  constructor(private readonly db: Database) {}

  upsert(drift: PositionDrift): void {
    this.db
      .prepare(
        `INSERT INTO position_drifts
           (settlement_id, token_id, condition_id, detected_at,
            on_chain_balance, last_checked_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(settlement_id) DO UPDATE SET
           on_chain_balance = excluded.on_chain_balance,
           last_checked_at  = excluded.last_checked_at,
           status           = excluded.status`,
      )
      .run(
        drift.settlementId,
        drift.tokenId,
        drift.conditionId,
        drift.detectedAt,
        drift.onChainBalance,
        drift.lastCheckedAt,
        drift.status,
      );
  }

  findOpen(): PositionDrift[] {
    const rows = this.db
      .prepare(
        `SELECT settlement_id, token_id, condition_id, detected_at,
                on_chain_balance, last_checked_at, status, created_at
           FROM position_drifts
          WHERE status = 'open'
          ORDER BY detected_at DESC`,
      )
      .all() as PositionDriftRow[];
    return rows.map(rowToDrift);
  }

  markResolved(settlementId: string, resolvedAtIso: string): void {
    this.db
      .prepare(
        `UPDATE position_drifts
            SET status          = 'resolved',
                last_checked_at = ?
          WHERE settlement_id   = ?`,
      )
      .run(resolvedAtIso, settlementId);
  }
}
