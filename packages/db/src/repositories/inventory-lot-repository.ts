import type Database from "better-sqlite3";
import type { InventoryLotRepository } from "@plankton/domain";
import type { InventoryLot, PositionId, TokenId } from "@plankton/domain";
import {
  createLotId,
  createPositionId,
  createTokenId,
  createFamilyId,
  createFillId,
} from "@plankton/domain";
import type { OrderSide } from "@plankton/domain";

interface LotRow {
  lot_id: string;
  position_id: string;
  token_id: string;
  family_id: string;
  side: string;
  size: number;
  remaining_size: number;
  entry_price: number;
  cost_usdc: number;
  fill_id: string;
  created_at: string;
}

function rowToLot(row: LotRow): InventoryLot {
  return {
    lotId: createLotId(row.lot_id),
    positionId: createPositionId(row.position_id),
    tokenId: createTokenId(row.token_id),
    familyId: createFamilyId(row.family_id),
    side: row.side as OrderSide,
    size: row.size,
    remainingSize: row.remaining_size,
    entryPrice: row.entry_price,
    costUsdc: row.cost_usdc,
    fillId: createFillId(row.fill_id),
    createdAt: row.created_at,
  };
}

export class SqliteInventoryLotRepository implements InventoryLotRepository {
  constructor(private readonly db: Database.Database) {}

  save(lot: InventoryLot): void {
    this.db
      .prepare(
        `INSERT INTO inventory_lots
           (lot_id, position_id, token_id, family_id, side, size,
            remaining_size, entry_price, cost_usdc, fill_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        lot.lotId,
        lot.positionId,
        lot.tokenId,
        lot.familyId,
        lot.side,
        lot.size,
        lot.remainingSize,
        lot.entryPrice,
        lot.costUsdc,
        lot.fillId,
        lot.createdAt,
      );
  }

  findByTokenId(tokenId: TokenId): InventoryLot[] {
    const rows = this.db
      .prepare(`SELECT * FROM inventory_lots WHERE token_id = ?`)
      .all(tokenId) as LotRow[];
    return rows.map(rowToLot);
  }

  findOpen(positionId: PositionId): InventoryLot[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inventory_lots
         WHERE position_id = ? AND remaining_size > 0
         ORDER BY created_at ASC`,
      )
      .all(positionId) as LotRow[];
    return rows.map(rowToLot);
  }

  consumeFifo(positionId: PositionId, size: number): { lot: InventoryLot; consumed: number }[] {
    return this.db.transaction(() => {
      const openLots = this.db
        .prepare(
          `SELECT * FROM inventory_lots
           WHERE position_id = ? AND remaining_size > 0
           ORDER BY created_at ASC`,
        )
        .all(positionId) as LotRow[];

      const totalAvailable = openLots.reduce((sum, r) => sum + r.remaining_size, 0);
      if (totalAvailable < size) {
        throw new Error(`Insufficient inventory: requested ${size}, available ${totalAvailable}`);
      }

      const updateStmt = this.db.prepare(
        `UPDATE inventory_lots SET remaining_size = remaining_size - ? WHERE lot_id = ?`,
      );

      const result: { lot: InventoryLot; consumed: number }[] = [];
      let remaining = size;

      for (const row of openLots) {
        if (remaining <= 0) break;
        const consumed = Math.min(row.remaining_size, remaining);
        updateStmt.run(consumed, row.lot_id);
        remaining -= consumed;

        // Re-read to return the updated lot
        const updatedRow = this.db
          .prepare(`SELECT * FROM inventory_lots WHERE lot_id = ?`)
          .get(row.lot_id) as LotRow;
        result.push({ lot: rowToLot(updatedRow), consumed });
      }

      return result;
    })();
  }

  settleAll(positionId: PositionId): void {
    this.db
      .prepare(
        `UPDATE inventory_lots SET remaining_size = 0 WHERE position_id = ? AND remaining_size > 0`,
      )
      .run(positionId);
  }
}
