import type Database from "better-sqlite3";
import type { FillRepository, Fill } from "@plankton/domain";
import type { OrderId, TokenId, FillId, OrderSide, FamilyId } from "@plankton/domain";
import {
  createFillId,
  createOrderId,
  createTokenId,
  createFamilyId,
} from "@plankton/domain";

export class SqliteFillRepository implements FillRepository {
  constructor(private readonly db: Database.Database) {}

  save(fill: Fill): void {
    this.db
      .prepare(
        `INSERT INTO fills
         (fill_id, order_id, token_id, family_id, side, price, size,
          size_usdc, fee, filled_at, reconciled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        fill.fillId,
        fill.orderId,
        fill.tokenId,
        fill.familyId,
        fill.side,
        fill.price,
        fill.size,
        fill.sizeUsdc,
        fill.fee,
        fill.filledAt,
      );
  }

  exists(fillId: FillId): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM fills WHERE fill_id = ? LIMIT 1")
      .get(fillId);
    return row !== undefined;
  }

  findByOrderId(orderId: OrderId): Fill[] {
    const rows = this.db
      .prepare("SELECT * FROM fills WHERE order_id = ?")
      .all(orderId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToFill(r));
  }

  findByTokenId(tokenId: TokenId): Fill[] {
    const rows = this.db
      .prepare("SELECT * FROM fills WHERE token_id = ?")
      .all(tokenId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToFill(r));
  }

  findRecent(limit: number): Fill[] {
    const rows = this.db
      .prepare("SELECT * FROM fills ORDER BY filled_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.rowToFill(r));
  }

  findUnreconciled(): Fill[] {
    const rows = this.db
      .prepare("SELECT * FROM fills WHERE reconciled = 0")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToFill(r));
  }

  markReconciled(fillIds: FillId[]): void {
    if (fillIds.length === 0) return;

    const placeholders = fillIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE fills SET reconciled = 1 WHERE fill_id IN (${placeholders})`,
      )
      .run(...fillIds);
  }

  private rowToFill(row: Record<string, unknown>): Fill {
    return {
      fillId: createFillId(row.fill_id as string),
      orderId: createOrderId(row.order_id as string),
      tokenId: createTokenId(row.token_id as string),
      familyId: createFamilyId(row.family_id as string),
      side: row.side as OrderSide,
      price: row.price as number,
      size: row.size as number,
      sizeUsdc: row.size_usdc as number,
      fee: row.fee as number,
      filledAt: row.filled_at as string,
    };
  }
}
