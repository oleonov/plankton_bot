import type {
  ExchangeGateway,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  TokenId,
} from "@plankton/domain";

export type FillMode = "immediate" | "manual";

export interface SimulationExchangeConfig {
  fillMode?: FillMode;
  initialBalanceUsdc?: number;
  feeRate?: number;
}

export class SimulationExchangeGateway implements ExchangeGateway {
  private orderCounter = 0;
  private fillCounter = 0;
  private readonly orders = new Map<string, ExchangeOrder>();
  private readonly fills: ExchangeFill[] = [];
  private readonly clientOrderIds = new Set<string>();
  private balanceUsdc: number;
  private lockedUsdc = 0;
  private readonly fillMode: FillMode;
  private readonly feeRate: number;

  constructor(config: SimulationExchangeConfig = {}) {
    this.fillMode = config.fillMode ?? "immediate";
    this.balanceUsdc = config.initialBalanceUsdc ?? 10_000;
    this.feeRate = config.feeRate ?? 0;
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    if (params.price < 0 || params.price > 1) {
      return {
        success: false,
        errorCode: "INVALID_PRICE",
        errorMessage: "Price must be in [0, 1]",
      };
    }
    if (params.size <= 0) {
      return { success: false, errorCode: "INVALID_SIZE", errorMessage: "Size must be positive" };
    }
    if (this.clientOrderIds.has(params.clientOrderId)) {
      return {
        success: false,
        errorCode: "DUPLICATE_CLIENT_ORDER_ID",
        errorMessage: "Duplicate clientOrderId",
      };
    }

    const cost = params.side === "buy" ? params.size * params.price : 0;
    if (cost > this.balanceUsdc - this.lockedUsdc) {
      return {
        success: false,
        errorCode: "INSUFFICIENT_BALANCE",
        errorMessage: "Insufficient USDC balance",
      };
    }

    this.orderCounter++;
    const orderId = `sim-ord-${this.orderCounter}`;
    const now = Date.now();

    this.clientOrderIds.add(params.clientOrderId);

    if (this.fillMode === "immediate") {
      const fee = params.size * params.price * this.feeRate;
      this.fillCounter++;
      const fillId = `sim-fill-${this.fillCounter}`;

      const fill: ExchangeFill = {
        fillId,
        orderId,
        clientOrderId: params.clientOrderId,
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        size: params.size,
        fee,
        timestamp: now,
      };
      this.fills.push(fill);

      if (params.side === "buy") {
        this.balanceUsdc -= params.size * params.price + fee;
      } else {
        this.balanceUsdc += params.size * params.price - fee;
      }

      const order: ExchangeOrder = {
        orderId,
        clientOrderId: params.clientOrderId,
        tokenId: params.tokenId,
        side: params.side,
        price: params.price,
        sizeTotal: params.size,
        sizeFilled: params.size,
        sizeRemaining: 0,
        status: "FILLED",
        createdAt: now,
      };
      this.orders.set(orderId, order);

      return { success: true, orderId };
    }

    // Manual fill mode — order stays OPEN
    if (params.side === "buy") {
      this.lockedUsdc += cost;
    }

    const order: ExchangeOrder = {
      orderId,
      clientOrderId: params.clientOrderId,
      tokenId: params.tokenId,
      side: params.side,
      price: params.price,
      sizeTotal: params.size,
      sizeFilled: 0,
      sizeRemaining: params.size,
      status: "OPEN",
      createdAt: now,
    };
    this.orders.set(orderId, order);

    return { success: true, orderId };
  }

  async cancelOrder(params: CancelOrderParams): Promise<CancelOrderResult> {
    const order = this.orders.get(params.orderId);
    if (!order) {
      return { success: false, errorCode: "ORDER_NOT_FOUND", errorMessage: "Order not found" };
    }
    if (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED") {
      return { success: false, errorCode: "ORDER_NOT_FOUND", errorMessage: "Order is not open" };
    }

    if (order.side === "buy") {
      this.lockedUsdc -= order.sizeRemaining * order.price;
    }

    this.orders.set(params.orderId, { ...order, status: "CANCELLED", sizeRemaining: 0 });
    return { success: true };
  }

  async cancelAllOrders(): Promise<CancelOrderResult> {
    for (const [id, order] of this.orders) {
      if (order.status === "OPEN" || order.status === "PARTIALLY_FILLED") {
        if (order.side === "buy") {
          this.lockedUsdc -= order.sizeRemaining * order.price;
        }
        this.orders.set(id, { ...order, status: "CANCELLED", sizeRemaining: 0 });
      }
    }
    return { success: true };
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    return [...this.orders.values()].filter(
      (o) => o.status === "OPEN" || o.status === "PARTIALLY_FILLED",
    );
  }

  async getOpenOrdersForToken(tokenId: TokenId): Promise<ExchangeOrder[]> {
    return (await this.getOpenOrders()).filter((o) => o.tokenId === tokenId);
  }

  async getFills(sinceMs: number): Promise<ExchangeFill[]> {
    return this.fills.filter((f) => f.timestamp >= sinceMs);
  }

  async getBalances(): Promise<ExchangeBalance[]> {
    return [
      { asset: "USDC", available: this.balanceUsdc - this.lockedUsdc, locked: this.lockedUsdc },
    ];
  }

  async getPositionBalance(_tokenId: TokenId): Promise<number> {
    return 0;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }

  // ─── Test helpers (not part of interface) ──────────────────────────────

  /** Manually inject a fill for an open order (used in "manual" fill mode). */
  injectFill(orderId: string, fillSize: number): ExchangeFill | null {
    const order = this.orders.get(orderId);
    if (!order || (order.status !== "OPEN" && order.status !== "PARTIALLY_FILLED")) return null;

    const size = Math.min(fillSize, order.sizeRemaining);
    const fee = size * order.price * this.feeRate;
    this.fillCounter++;
    const fillId = `sim-fill-${this.fillCounter}`;

    const fill: ExchangeFill = {
      fillId,
      orderId,
      clientOrderId: order.clientOrderId,
      tokenId: order.tokenId,
      side: order.side,
      price: order.price,
      size,
      fee,
      timestamp: Date.now(),
    };
    this.fills.push(fill);

    const newFilled = order.sizeFilled + size;
    const newRemaining = order.sizeTotal - newFilled;
    const newStatus = newRemaining <= 0 ? ("FILLED" as const) : ("PARTIALLY_FILLED" as const);

    if (order.side === "buy") {
      this.lockedUsdc -= size * order.price;
      this.balanceUsdc -= size * order.price + fee;
    } else {
      this.balanceUsdc += size * order.price - fee;
    }

    this.orders.set(orderId, {
      ...order,
      sizeFilled: newFilled,
      sizeRemaining: newRemaining,
      status: newStatus,
    });

    return fill;
  }

  /** Reset all state. */
  reset(initialBalanceUsdc = 10_000): void {
    this.orders.clear();
    this.fills.length = 0;
    this.clientOrderIds.clear();
    this.orderCounter = 0;
    this.fillCounter = 0;
    this.balanceUsdc = initialBalanceUsdc;
    this.lockedUsdc = 0;
  }
}
