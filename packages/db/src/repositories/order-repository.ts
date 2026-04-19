import type Database from "better-sqlite3";
import type { OrderRepository, Order } from "@plankton/domain";
import type {
  OrderId,
  TokenId,
  ClientOrderId,
  OrderStatus,
  OrderSide,
  OrderType,
} from "@plankton/domain";
import { createOrderId, createTokenId, createConditionId, createBotRunId } from "@plankton/domain";

export class SqliteOrderRepository implements OrderRepository {
  constructor(private readonly db: Database.Database) {}

  save(order: Order): void {
    this.db
      .prepare(
        `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type, post_only,
          price, size, size_usdc, status, exchange_order_id, signal_id,
          signal_reason, bot_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           status = excluded.status,
           exchange_order_id = excluded.exchange_order_id,
           post_only = excluded.post_only,
           size = excluded.size,
           size_usdc = excluded.size_usdc,
           updated_at = excluded.updated_at`,
      )
      .run(
        order.orderId,
        order.clientOrderId,
        order.tokenId,
        order.conditionId,
        order.side,
        order.orderType,
        order.postOnly === true ? 1 : 0,
        order.price,
        order.size,
        order.sizeUsdc,
        order.status,
        order.exchangeOrderId,
        order.signalId,
        order.signalReason,
        order.botRunId,
        order.createdAt,
        order.updatedAt,
      );
  }

  findById(id: OrderId): Order | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE order_id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  findByClientOrderId(clientOrderId: string): Order | null {
    const row = this.db
      .prepare("SELECT * FROM orders WHERE client_order_id = ?")
      .get(clientOrderId) as Record<string, unknown> | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  findByExchangeOrderId(exchangeOrderId: string): Order | null {
    const row = this.db
      .prepare("SELECT * FROM orders WHERE exchange_order_id = ?")
      .get(exchangeOrderId) as Record<string, unknown> | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  findOpen(): Order[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE status IN ('pending', 'open', 'partially-filled')")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToOrder(r));
  }

  findByTokenId(tokenId: TokenId): Order[] {
    const rows = this.db.prepare("SELECT * FROM orders WHERE token_id = ?").all(tokenId) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToOrder(r));
  }

  updateStatus(id: OrderId, status: OrderStatus, exchangeOrderId?: string): void {
    if (exchangeOrderId !== undefined) {
      this.db
        .prepare(
          `UPDATE orders
           SET status = ?, exchange_order_id = ?, updated_at = datetime('now')
           WHERE order_id = ?`,
        )
        .run(status, exchangeOrderId, id);
    } else {
      this.db
        .prepare(
          `UPDATE orders
           SET status = ?, updated_at = datetime('now')
           WHERE order_id = ?`,
        )
        .run(status, id);
    }
  }

  sumOpenBuyNotional(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(size_usdc), 0) as total FROM orders WHERE status IN ('pending', 'open', 'partially-filled') AND side = 'buy'",
      )
      .get() as { total: number };
    return row.total;
  }

  private rowToOrder(row: Record<string, unknown>): Order {
    return {
      orderId: createOrderId(row.order_id as string),
      clientOrderId: row.client_order_id as string as ClientOrderId,
      tokenId: createTokenId(row.token_id as string),
      conditionId: createConditionId(row.condition_id as string),
      side: row.side as OrderSide,
      orderType: row.order_type as OrderType,
      postOnly: row.post_only === 1,
      price: row.price as number,
      size: row.size as number,
      sizeUsdc: row.size_usdc as number,
      status: row.status as OrderStatus,
      exchangeOrderId: (row.exchange_order_id as string) ?? null,
      signalId: (row.signal_id as string) ?? null,
      signalReason: (row.signal_reason as string) ?? null,
      botRunId: createBotRunId(row.bot_run_id as string),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
