import type Database from "better-sqlite3";
import type { FillRepository, Fill } from "@plankton/domain";
import type { OrderId, TokenId, FillId, OrderSide, LiquidityRole } from "@plankton/domain";
import { createFillId, createOrderId, createTokenId, createConditionId } from "@plankton/domain";

export class SqliteFillRepository implements FillRepository {
  private static readonly FIND_BY_ORDER_IDS_CHUNK_SIZE = 500;

  constructor(private readonly db: Database.Database) {}

  save(fill: Fill): void {
    this.db
      .prepare(
        `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size,
          size_usdc, liquidity_role, fee, fee_rate_bps, signal_id, decision_rule_id,
          signal_timestamp, filled_at, reconciled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        fill.fillId,
        fill.orderId,
        fill.tokenId,
        fill.conditionId,
        fill.side,
        fill.price,
        fill.size,
        fill.sizeUsdc,
        fill.liquidityRole,
        fill.fee,
        fill.feeRateBps,
        fill.signalId ?? null,
        fill.decisionRuleId ?? null,
        fill.signalTimestamp ?? null,
        fill.filledAt,
      );
  }

  exists(fillId: FillId): boolean {
    const row = this.db.prepare("SELECT 1 FROM fills WHERE fill_id = ? LIMIT 1").get(fillId);
    return row !== undefined;
  }

  findByOrderId(orderId: OrderId): Fill[] {
    const rows = this.db.prepare("SELECT * FROM fills WHERE order_id = ?").all(orderId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToFill(r));
  }

  findByOrderIds(orderIds: OrderId[]): Fill[] {
    if (orderIds.length === 0) return [];

    const rows: Record<string, unknown>[] = [];
    for (
      let offset = 0;
      offset < orderIds.length;
      offset += SqliteFillRepository.FIND_BY_ORDER_IDS_CHUNK_SIZE
    ) {
      const chunk = orderIds.slice(
        offset,
        offset + SqliteFillRepository.FIND_BY_ORDER_IDS_CHUNK_SIZE,
      );
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(
        ...(this.db
          .prepare(`SELECT * FROM fills WHERE order_id IN (${placeholders})`)
          .all(...chunk) as Record<string, unknown>[]),
      );
    }
    return rows.map((r) => this.rowToFill(r));
  }

  findByTokenId(tokenId: TokenId): Fill[] {
    const rows = this.db.prepare("SELECT * FROM fills WHERE token_id = ?").all(tokenId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToFill(r));
  }

  findRecentByTokenId(tokenId: TokenId, limit: number): Fill[] {
    const rows = this.db
      .prepare("SELECT * FROM fills WHERE token_id = ? ORDER BY filled_at DESC LIMIT ?")
      .all(tokenId, Math.max(0, Math.trunc(limit))) as Record<string, unknown>[];
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
      .prepare("SELECT * FROM fills WHERE reconciled = 0 ORDER BY filled_at ASC, fill_id ASC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToFill(r));
  }

  markReconciled(fillIds: FillId[]): void {
    if (fillIds.length === 0) return;

    const placeholders = fillIds.map(() => "?").join(", ");
    this.db
      .prepare(`UPDATE fills SET reconciled = 1 WHERE fill_id IN (${placeholders})`)
      .run(...fillIds);
  }

  getLatestTimestamp(): number | null {
    const row = this.db
      .prepare("SELECT filled_at FROM fills ORDER BY filled_at DESC LIMIT 1")
      .get() as { filled_at: string } | undefined;
    if (!row) return null;
    return new Date(row.filled_at).getTime();
  }

  private rowToFill(row: Record<string, unknown>): Fill {
    return {
      fillId: createFillId(row.fill_id as string),
      orderId: createOrderId(row.order_id as string),
      tokenId: createTokenId(row.token_id as string),
      conditionId: createConditionId(row.condition_id as string),
      side: row.side as OrderSide,
      price: row.price as number,
      size: row.size as number,
      sizeUsdc: row.size_usdc as number,
      liquidityRole: row.liquidity_role as LiquidityRole,
      fee: row.fee as number,
      feeRateBps: (row.fee_rate_bps as number) ?? 0,
      signalId: (row.signal_id as string) ?? null,
      decisionRuleId: (row.decision_rule_id as string) ?? null,
      signalTimestamp: (row.signal_timestamp as string) ?? null,
      filledAt: row.filled_at as string,
    };
  }
}
