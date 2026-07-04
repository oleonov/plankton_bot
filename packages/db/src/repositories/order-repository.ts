import type Database from "better-sqlite3";
import type { OrderRepository, Order, OrderCancelTelemetry, CancelAgeBucket } from "@krabs/domain";
import type {
  OrderId,
  TokenId,
  ClientOrderId,
  OrderStatus,
  OrderSide,
  OrderType,
} from "@krabs/domain";
import { createOrderId, createTokenId, createConditionId, createBotRunId } from "@krabs/domain";

export class SqliteOrderRepository implements OrderRepository {
  constructor(private readonly db: Database.Database) {}

  save(order: Order): void {
    this.db
      .prepare(
        `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type, post_only,
          price, size, size_usdc, status, exchange_order_id, signal_id,
          signal_reason, cancel_reason, cancel_age_ms, cancel_age_bucket,
          fill_progress_shares, market_horizon,
          decision_rule_id, signal_timestamp, exchange_error_code,
          exchange_error_message, exchange_error_payload, exchange_rejection_reason,
          metadata_json, entry_style, bot_run_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(order_id) DO UPDATE SET
           status = excluded.status,
           exchange_order_id = excluded.exchange_order_id,
           post_only = excluded.post_only,
           size = excluded.size,
           size_usdc = excluded.size_usdc,
           signal_id = excluded.signal_id,
           signal_reason = excluded.signal_reason,
           cancel_reason = excluded.cancel_reason,
           cancel_age_ms = excluded.cancel_age_ms,
           cancel_age_bucket = excluded.cancel_age_bucket,
           fill_progress_shares = excluded.fill_progress_shares,
           market_horizon = excluded.market_horizon,
           decision_rule_id = excluded.decision_rule_id,
           signal_timestamp = excluded.signal_timestamp,
           exchange_error_code = excluded.exchange_error_code,
           exchange_error_message = excluded.exchange_error_message,
           exchange_error_payload = excluded.exchange_error_payload,
           exchange_rejection_reason = excluded.exchange_rejection_reason,
           metadata_json = excluded.metadata_json,
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
        order.cancelAgeMs ?? null,
        order.cancelAgeBucket ?? null,
        order.fillProgressShares ?? null,
        order.marketHorizon ?? null,
        order.decisionRuleId ?? null,
        order.signalTimestamp ?? null,
        order.exchangeErrorCode ?? null,
        order.exchangeErrorMessage ?? null,
        order.exchangeErrorPayload ?? null,
        order.exchangeRejectionReason ?? null,
        order.metadata ? JSON.stringify(order.metadata) : null,
        order.entryStyle ?? null,
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

  findRecentByTokenId(tokenId: TokenId, limit: number): Order[] {
    const rows = this.db
      .prepare("SELECT * FROM orders WHERE token_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(tokenId, Math.max(0, Math.trunc(limit))) as Record<string, unknown>[];
    return rows.map((r) => this.rowToOrder(r));
  }

  findFirstByTokenId(tokenId: TokenId): Order | null {
    const row = this.db
      .prepare("SELECT * FROM orders WHERE token_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(tokenId) as Record<string, unknown> | undefined;
    return row ? this.rowToOrder(row) : null;
  }

  findRecentBySignalReasons(
    signalReasons: readonly string[],
    sinceIso: string,
    limit: number,
  ): Order[] {
    if (signalReasons.length === 0 || limit <= 0) return [];
    const placeholders = signalReasons.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM orders
         WHERE signal_reason IN (${placeholders}) AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...signalReasons, sinceIso, Math.trunc(limit)) as Record<string, unknown>[];
    return rows.map((r) => this.rowToOrder(r));
  }

  updateStatus(
    id: OrderId,
    status: OrderStatus,
    exchangeOrderId?: string,
    cancelReason?: string,
    telemetry?: OrderCancelTelemetry,
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

    if (telemetry !== undefined) {
      assignments.push("cancel_age_ms = ?");
      params.push(telemetry.cancelAgeMs);
      assignments.push("cancel_age_bucket = ?");
      params.push(telemetry.cancelAgeBucket);
      assignments.push("fill_progress_shares = ?");
      params.push(telemetry.fillProgressShares);
      assignments.push("market_horizon = ?");
      params.push(telemetry.marketHorizon);
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

  updateMetadata(id: OrderId, metadata: Readonly<Record<string, unknown>>): Order {
    this.runMetadataUpdate(id, metadata);
    const updated = this.findById(id);
    if (!updated) {
      throw new Error(`Order not found after metadata update: ${String(id)}`);
    }
    return updated;
  }

  updateMetadataBulk(
    updates: readonly { orderId: OrderId; metadata: Readonly<Record<string, unknown>> }[],
  ): Order[] {
    if (updates.length === 0) return [];
    const apply = this.db.transaction(() => {
      for (const update of updates) {
        this.runMetadataUpdate(update.orderId, update.metadata);
      }
      return updates.map((update) => {
        const updated = this.findById(update.orderId);
        if (!updated) {
          throw new Error(`Order not found after metadata update: ${String(update.orderId)}`);
        }
        return updated;
      });
    });
    return apply();
  }

  sumOpenBuyNotional(): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(size_usdc), 0) as total FROM orders WHERE status IN ('pending', 'open', 'partially-filled') AND side = 'buy'",
      )
      .get() as { total: number };
    return row.total;
  }

  private runMetadataUpdate(id: OrderId, metadata: Readonly<Record<string, unknown>>): void {
    const result = this.db
      .prepare(
        `UPDATE orders
         SET metadata_json = ?, updated_at = datetime('now')
         WHERE order_id = ?`,
      )
      .run(JSON.stringify(metadata), id);
    if (result.changes !== 1) {
      throw new Error(`Order metadata update expected one row for order_id=${String(id)}`);
    }
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
      cancelAgeMs: (row.cancel_age_ms as number | null) ?? null,
      cancelAgeBucket: (row.cancel_age_bucket as CancelAgeBucket | null) ?? null,
      fillProgressShares: (row.fill_progress_shares as number | null) ?? null,
      marketHorizon: (row.market_horizon as string | null) ?? null,
      exchangeOrderId: (row.exchange_order_id as string) ?? null,
      signalId: (row.signal_id as string) ?? null,
      signalReason: (row.signal_reason as string) ?? null,
      decisionRuleId: (row.decision_rule_id as string) ?? null,
      signalTimestamp: (row.signal_timestamp as string) ?? null,
      entryStyle: (row.entry_style as "probe" | "maker") ?? null,
      exchangeErrorCode: (row.exchange_error_code as string) ?? null,
      exchangeErrorMessage: (row.exchange_error_message as string) ?? null,
      exchangeErrorPayload: (row.exchange_error_payload as string) ?? null,
      exchangeRejectionReason: (row.exchange_rejection_reason as string) ?? null,
      metadata: parseMetadata(row.metadata_json),
      botRunId: createBotRunId(row.bot_run_id as string),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}

function parseMetadata(raw: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}
