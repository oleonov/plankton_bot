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
          signal_reason, cancel_reason, decision_rule_id, signal_timestamp, exchange_error_code,
          exchange_error_message, exchange_error_payload, bot_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           status = excluded.status,
           exchange_order_id = excluded.exchange_order_id,
           post_only = excluded.post_only,
           size = excluded.size,
           size_usdc = excluded.size_usdc,
           signal_id = excluded.signal_id,
           signal_reason = excluded.signal_reason,
           cancel_reason = excluded.cancel_reason,
           decision_rule_id = excluded.decision_rule_id,
           signal_timestamp = excluded.signal_timestamp,
           exchange_error_code = excluded.exchange_error_code,
           exchange_error_message = excluded.exchange_error_message,
           exchange_error_payload = excluded.exchange_error_payload,
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
        order.cancelReason ?? null,
        order.decisionRuleId ?? null,
        order.signalTimestamp ?? null,
        order.exchangeErrorCode ?? null,
        order.exchangeErrorMessage ?? null,
        order.exchangeErrorPayload ?? null,
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

  updateStatus(
    id: OrderId,
    status: OrderStatus,
    exchangeOrderId?: string,
    cancelReason?: string,
  ): void {
    const assignments = ["status = ?", "updated_at = datetime('now')"];
    const params: unknown[] = [status];

    if (exchangeOrderId !== undefined) {
      assignments.push("exchange_order_id = ?");
      params.push(exchangeOrderId);
    }

    if (cancelReason !== undefined) {
      assignments.push("cancel_reason = ?");
      params.push(cancelReason);
    }

    params.push(id);
    this.db
      .prepare(
        `UPDATE orders
         SET ${assignments.join(", ")}
         WHERE order_id = ?`,
      )
      .run(...params);
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
      cancelReason: (row.cancel_reason as string) ?? null,
      exchangeOrderId: (row.exchange_order_id as string) ?? null,
      signalId: (row.signal_id as string) ?? null,
      signalReason: (row.signal_reason as string) ?? null,
      decisionRuleId: (row.decision_rule_id as string) ?? null,
      signalTimestamp: (row.signal_timestamp as string) ?? null,
      exchangeErrorCode: (row.exchange_error_code as string) ?? null,
      exchangeErrorMessage: (row.exchange_error_message as string) ?? null,
      exchangeErrorPayload: (row.exchange_error_payload as string) ?? null,
      botRunId: createBotRunId(row.bot_run_id as string),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
