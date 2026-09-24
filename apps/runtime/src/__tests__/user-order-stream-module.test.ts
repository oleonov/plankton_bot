import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import { createOrderId, createTokenId, createConditionId } from "@krabs/domain";
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
  Order,
  TokenId,
} from "@krabs/domain";
import { bootstrapLedgerDb, SqliteFillRepository, SqliteOrderRepository } from "@krabs/db";
import { UserOrderStreamModule } from "../modules/reconciliation/user-order-stream-module.js";
import { readExchangeAbsence } from "../modules/reconciliation/exchange-absence.js";
import { inOrderLifecycleLane } from "../modules/reconciliation/order-status-resolver.js";

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
    getOrderResult: vi.fn().mockResolvedValue({
      ok: true,
      data: { orderId: "ord-exch-1", status: "CANCELLED", sizeFilled: 0 },
    }),
    getBalances: vi.fn<() => Promise<ExchangeBalance[]>>().mockResolvedValue([]),
    getPositionBalance: vi.fn<(tokenId: TokenId) => Promise<number>>().mockResolvedValue(0),
    getOutcomeTokenBalance: vi.fn<(tokenId: TokenId) => Promise<bigint>>().mockResolvedValue(0n),
    redeemPositions: vi.fn().mockResolvedValue({
      status: "skipped" as const,
      conditionIds: [],
      txHash: null,
      gasUsed: null,
    }),
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
    claimForReconciliation: vi.fn().mockReturnValue(true),
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
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findTrackedForPricingTiered: vi.fn().mockReturnValue({
      executionCritical: [],
      entryCandidates: [],
      discoveryOnly: [],
    }),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
    updateTickSize: vi.fn(),
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

  it.each([false, true])(
    "retains the last locally closed condition across restart (prestart=%s)",
    async (prestart) => {
      const durable: Order = {
        ...order,
        cancelReason: "resolved_loser_settled_local",
        status: "cancelled",
      };
      orderRepo.findLocallyClosedResolvedLosers = vi.fn(() => (prestart ? [durable] : []));
      if (prestart) vi.mocked(orderRepo.findOpen).mockReturnValue([]);
      await mod.start();
      vi.mocked(orderRepo.findOpen).mockReturnValue([]);
      vi.mocked(orderRepo.findById).mockReturnValue(durable);
      vi.mocked(marketRepo.findByTokenId).mockReturnValue(null);
      await bus.publish("OrderCancelled", {
        commandId: "local-close" as any,
        orderId: order.orderId,
        tokenId: order.tokenId,
        conditionId: order.conditionId,
        reason: durable.cancelReason!,
        signalReason: null,
        timestamp: Date.now(),
      });
      expect(stream.conditionIds).toEqual([order.conditionId]);
      expect(orderRepo.findLocallyClosedResolvedLosers).toHaveBeenCalledTimes(1);
      durable.status = "filled";
      await mod.stop();
      vi.mocked(orderRepo.findLocallyClosedResolvedLosers).mockReturnValue([durable]);
      await mod.start();
      expect(stream.conditionIds).toEqual([order.conditionId]);
      expect(orderRepo.findLocallyClosedResolvedLosers).toHaveBeenCalledTimes(2);
    },
  );

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

  // ─── Fill-completion tolerance propagation (#36) ───────────────────────

  it("forwards fillCompletionTolerance=0 through the ws import path → partially-filled", async () => {
    mod = new UserOrderStreamModule({
      gateway,
      fillRepo,
      marketRepo,
      orderRepo,
      bus,
      log: silentLog,
      now: () => 1_700_000_000_000,
      fillCompletionTolerance: 0,
    });
    (orderRepo.findById as any).mockReturnValue({ ...order, size: 10 });
    (fillRepo.findByOrderId as any).mockReturnValue([
      { side: "buy", price: 0.5, size: 9.97, liquidityRole: "unknown" },
    ]);

    await mod.start();
    await stream.emitTrade({
      type: "trade",
      tradeId: "trade-near-complete",
      status: "MATCHED",
      timestamp: 1_699_999_999_500,
      fills: [
        {
          fillId: "fill-near-complete",
          orderId: "ord-exch-1",
          clientOrderId: order.clientOrderId,
          tokenId: order.tokenId,
          side: "buy",
          price: 0.5,
          size: 9.97,
          liquidityRole: "unknown",
          fee: 0,
          feeRateBps: 0,
          timestamp: 1_699_999_999_500,
        },
      ],
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(order.orderId, "partially-filled");
  });

  it("forwards fillCompletionTolerance=0 through the catch-up reconcileFills path → partially-filled", async () => {
    mod = new UserOrderStreamModule({
      gateway,
      fillRepo,
      marketRepo,
      orderRepo,
      bus,
      log: silentLog,
      now: () => 1_700_000_000_000,
      fillCompletionTolerance: 0,
    });
    (gateway.getFills as any).mockResolvedValue([
      {
        fillId: "fill-catchup",
        orderId: "ord-exch-1",
        clientOrderId: order.clientOrderId,
        tokenId: order.tokenId,
        side: "buy",
        price: 0.5,
        size: 9.97,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        timestamp: 1_699_999_999_000,
      },
    ]);
    (orderRepo.findById as any).mockReturnValue({ ...order, size: 10 });
    (fillRepo.findByOrderId as any).mockReturnValue([
      { side: "buy", price: 0.5, size: 9.97, liquidityRole: "unknown" },
    ]);

    // start() runs runCatchupSync("startup") → reconcileFills(...) → importExchangeFills
    await mod.start();

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(order.orderId, "partially-filled");
  });

  it("forwards fillCompletionTolerance=0 through exact websocket order resolution", async () => {
    mod = new UserOrderStreamModule({
      gateway,
      fillRepo,
      marketRepo,
      orderRepo,
      bus,
      log: silentLog,
      now: () => 1_700_000_000_000,
      fillCompletionTolerance: 0,
    });
    await mod.start();
    (fillRepo.findByOrderId as any).mockReturnValue([
      { side: "buy", price: 0.5, size: 9.97, liquidityRole: "unknown" },
    ]);
    (gateway.getOrderResult as any).mockResolvedValue({
      ok: true,
      data: { orderId: "ord-exch-1", status: "CANCELLED", sizeFilled: 9.97 },
    });

    await stream.emitOrder({
      type: "order",
      event: "CANCELLATION",
      orderId: "ord-exch-1",
      clientOrderId: order.clientOrderId,
      tokenId: order.tokenId,
      side: "buy",
      sizeTotal: 10,
      sizeFilled: 9.97,
      sizeRemaining: 0.03,
      status: "CANCELLED",
      timestamp: 1_700_000_000_000,
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "cancelled",
      undefined,
      "exchange-exact-cancelled",
      {
        cancelAgeMs: null,
        cancelAgeBucket: null,
        fillProgressShares: 9.97,
        marketHorizon: null,
      },
    );
  });

  it("exact-resolves a rejected websocket order instead of reopening it", async () => {
    await mod.start();
    (gateway.getOrderResult as any).mockResolvedValue({
      ok: true,
      data: { orderId: "ord-exch-1", status: "REJECTED", sizeFilled: 0 },
    });

    await stream.emitOrder({
      type: "order",
      event: "UPDATE",
      orderId: "ord-exch-1",
      clientOrderId: order.clientOrderId,
      tokenId: order.tokenId,
      side: "buy",
      sizeTotal: 10,
      sizeFilled: 0,
      sizeRemaining: 10,
      status: "REJECTED",
      timestamp: 1_700_000_000_000,
    });

    expect(gateway.getOrderResult).toHaveBeenCalledWith("ord-exch-1");
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "rejected",
      undefined,
      "exchange-exact-invalid",
    );
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

  it("releases exact pending websocket events only after OrderPlaced", async () => {
    const events: string[] = [];
    const pendingOrder: Order = { ...order, status: "pending" };
    let localOrder: Order = pendingOrder;
    (orderRepo.findByClientOrderId as any).mockImplementation(() => localOrder);
    (orderRepo.findByExchangeOrderId as any).mockImplementation(() => localOrder);
    (orderRepo.updateStatus as any).mockImplementation((_id: unknown, status: Order["status"]) => {
      localOrder = { ...localOrder, status };
    });
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 10 }]);
    bus.subscribe("OrderPlaced", async () => {
      events.push("placed");
    });
    bus.subscribe("OrderCancelled", async () => {
      events.push("cancelled");
    });
    bus.subscribe("FillReceived", async () => {
      events.push("fill");
    });

    await mod.start();
    await stream.emitOrder({
      type: "order",
      event: "CANCELLATION",
      orderId: order.exchangeOrderId,
      clientOrderId: order.clientOrderId,
      tokenId: order.tokenId,
      side: order.side,
      sizeTotal: 10,
      sizeFilled: 0,
      sizeRemaining: 10,
      status: "CANCELLED",
      timestamp: Date.now(),
    });
    await stream.emitTrade({
      type: "trade",
      tradeId: "trade-pre-ack",
      status: "MATCHED",
      timestamp: Date.now(),
      fills: [
        {
          fillId: "fill-pre-ack",
          orderId: order.exchangeOrderId,
          clientOrderId: order.clientOrderId,
          tokenId: order.tokenId,
          side: order.side,
          price: order.price,
          size: order.size,
          liquidityRole: "unknown",
          fee: 0,
          feeRateBps: 0,
          timestamp: Date.now(),
        },
      ],
    });

    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    expect(fillRepo.save).not.toHaveBeenCalled();

    localOrder = { ...localOrder, status: "open" };
    await bus.publish("OrderPlaced", {
      commandId: "cmd-pre-ack" as any,
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

    expect(events).toEqual(["placed", "fill"]);
    expect(events).not.toContain("cancelled");
    expect(fillRepo.save).toHaveBeenCalledTimes(1);
  });

  it("notifies later synchronous OrderPlaced subscribers before flushing buffered events", async () => {
    const events: string[] = [];
    let localOrder: Order = { ...order, status: "pending" };
    (orderRepo.findByClientOrderId as any).mockImplementation(() => localOrder);
    (orderRepo.findByExchangeOrderId as any).mockImplementation(() => localOrder);
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 10 }]);

    await mod.start();
    bus.subscribe("OrderPlaced", async () => {
      events.push("placed-later");
    });
    bus.subscribe("OrderCancelled", async () => {
      events.push("cancelled");
    });

    await stream.emitOrder({
      type: "order",
      event: "CANCELLATION",
      orderId: order.exchangeOrderId,
      clientOrderId: order.clientOrderId,
      tokenId: order.tokenId,
      side: order.side,
      sizeTotal: 10,
      sizeFilled: 0,
      sizeRemaining: 10,
      status: "CANCELLED",
      timestamp: Date.now(),
    });
    localOrder = { ...localOrder, status: "open" };

    await bus.publish("OrderPlaced", {
      commandId: "cmd-pre-ack-order" as any,
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

    expect(events).toEqual(["placed-later"]);
    expect(events).not.toContain("cancelled");
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
      undefined,
      "exchange-exact-cancelled",
      {
        cancelAgeMs: null,
        cancelAgeBucket: null,
        fillProgressShares: 0,
        marketHorizon: null,
      },
    );
    expect(cancelled).toHaveLength(1);
    expect(mod.getMetricsSnapshot().dedupeHits).toBe(1);
  });

  it("CANCEL_ANCHOR propagates a valid websocket timestamp with the registered execution reason", async () => {
    const { registerCancelIntent } =
      await import("../modules/reconciliation/order-status-resolver.js");
    registerCancelIntent(String(order.orderId), "reprice-threshold");
    const cancelled: Array<{ reason: string }> = [];
    bus.subscribe("OrderCancelled", async (payload) => {
      cancelled.push(payload);
    });
    await mod.start();
    order.createdAt = new Date(1_699_999_994_500).toISOString();

    await stream.emitOrder({
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
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "cancelled",
      undefined,
      "reprice-threshold",
      {
        cancelAgeMs: 5_000,
        cancelAgeBucket: "<1min",
        fillProgressShares: 0,
        marketHorizon: null,
      },
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.reason).toBe("reprice-threshold");
    expect(cancelled[0]).toMatchObject({ timestamp: 1_699_999_999_500 });
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

describe("UserOrderStreamModule — exchange-absence marker", () => {
  const DAY = 24 * 60 * 60_000;
  const ZOMBIE = createOrderId("zombie");
  const markedAt = Date.now() - 2 * DAY;
  let conn: ReturnType<typeof bootstrapLedgerDb>;
  let orders: SqliteOrderRepository;
  let stream: FakeUserEventStream;
  let gateway: ExchangeGateway;
  let mod: UserOrderStreamModule;
  const zombie = () => orders.findById(ZOMBIE)!;
  const marker = () => readExchangeAbsence(zombie())?.firstNullAtMs ?? null;

  beforeEach(async () => {
    conn = bootstrapLedgerDb(":memory:");
    orders = new SqliteOrderRepository(conn.db);
    const { order } = createMockOrderRepo();
    orders.save({
      ...order,
      orderId: ZOMBIE,
      clientOrderId: "zombie-client" as any,
      side: "sell",
      status: "partially-filled",
      exchangeOrderId: "zx",
      createdAt: new Date(Date.now() - 30 * DAY).toISOString(),
      metadata: { exchangeAbsenceV1: { firstNullAt: new Date(markedAt).toISOString() } },
    });
    stream = new FakeUserEventStream();
    gateway = createMockGateway(stream);
    gateway.getOrderResult = vi.fn().mockResolvedValue({ ok: true, data: null });
    mod = new UserOrderStreamModule({
      gateway,
      fillRepo: new SqliteFillRepository(conn.db),
      marketRepo: createMockMarketRepo(order.tokenId),
      orderRepo: orders,
      bus: new InProcessEventBus(),
      log: silentLog,
    });
    await mod.start();
  });

  afterEach(async () => {
    await mod.stop();
    conn.close();
  });

  it("catch-up reconcile keeps a due order open and its marker intact", async () => {
    expect(gateway.getOrderResult).toHaveBeenCalledWith("zx");
    await stream.emitGap();
    expect(zombie().status).toBe("partially-filled");
    expect(marker()).toBe(markedAt);
  });

  it("never resurrects a status a lane holder terminalized while the event was in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const held = inOrderLifecycleLane(String(ZOMBIE), () => gate);
    const handled = stream.emitOrder({
      type: "order",
      event: "UPDATE",
      orderId: "zx",
      clientOrderId: "zombie-client",
      tokenId: zombie().tokenId,
      side: "sell",
      sizeTotal: 10,
      sizeFilled: 2,
      sizeRemaining: 8,
      status: "PARTIALLY_FILLED",
      timestamp: Date.now(),
    });
    orders.updateStatus(ZOMBIE, "cancelled");
    release();
    await Promise.all([held, handled]);
    expect(zombie().status).toBe("cancelled");
    expect(marker()).toBeNull();
  });

  it.each([
    ["PLACEMENT", "OPEN", { ok: true, data: null }],
    ["UPDATE", "PARTIALLY_FILLED", { ok: true, data: null }],
    ["CANCELLATION", "CANCELLED", { ok: false, reason: "server" }],
    ["CANCELLATION", "CANCELLED", { ok: true, data: null }],
  ] as const)(
    "clears the marker on a websocket %s event (exact lookup %j)",
    async (event, status, exact) => {
      vi.mocked(gateway.getOrderResult!).mockResolvedValue(exact as never);
      await stream.emitOrder({
        type: "order",
        event,
        orderId: "zx",
        clientOrderId: "zombie-client",
        tokenId: zombie().tokenId,
        side: "sell",
        sizeTotal: 10,
        sizeFilled: 2,
        sizeRemaining: 8,
        status,
        timestamp: Date.now(),
      });
      expect(marker()).toBeNull();
      expect(zombie().status).toBe("partially-filled");
    },
  );
});
