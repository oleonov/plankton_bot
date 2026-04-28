import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import { createOrderId, createTokenId, createConditionId } from "@plankton/domain";
import type {
  ExchangeBalance,
  ExchangeFill,
  ExchangeGateway,
  ExchangeUserEventStream,
  ExchangeOrder,
  ExchangeUserOrderEvent,
  ExchangeUserTradeEvent,
  FillRepository,
  MarketRepository,
  OrderRepository,
  PlaceOrderParams,
  PlaceOrderResult,
  CancelOrderParams,
  CancelOrderResult,
  TokenId,
} from "@plankton/domain";
import { UserOrderStreamModule } from "../modules/reconciliation/user-order-stream-module.js";

class FakeUserEventStream implements ExchangeUserEventStream {
  handlers: {
    onTradeEvents: (events: readonly ExchangeUserTradeEvent[]) => Promise<void> | void;
    onOrderEvents: (events: readonly ExchangeUserOrderEvent[]) => Promise<void> | void;
    onGapDetected?:
      | ((info: Readonly<{ reason: string; timestamp: number }>) => Promise<void> | void)
      | undefined;
  } | null = null;
  closed = false;
  conditionIds: string[] = [];

  setConditionIds(conditionIds: readonly string[]): void {
    this.conditionIds = [...conditionIds];
  }

  close(): void {
    this.closed = true;
  }

  async emitTrade(event: ExchangeUserTradeEvent): Promise<void> {
    await this.handlers?.onTradeEvents([event]);
  }

  async emitOrder(event: ExchangeUserOrderEvent): Promise<void> {
    await this.handlers?.onOrderEvents([event]);
  }

  async emitGap(reason = "socket-close"): Promise<void> {
    await this.handlers?.onGapDetected?.({ reason, timestamp: Date.now() });
  }
}

function createMockGateway(stream: FakeUserEventStream): ExchangeGateway {
  return {
    placeOrder: vi.fn<(p: PlaceOrderParams) => Promise<PlaceOrderResult>>().mockResolvedValue({
      success: true,
      orderId: "ignored",
    }),
    cancelOrder: vi.fn<(p: CancelOrderParams) => Promise<CancelOrderResult>>().mockResolvedValue({
      success: true,
    }),
    cancelAllOrders: vi.fn().mockResolvedValue({ success: true }),
    getOpenOrders: vi.fn<() => Promise<ExchangeOrder[]>>().mockResolvedValue([]),
    getOpenOrdersForToken: vi
      .fn<(tokenId: TokenId) => Promise<ExchangeOrder[]>>()
      .mockResolvedValue([]),
    getFills: vi.fn<(sinceMs: number) => Promise<ExchangeFill[]>>().mockResolvedValue([]),
    getBalances: vi.fn<() => Promise<ExchangeBalance[]>>().mockResolvedValue([]),
    getPositionBalance: vi.fn<(tokenId: TokenId) => Promise<number>>().mockResolvedValue(0),
    getOutcomeTokenBalance: vi.fn<(tokenId: TokenId) => Promise<bigint>>().mockResolvedValue(0n),
    redeemPositions: vi.fn<(conditionIds: string[]) => Promise<void>>().mockResolvedValue(),
    mergePositions: vi
      .fn<(merges: { conditionId: string; amount: number }[]) => Promise<void>>()
      .mockResolvedValue(),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    createUserEventStream: (handlers) => {
      stream.handlers = handlers;
      return stream;
    },
  };
}

function createMockFillRepo(): FillRepository {
  return {
    save: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    findByOrderId: vi.fn().mockReturnValue([]),
    findByOrderIds: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    findRecent: vi.fn().mockReturnValue([]),
    findUnreconciled: vi.fn().mockReturnValue([]),
    markReconciled: vi.fn(),
    getLatestTimestamp: vi.fn().mockReturnValue(null),
  };
}

function createMockOrderRepo() {
  const order = {
    orderId: createOrderId("ord-local"),
    clientOrderId: "cloid-1" as any,
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy" as const,
    orderType: "GTC" as const,
    price: 0.5,
    size: 10,
    sizeUsdc: 5,
    status: "open" as const,
    exchangeOrderId: "ord-exch-1",
    signalId: null,
    signalReason: "probe-entry",
    botRunId: "run-1" as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const repo: OrderRepository = {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(order),
    findByClientOrderId: vi.fn().mockReturnValue(order),
    findByExchangeOrderId: vi.fn().mockReturnValue(order),
    findOpen: vi.fn().mockReturnValue([order]),
    findByTokenId: vi.fn().mockReturnValue([order]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
  return { repo, order };
}

function createMockMarketRepo(orderTokenId: TokenId): MarketRepository {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockImplementation((tokenId: TokenId) =>
      String(tokenId) === String(orderTokenId)
        ? {
            tokenId: orderTokenId,
            conditionId: "cond-1",
            slug: "slug-1",
            eventSlug: null,
            question: "question",
            outcome: "YES",
            outcomeIndex: 0,
            regime: "generic",
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        : null,
    ),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findTrackedForPricingTiered: vi.fn().mockReturnValue({
      executionCritical: [],
      entryCandidates: [],
      discoveryOnly: [],
    }),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

describe("UserOrderStreamModule", () => {
  let stream: FakeUserEventStream;
  let gateway: ExchangeGateway;
  let fillRepo: ReturnType<typeof createMockFillRepo>;
  let orderRepo: OrderRepository;
  let order: ReturnType<typeof createMockOrderRepo>["order"];
  let marketRepo: MarketRepository;
  let bus: InProcessEventBus;
  let mod: UserOrderStreamModule;

  beforeEach(() => {
    stream = new FakeUserEventStream();
    gateway = createMockGateway(stream);
    fillRepo = createMockFillRepo();
    ({ repo: orderRepo, order } = createMockOrderRepo());
    marketRepo = createMockMarketRepo(order.tokenId);
    bus = new InProcessEventBus();
    mod = new UserOrderStreamModule({
      gateway,
      fillRepo,
      marketRepo,
      orderRepo,
      bus,
      log: silentLog,
      now: () => 1_700_000_000_000,
    });
  });

  afterEach(async () => {
    await mod.stop();
  });

  it("imports websocket trade fills and publishes FillReceived", async () => {
    const received: unknown[] = [];
    bus.subscribe("FillReceived", async (payload) => {
      received.push(payload);
    });

    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 10 }]);

    await mod.start();
    await stream.emitTrade({
      type: "trade",
      tradeId: "trade-1",
      status: "MATCHED",
      timestamp: 1_699_999_999_500,
      fills: [
        {
          fillId: "fill-1",
          orderId: "ord-exch-1",
          clientOrderId: order.clientOrderId,
          tokenId: order.tokenId,
          side: "buy",
          price: 0.5,
          size: 10,
          liquidityRole: "unknown",
          fee: 0,
          feeRateBps: 0,
          timestamp: 1_699_999_999_500,
        },
      ],
    });

    expect(fillRepo.save).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(mod.getMetricsSnapshot().wsFills).toBe(1);
  });

  it("buffers orphan websocket trades and flushes them after local order placement", async () => {
    (orderRepo.findByClientOrderId as any).mockReturnValue(null);
    (orderRepo.findByExchangeOrderId as any).mockReturnValue(null);
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 10 }]);

    await mod.start();
    await stream.emitTrade({
      type: "trade",
      tradeId: "trade-orphan",
      status: "MATCHED",
      timestamp: 1_699_999_999_500,
      fills: [
        {
          fillId: "fill-orphan",
          orderId: "ord-exch-1",
          clientOrderId: order.clientOrderId,
          tokenId: order.tokenId,
          side: "buy",
          price: 0.5,
          size: 10,
          liquidityRole: "unknown",
          fee: 0,
          feeRateBps: 0,
          timestamp: 1_699_999_999_500,
        },
      ],
    });

    expect(fillRepo.save).not.toHaveBeenCalled();
    expect(mod.getMetricsSnapshot().orphanBufferSize).toBe(1);

    (orderRepo.findByClientOrderId as any).mockReturnValue(order);
    (orderRepo.findByExchangeOrderId as any).mockReturnValue(order);
    await bus.publish("OrderPlaced", {
      commandId: "cmd-1" as any,
      clientOrderId: order.clientOrderId,
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      side: order.side,
      price: order.price,
      size: order.size,
      orderType: order.orderType,
      signalReason: order.signalReason,
      timestamp: Date.now(),
    });

    expect(fillRepo.save).toHaveBeenCalledTimes(1);
    expect(mod.getMetricsSnapshot().orphanBufferSize).toBe(0);
  });

  it("applies cancellation order updates once and publishes OrderCancelled once", async () => {
    const cancelled: unknown[] = [];
    bus.subscribe("OrderCancelled", async (payload) => {
      cancelled.push(payload);
    });

    await mod.start();
    const cancellation: ExchangeUserOrderEvent = {
      type: "order",
      event: "CANCELLATION",
      orderId: "ord-exch-1",
      clientOrderId: order.clientOrderId,
      tokenId: order.tokenId,
      side: order.side,
      sizeTotal: 10,
      sizeFilled: 0,
      sizeRemaining: 10,
      status: "CANCELLED",
      timestamp: 1_699_999_999_500,
    };

    await stream.emitOrder(cancellation);
    await stream.emitOrder(cancellation);

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "cancelled",
      "ord-exch-1",
      "exchange-user-ws-cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(mod.getMetricsSnapshot().dedupeHits).toBe(1);
  });

  it("does not regress a terminal local order back to open on stale websocket placement", async () => {
    (orderRepo.findByClientOrderId as any).mockReturnValue({
      ...order,
      status: "filled",
    });
    (orderRepo.findByExchangeOrderId as any).mockReturnValue({
      ...order,
      status: "filled",
    });

    await mod.start();
    await stream.emitOrder({
      type: "order",
      event: "PLACEMENT",
      orderId: "ord-exch-1",
      clientOrderId: order.clientOrderId,
      tokenId: order.tokenId,
      side: order.side,
      sizeTotal: 10,
      sizeFilled: 0,
      sizeRemaining: 10,
      status: "OPEN",
      timestamp: 1_699_999_999_500,
    });

    expect(orderRepo.updateStatus).not.toHaveBeenCalledWith(order.orderId, "open", "ord-exch-1");
  });

  it("does not rewrite a filled local order to cancelled on stale websocket cancellation", async () => {
    (orderRepo.findByClientOrderId as any).mockReturnValue({
      ...order,
      status: "filled",
    });
    (orderRepo.findByExchangeOrderId as any).mockReturnValue({
      ...order,
      status: "filled",
    });

    await mod.start();
    await stream.emitOrder({
      type: "order",
      event: "CANCELLATION",
      orderId: "ord-exch-1",
      clientOrderId: order.clientOrderId,
      tokenId: order.tokenId,
      side: order.side,
      sizeTotal: 10,
      sizeFilled: 10,
      sizeRemaining: 0,
      status: "CANCELLED",
      timestamp: 1_699_999_999_500,
    });

    expect(orderRepo.updateStatus).not.toHaveBeenCalledWith(
      order.orderId,
      "cancelled",
      "ord-exch-1",
    );
  });

  it("runs catch-up sync on websocket gap and tracks reconnect metrics", async () => {
    await mod.start();
    expect(stream.conditionIds).toEqual(["cond-1"]);
    expect(gateway.getFills).toHaveBeenCalledTimes(1);
    expect(gateway.getOpenOrders).toHaveBeenCalledTimes(1);

    await stream.emitGap("socket-close");

    expect(gateway.getFills).toHaveBeenCalledTimes(2);
    expect(gateway.getOpenOrders).toHaveBeenCalledTimes(2);
    expect(mod.getMetricsSnapshot().wsEventGapDetected).toBe(1);
    expect(mod.getMetricsSnapshot().reconnectCount).toBe(1);
  });

  it("updates subscribed conditions after order lifecycle changes", async () => {
    await mod.start();
    expect(stream.conditionIds).toEqual(["cond-1"]);

    (orderRepo.findOpen as any).mockReturnValue([]);
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as any,
      orderId: order.orderId,
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      reason: "cancelled",
      signalReason: order.signalReason,
      timestamp: Date.now(),
    });

    expect(stream.conditionIds).toEqual([]);
  });
});
