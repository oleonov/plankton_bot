import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createOrderId,
  createCommandId,
  createBotRunId,
  createPositionId,
  createConditionId,
  createLotId,
  createFillId,
  DEFAULT_EXECUTION_POLICY,
  ExchangeErrorCode,
  GATE_ENTRY_RULE_ID,
  S1_LADDER_RULE_ID,
} from "@krabs/domain";
import { LiveLiteGuard } from "../live-lite-guard.js";
import type {
  ExchangeGateway,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  OrderRepository,
  FillRepository,
  PlaceOrderCommand,
  CancelOrderCommand,
  TokenId,
  ClientOrderId,
  Order,
  Fill,
  Position,
  PositionRepository,
  InventoryLotRepository,
  LegStateRepository,
  NormalizedMarket,
  RiskEventRepository,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

const PHASE_ONE_ACTIVE_MARKET_CAP = 250;
const BOT_RUN_ID = createBotRunId("test-run-1");

function makePlaceCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId("cmd-1"),
    clientOrderId: "plk_abc123" as ClientOrderId,
    source: "strategy",
    tokenId: createTokenId("tok-yes"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    size: 10,
    price: 0.5,
    orderType: "GTC",
    tickSize: 0.01,
    negRisk: false,
    sequenceInTick: 0,
    signalReason: null,
    ...overrides,
  };
}

function makeCancelCmd(overrides?: Partial<CancelOrderCommand>): CancelOrderCommand {
  return {
    type: "CancelOrderCommand",
    commandId: createCommandId("cancel-1"),
    orderId: createOrderId("sim-ord-1"),
    reason: "operator",
    ...overrides,
  };
}

function createMockGateway(): ExchangeGateway {
  return {
    placeOrder: vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue({ success: true, orderId: "sim-ord-1" }),
    cancelOrder: vi
      .fn<(params: CancelOrderParams) => Promise<CancelOrderResult>>()
      .mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ success: true }),
    getOpenOrders: vi.fn<() => Promise<ExchangeOrder[]>>().mockResolvedValue([]),
    getOpenOrdersForToken: vi
      .fn<(tokenId: TokenId) => Promise<ExchangeOrder[]>>()
      .mockResolvedValue([]),
    getFills: vi.fn<(sinceMs: number) => Promise<ExchangeFill[]>>().mockResolvedValue([]),
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
  };
}

function createMockMarketRepo() {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue({ active: true }),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    upsertAll: vi.fn(),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
    updateTickSize: vi.fn(),
  };
}

function createMockOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

function createMockFillRepo(): FillRepository {
  return {
    save: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    findByOrderId: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    findRecent: vi.fn().mockReturnValue([]),
    findUnreconciled: vi.fn().mockReturnValue([]),
    markReconciled: vi.fn(),
    getLatestTimestamp: vi.fn().mockReturnValue(null),
  };
}

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: createTokenId("tok-yes"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    size: 10,
    avgEntryPrice: 0.5,
    costBasisUsdc: 5,
    currentValueUsdc: 5,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOpenPositions(count: number): Position[] {
  return Array.from({ length: count }, (_, index) =>
    makePosition({
      positionId: createPositionId(`pos-active-${index}`),
      tokenId: createTokenId(`tok-active-${index}`),
      costBasisUsdc: 1,
    }),
  );
}

function makeNormalizedMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  const bestBid = overrides.bestBid ?? 0.1;
  const bestAsk = overrides.bestAsk ?? 0.12;
  return {
    tokenId: createTokenId("tok-yes"),
    conditionId: createConditionId("cond-1"),
    slug: "test-market",
    eventSlug: null,
    question: "Test market?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid,
    bestAsk,
    midPrice: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    minOrderSize: null,
    bookSource: "clob",
    gammaCreatedAt: null,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...overrides,
  };
}

function openSellAt(price: number, overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("existing-sell"),
    clientOrderId: "plk_existing_sell" as ClientOrderId,
    tokenId: createTokenId("tok-yes"),
    conditionId: createConditionId("cond-1"),
    side: "sell",
    orderType: "GTC",
    price,
    size: 5,
    sizeUsdc: price * 5,
    status: "open",
    exchangeOrderId: "existing-sell",
    signalId: null,
    signalReason: "repricing-exit",
    botRunId: BOT_RUN_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockPositionRepo(position: Position | null = null): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(position),
    findOpen: vi.fn().mockReturnValue(position?.status === "open" ? [position] : []),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue(position ? [position] : []),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
  };
}

// Exit-loss-floor gate (docs/plans/2026-07-20-exit-loss-floor.md) fails closed
// on a missing/inconsistent inventoryLotRepo. A single lot spanning the whole
// position — remainingSize=position.size, entryPrice=costBasisUsdc/size — is
// the simplest fixture that satisfies both FIFO-sufficiency and the
// cost-consistency check, so normal SELLs above the floor keep passing.
function createMockInventoryLotRepo(position: Position | null = null): InventoryLotRepository {
  const lots =
    position == null
      ? []
      : [
          {
            lotId: createLotId(`lot-${position.positionId}`),
            positionId: position.positionId,
            tokenId: position.tokenId,
            side: position.side,
            size: position.size,
            remainingSize: position.size,
            entryPrice: position.costBasisUsdc / position.size,
            costUsdc: position.costBasisUsdc,
            fillId: createFillId(`fill-${position.positionId}`),
            createdAt: position.openedAt,
          },
        ];
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(lots),
    findOpen: vi.fn().mockReturnValue(lots),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

function createMockLegStateRepo(): LegStateRepository {
  let count = 0;
  let abandoned = false;
  return {
    get: vi.fn().mockReturnValue(null),
    upsert: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn().mockReturnValue([]),
    incrementSellResidualReject: vi.fn((_tokenId, _nowIso, abandon) => {
      count += 1;
      const markedAbandoned = abandon != null && count >= abandon.threshold && !abandoned;
      if (markedAbandoned) abandoned = true;
      return { count, markedAbandoned };
    }),
    markAbandoned: vi.fn(),
    resetAbandoned: vi.fn(),
    applyRepriceChainEvent: vi.fn(),
  };
}

function getRejectOrderCaller(mod: ExecutionModule): {
  rejectOrder(cmd: PlaceOrderCommand, reason: string, errorCode: ExchangeErrorCode): Promise<void>;
} {
  return mod as unknown as {
    rejectOrder(
      cmd: PlaceOrderCommand,
      reason: string,
      errorCode: ExchangeErrorCode,
    ): Promise<void>;
  };
}

function getExecutePlaceCaller(mod: ExecutionModule): {
  executePlace(cmd: PlaceOrderCommand): Promise<void>;
} {
  return mod as unknown as {
    executePlace(cmd: PlaceOrderCommand): Promise<void>;
  };
}

function looksLikeMinSizeError(message: string | null | undefined, details: unknown): boolean {
  return (
    ExecutionModule as unknown as {
      looksLikeMinSizeError(message: string | null | undefined, details: unknown): boolean;
    }
  ).looksLikeMinSizeError(message, details);
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

// ─── Tests ───────────────────────────────────────────────────────────────

describe("ExecutionModule", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let bus: InProcessEventBus;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: ReturnType<typeof createMockFillRepo>;
  let mod: ExecutionModule;

  beforeEach(() => {
    gateway = createMockGateway();
    bus = new InProcessEventBus();
    marketRepo = createMockMarketRepo();
    orderRepo = createMockOrderRepo();
    fillRepo = createMockFillRepo();
    // Low cost basis vs. the ~0.1-0.14 SELL prices used across this file's
    // shared-`mod` post-only tests keeps every one of them well clear of the
    // exit-loss-floor (this is a profit scenario, not a floor-adjacent one).
    const position = makePosition({ size: 5, costBasisUsdc: 0.1 });
    mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      positionRepo: createMockPositionRepo(position),
      inventoryLotRepo: createMockInventoryLotRepo(position),
    });
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────

  it("healthCheck returns not-ok before start", async () => {
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("not started");
  });

  it("healthCheck returns ok after start (gateway healthy)", async () => {
    await mod.start();
    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    await mod.stop();
  });

  it("healthCheck returns not-ok when gateway is down", async () => {
    (gateway.healthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      latencyMs: 0,
    });
    await mod.start();
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("unreachable");
    await mod.stop();
  });

  // ─── Place order ───────────────────────────────────────────────────

  const makeOpenGateBuys = (n: number): Order[] =>
    Array.from(
      { length: n },
      (_, i) =>
        ({
          orderId: createOrderId(`gate-open-${i}`),
          tokenId: createTokenId("tok-yes"),
          side: "buy",
          status: "open",
          price: 0.05,
          size: 20,
          decisionRuleId: GATE_ENTRY_RULE_ID,
          signalReason: "probe-entry",
        }) as unknown as Order,
    );

  it("skips a GATE buy once the open-GATE cap (6) is reached — gate_open_cap", async () => {
    orderRepo.findOpen = vi.fn().mockReturnValue(makeOpenGateBuys(6));
    await mod.start();
    const skipped: any[] = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-gate-7"),
        decisionRuleId: GATE_ENTRY_RULE_ID,
        price: 0.05,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(skipped.some((s) => s.reasonCode === "gate_open_cap")).toBe(true);
    await mod.stop();
  });

  it("does NOT gate_open_cap-skip a GATE buy while under the cap (5 open)", async () => {
    orderRepo.findOpen = vi.fn().mockReturnValue(makeOpenGateBuys(5));
    await mod.start();
    const skipped: any[] = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-gate-6"),
        decisionRuleId: GATE_ENTRY_RULE_ID,
        price: 0.05,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(skipped.some((s) => s.reasonCode === "gate_open_cap")).toBe(false);
    await mod.stop();
  });

  it("places order via gateway and persists Order row", async () => {
    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(orderRepo.save).toHaveBeenCalledTimes(1);

    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Order;
    expect(savedOrder.clientOrderId).toBe("plk_abc123");
    expect(savedOrder.status).toBe("open");
    expect(savedOrder.exchangeOrderId).toBe("sim-ord-1");
    expect(savedOrder.botRunId).toBe(BOT_RUN_ID);

    await mod.stop();
  });

  it("publishes OrderPlaced event on success", async () => {
    await mod.start();

    const placed: any[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(placed).toHaveLength(1);
    expect(placed[0].orderId).toBe("sim-ord-1");
    expect(placed[0].clientOrderId).toBe("plk_abc123");
    expect(placed[0].side).toBe("buy");

    await mod.stop();
  });

  it("places post-only SELL pre-submit when submit price is above refreshed ask", async () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const position = makePosition({ size: 5, costBasisUsdc: 0.1 });
    const guarded = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      riskEventRepo,
      positionRepo: createMockPositionRepo(position),
      inventoryLotRepo: createMockInventoryLotRepo(position),
    });
    await guarded.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.05, bestAsk: 0.1 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.12, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", price: 0.12, postOnly: true }),
    );
    expect(riskEventRepo.insert).not.toHaveBeenCalled();

    await guarded.stop();
  });

  it("places post-only SELL pre-submit when submit price is inside the spread", async () => {
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.1, bestAsk: 0.12 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.11, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", price: 0.11 }),
    );

    await mod.stop();
  });

  it("places post-only SELL pre-submit when submit price equals refreshed ask", async () => {
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.1, bestAsk: 0.12 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.12, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", price: 0.12, postOnly: true }),
    );

    await mod.stop();
  });

  it("skips post-only SELL pre-submit when submit price equals refreshed bid", async () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const guarded = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      riskEventRepo,
    });
    await guarded.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.12, bestAsk: 0.14 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.12, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "order_skipped",
      payload: expect.objectContaining({
        reasonCode: "post-only-cross-pre-submit",
        side: "sell",
        price: 0.12,
        currentBestBid: 0.12,
        currentBestAsk: 0.14,
      }),
    });

    await guarded.stop();
  });

  it("skips post-only SELL pre-submit when submit price is below refreshed bid", async () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const guarded = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      riskEventRepo,
    });
    await guarded.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.12, bestAsk: 0.14 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.1, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "order_skipped",
      payload: expect.objectContaining({
        reasonCode: "post-only-cross-pre-submit",
        side: "sell",
        price: 0.1,
        currentBestBid: 0.12,
        currentBestAsk: 0.14,
      }),
    });

    await guarded.stop();
  });

  it("publishes exactly one OrderSkipped (and the risk event) on post-only cross", async () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const guarded = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      riskEventRepo,
    });
    await guarded.start();

    const skipped: any[] = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push(p);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.12, bestAsk: 0.14 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.1, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      reasonCode: "post-only-cross-pre-submit",
      side: "sell",
      price: 0.1,
      size: 5,
      tokenId: "tok-yes",
      conditionId: "cond-1",
    });
    expect(riskEventRepo.insert).toHaveBeenCalledTimes(1);

    await guarded.stop();
  });

  it("post-only cross publishes no OrderRejected and does not submit or save an order", async () => {
    const guarded = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await guarded.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.12, bestAsk: 0.14 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.1, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(0);

    await guarded.stop();
  });

  it("executePlace path also publishes OrderSkipped on post-only cross", async () => {
    const guarded = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await guarded.start();

    const skipped: any[] = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push(p);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.12, bestAsk: 0.14 })],
      timestamp: Date.now(),
    });
    await getExecutePlaceCaller(guarded).executePlace(
      makePlaceCmd({ side: "sell", price: 0.1, size: 5, postOnly: true }),
    );

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reasonCode).toBe("post-only-cross-pre-submit");

    await guarded.stop();
  });

  it("does not apply post-only pre-submit guard when refreshed bid is unavailable", async () => {
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: null, bestAsk: 0.12 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.1, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", price: 0.1, postOnly: true }),
    );

    await mod.stop();
  });

  it("does not apply post-only pre-submit guard when postOnly is omitted", async () => {
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.12, bestAsk: 0.14 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.12, size: 5 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", price: 0.12 }),
    );

    await mod.stop();
  });

  it("does not apply post-only pre-submit guard when postOnly is false", async () => {
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.08, bestAsk: 0.1 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.12, size: 5, postOnly: false }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", price: 0.12, postOnly: false }),
    );

    await mod.stop();
  });

  it("skips crossing post-only SELL before cancel-replacing an existing order", async () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const existingSell: Order = {
      orderId: createOrderId("existing-sell-cross"),
      clientOrderId: "plk_existing_sell_cross" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),
      side: "sell",
      orderType: "GTC",
      price: 0.2,
      size: 5,
      sizeUsdc: 1,
      status: "open",
      exchangeOrderId: "existing-sell-cross",
      signalId: null,
      signalReason: "repricing-exit",
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);

    const guarded = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      riskEventRepo,
    });
    await guarded.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ bestBid: 0.12, bestAsk: 0.14 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.12, size: 5, postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "order_skipped",
      payload: expect.objectContaining({
        reasonCode: "post-only-cross-pre-submit",
        side: "sell",
        price: 0.12,
        currentBestBid: 0.12,
        currentBestAsk: 0.14,
      }),
    });

    await guarded.stop();
  });

  it("publishes OrderRejected when gateway rejects", async () => {
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      errorCode: "INSUFFICIENT_BALANCE",
      errorMessage: "no funds",
      errorDetails: { status: 400, responseBody: { error: "no funds" } },
    });

    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        signalId: "sig-1",
        decisionRuleId: "D5",
        signalTimestamp: "2026-04-26T00:00:00.000Z",
      }),
      timestamp: Date.now(),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].errorCode).toBe("INSUFFICIENT_BALANCE");
    expect(rejected[0].reason).toBe("no funds");
    expect(rejected[0].decisionRuleId).toBe("D5");
    expect(rejected[0].exchangeErrorDetails).toMatchObject({
      status: 400,
      responseBody: { error: "no funds" },
    });

    // Rejected order should still be persisted
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Order;
    expect(savedOrder.status).toBe("rejected");
    expect(savedOrder.decisionRuleId).toBe("D5");
    expect(savedOrder.exchangeErrorCode).toBe("INSUFFICIENT_BALANCE");
    expect(savedOrder.exchangeErrorPayload).toContain("no funds");

    await mod.stop();
  });

  it("normalizes gateway balance and allowance rejects for diagnostics", async () => {
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      errorCode: "INSUFFICIENT_BALANCE",
      errorMessage: "not enough balance / allowance: balance: 43130000",
    });

    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("exchange-insufficient-balance-or-allowance");
    expect(mod.getDiagnostics().gatewayRejectsLast10mByCode).toEqual({
      INSUFFICIENT_BALANCE: 1,
    });

    await mod.stop();
  });

  it("treats gateway success without order id as rejection", async () => {
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      orderId: "",
    });
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].errorCode).toBe("UNKNOWN");
    expect(rejected[0].reason).toContain("without order id");

    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Order;
    expect(savedOrder.status).toBe("rejected");
    expect(savedOrder.exchangeOrderId).toBeNull();
    expect(savedOrder.exchangeErrorMessage).toBe("gateway returned success without order id");
    expect(savedOrder.exchangeRejectionReason).toBe("rejection_missing_order_id");

    await mod.stop();
  });

  it("rejects BUY before gateway when price is below the market tick", async () => {
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        price: 0.0005,
        tickSize: 0.001,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: "invalid-order-price",
      errorCode: "INVALID_PRICE",
    });

    await mod.stop();
  });

  it("rejects SELL before gateway when price is above the market upper bound", async () => {
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        side: "sell",
        price: 1,
        tickSize: 0.001,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      reason: "invalid-order-price",
      errorCode: "INVALID_PRICE",
    });

    await mod.stop();
  });

  // ─── Deduplication ────────────────────────────────────────────────

  it("skips duplicate commandId (idempotency)", async () => {
    await mod.start();

    const cmd = makePlaceCmd();
    await bus.publish("PlaceOrderRequested", { command: cmd, timestamp: Date.now() });
    await bus.publish("PlaceOrderRequested", { command: cmd, timestamp: Date.now() });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("skips duplicate clientOrderId when existing order is open", async () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const duplicateMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      riskEventRepo,
    });
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "existing",
      status: "open",
    });
    const skipped: any[] = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push(p);
    });

    await duplicateMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("cmd-new") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      reasonCode: "duplicate_client_order_id_pre_submit",
      clientOrderId: "plk_abc123",
    });
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "order_skipped",
      payload: expect.objectContaining({
        reasonCode: "duplicate_client_order_id_pre_submit",
        existingOrderId: "existing",
        existingStatus: "open",
      }),
    });

    await duplicateMod.stop();
  });

  it("skips duplicate clientOrderId when existing order is pending", async () => {
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "existing",
      status: "pending",
    });

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("cmd-new") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("skips duplicate clientOrderId when prior order is filled", async () => {
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "old-filled",
      status: "filled",
    });

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("cmd-reentry") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("skips duplicate clientOrderId when prior order is cancelled", async () => {
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "old-cancelled",
      status: "cancelled",
    });

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("cmd-retry") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("skips duplicate clientOrderId when prior order is rejected", async () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const duplicateMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      riskEventRepo,
    });
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "old-rejected",
      status: "rejected",
    });

    await duplicateMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-retry2"),
        side: "sell",
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "order_skipped",
      payload: expect.objectContaining({
        reasonCode: "duplicate_client_order_id_pre_submit",
        existingOrderId: "old-rejected",
        existingStatus: "rejected",
      }),
    });

    await duplicateMod.stop();
  });

  it("fails closed for non-ProfileLadder duplicate clientOrderId before exchange submit", async () => {
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "legacy-duplicate",
      status: "filled",
    });
    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-non-profile-duplicate"),
        source: "strategy",
        signalReason: "probe-entry",
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("emits critical orphan-risk telemetry when persistence fails after exchange accept", async () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const position = makePosition({ size: 13.56, costBasisUsdc: 13.56 * 0.03 });
    const orphanRiskMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      riskEventRepo,
      positionRepo: createMockPositionRepo(position),
      inventoryLotRepo: createMockInventoryLotRepo(position),
    });
    const persistError = new Error("UNIQUE constraint failed: orders.client_order_id");
    (orderRepo.save as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw persistError;
    });

    await expect(
      getExecutePlaceCaller(orphanRiskMod).executePlace(
        makePlaceCmd({
          side: "sell",
          size: 13.56,
          price: 0.081,
          signalReason: "profile-ladder-exit",
          decisionRuleId: "PROFILE_LADDER",
        }),
      ),
    ).rejects.toThrow("UNIQUE constraint failed");

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(silentLog.fatal).toHaveBeenCalledWith(
      expect.objectContaining({
        exchangeOrderId: "sim-ord-1",
        clientOrderId: "plk_abc123",
        tokenId: "tok-yes",
        side: "sell",
        price: 0.081,
        size: 13.56,
        decisionRuleId: "PROFILE_LADDER",
        signalReason: "profile-ladder-exit",
        persistenceError: expect.stringContaining("UNIQUE constraint failed"),
      }),
      "order persistence failed after exchange accept — exchange-live orphan risk",
    );
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "order_persist_failed_after_exchange_accept",
      payload: expect.objectContaining({
        exchangeOrderId: "sim-ord-1",
        clientOrderId: "plk_abc123",
        tokenId: "tok-yes",
        side: "sell",
        price: 0.081,
        size: 13.56,
        decisionRuleId: "PROFILE_LADDER",
        signalReason: "profile-ladder-exit",
      }),
    });
  });

  // ─── Fill detection ───────────────────────────────────────────────

  it("detects immediate fills and publishes FillReceived", async () => {
    const mockFill: ExchangeFill = {
      fillId: "sim-fill-1",
      orderId: "sim-ord-1",
      clientOrderId: "plk_abc123",
      tokenId: createTokenId("tok-yes"),
      side: "buy",
      price: 0.5,
      size: 10,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,

      timestamp: Date.now(),
    };
    (gateway.getFills as ReturnType<typeof vi.fn>).mockResolvedValue([mockFill]);

    // importExchangeFills needs order lookup to resolve status.
    // findByClientOrderId must return null for dedup check (handlePlace),
    // then return the order when called by importExchangeFills after placement.
    const savedOrder: Order = {
      orderId: createOrderId("sim-ord-1"),
      clientOrderId: "plk_abc123" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),

      side: "buy",
      orderType: "GTC",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      status: "open",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
      signalReason: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(null) // semantic dedup check in handlePlace
      .mockReturnValue(savedOrder); // importExchangeFills order lookup
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);
    (fillRepo.findByOrderId as ReturnType<typeof vi.fn>).mockReturnValue([
      { fillId: "sim-fill-1", size: 10 },
    ]);

    await mod.start();

    const fills: any[] = [];
    bus.subscribe("FillReceived", async (p) => {
      fills.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(fills).toHaveLength(1);
    expect(fills[0].fillId).toBe("sim-fill-1");
    expect(fills[0].size).toBe(10);
    expect(fills[0].sizeUsdc).toBe(5); // 10 * 0.5

    // Fill persisted
    expect(fillRepo.save).toHaveBeenCalledTimes(1);
    const savedFill = (fillRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Fill;
    expect(savedFill.fillId).toBe("sim-fill-1");

    // Order status updated to filled
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("sim-ord-1"), "filled");

    await mod.stop();
  });

  it("sets partially-filled status when fill size < order size", async () => {
    const partialFill: ExchangeFill = {
      fillId: "sim-fill-1",
      orderId: "sim-ord-1",
      clientOrderId: "plk_abc123",
      tokenId: createTokenId("tok-yes"),
      side: "buy",
      price: 0.5,
      size: 4, // partial: 4 of 10
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,

      timestamp: Date.now(),
    };
    (gateway.getFills as ReturnType<typeof vi.fn>).mockResolvedValue([partialFill]);

    const savedOrder: Order = {
      orderId: createOrderId("sim-ord-1"),
      clientOrderId: "plk_abc123" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),

      side: "buy",
      orderType: "GTC",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      status: "open",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
      signalReason: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(null)
      .mockReturnValue(savedOrder);
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);
    (fillRepo.findByOrderId as ReturnType<typeof vi.fn>).mockReturnValue([
      { fillId: "sim-fill-1", size: 4 },
    ]);

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(), // size=10
      timestamp: Date.now(),
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      createOrderId("sim-ord-1"),
      "partially-filled",
    );

    await mod.stop();
  });

  it("forwards fillCompletionTolerance=0 → near-complete fill stays partially-filled (#36)", async () => {
    const nearComplete: ExchangeFill = {
      fillId: "sim-fill-1",
      orderId: "sim-ord-1",
      clientOrderId: "plk_abc123",
      tokenId: createTokenId("tok-yes"),
      side: "buy",
      price: 0.5,
      size: 9.97, // 0.3% short of the 10-share order
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      timestamp: Date.now(),
    };
    (gateway.getFills as ReturnType<typeof vi.fn>).mockResolvedValue([nearComplete]);

    const savedOrder: Order = {
      orderId: createOrderId("sim-ord-1"),
      clientOrderId: "plk_abc123" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),
      side: "buy",
      orderType: "GTC",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      status: "open",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
      signalReason: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(null)
      .mockReturnValue(savedOrder);
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);
    (fillRepo.findByOrderId as ReturnType<typeof vi.fn>).mockReturnValue([
      { fillId: "sim-fill-1", size: 9.97 },
    ]);

    const tolerant = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      fillCompletionTolerance: 0,
    });

    await tolerant.start();
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(), // size=10
      timestamp: Date.now(),
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      createOrderId("sim-ord-1"),
      "partially-filled",
    );

    await tolerant.stop();
  });

  it("sets filled status when cumulative fill size >= order size", async () => {
    const fill1: ExchangeFill = {
      fillId: "sim-fill-1",
      orderId: "sim-ord-1",
      clientOrderId: "plk_abc123",
      tokenId: createTokenId("tok-yes"),
      side: "buy",
      price: 0.5,
      size: 6,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,

      timestamp: Date.now(),
    };
    const fill2: ExchangeFill = {
      fillId: "sim-fill-2",
      orderId: "sim-ord-1",
      clientOrderId: "plk_abc123",
      tokenId: createTokenId("tok-yes"),
      side: "buy",
      price: 0.5,
      size: 4,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,

      timestamp: Date.now(),
    };
    (gateway.getFills as ReturnType<typeof vi.fn>).mockResolvedValue([fill1, fill2]);

    const savedOrder: Order = {
      orderId: createOrderId("sim-ord-1"),
      clientOrderId: "plk_abc123" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),

      side: "buy",
      orderType: "GTC",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      status: "open",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
      signalReason: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(null)
      .mockReturnValue(savedOrder);
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);
    (fillRepo.findByOrderId as ReturnType<typeof vi.fn>).mockReturnValue([
      { fillId: "sim-fill-1", size: 6 },
      { fillId: "sim-fill-2", size: 4 },
    ]);

    await mod.start();

    const fills: any[] = [];
    bus.subscribe("FillReceived", async (p) => {
      fills.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(), // size=10
      timestamp: Date.now(),
    });

    // Both fills published
    expect(fills).toHaveLength(2);
    expect(fillRepo.save).toHaveBeenCalledTimes(2);

    // Final status is filled (6+4 = 10 = order size)
    expect(orderRepo.updateStatus).toHaveBeenCalledTimes(1);
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("sim-ord-1"), "filled");

    await mod.stop();
  });

  // ─── Cancel order ─────────────────────────────────────────────────

  it("cancels order via gateway and publishes OrderCancelled", async () => {
    const savedOrder: Order = {
      orderId: createOrderId("sim-ord-1"),
      clientOrderId: "plk_abc123" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),

      side: "buy",
      orderType: "GTC",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      status: "open",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
      signalReason: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);

    await mod.start();

    const cancelled: any[] = [];
    bus.subscribe("OrderCancelled", async (p) => {
      cancelled.push(p);
    });

    await bus.publish("CancelOrderRequested", {
      command: makeCancelCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      createOrderId("sim-ord-1"),
      "cancelled",
      undefined,
      "operator",
      expect.objectContaining({
        cancelAgeMs: expect.any(Number),
        cancelAgeBucket: expect.any(String),
        fillProgressShares: 0,
        marketHorizon: null,
      }),
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].reason).toBe("operator");

    await mod.stop();
  });

  it("skips duplicate cancel commandId", async () => {
    await mod.start();

    const cmd = makeCancelCmd();
    await bus.publish("CancelOrderRequested", { command: cmd, timestamp: Date.now() });
    await bus.publish("CancelOrderRequested", { command: cmd, timestamp: Date.now() });

    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("does not publish OrderCancelled when gateway rejects cancel", async () => {
    (gateway.cancelOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      errorCode: "ORDER_NOT_FOUND",
      errorMessage: "not found",
    });

    await mod.start();

    const cancelled: any[] = [];
    bus.subscribe("OrderCancelled", async (p) => {
      cancelled.push(p);
    });

    await bus.publish("CancelOrderRequested", {
      command: makeCancelCmd(),
      timestamp: Date.now(),
    });

    expect(cancelled).toHaveLength(0);
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();

    await mod.stop();
  });

  // ─── Capital reservations ──────────────────────────────────────────

  it("counts queued SELL orders as pending token reservations before gateway acceptance", async () => {
    let resolvePlace: () => void;
    const slowPlace = new Promise<PlaceOrderResult>((resolve) => {
      resolvePlace = () => resolve({ success: true, orderId: "sim-ord-slow" });
    });
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPlace);

    const reservePosition = makePosition({ size: 10 });
    const reserveMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(reservePosition),
      inventoryLotRepo: createMockInventoryLotRepo(reservePosition),

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      maxConcurrency: 1,
      // Pin to pre-ADR-008 reject semantics so the reservation-rejection
      // path is exercised directly. ADR-008 clamp behavior is covered in
      // execution-sell-clamp.test.ts.
      allowSellSizeClamp: false,
    });

    await reserveMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-pending-1"),
        side: "sell",
        size: 8,
      }),
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-pending-2"),
        clientOrderId: "plk_sell_pending_2" as ClientOrderId,
        side: "sell",
        size: 3,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("reserved-token-limit");
    const diag = reserveMod.getDiagnostics();
    expect(diag).toMatchObject({
      reservedSellTokenCount: 1,
      internalReservationRejectsLast10m: 1,
      internalReservationRejectsLast10mByReason: { "reserved-token-limit": 1 },
    });
    // count and by-reason come from ONE pruned window → their totals must always agree.
    expect(
      Object.values(diag.internalReservationRejectsLast10mByReason).reduce((sum, n) => sum + n, 0),
    ).toBe(diag.internalReservationRejectsLast10m);

    resolvePlace!();
    await reserveMod.stop();
  });

  it("uses the S1 per-token SELL budget independently from the normal SELL budget", async () => {
    const s1Token = createTokenId("s1-budget-token");
    const normalToken = createTokenId("normal-budget-token");
    const now = new Date().toISOString();
    const makeOpenSell = (tokenId: TokenId, index: number, decisionRuleId: string): Order => ({
      orderId: createOrderId(`${String(tokenId)}-open-${index}`),
      clientOrderId: `plk_${String(tokenId)}_${index}` as ClientOrderId,
      tokenId,
      conditionId: createConditionId("cond-1"),
      side: "sell",
      orderType: "GTC",
      postOnly: true,
      price: 0.3 + index * 0.01,
      size: 1,
      sizeUsdc: 0.3 + index * 0.01,
      status: "open",
      exchangeOrderId: `exchange-${String(tokenId)}-${index}`,
      signalId: null,
      signalReason: "repricing-exit",
      decisionRuleId,
      botRunId: BOT_RUN_ID,
      createdAt: now,
      updatedAt: now,
    });
    const orders: Order[] = [
      makeOpenSell(s1Token, 0, S1_LADDER_RULE_ID),
      makeOpenSell(s1Token, 1, S1_LADDER_RULE_ID),
      makeOpenSell(s1Token, 2, S1_LADDER_RULE_ID),
      makeOpenSell(normalToken, 0, "D8_PROFIT_RATIO"),
    ];
    orderRepo.findOpen = vi.fn(() => orders.filter((order) => order.status === "open"));
    orderRepo.findByTokenId = vi.fn((id) => orders.filter((order) => order.tokenId === id));
    orderRepo.findByClientOrderId = vi.fn(
      (clientOrderId) =>
        orders.find(
          (order) =>
            order.clientOrderId === clientOrderId &&
            (order.status === "open" || order.status === "pending"),
        ) ?? null,
    );
    orderRepo.save = vi.fn((order: Order) => {
      orders.push(order);
    });
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (payload) => {
      rejected.push(payload);
    });
    // Constant-return position mock is shared by both s1Token and normalToken
    // commands below (findByTokenId ignores its argument). The sell-capacity
    // gate's availableSize = position.size - alreadyReservedSell must clear
    // existing reservations (3 open sells on s1Token, 1 on normalToken) plus
    // the 1-share command being evaluated, so size must be >= 4; cost basis
    // stays low relative to the 0.5 submit price for the floor gate.
    const budgetPosition = makePosition({ size: 10, costBasisUsdc: 0.5 });
    const budgetMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(budgetPosition),
      inventoryLotRepo: createMockInventoryLotRepo(budgetPosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        sellCapacity: {
          ...DEFAULT_EXECUTION_POLICY.sellCapacity,
          enabled: true,
          maxOpenSellOrders: 10,
          maxOpenSellOrdersPerToken: 2,
        },
        trackS1: {
          ...DEFAULT_EXECUTION_POLICY.trackS1,
          s1MaxOrdersPerToken: 4,
        },
      }),
    });

    await budgetMod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("s1-fourth"),
        clientOrderId: "plk_s1_fourth" as ClientOrderId,
        tokenId: s1Token,
        side: "sell",
        size: 1,
        decisionRuleId: S1_LADDER_RULE_ID,
        metadata: { sellReplacementCancelledOrderId: "already-cancelled-s1" },
      }),
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("s1-fifth"),
        clientOrderId: "plk_s1_fifth" as ClientOrderId,
        tokenId: s1Token,
        side: "sell",
        size: 1,
        decisionRuleId: S1_LADDER_RULE_ID,
        metadata: { sellReplacementCancelledOrderId: "already-cancelled-s1" },
      }),
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("normal-second"),
        clientOrderId: "plk_normal_second" as ClientOrderId,
        tokenId: normalToken,
        side: "sell",
        size: 1,
        decisionRuleId: "D8_PROFIT_RATIO",
        metadata: { sellReplacementCancelledOrderId: "already-cancelled-normal" },
      }),
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("normal-third"),
        clientOrderId: "plk_normal_third" as ClientOrderId,
        tokenId: normalToken,
        side: "sell",
        size: 1,
        decisionRuleId: "D8_PROFIT_RATIO",
        metadata: { sellReplacementCancelledOrderId: "already-cancelled-normal" },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);
    expect(rejected.map((event) => event.reason)).toEqual([
      "per_token_sell_limit",
      "per_token_sell_limit",
    ]);

    await budgetMod.stop();
  });

  it("does NOT increment dust counter for reserved-token-limit rejects (v064a)", async () => {
    const legStateRepo = createMockLegStateRepo();
    const dustMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      legStateRepo,
    });
    const rejectOrder = getRejectOrderCaller(dustMod).rejectOrder.bind(dustMod);

    for (let idx = 0; idx < 10; idx++) {
      await rejectOrder(
        makePlaceCmd({
          commandId: createCommandId(`sell-dust-reject-${idx}`),
          clientOrderId: `plk_sell_dust_reject_${idx}` as ClientOrderId,
          side: "sell",
          price: 0.17,
        }),
        "reserved-token-limit",
        ExchangeErrorCode.InsufficientBalance,
      );
    }

    // v064a narrowed dust counter to position.size < min, not counter pollution
    // from unrelated rejects like reserved-token-limit.
    expect(legStateRepo.incrementSellResidualReject).not.toHaveBeenCalled();
  });

  it("does not increment dust counter for non-dust reasons or BUY rejects", async () => {
    const legStateRepo = createMockLegStateRepo();
    const dustMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      legStateRepo,
    });
    const rejectOrder = getRejectOrderCaller(dustMod).rejectOrder.bind(dustMod);

    await rejectOrder(
      makePlaceCmd({
        commandId: createCommandId("sell-rate-limit-reject"),
        clientOrderId: "plk_sell_rate_limit_reject" as ClientOrderId,
        side: "sell",
      }),
      "rate-limit",
      ExchangeErrorCode.RateLimited,
    );
    await rejectOrder(
      makePlaceCmd({
        commandId: createCommandId("buy-reserved-token-limit-reject"),
        clientOrderId: "plk_buy_reserved_token_limit_reject" as ClientOrderId,
        side: "buy",
      }),
      "reserved-token-limit",
      ExchangeErrorCode.InsufficientBalance,
    );

    expect(legStateRepo.incrementSellResidualReject).not.toHaveBeenCalled();
  });

  it("does NOT increment dust counter for gateway min-size reject if position size >= min", async () => {
    const legStateRepo = createMockLegStateRepo();
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      errorCode: "UNKNOWN",
      errorMessage: "exchange returned no order id",
      errorDetails: {
        responseBody: {
          error: "order is invalid. Size (3.66) lower than the minimum: 5",
          status: 400,
        },
      },
    });
    const dustPosition = makePosition({ size: 17.64, costBasisUsdc: 17.64 * 0.05 });
    const dustMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(dustPosition),
      inventoryLotRepo: createMockInventoryLotRepo(dustPosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      legStateRepo,
    });

    await dustMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-gateway-min-size-reject"),
        clientOrderId: "plk_sell_gateway_min_size_reject" as ClientOrderId,
        side: "sell",
        size: 3.66,
        price: 0.17,
        metadata: { marketData: { minOrderSize: 5 } },
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(legStateRepo.incrementSellResidualReject).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("exchange returned no order id");
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Order;
    expect(savedOrder.exchangeErrorMessage).toBe("exchange returned no order id");
    expect(savedOrder.exchangeRejectionReason).toBe("rejection_min_size");

    await dustMod.stop();
  });

  it("increments dust counter before gateway submit if position size < min", async () => {
    const legStateRepo = createMockLegStateRepo();
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      errorCode: "UNKNOWN",
      errorMessage: "exchange returned no order id",
      errorDetails: {
        responseBody: {
          error: "order is invalid. Size (2) lower than the minimum: 5",
          status: 400,
        },
      },
    });
    const dustMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 2 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      legStateRepo,
    });
    const executePlace = getExecutePlaceCaller(dustMod).executePlace.bind(dustMod);

    await executePlace(
      makePlaceCmd({
        commandId: createCommandId("sell-gateway-true-dust-reject"),
        clientOrderId: "plk_sell_gateway_true_dust_reject" as ClientOrderId,
        side: "sell",
        size: 2,
        price: 0.17,
        metadata: { marketData: { minOrderSize: 5 } },
      }),
    );

    expect(legStateRepo.incrementSellResidualReject).toHaveBeenCalledTimes(1);
    expect(legStateRepo.incrementSellResidualReject).toHaveBeenCalledWith(
      createTokenId("tok-yes"),
      expect.any(String),
      { threshold: DEFAULT_EXECUTION_POLICY.dustAbandonment.maxConsecutiveRejects, price: 0.17 },
    );
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();
  });

  it("does not increment dust counter for non-min gateway rejects or BUY min-size rejects", async () => {
    const cases: Array<{
      name: string;
      command: PlaceOrderCommand;
      result: PlaceOrderResult;
    }> = [
      {
        name: "insufficient-balance",
        command: makePlaceCmd({
          commandId: createCommandId("sell-gateway-insufficient-balance"),
          clientOrderId: "plk_sell_gateway_insufficient_balance" as ClientOrderId,
          side: "sell",
        }),
        result: {
          success: false,
          errorCode: ExchangeErrorCode.InsufficientBalance,
          errorMessage: "insufficient balance",
        },
      },
      {
        name: "rate-limit",
        command: makePlaceCmd({
          commandId: createCommandId("sell-gateway-rate-limit"),
          clientOrderId: "plk_sell_gateway_rate_limit" as ClientOrderId,
          side: "sell",
        }),
        result: {
          success: false,
          errorCode: ExchangeErrorCode.RateLimited,
          errorMessage: "rate limit exceeded",
        },
      },
      {
        name: "buy-min-size",
        command: makePlaceCmd({
          commandId: createCommandId("buy-gateway-min-size"),
          clientOrderId: "plk_buy_gateway_min_size" as ClientOrderId,
          side: "buy",
          size: 3.66,
        }),
        result: {
          success: false,
          errorCode: "UNKNOWN",
          errorMessage: "exchange returned no order id",
          errorDetails: {
            responseBody: { error: "Size (3.66) lower than the minimum: 5" },
          },
        },
      },
    ];

    for (const testCase of cases) {
      const caseBus = new InProcessEventBus();
      const caseGateway = createMockGateway();
      const caseOrderRepo = createMockOrderRepo();
      const legStateRepo = createMockLegStateRepo();
      (caseGateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue(testCase.result);
      const dustMod = new ExecutionModule({
        gateway: caseGateway,
        bus: caseBus,
        marketRepo: marketRepo as any,
        orderRepo: caseOrderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        executionPolicy: () => DEFAULT_EXECUTION_POLICY,
        legStateRepo,
      });

      await dustMod.start();
      await caseBus.publish("PlaceOrderRequested", {
        command: testCase.command,
        timestamp: Date.now(),
      });
      await caseBus.drain();

      expect(legStateRepo.incrementSellResidualReject, testCase.name).not.toHaveBeenCalled();

      await dustMod.stop();
    }
  });

  it("detects gateway min-size wording case-insensitively", () => {
    expect(looksLikeMinSizeError("LOWER THAN THE MINIMUM", null)).toBe(true);
    expect(looksLikeMinSizeError("invalid size", null)).toBe(true);
    expect(looksLikeMinSizeError("MIN ORDER SIZE", null)).toBe(true);
    expect(looksLikeMinSizeError("size must be greater than minimum", null)).toBe(true);
    expect(looksLikeMinSizeError(null, { error: "Size (3.66) lower than the minimum: 5" })).toBe(
      true,
    );
    expect(looksLikeMinSizeError("rate limit exceeded", { code: 429 })).toBe(false);
  });

  it.each([
    { label: "exact match", existingPrice: 0.3, requestedPrice: 0.3 },
    { label: "one tick", existingPrice: 0.3, requestedPrice: 0.31 },
    { label: "two ticks", existingPrice: 0.3, requestedPrice: 0.32 },
  ])(
    "keeps an existing SELL when replacement price is acceptable: $label",
    async ({ existingPrice, requestedPrice }) => {
      orderRepo.findByTokenId = vi.fn().mockReturnValue([openSellAt(existingPrice)]);
      const replaceMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      });
      await replaceMod.start();
      const rejected: any[] = [];
      bus.subscribe("OrderRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId(`sell-acceptable-${requestedPrice}`),
          clientOrderId: `plk_sell_acceptable_${requestedPrice}` as ClientOrderId,
          side: "sell",
          price: requestedPrice,
          size: 5,
        }),
        timestamp: Date.now(),
      });

      expect(gateway.cancelOrder).not.toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe("sell-order-acceptable-price-already-open");
      await replaceMod.stop();
    },
  );

  it("cancel-replaces a SELL when replacement price moves beyond the threshold", async () => {
    const existingSell = openSellAt(0.3);
    orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
    orderRepo.findById = vi.fn().mockReturnValue(existingSell);
    const replacePosition = makePosition({ size: 10 });
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(replacePosition),
      inventoryLotRepo: createMockInventoryLotRepo(replacePosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
    });
    await replaceMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-replace-three-ticks"),
        clientOrderId: "plk_sell_replace_three_ticks" as ClientOrderId,
        side: "sell",
        price: 0.4,
        size: 5,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell" });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    await replaceMod.stop();
  });

  it("uses configured SELL replacement threshold", async () => {
    orderRepo.findByTokenId = vi.fn().mockReturnValue([openSellAt(0.3)]);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        exitRepriceThresholdPct: 0.05,
        exitRepriceThresholdTicks: 1,
      }),
    });
    await replaceMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-replace-configured-tolerance"),
        clientOrderId: "plk_sell_replace_configured_tolerance" as ClientOrderId,
        side: "sell",
        price: 0.32,
        size: 5,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell" });
    await replaceMod.stop();
  });

  it("keeps an existing SELL when replacement threshold cannot be resolved", async () => {
    orderRepo.findByTokenId = vi.fn().mockReturnValue([openSellAt(0.3)]);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
    });
    await replaceMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-replace-invalid-threshold"),
        clientOrderId: "plk_sell_replace_invalid_threshold" as ClientOrderId,
        side: "sell",
        price: 0.4,
        size: 5,
        tickSize: 0,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("sell-replace-invalid-threshold");
    await replaceMod.stop();
  });

  it("does not apply SELL replacement tolerance to BUY commands", async () => {
    orderRepo.findByTokenId = vi.fn().mockReturnValue([openSellAt(0.3)]);
    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("buy-not-sell-replacement"),
        clientOrderId: "plk_buy_not_sell_replacement" as ClientOrderId,
        side: "buy",
        price: 0.31,
        size: 5,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    await mod.stop();
  });

  it("cancels an existing SELL before submitting the replacement order", async () => {
    let cancelled = false;
    const existingSell: Order = {
      orderId: createOrderId("existing-sell"),
      clientOrderId: "plk_existing_sell" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),

      side: "sell",
      orderType: "GTC",
      price: 0.55,
      size: 5,
      sizeUsdc: 2.75,
      status: "open",
      exchangeOrderId: "existing-sell",
      signalId: null,
      signalReason: "repricing-exit",
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orderRepo.findByTokenId = vi.fn().mockImplementation(() => (cancelled ? [] : [existingSell]));
    orderRepo.findById = vi.fn().mockReturnValue(existingSell);
    orderRepo.updateStatus = vi.fn().mockImplementation(() => {
      cancelled = true;
    });

    const replacePosition = makePosition({ size: 10 });
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(replacePosition),
      inventoryLotRepo: createMockInventoryLotRepo(replacePosition),

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    await replaceMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-replace-request"),
        clientOrderId: "plk_sell_replace" as ClientOrderId,
        side: "sell",
        price: 0.44,
        size: 5,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell" });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect((gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      clientOrderId: "plk_sell_replace",
      side: "sell",
      price: 0.44,
    });
    expect(rejected.some((event) => event.reason === "sell-replace-pending")).toBe(true);
    expect(replaceMod.getDiagnostics().cancelReplacePendingCount).toBe(0);

    await replaceMod.stop();
  });

  it("routes ProfileLadder replacement metadata through the existing sell-replace flow", async () => {
    const existingSell = openSellAt(0.111, {
      signalReason: "profile-ladder-exit",
      decisionRuleId: "PROFILE_LADDER",
      metadata: { source: "profile_ladder" },
    });
    orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
    orderRepo.findById = vi.fn().mockReturnValue(existingSell);
    // Submit price (0.077) is well below the default costBasisUsdc=5 ratio,
    // so this site needs an explicit low cost basis to stay a profit exit.
    const replacePosition = makePosition({ size: 10, costBasisUsdc: 0.3 });
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(replacePosition),
      inventoryLotRepo: createMockInventoryLotRepo(replacePosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
    });
    await replaceMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-replace-request"),
        clientOrderId: "plk_profile_ladder_replace" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadderReplacement: { oldOrderId: String(existingSell.orderId) },
        },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: String(existingSell.orderId) });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected.some((event) => event.reason === "sell-replace-pending")).toBe(true);
    await replaceMod.stop();
  });

  it("fails closed when ProfileLadder replacement oldOrderId is absent and no live SELL exists", async () => {
    orderRepo.findByTokenId = vi.fn().mockReturnValue([]);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await replaceMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-target-absent"),
        clientOrderId: "plk_profile_ladder_target_absent" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadderReplacement: { oldOrderId: "missing-old-order" },
        },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("sell-replace-required-order-missing");
    await replaceMod.stop();
  });

  it("fails closed when ProfileLadder replacement target is absent but another live SELL exists", async () => {
    orderRepo.findByTokenId = vi.fn().mockReturnValue([
      openSellAt(0.111, {
        orderId: createOrderId("other-live-sell"),
        exchangeOrderId: "other-live-sell",
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: { source: "profile_ladder" },
      }),
    ]);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await replaceMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-target-mismatch"),
        clientOrderId: "plk_profile_ladder_target_mismatch" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadderReplacement: { oldOrderId: "missing-old-order" },
        },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected[0].reason).toBe("sell-replace-required-order-missing");
    await replaceMod.stop();
  });

  it("fails closed with an incompatible reason when oldOrderId targets a non-ProfileLadder SELL", async () => {
    orderRepo.findByTokenId = vi.fn().mockReturnValue([
      openSellAt(0.111, {
        orderId: createOrderId("legacy-live-sell-target"),
        exchangeOrderId: "legacy-live-sell-target",
        signalReason: "track-s1-ladder",
        decisionRuleId: "LEGACY_SELL",
        metadata: { source: "s1" },
      }),
    ]);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await replaceMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-target-incompatible"),
        clientOrderId: "plk_profile_ladder_target_incompatible" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadderReplacement: { oldOrderId: "legacy-live-sell-target" },
        },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected[0].reason).toBe("sell-replace-required-order-incompatible");
    await replaceMod.stop();
  });

  it("fails closed on duplicate live SELL ambiguity for ProfileLadder replacement", async () => {
    orderRepo.findByTokenId = vi.fn().mockReturnValue([
      openSellAt(0.111, {
        orderId: createOrderId("profile-live-one"),
        exchangeOrderId: "profile-live-one",
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: { source: "profile_ladder" },
      }),
      openSellAt(0.12, {
        orderId: createOrderId("profile-live-two"),
        exchangeOrderId: "profile-live-two",
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: { source: "profile_ladder" },
      }),
    ]);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await replaceMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-duplicate-live-sell"),
        clientOrderId: "plk_profile_ladder_duplicate_live_sell" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadderReplacement: { oldOrderId: "profile-live-one" },
        },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected[0].reason).toBe("sell-replace-duplicate-live-sell");
    await replaceMod.stop();
  });

  it("respects the existing sell-replace lock for ProfileLadder replacement commands", async () => {
    const existingSell = openSellAt(0.111, {
      signalReason: "profile-ladder-exit",
      decisionRuleId: "PROFILE_LADDER",
      metadata: { source: "profile_ladder" },
    });
    (gateway.cancelOrder as ReturnType<typeof vi.fn>).mockResolvedValue({ success: false });
    orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
    });
    await replaceMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });
    const replacementMetadata = {
      source: "profile_ladder",
      profileLadderReplacement: { oldOrderId: String(existingSell.orderId) },
    };

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-lock-first"),
        clientOrderId: "plk_profile_ladder_lock_first" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: replacementMetadata,
      }),
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-lock-second"),
        clientOrderId: "plk_profile_ladder_lock_second" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: replacementMetadata,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);
    expect(rejected.some((event) => event.reason === "sell-replace-lock-active")).toBe(true);
    await replaceMod.stop();
  });

  it("respects reprice-chain cap for ProfileLadder replacement commands", async () => {
    const existingSell = openSellAt(0.111, {
      signalReason: "profile-ladder-exit",
      decisionRuleId: "PROFILE_LADDER",
      metadata: { source: "profile_ladder" },
    });
    const nowIso = new Date().toISOString();
    const legStateRepo = createMockLegStateRepo();
    legStateRepo.get = vi.fn().mockReturnValue({
      tokenId: createTokenId("tok-yes"),
      buyCount: 1,
      sellCount: 1,
      lastAction: "SELL",
      firstTradePrice: 0.3,
      firstTradeAt: nowIso,
      lastTradeAt: nowIso,
      updatedAt: nowIso,
      repriceChainEvents24hJson: JSON.stringify([nowIso]),
      repriceChainCount24h: 1,
    });
    orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      legStateRepo,
      repriceChainPolicy: () => ({
        enabled: true,
        windowMs: 24 * 60 * 60 * 1000,
        maxChainCount: 1,
        dynamicChainCap: {
          enabled: false,
          tradeCountThinThreshold: 10,
          tradeCountLiquidThreshold: 49,
          capThin: 50,
          capMedium: 30,
          capLiquid: 13,
          capUnknown: 30,
        },
      }),
    });
    await replaceMod.start();
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-chain-cap"),
        clientOrderId: "plk_profile_ladder_chain_cap" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadderReplacement: { oldOrderId: String(existingSell.orderId) },
        },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected[0].reason).toBe("sell-replace-chain-cap");
    await replaceMod.stop();
  });

  it("does not re-enter sell replacement for resubmit commands carrying the cancelled oldOrderId", async () => {
    orderRepo.findByTokenId = vi.fn().mockReturnValue([
      openSellAt(0.111, {
        orderId: createOrderId("still-open-other-sell"),
        exchangeOrderId: "still-open-other-sell",
      }),
    ]);
    // Submit price (0.077) is below the default costBasisUsdc=5 ratio, so an
    // explicit low cost basis is needed to stay a profit exit.
    const replacePosition = makePosition({ size: 10, costBasisUsdc: 0.3 });
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(replacePosition),
      inventoryLotRepo: createMockInventoryLotRepo(replacePosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await replaceMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("profile-ladder-resubmit"),
        clientOrderId: "plk_profile_ladder_resubmit" as ClientOrderId,
        side: "sell",
        price: 0.077,
        tickSize: 0.001,
        size: 5,
        signalReason: "profile-ladder-exit",
        decisionRuleId: "PROFILE_LADDER",
        metadata: {
          source: "profile_ladder",
          profileLadderReplacement: { oldOrderId: "cancelled-old-order" },
          sellReplacementCancelledOrderId: "cancelled-old-order",
        },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    await replaceMod.stop();
  });

  it("does not resubmit a sell replacement when cancel succeeds but local order is missing", async () => {
    const existingSell = openSellAt(0.55);
    orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
    orderRepo.findById = vi.fn().mockReturnValue(null);
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await replaceMod.start();
    const cancelled: any[] = [];
    bus.subscribe("OrderCancelled", async (p) => {
      cancelled.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-replace-local-not-found"),
        clientOrderId: "plk_sell_replace_local_not_found" as ClientOrderId,
        side: "sell",
        price: 0.44,
        size: 5,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell" });
    expect(cancelled).toHaveLength(0);
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    await replaceMod.stop();
  });

  it("does not cascade-cancel a second same-token SELL after replacement cancel completes", async () => {
    const tokenId = createTokenId("tok-yes");
    const now = new Date().toISOString();
    const makeOpenOrder = (overrides: Partial<Order>): Order => ({
      orderId: createOrderId("ord-default"),
      clientOrderId: "plk_default" as ClientOrderId,
      tokenId,
      conditionId: createConditionId("cond-1"),
      side: "sell",
      orderType: "GTC",
      price: 0.55,
      size: 5,
      sizeUsdc: 2.75,
      status: "open",
      exchangeOrderId: null,
      signalId: null,
      signalReason: "repricing-exit",
      botRunId: BOT_RUN_ID,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
    const orders: Order[] = [
      makeOpenOrder({
        orderId: createOrderId("existing-sell-1"),
        clientOrderId: "plk_existing_sell_1" as ClientOrderId,
        exchangeOrderId: "existing-sell-1",
        price: 0.55,
      }),
      makeOpenOrder({
        orderId: createOrderId("existing-sell-2"),
        clientOrderId: "plk_existing_sell_2" as ClientOrderId,
        exchangeOrderId: "existing-sell-2",
        price: 0.6,
      }),
      ...Array.from({ length: 8 }, (_, index) =>
        makeOpenOrder({
          orderId: createOrderId(`other-sell-${index}`),
          clientOrderId: `plk_other_sell_${index}` as ClientOrderId,
          tokenId: createTokenId(`other-sell-token-${index}`),
        }),
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        makeOpenOrder({
          orderId: createOrderId(`other-buy-${index}`),
          clientOrderId: `plk_other_buy_${index}` as ClientOrderId,
          tokenId: createTokenId(`other-buy-token-${index}`),
          side: "buy",
        }),
      ),
    ];
    orderRepo.findOpen = vi
      .fn()
      .mockImplementation(() => orders.filter((order) => order.status === "open"));
    orderRepo.findById = vi
      .fn()
      .mockImplementation((orderId) => orders.find((order) => order.orderId === orderId) ?? null);
    orderRepo.findByTokenId = vi
      .fn()
      .mockImplementation((id) => orders.filter((order) => order.tokenId === id));
    orderRepo.findByClientOrderId = vi
      .fn()
      .mockImplementation(
        (clientOrderId) =>
          orders.find(
            (order) =>
              order.clientOrderId === clientOrderId &&
              (order.status === "pending" || order.status === "open"),
          ) ?? null,
      );
    orderRepo.updateStatus = vi.fn().mockImplementation((orderId, status) => {
      const order = orders.find((entry) => entry.orderId === orderId);
      if (order) order.status = status;
    });
    orderRepo.save = vi.fn().mockImplementation((order: Order) => {
      orders.push(order);
    });

    const cascadePosition = makePosition({ size: 100 });
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(cascadePosition),
      inventoryLotRepo: createMockInventoryLotRepo(cascadePosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
    });

    await replaceMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-replace-two-open-request"),
        clientOrderId: "plk_sell_replace_two_open" as ClientOrderId,
        side: "sell",
        price: 0.44,
        size: 5,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);
    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell-1" });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect((gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      clientOrderId: "plk_sell_replace_two_open",
      side: "sell",
      price: 0.44,
    });
    expect(orders.find((order) => order.orderId === createOrderId("existing-sell-2"))?.status).toBe(
      "open",
    );

    await replaceMod.stop();
  });

  // docs/plans/2026-07-20-exit-loss-floor.md §Phase 6 — best-effort pre-cancel
  // screen, PositionUpdated re-evaluation, and executeCancel idempotency.
  describe("exit loss floor — Phase 6 (pre-cancel screen, PositionUpdated re-eval, cancel idempotency)", () => {
    it("pre-cancel screen leaves the resting order in place when the replacement is below floor", async () => {
      const existingSell: Order = {
        orderId: createOrderId("existing-sell"),
        clientOrderId: "plk_existing_sell" as ClientOrderId,
        tokenId: createTokenId("tok-yes"),
        conditionId: createConditionId("cond-1"),
        side: "sell",
        orderType: "GTC",
        price: 0.55,
        size: 5,
        sizeUsdc: 2.75,
        status: "open",
        exchangeOrderId: "existing-sell",
        signalId: null,
        signalReason: "repricing-exit",
        botRunId: BOT_RUN_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findOpen = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findById = vi.fn().mockReturnValue(existingSell);

      // entryPrice = costBasisUsdc / size = 5 / 5 = 1.0/share. The existing
      // sell fully reserves the position (size 5 of 5), so excluding it from
      // the reservation snapshot frees the whole position for the
      // prospective replacement — a 0.44 submit realizes ~58% loss, past the
      // default 50% floor (execution-policy.ts maxExitLossFraction).
      const floorPosition = makePosition({ size: 5, costBasisUsdc: 5 });
      const screenMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(floorPosition),
        inventoryLotRepo: createMockInventoryLotRepo(floorPosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
      });
      await screenMod.start();

      const skipped: any[] = [];
      bus.subscribe("OrderSkipped", async (p) => {
        skipped.push(p);
      });

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("sell-replace-below-floor"),
          clientOrderId: "plk_sell_replace_floor" as ClientOrderId,
          side: "sell",
          price: 0.44,
          size: 5,
        }),
        timestamp: Date.now(),
      });

      expect(gateway.cancelOrder).not.toHaveBeenCalled();
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(skipped).toHaveLength(1);
      expect(skipped[0].reasonCode).toBe("exit_loss_floor_blocked");
      expect(skipped[0].details).toMatchObject({
        phase: "pre-cancel-screen",
        existingOrderId: "existing-sell",
        exitLossFloorReason: "exit_loss_floor_blocked",
      });

      await screenMod.stop();
    });

    it("PositionUpdated cancels a now-below-floor resting SELL after a scale-in raises cost basis", async () => {
      const existingSell = openSellAt(0.4);
      orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findById = vi.fn().mockReturnValue(existingSell);

      // Scale-in raised the average entry to 1.0/share — the resting SELL at
      // 0.4 now realizes ~62% loss, past the default 50% floor.
      // handlePositionUpdated re-evaluates against the CURRENT
      // positionRepo/inventoryLotRepo state; the event payload's `position`
      // is only used to resolve which token to re-check.
      const scaledInPosition = makePosition({ size: 5, costBasisUsdc: 5 });
      const posUpdateMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(scaledInPosition),
        inventoryLotRepo: createMockInventoryLotRepo(scaledInPosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
      });
      await posUpdateMod.start();

      await bus.publish("PositionUpdated", { position: scaledInPosition });

      expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell" });
      expect(orderRepo.updateStatus).toHaveBeenCalledWith(
        existingSell.orderId,
        "cancelled",
        undefined,
        "exit_loss_floor",
        expect.anything(),
      );

      await posUpdateMod.stop();
    });

    it("cancels a below-floor resting SELL only once for concurrent duplicate PositionUpdated events", async () => {
      const existingSell = openSellAt(0.4);
      orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findById = vi.fn().mockReturnValue(existingSell);

      const scaledInPosition = makePosition({ size: 5, costBasisUsdc: 5 });
      const posUpdateMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(scaledInPosition),
        inventoryLotRepo: createMockInventoryLotRepo(scaledInPosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
      });
      await posUpdateMod.start();

      // Two concurrent subscribers re-evaluating the same PositionUpdated
      // (e.g. this handler racing the ProfileLadder rebuild, which also
      // listens on PositionUpdated) must still only cancel the resting order
      // once — the in-flight `cancelReservations` guard in executeCancel
      // dedupes them.
      await Promise.all([
        bus.publish("PositionUpdated", { position: scaledInPosition }),
        bus.publish("PositionUpdated", { position: scaledInPosition }),
      ]);

      expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);

      await posUpdateMod.stop();
    });

    it("clears the cancel reservation on gateway failure so the next PositionUpdated retries", async () => {
      const existingSell = openSellAt(0.4);
      orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findById = vi.fn().mockReturnValue(existingSell);
      (gateway.cancelOrder as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ success: false, errorCode: ExchangeErrorCode.NetworkError })
        .mockResolvedValueOnce({ success: true });

      const scaledInPosition = makePosition({ size: 5, costBasisUsdc: 5 });
      const posUpdateMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(scaledInPosition),
        inventoryLotRepo: createMockInventoryLotRepo(scaledInPosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
      });
      await posUpdateMod.start();

      await bus.publish("PositionUpdated", { position: scaledInPosition });
      expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();

      await bus.publish("PositionUpdated", { position: scaledInPosition });
      expect(gateway.cancelOrder).toHaveBeenCalledTimes(2);
      expect(orderRepo.updateStatus).toHaveBeenCalledWith(
        existingSell.orderId,
        "cancelled",
        undefined,
        "exit_loss_floor",
        expect.anything(),
      );

      await posUpdateMod.stop();
    });

    it("cancels an already-below-floor resting SELL at startup — WITHOUT any PositionUpdated (code-review finding #3)", async () => {
      // risk/inventory starts before execution and can emit PositionUpdated
      // BEFORE we subscribe. A SELL that went below floor while we were down
      // must still be re-checked once at startup, driven purely by start()'s
      // scan of orderRepo.findOpen() — never waiting for a fresh PositionUpdated.
      const existingSell = openSellAt(0.4);
      orderRepo.findOpen = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findById = vi.fn().mockReturnValue(existingSell);

      const belowFloorPosition = makePosition({ size: 5, costBasisUsdc: 5 }); // 1.0/share
      const startupMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(belowFloorPosition),
        inventoryLotRepo: createMockInventoryLotRepo(belowFloorPosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
      });

      let positionUpdatedCount = 0;
      bus.subscribe("PositionUpdated", async () => {
        positionUpdatedCount++;
      });

      await startupMod.start();

      // Cancelled purely from the startup scan — no PositionUpdated was published.
      expect(positionUpdatedCount).toBe(0);
      expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell" });
      expect(orderRepo.updateStatus).toHaveBeenCalledWith(
        existingSell.orderId,
        "cancelled",
        undefined,
        "exit_loss_floor",
        expect.anything(),
      );

      await startupMod.stop();
    });

    it("blocks a post-only exit SELL at the exact platform boundary once the additive builder fee is charged (code-review 2026-07-20)", async () => {
      // Position 10 @ 0.20/share (maxLot 0.20). A post-only SELL at exactly
      // 0.5×maxLot = 0.10 sits AT the 50% floor with the platform fee alone (a
      // maker pays 0 platform fee, so it would be ALLOWED at the boundary). The
      // additive CLOB-V2 builder maker fee (0.5% × price = 0.0005) nets it to
      // 0.0995 → 50.25% loss → BLOCKED. Proves the builder fee is included.
      const boundaryPosition = makePosition({ size: 10, costBasisUsdc: 10 * 0.2 });
      const builderMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(boundaryPosition),
        inventoryLotRepo: createMockInventoryLotRepo(boundaryPosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
      });
      await builderMod.start();

      const skipped: any[] = [];
      bus.subscribe("OrderSkipped", async (p) => {
        skipped.push(p);
      });

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("builder-fee-boundary"),
          side: "sell",
          price: 0.1,
          size: 10,
          postOnly: true,
        }),
        timestamp: Date.now(),
      });

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(skipped).toHaveLength(1);
      expect(skipped[0].reasonCode).toBe("exit_loss_floor_blocked");

      await builderMod.stop();
    });
  });

  it("clamps a sub-min SELL replacement after canceling the existing order", async () => {
    const existingSell: Order = {
      orderId: createOrderId("existing-sell"),
      clientOrderId: "plk_existing_sell" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),

      side: "sell",
      orderType: "GTC",
      price: 0.55,
      size: 6,
      sizeUsdc: 3.3,
      status: "open",
      exchangeOrderId: "existing-sell",
      signalId: null,
      signalReason: "repricing-exit",
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
    orderRepo.findById = vi.fn().mockReturnValue(existingSell);

    // Order is clamped up to the full position size (6) before submit; keep
    // cost basis low relative to the 0.44 submit price for a clear margin.
    const clampPosition = makePosition({ size: 6, costBasisUsdc: 6 * 0.05 });
    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(clampPosition),
      inventoryLotRepo: createMockInventoryLotRepo(clampPosition),

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    await replaceMod.start();

    const rejected: any[] = [];
    const cancelRequested: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelRequested.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("sell-replace-sub-min"),
        clientOrderId: "plk_sell_replace_sub_min" as ClientOrderId,
        side: "sell",
        price: 0.44,
        size: 3.1,
        metadata: {
          marketData: {
            minOrderSize: 5,
          },
        },
      }),
      timestamp: Date.now(),
    });

    expect(cancelRequested).toHaveLength(1);
    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell" });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect((gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      clientOrderId: "plk_sell_replace_sub_min",
      side: "sell",
      size: 6,
      price: 0.44,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("sell-replace-pending");
    expect(rejected[0].errorCode).toBe("LIVE_POLICY_BLOCKED");
    expect(replaceMod.getDiagnostics().cancelReplacePendingCount).toBe(0);

    await replaceMod.stop();
  });

  it("below-min-size rejection log carries full diagnostic field set (pre-clamp path)", async () => {
    const scopedLog = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: () => scopedLog,
    } as any;

    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 42 })),
      log: scopedLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await mod2.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-below-min-pre-clamp"),
        side: "buy",
        size: 2,
        tickSize: 0.01,
        metadata: { marketData: { minOrderSize: 5 } },
      }),
      timestamp: Date.now(),
    });

    const warnCalls = scopedLog.warn.mock.calls as Array<[Record<string, unknown>, string]>;
    const hit = warnCalls.find(([, msg]) => msg === "order rejected — below exchange minimum size");
    expect(hit, "expected below-min-size warn log").toBeTruthy();
    expect(hit![0]).toMatchObject({
      side: "buy",
      originalSize: 2,
      clampedSize: null,
      minOrderSize: 5,
      positionSize: 42,
      tickSize: 0.01,
      reason: "below_min_size",
      phase: "pre-clamp",
    });

    await mod2.stop();
  });

  it("rejects SELL residual below the refreshed market minimum when command metadata is missing", async () => {
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 3.28 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await mod2.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: 5, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        side: "sell",
        price: 0.5,
        size: 3.28,
        postOnly: false,
        metadata: { marketData: { minOrderSize: null } },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("sell-residual-below-min-order-size");
    expect(rejected[0].errorCode).toBe("INVALID_SIZE");

    await mod2.stop();
  });

  it("places SELL residual that meets the refreshed market minimum", async () => {
    const residualPosition = makePosition({ size: 5.5, costBasisUsdc: 5.5 * 0.05 });
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(residualPosition),
      inventoryLotRepo: createMockInventoryLotRepo(residualPosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await mod2.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: 5, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        side: "sell",
        price: 0.5,
        size: 5.5,
        postOnly: false,
        metadata: { marketData: { minOrderSize: null } },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: "sell", size: 5.5 }),
    );

    await mod2.stop();
  });

  it("blocks live-lite SELL when market minimum is unavailable", async () => {
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 0.8 })),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
    });
    await mod2.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: null, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        side: "sell",
        price: 0.5,
        size: 0.8,
        postOnly: false,
        metadata: { marketData: { minOrderSize: null } },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("sell-residual-unknown-min");

    await mod2.stop();
  });

  // ─── Live-lite allowlist (removed) ──────────────────────────────────────────
  // The per-family allowlist gate was removed from ExecutionModule.
  // Orders are no longer rejected based on family allowlist membership.

  it("places order for any family (family allowlist gate removed)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    // Family allowlist gate is removed — order reaches the gateway
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("rejects order exceeding max order cap (live-lite order cap)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 10,
      maxActiveMarkets: 10,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    // price=0.5, size=21 → notional=10.5 > 10
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.5, size: 21 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("live-lite-order-cap-exceeded");

    await guardedMod.stop();
  });

  it("rejects BUY when positions + open buys + new notional > maxOpenValueUsdc (ADR-009)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 15,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
    });
    const positionRepo = createMockPositionRepo(
      makePosition({ costBasisUsdc: 8, tokenId: createTokenId("tok-a") }),
    );
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(7);
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    // 8 (positions) + 7 (open buys) + 1 (new) = 16 > 15 → reject
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.5, size: 2, tickSize: 0.001 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("live-lite-open-value-cap-exceeded");

    await guardedMod.stop();
  });

  it("allows BUY when within open-value cap (ADR-009)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 100,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
    });
    const positionRepo = createMockPositionRepo(
      makePosition({ costBasisUsdc: 8, tokenId: createTokenId("tok-a") }),
    );
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(7);
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.5, size: 2, tickSize: 0.001 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("rejects BUY on new market when active-markets cap reached (ADR-009)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 25,
      maxActiveMarkets: PHASE_ONE_ACTIVE_MARKET_CAP,
    });
    const positionRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findOpen: vi.fn().mockReturnValue(makeOpenPositions(PHASE_ONE_ACTIVE_MARKET_CAP)),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    } as PositionRepository;
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    // BUY on tok-c (new market) with 250 already open → 251 > 250 → reject
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ tokenId: createTokenId("tok-c"), price: 0.5, size: 2 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("live-lite-active-markets-cap-exceeded");

    await guardedMod.stop();
  });

  it("allows BUY on new market with active-markets cap room at 249 of 250", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 25,
      maxActiveMarkets: PHASE_ONE_ACTIVE_MARKET_CAP,
    });
    const positionRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findOpen: vi.fn().mockReturnValue(makeOpenPositions(PHASE_ONE_ACTIVE_MARKET_CAP - 1)),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    } as PositionRepository;
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ tokenId: createTokenId("tok-c"), price: 0.5, size: 2 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveLength(0);

    await guardedMod.stop();
  });

  it("allows BUY on existing market even at active-markets cap (ADR-009 scale-in path)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 2,
    });
    const positionRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findOpen: vi
        .fn()
        .mockReturnValue([
          makePosition({ tokenId: createTokenId("tok-a"), costBasisUsdc: 1 }),
          makePosition({ tokenId: createTokenId("tok-b"), costBasisUsdc: 1 }),
        ]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    } as PositionRepository;
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    // BUY on tok-a (already open) → no new market, passes
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ tokenId: createTokenId("tok-a"), price: 0.5, size: 2 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("does not count dust positions toward live-lite active-markets cap", async () => {
    // cap=3, with 2 open + 3 dust positions. The new BUY on a fresh token must
    // be allowed (open=2 + 1 new = 3 ≤ cap). If dust were counted, it would be
    // rejected (5 + 1 = 6 > 3). Mirrors the preflight fix.
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 3,
    });
    const positionRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findOpen: vi
        .fn()
        .mockReturnValue([
          makePosition({ tokenId: createTokenId("tok-a"), costBasisUsdc: 1 }),
          makePosition({ tokenId: createTokenId("tok-b"), costBasisUsdc: 1 }),
        ]),
      findDust: vi
        .fn()
        .mockReturnValue([
          makePosition({ tokenId: createTokenId("tok-c"), costBasisUsdc: 0.01 }),
          makePosition({ tokenId: createTokenId("tok-d"), costBasisUsdc: 0.01 }),
          makePosition({ tokenId: createTokenId("tok-e"), costBasisUsdc: 0.01 }),
        ]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    } as PositionRepository;
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ tokenId: createTokenId("tok-f"), price: 0.5, size: 2 }),
      timestamp: Date.now(),
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("places fee-enabled EOA orders to gateway (family policy gate removed)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
      walletMode: "eoa",
      minOrderUsdc: 3,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    // Family policy gate is removed — order reaches the gateway
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("passes post-only relayer orders for fee-enabled families to the gateway", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
      walletMode: "relayer",
      minOrderUsdc: 2,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ postOnly: true }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect((gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      postOnly: true,
      orderType: "GTC",
    });

    await guardedMod.stop();
  });

  it("passes explicit non-post-only relayer orders to the gateway", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
      walletMode: "relayer",
      minOrderUsdc: 2,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ postOnly: false }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect((gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      postOnly: false,
      orderType: "GTC",
    });

    await guardedMod.stop();
  });

  it("places relayer fee-enabled orders to gateway without post-only (family policy gate removed)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
      walletMode: "relayer",
      minOrderUsdc: 2,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    // Family policy gate is removed — order reaches the gateway even without post-only
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("places buy orders below min_order_usdc to gateway (family policy gate removed)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
      walletMode: "eoa",
      minOrderUsdc: 3,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.5, size: 5 }),
      timestamp: Date.now(),
    });

    // Family policy gate is removed — order reaches the gateway regardless of min_order_usdc
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("places relayer buy entries below CLOB marketable minimum to gateway (family policy gate removed)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
      walletMode: "relayer",
      minOrderUsdc: 0.05,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.12, size: 5, signalReason: "probe-entry" }),
      timestamp: Date.now(),
    });

    // Family policy gate is removed — order reaches the gateway regardless of CLOB minimum check
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("allows relayer buy entries at the CLOB minimum despite floating-point drift", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 100,
      maxActiveMarkets: 10,
      walletMode: "relayer",
      minOrderUsdc: 0.05,
    });
    const guardedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.09, size: 1 / 0.09, signalReason: "probe-entry" }),
      timestamp: Date.now(),
    });

    expect(0.09 * (1 / 0.09)).toBeLessThan(1);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  // ─── Market inactive guard ──────────────────────────────────────────

  it("rejects order when market is inactive (resolved/deactivated)", async () => {
    marketRepo.findByTokenId.mockReturnValue({ active: false });

    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("market-inactive");
    expect(rejected[0].errorCode).toBe("MARKET_INACTIVE");

    await mod.stop();
  });

  it("allows order when market is not found in repo (new market)", async () => {
    marketRepo.findByTokenId.mockReturnValue(null);

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalled();

    await mod.stop();
  });

  // ─── Runtime mode gating ─────────────────────────────────────────

  it("calls inline checkForFills in paper mode (uses SimulationExchangeGateway)", async () => {
    const paperMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "paper",
    });

    const mockFill: ExchangeFill = {
      fillId: "sim-fill-1",
      orderId: "sim-ord-1",
      clientOrderId: "plk_abc123",
      tokenId: createTokenId("tok-yes"),
      side: "buy",
      price: 0.5,
      size: 10,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,

      timestamp: Date.now(),
    };
    (gateway.getFills as ReturnType<typeof vi.fn>).mockResolvedValue([mockFill]);

    await paperMod.start();

    const fills: any[] = [];
    bus.subscribe("FillReceived", async (p) => {
      fills.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    // Paper mode uses SimulationExchangeGateway with immediate fills,
    // so checkForFills must run inline (same as simulation mode)
    expect(gateway.getFills).toHaveBeenCalled();

    await paperMod.stop();
  });

  it("skips inline checkForFills in live-lite mode", async () => {
    const liveMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
    });

    await liveMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    // Live-lite uses real exchange — fills come via reconciliation, not inline
    expect(gateway.getFills).not.toHaveBeenCalled();

    await liveMod.stop();
  });

  // ─── Queue integration ────────────────────────────────────────────

  it("uses queue for non-blocking execution when maxConcurrency is set", async () => {
    let resolvePlace: () => void;
    const slowPlace = new Promise<PlaceOrderResult>((r) => {
      resolvePlace = () => r({ success: true, orderId: "sim-ord-slow" });
    });
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPlace);

    const queuedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      maxConcurrency: 4,
    });

    await queuedMod.start();

    // Publish should return quickly (enqueue, not await gateway)
    const publishPromise = bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    // publish should resolve even though gateway hasn't responded
    await publishPromise;

    // Gateway call is in-flight but not resolved
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(queuedMod.getDiagnostics()).toMatchObject({
      pendingCount: 1,
      activeCount: 1,
      queueDepth: 0,
      maxConcurrency: 4,
      placeCompleted: 0,
    });

    // Resolve the gateway call
    resolvePlace!();

    // Drain the queue
    await queuedMod.stop();
    expect(queuedMod.getDiagnostics().placeCompleted).toBe(1);
    expect(queuedMod.getDiagnostics().avgPlaceLatencyMs).not.toBeNull();
  });

  // ─── Unsubscribe on stop ──────────────────────────────────────────

  it("does not process events after stop", async () => {
    await mod.start();
    await mod.stop();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
  });

  // ─── Pause enforcement ────────────────────────────────────────────

  it("rejects PlaceOrderRequested with OrderRejected when paused, but processes cancel", async () => {
    const pausedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => true },
    });

    await pausedMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("paused");
    expect(rejected[0].errorCode).toBe("RUNTIME_PAUSED");

    // Cancel should still work while paused
    await bus.publish("CancelOrderRequested", {
      command: makeCancelCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);

    await pausedMod.stop();
  });

  // ─── Wallet balance pre-flight ──────────────────────────────────

  function createMockControlDb(walletBalance: number | null) {
    return {
      prepare: vi.fn().mockReturnValue({
        get: vi
          .fn()
          .mockReturnValue(
            walletBalance != null ? { wallet_balance_usdc: walletBalance } : undefined,
          ),
      }),
    };
  }

  it("rejects buy order when wallet balance is insufficient after reserved BUY notional", async () => {
    const controlDb = createMockControlDb(20);
    orderRepo.findOpen = vi.fn().mockReturnValue([
      {
        ...makePlaceCmd(),
        orderId: createOrderId("open-buy-1"),
        status: "open",
        size: 30,
        price: 0.5,
        sizeUsdc: 15,
        exchangeOrderId: "open-buy-1",
        signalId: null,
        botRunId: BOT_RUN_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Order,
    ]);

    const balanceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
    });

    await balanceMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    // price=0.5, size=20 → notional=10 > available=20 - 15 - 3% buffer
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.5, size: 20 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled(); // no rejected order row saved
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("reserved-usdc-limit");
    expect(rejected[0].errorCode).toBe("INSUFFICIENT_BALANCE");

    await balanceMod.stop();
  });

  it("allows buy order when wallet balance is sufficient", async () => {
    const controlDb = createMockControlDb(100);
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(10);

    const balanceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
    });

    await balanceMod.start();

    // price=0.5, size=10 → notional=5 < available=90
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.5, size: 10 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await balanceMod.stop();
  });

  it("counts queued BUY orders as pending reservations before gateway acceptance", async () => {
    const controlDb = createMockControlDb(11);
    let resolvePlace: () => void;
    const slowPlace = new Promise<PlaceOrderResult>((resolve) => {
      resolvePlace = () => resolve({ success: true, orderId: "sim-ord-slow" });
    });
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPlace);

    const queuedMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      maxConcurrency: 1,
    });

    await queuedMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("pending-1"), price: 0.5, size: 10 }),
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("pending-2"),
        clientOrderId: "plk_pending_2" as ClientOrderId,
        price: 0.5,
        size: 12,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("reserved-usdc-limit");
    expect(queuedMod.getDiagnostics()).toMatchObject({
      reservedBuyUsdc: 5,
      internalReservationRejectsLast10m: 1,
    });

    resolvePlace!();
    await queuedMod.stop();
  });

  it("skips balance check when controlDb is not provided", async () => {
    const noDeps = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    await noDeps.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await noDeps.stop();
  });

  it("skips balance check when profile_summaries row not found", async () => {
    const controlDb = createMockControlDb(null);

    const balanceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
    });

    await balanceMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await balanceMod.stop();
  });

  it("skips balance check for sell orders", async () => {
    const controlDb = createMockControlDb(1); // very low balance
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(0);

    const balancePosition = makePosition({ size: 10, costBasisUsdc: 0.5 });
    const balanceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(balancePosition),
      inventoryLotRepo: createMockInventoryLotRepo(balancePosition),

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
    });

    await balanceMod.start();

    // sell order with notional=5 > wallet=1, but should not be blocked
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ side: "sell", price: 0.5, size: 10 }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await balanceMod.stop();
  });

  it("dedup takes priority over balance check — duplicate commandId gets dedup skip, not balance rejection", async () => {
    const controlDb = createMockControlDb(0); // zero balance — would fail balance check
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(0);

    const balanceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
    });

    await balanceMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    const cmd = makePlaceCmd({ price: 0.5, size: 20 });

    // First attempt — rejected by balance check
    await bus.publish("PlaceOrderRequested", { command: cmd, timestamp: Date.now() });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("reserved-usdc-limit");

    // Second attempt with same commandId — should be dedup-skipped, NOT another balance rejection
    rejected.length = 0;
    await bus.publish("PlaceOrderRequested", { command: cmd, timestamp: Date.now() });
    expect(rejected).toHaveLength(0); // dedup silently skips
    expect(gateway.placeOrder).not.toHaveBeenCalled();

    await balanceMod.stop();
  });

  it("semantic dedup takes priority over balance check — existing open order with same clientOrderId skips, not balance rejection", async () => {
    const controlDb = createMockControlDb(0); // zero balance
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(0);

    // Simulate existing open order with same clientOrderId
    const cmd = makePlaceCmd({ price: 0.5, size: 20 });
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      orderId: "existing-ord",
      clientOrderId: cmd.clientOrderId,
      status: "open",
    });

    const balanceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,

      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
    });

    await balanceMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", { command: cmd, timestamp: Date.now() });

    // Should be semantic-dedup skipped, NOT balance rejection
    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();

    await balanceMod.stop();
  });

  it("rejects BUY at execution backstop when position concentration cap is exhausted", async () => {
    const concentrationMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      positionConcentration: {
        evaluateBuy: vi.fn(() => ({
          action: "skip",
          reason: "gross_cap",
          concentrationKey: "condition:cond-1",
          keyType: "condition",
          fallbackReason: null,
          effectiveNotionalUsdc: 0,
          metrics: null,
        })),
      } as never,
    });
    await concentrationMod.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.5, size: 20 }),
      timestamp: Date.now(),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("position-concentration-gross_cap");
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(orderRepo.save).not.toHaveBeenCalled();

    await concentrationMod.stop();
  });

  // ─── Maker micro-cap (Bug 3) ───────────────────────────────────────────────

  describe("maker micro-cap enforcement", () => {
    it("maker BUY over microMaxOrderUsdc is rejected", async () => {
      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live" as const,
            // Fix #1+TOCTOU's whitelist check runs before the cap check — must
            // include the command's conditionId ("cond-1") so this test still
            // exercises the per-order cap rejection, not the whitelist one.
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 5,
            microMaxOpenUsdc: 50,
          },
        }),
      });
      await microMod.start();

      const rejected: any[] = [];
      bus.subscribe("OrderRejected", async (p) => {
        rejected.push(p);
      });

      // notional = size 10 * price 0.6 = 6, which exceeds microMaxOrderUsdc: 5
      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({ entryStyle: "maker", side: "buy", size: 10, price: 0.6 }),
        timestamp: Date.now(),
      });

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe("maker-micro-order-cap-exceeded");

      await microMod.stop();
    });

    it("two concurrent maker BUYs that together exceed microMaxOpenUsdc: second is rejected", async () => {
      let resolvePlace: () => void;
      const slowPlace = new Promise<{ success: true; orderId: string }>((resolve) => {
        resolvePlace = () => resolve({ success: true, orderId: "sim-ord-maker-slow" });
      });
      (gateway.placeOrder as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPlace);

      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        maxConcurrency: 1,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live" as const,
            // Fix #1+TOCTOU's whitelist check runs before the cap check — must
            // include the command's conditionId ("cond-1") so this test still
            // exercises the aggregate-cap rejection, not the whitelist one.
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 20,
            microMaxOpenUsdc: 15,
          },
        }),
      });
      await microMod.start();

      const rejected: any[] = [];
      bus.subscribe("OrderRejected", async (p) => {
        rejected.push(p);
      });

      // First maker BUY: notional 9 (within per-order cap=20 and open cap=15)
      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("maker-buy-1"),
          entryStyle: "maker",
          side: "buy",
          size: 10,
          price: 0.9,
        }),
        timestamp: Date.now(),
      });

      // Second maker BUY: notional 7.2 — within per-order cap, but 9 + 7.2 = 16.2 > 15 open cap
      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("maker-buy-2"),
          clientOrderId: "plk_maker_buy_2" as any,
          entryStyle: "maker",
          side: "buy",
          size: 8,
          price: 0.9,
        }),
        timestamp: Date.now(),
      });

      expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe("maker-micro-open-cap-exceeded");

      resolvePlace!();
      await microMod.stop();
    });

    it("Fix #4 — a DUST maker position counts toward microMaxOpenUsdc (not just open)", async () => {
      // cap=5. No open maker positions/orders. One DUST maker position (cost 4.5)
      // exists from a partial exit. A new maker BUY of notional 1 → 4.5 (dust) + 1
      // = 5.5 > 5 → rejected. If dust were NOT counted, 0 + 1 = 1 ≤ 5 would place.
      const positionRepo = {
        save: vi.fn(),
        findByTokenId: vi.fn().mockReturnValue(null),
        findOpen: vi.fn().mockReturnValue([]),
        findAll: vi.fn().mockReturnValue([]),
        findOpenByEntryStyle: vi.fn().mockReturnValue([]),
        findDust: vi
          .fn()
          .mockReturnValue([
            makePosition({
              tokenId: createTokenId("tok-dust"),
              entryStyle: "maker",
              status: "dust",
              costBasisUsdc: 4.5,
            }),
          ]),
      } as unknown as PositionRepository;

      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live" as const,
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 100,
            microMaxOpenUsdc: 5,
          },
        }),
      });
      await microMod.start();

      const rejected: any[] = [];
      bus.subscribe("OrderRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("maker-buy-dust"),
          entryStyle: "maker",
          side: "buy",
          size: 2,
          price: 0.5,
        }),
        timestamp: Date.now(),
      });

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe("maker-micro-open-cap-exceeded");
      expect(positionRepo.findDust).toHaveBeenCalled();

      await microMod.stop();
    });

    it("Fix #1+TOCTOU — an upward tick re-snap after admission counts at the FINAL submit notional (no cap bypass)", async () => {
      // Admitted at price 0.005 → reservation notional 0.005*110 = 0.55 (≤ cap 1).
      // The authoritative tick resolves UP to 0.01, re-snapping the price to 0.01, so
      // the real submit notional is 0.01*110 = 1.10 > cap 1. The submit validator must
      // exclude the stale 0.55 reservation and count the LIVE 1.10 → reject BEFORE the
      // exchange. (The old candidateReserved=true accounting counted only the stale
      // 0.55 and would have placed $1.10 — the bypass Codex flagged.)
      const tickResolver = { resolve: vi.fn().mockResolvedValue(0.01), invalidate: vi.fn() };
      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        tickResolver: tickResolver as any,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live" as const,
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 100,
            microMaxOpenUsdc: 1,
          },
        }),
      });
      await microMod.start();

      const rejected: any[] = [];
      bus.subscribe("OrderRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("maker-resnap"),
          entryStyle: "maker",
          side: "buy",
          size: 110,
          price: 0.005,
          tickSize: 0.005,
        }),
        timestamp: Date.now(),
      });

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBe("maker-micro-open-cap-exceeded");

      await microMod.stop();
    });

    it("Fix #1 concurrency — a persisted-open maker order is not double-counted (open + its own stale reservation)", async () => {
      // order-1 places successfully → persisted-open → its reservation is cleared AT
      // persist (before the awaited OrderPlaced publish). A concurrent order-2 admission
      // that runs during that window must count order-1 EXACTLY ONCE (via findOpen), not
      // also via a stale reservation. cap=10, order-1=4, order-2=5 → 9 ≤ 10 → admitted.
      // Without the fix: 4 (open) + 4 (stale reservation) + 5 = 13 > 10 → falsely rejected.
      (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        orderId: "ord-conc-1",
      });

      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        maxConcurrency: 1,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live" as const,
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 100,
            microMaxOpenUsdc: 10,
          },
        }),
      });
      await microMod.start();

      const rejected: any[] = [];
      bus.subscribe("OrderRejected", async (p) => {
        rejected.push(p);
      });

      // When order-1's OrderPlaced fires it is persisted-open (reservation already
      // cleared by the fix). Simulate it in findOpen (the mock is not stateful) and run
      // order-2's admission inside this window.
      let order2CheckDone = false;
      bus.subscribe("OrderPlaced", async (e: any) => {
        if (order2CheckDone || String(e.commandId) !== "maker-conc-1") return;
        order2CheckDone = true;
        (orderRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
          {
            orderId: createOrderId("ord-conc-1"),
            entryStyle: "maker",
            side: "buy",
            status: "open",
            price: 0.5,
            size: 8,
          } as unknown as Order,
        ]);
        await bus.publish("PlaceOrderRequested", {
          command: makePlaceCmd({
            commandId: createCommandId("maker-conc-2"),
            entryStyle: "maker",
            side: "buy",
            price: 0.5,
            size: 10,
          }),
          timestamp: Date.now(),
        });
      });

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("maker-conc-1"),
          entryStyle: "maker",
          side: "buy",
          price: 0.5,
          size: 8,
        }),
        timestamp: Date.now(),
      });

      expect(order2CheckDone).toBe(true);
      // order-2 admitted (not falsely rejected by a double-counted order-1).
      expect(rejected).toHaveLength(0);

      await microMod.stop();
    });
  });
});
