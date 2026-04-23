import type { Database } from "better-sqlite3";
import type { SettlementLedgerRepository, SettlementRecord } from "@plankton/domain";

interface SettlementLedgerRow {
  settlement_id: string;
  condition_id: string;
  position_id: string;
  token_id: string;
  resolution: string;
  settlement_price: number;
  size: number;
  delta: number;
  settled_at: string;
  created_at: string;
}

function rowToRecord(row: SettlementLedgerRow): SettlementRecord {
  return {
    settlementId: row.settlement_id,
    conditionId: row.condition_id,
    positionId: row.position_id,
    tokenId: row.token_id,
    resolution: row.resolution,
    settlementPrice: row.settlement_price,
    size: row.size,
    delta: row.delta,
    settledAt: row.settled_at,
    createdAt: row.created_at,
  };
}

const ALGO_REDEEM_RESOLUTION = "algo-redeem";

export class SqliteSettlementLedgerRepository implements SettlementLedgerRepository {
  constructor(private readonly db: Database) {}

  save(settlement: SettlementRecord): void {
    this.db
      .prepare(
        `INSERT INTO settlement_ledger
           (settlement_id, condition_id, position_id, token_id,
            resolution, settlement_price, size, delta, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        settlement.settlementId,
        settlement.conditionId,
        settlement.positionId,
        settlement.tokenId,
        settlement.resolution,
        settlement.settlementPrice,
        settlement.size,
        settlement.delta,
        settlement.settledAt,
      );
  }

  findAlgoRedeemSettlementsSince(cutoffIso: string): SettlementRecord[] {
    const rows = this.db
      .prepare(
        `SELECT settlement_id, condition_id, position_id, token_id,
                resolution, settlement_price, size, delta, settled_at, created_at
           FROM settlement_ledger
          WHERE resolution = ? AND settled_at > ?
          ORDER BY settled_at DESC`,
      )
      .all(ALGO_REDEEM_RESOLUTION, cutoffIso) as SettlementLedgerRow[];
    return rows.map(rowToRecord);
  }
}
