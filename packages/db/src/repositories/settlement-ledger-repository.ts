import type { Database } from "better-sqlite3";
import type { Order, SettlementLedgerRepository, SettlementRecord } from "@krabs/domain";
import { parseInstantMs } from "@krabs/domain";

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

type ClosureEvidence = NonNullable<
  ReturnType<NonNullable<SettlementLedgerRepository["findLocalClosureEvidence"]>>
>;
type ClosureFillRow = Omit<ClosureEvidence["fills"][number], "accounting"> & {
  orderPositionId: string | null;
  orderTokenId: string;
  orderConditionId: string;
  orderSide: string;
  orderCreatedAt: string;
};
type ClosureAccounting = ClosureEvidence["fills"][number]["accounting"];

const ALGO_REDEEM_RESOLUTION = "algo-redeem";

export class SqliteSettlementLedgerRepository implements SettlementLedgerRepository {
  constructor(private readonly db: Database) {}

  findLocalClosureEvidence(order: Order): ClosureEvidence | null {
    const raw = this.db
      .prepare(
        `SELECT o.metadata_json, p.opened_at, p.closed_at
      FROM orders o JOIN positions p ON p.position_id = o.position_id WHERE o.order_id = ?`,
      )
      .get(order.orderId) as
      | { metadata_json: string | null; opened_at: string; closed_at: string }
      | undefined;
    if (!raw || !order.positionId) return null;
    const settlements = (
      this.db
        .prepare("SELECT * FROM settlement_ledger WHERE position_id = ?")
        .all(order.positionId) as SettlementLedgerRow[]
    ).map(rowToRecord);
    const fills = this.findClosureFills(order, raw.opened_at, raw.closed_at);
    if (
      fills.some(
        (fill) =>
          fill.tokenId !== fill.orderTokenId ||
          fill.conditionId !== fill.orderConditionId ||
          fill.side !== fill.orderSide ||
          !(parseInstantMs(fill.filledAt) >= parseInstantMs(fill.orderCreatedAt)),
      )
    )
      return null;
    return { metadataJson: raw.metadata_json, settlements, fills };
  }

  private readClosureFillRows(order: Order): ClosureFillRow[] {
    return this.db
      .prepare(
        `WITH candidate_fill_ids AS (
        SELECT fill_id FROM fills WHERE token_id = ?
        UNION SELECT fill_id FROM fills WHERE order_id = ?
        UNION SELECT f.fill_id FROM orders o JOIN fills f ON f.order_id = o.order_id
          WHERE o.position_id = ?
        UNION SELECT fill_id FROM inventory_lots WHERE position_id = ?
        UNION SELECT fill_id FROM pnl_ledger WHERE position_id = ?
      )
      SELECT f.fill_id AS fillId, f.order_id AS orderId,
      f.token_id AS tokenId, f.condition_id AS conditionId, f.side, f.reconciled,
      f.filled_at AS filledAt, o.position_id AS orderPositionId,
      o.token_id AS orderTokenId, o.condition_id AS orderConditionId,
      o.side AS orderSide, o.created_at AS orderCreatedAt
      FROM fills f JOIN orders o ON o.order_id = f.order_id
      WHERE f.fill_id IN (SELECT fill_id FROM candidate_fill_ids)
      ORDER BY f.fill_id`,
      )
      .all(
        order.tokenId,
        order.orderId,
        order.positionId,
        order.positionId,
        order.positionId,
      ) as ClosureFillRow[];
  }

  private readClosureAccounting(fills: ClosureFillRow[]): Map<string, ClosureAccounting> {
    const grouped = new Map<string, ClosureAccounting>();
    for (const buy of [true, false]) {
      const ids = fills.filter((fill) => (fill.side === "buy") === buy).map((fill) => fill.fillId);
      if (!ids.length) continue;
      const rows = this.db
        .prepare(
          `SELECT a.fill_id AS fillId, a.position_id AS positionId, a.created_at AS createdAt,
            ${buy ? "a.token_id" : "p.token_id"} AS tokenId
          FROM ${buy ? "inventory_lots" : "pnl_ledger"} a
          JOIN positions p ON p.position_id = a.position_id
          WHERE a.fill_id IN (SELECT value FROM json_each(?))`,
        )
        .all(JSON.stringify(ids)) as (ClosureAccounting[number] & { fillId: string })[];
      for (const { fillId, ...entry } of rows) {
        const entries = grouped.get(fillId) ?? [];
        entries.push(entry);
        grouped.set(fillId, entries);
      }
    }
    return grouped;
  }

  private findClosureFills(order: Order, openedAt: string, closedAt: string) {
    const fills = this.readClosureFillRows(order);
    const accounting = this.readClosureAccounting(fills);
    return fills
      .map((fill) => ({ ...fill, accounting: accounting.get(fill.fillId) ?? [] }))
      .filter((fill) => {
        if (
          fill.orderId === order.orderId ||
          fill.orderPositionId === order.positionId ||
          fill.accounting.some((entry) => entry.positionId === order.positionId)
        )
          return true;
        const at = parseInstantMs(fill.filledAt);
        // Unattributed fills during this cycle must not disappear from the proof.
        return (
          !Number.isFinite(at) ||
          (!fill.orderPositionId &&
            at >= parseInstantMs(openedAt) &&
            at <= parseInstantMs(closedAt))
        );
      });
  }

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
