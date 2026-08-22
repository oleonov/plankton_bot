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
  buildS1LadderId,
  buildS1SignalId,
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
import { buildClientOrderId } from "@krabs/domain/node";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { buildMakerCaptureRepriceIdentity } from "../maker-capture-reprice.js";
import type { MakerBuyFastCancel } from "../modules/execution/maker-buy-fast-cancel.js";
import { LIFECYCLE_STOP_WAIT_MS } from "../lifecycle-chain.js";

// ─── Test helpers ────────────────────────────────────────────────────────

const PHASE_ONE_ACTIVE_MARKET_CAP = 250;
const BOT_RUN_ID = createBotRunId("test-run-1");

function makerWindowUsage(overrides: Partial<import("@krabs/domain").MakerBuyWindowUsage> = {}) {
  return {
    committedUsdc: 0,
    conditionCommittedUsdc: 0,
    distinctAcceptedConditions: 0,
    committedConditionIds: [],
    filledUsdc: 0,
    ...overrides,
  };
}

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
    prepareOrder: vi.fn().mockResolvedValue({
      orderId: "prepared-ord-1",
      __preparedOrderBrand: "PreparedOrder" as const,
    }),
    submitPreparedOrder: vi.fn().mockResolvedValue({
      kind: "accepted" as const,
      orderId: "prepared-ord-1",
    }),
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
    claimForReconciliation: vi.fn().mockReturnValue(true),
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
    findById: vi.fn(() => null),
    findActiveByTokenId: vi.fn(() => []),
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

  it("releases a failed pre-child capture command only until its child persists", async () => {
    const rootOrderId = createOrderId("capture-root");
    const predecessorOrderId = createOrderId("capture-predecessor");
    const identity = buildMakerCaptureRepriceIdentity(rootOrderId, predecessorOrderId, 1);
    const tokenId = createTokenId("tok-yes");
    let child: Order | null = null;
    let intent: any = {
      ...identity,
      predecessorOrderId,
      rootOrderId,
      tokenId,
      conditionId: createConditionId("cond-1"),
      replacementIndex: 1,
      status: "ready",
      candidatePrice: 0.33,
      replacementSize: 2,
      childOrderId: null,
    };
    const clientOrderId = buildClientOrderId({
      signalId: identity.lifecycleSignalId,
      tokenId,
      side: "buy",
    });
    const command = makePlaceCmd({
      commandId: createCommandId(`maker-capture-place:${identity.intentId}`),
      clientOrderId,
      tokenId,
      price: 0.33,
      size: 2,
      entryStyle: "maker",
      postOnly: true,
      decisionRuleId: "R23_DIP_TRIGGER",
      signalReason: "probe-entry",
      signalId: identity.lifecycleSignalId,
      metadata: {
        makerCaptureRepriceV1: {
          version: 1,
          intentId: identity.intentId,
          rootOrderId,
          predecessorOrderId,
          replacementIndex: 1,
        },
      },
    });
    orderRepo.findMakerCaptureRepriceIntentBySignal = vi.fn(() => intent);
    orderRepo.findByClientOrderId = vi.fn(() => child);
    orderRepo.markMakerCaptureRepriceSubmitted = vi.fn((_id, childOrderId) => {
      intent = { ...intent, status: "submitted", childOrderId };
      return true;
    });
    orderRepo.save = vi.fn((order) => (child = order));
    (gateway.prepareOrder as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("prepare"));
    const internal = mod as any;
    let predecessorRemainingShares = 2;
    internal.deps.runtimeMode = "live-lite";
    internal.deps.candidateBookCache = {
      prime: vi.fn(async () => {
        await Promise.resolve();
        predecessorRemainingShares = 1;
        const now = Date.now();
        return new Map([
          [
            String(tokenId),
            {
              tokenId: String(tokenId),
              sourceKind: "rest",
              cachedAtMs: now,
              sourcePolledAtMs: now,
              snapshotTs: now,
              book: { tokenId },
            },
          ],
        ]);
      }),
    };
    internal.makerCaptureExecutionContext = () =>
      predecessorRemainingShares >= command.size
        ? { intent, predecessor: { price: 0.3 }, usage: { predecessorRemainingShares } }
        : null;
    internal.makerCaptureRepriceRejection = () => null;
    internal.makerBuyLiveRejection = () => null;
    internal.stampMakerCaptureLineage = (order: Order) => order;
    await mod.start();
    await bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
    await bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
    await bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
    expect(gateway.prepareOrder).toHaveBeenCalledTimes(2);
    expect(gateway.submitPreparedOrder).not.toHaveBeenCalled();
    expect(
      new Set(
        (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls.map(([order]) => order.orderId),
      ).size,
    ).toBe(1);
    await mod.stop();
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

  it("does not finish stopping while a command that triggered the stop is still executing", async () => {
    // Without a queue the dispatch call IS the in-flight work, and `stop()` has no other handle on
    // it. `executePlace` reaches its `not_accepting_orders` publish with no preceding await, and the
    // bus dispatches handlers SYNCHRONOUSLY — so a handler calling `stop()` runs inside
    // `dispatchCommand`'s own stack frame. A claim registered only after the executor RETURNS is not
    // in `directInFlight` yet: the drain sees an empty set, reports the module drained over a
    // command that is mid-flight, and bulk-releases its idempotency mark with the reservation live.
    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ acceptingOrders: false })],
      timestamp: Date.now(),
    });

    let releaseCommand!: () => void;
    let stopped = false;
    let stopping!: Promise<void>;
    bus.subscribe("OrderSkipped", async () => {
      stopping = mod.stop().then(() => {
        stopped = true;
      });
      // Holds the publish — and with it the command — open, so "stopped" can only become true
      // while the command is demonstrably still running.
      await new Promise<void>((r) => (releaseCommand = r));
    });

    const dispatched = bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(stopped).toBe(false);

    releaseCommand();
    await dispatched;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("tail-drains an abandoned command on the queue-less path too", async () => {
    // `maxConcurrency` unset is the configuration this whole file runs under, so a tail drain wired
    // only into the queue would be a silent no-op in exactly the mode where `directInFlight` is the
    // only handle anything has on the work.
    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ acceptingOrders: false })],
      timestamp: Date.now(),
    });

    let releaseCommand!: () => void;
    bus.subscribe("OrderSkipped", async () => {
      await new Promise<void>((r) => (releaseCommand = r));
    });

    const dispatched = bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 0));

    // A bounded tail cannot finish a command that is still running, and it has to SAY so — a
    // verdict of "drained" over live work is what makes the caller exit on top of it.
    expect(await mod.drainAbandonedTail(20)).toBe(false);

    const tail = mod.drainAbandonedTail(5_000);
    releaseCommand();
    expect(await tail).toBe(true);
    await dispatched;
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

  it("does not regress a prepared order that left pending before acceptance", () => {
    const pending = makePlaceCmd();
    const prepared: Order = {
      orderId: createOrderId("prepared-ord-1"),
      clientOrderId: pending.clientOrderId,
      tokenId: pending.tokenId,
      conditionId: pending.conditionId,
      side: pending.side,
      orderType: pending.orderType,
      price: pending.price,
      size: pending.size,
      sizeUsdc: pending.price * pending.size,
      status: "pending",
      exchangeOrderId: "prepared-ord-1",
      signalId: null,
      signalReason: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue({
      ...prepared,
      status: "filled",
    });

    (mod as any).persistPreparedAcceptedOrder(pending, prepared, "prepared-ord-1");

    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
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
    expect(savedOrder.fillProgressShares).toBe(0);
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
    (gateway as any).getFillsResult = vi.fn().mockResolvedValue({ ok: true, data: [] });
    (gateway as any).getOrderResult = vi.fn().mockResolvedValue({
      ok: true,
      data: { orderId: "sim-ord-1", status: "CANCELLED", sizeFilled: 0 },
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

    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);
    expect((gateway as any).getFillsResult).toHaveBeenCalledWith(Date.parse(savedOrder.createdAt));
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

  it("does not prove cancellation from an unbounded fill query when createdAt is malformed", async () => {
    const savedOrder = openSellAt(0.5, {
      orderId: createOrderId("sim-ord-1"),
      exchangeOrderId: "sim-ord-1",
      createdAt: "not-a-date",
    });
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);
    (gateway as any).getFillsResult = vi.fn();
    (gateway as any).getOrderResult = vi.fn();
    await mod.start();

    await bus.publish("CancelOrderRequested", { command: makeCancelCmd(), timestamp: Date.now() });

    expect(gateway.cancelOrder).toHaveBeenCalledOnce();
    expect((gateway as any).getFillsResult).not.toHaveBeenCalled();
    expect((gateway as any).getOrderResult).not.toHaveBeenCalled();
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    await mod.stop();
  });

  it.each([
    ["found working", { ok: true, data: { orderId: "sim-ord-1", status: "OPEN", sizeFilled: 0 } }],
    ["authoritative null", { ok: true, data: null }],
    ["lookup error", { ok: false, reason: "server", attempts: 1 }],
    [
      "coverage gap",
      { ok: true, data: { orderId: "sim-ord-1", status: "CANCELLED", sizeFilled: 1 } },
    ],
  ])("treats cancel ACK plus exact %s as non-terminal", async (_label, exact) => {
    const savedOrder = openSellAt(0.5, {
      orderId: createOrderId("sim-ord-1"),
      exchangeOrderId: "sim-ord-1",
    });
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);
    (gateway as any).getFillsResult = vi.fn().mockResolvedValue({ ok: true, data: [] });
    (gateway as any).getOrderResult = vi.fn().mockResolvedValue(exact);
    const cancelled: unknown[] = [];
    bus.subscribe("OrderCancelled", async (event) => {
      cancelled.push(event);
    });
    await mod.start();

    await bus.publish("CancelOrderRequested", { command: makeCancelCmd(), timestamp: Date.now() });

    expect(gateway.cancelOrder).toHaveBeenCalledOnce();
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    expect(cancelled).toEqual([]);
    await mod.stop();
  });

  it("fences live pending orders without reserving their later confirmed cancellation", async () => {
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
      status: "pending",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
      signalReason: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);
    const liveMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeMode: "live-lite",
      runtimeControl: { isPaused: () => false },
    });
    const cancelled: any[] = [];
    bus.subscribe("OrderCancelled", async (event) => {
      cancelled.push(event);
    });
    await liveMod.start();

    await bus.publish("CancelOrderRequested", {
      command: makeCancelCmd(),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    expect(cancelled).toEqual([]);

    savedOrder.status = "open";
    (gateway as any).getFillsResult = vi.fn().mockResolvedValue({ ok: true, data: [] });
    (gateway as any).getOrderResult = vi.fn().mockResolvedValue({
      ok: true,
      data: { orderId: "sim-ord-1", status: "CANCELLED", sizeFilled: 0 },
    });
    await bus.publish("CancelOrderRequested", {
      command: makeCancelCmd({ commandId: createCommandId("cancel-confirmed-open") }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledOnce();
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      savedOrder.orderId,
      "cancelled",
      undefined,
      "operator",
      expect.anything(),
    );
    expect(cancelled).toHaveLength(1);
    await liveMod.stop();
  });

  it("allows only an expired frozen capture pending row to cancel in live-lite", async () => {
    const now = Date.now();
    const savedOrder = {
      ...openSellAt(0.5, { side: "buy" }),
      status: "pending" as const,
      postOnly: true,
      entryStyle: "maker" as const,
      decisionRuleId: "R23_DIP_TRIGGER",
      signalReason: "probe-entry",
      createdAt: new Date(now - 2 * 60 * 60_000).toISOString(),
      metadata: {
        makerMicroLiveLifecycle: {
          kind: "r23_capture",
          activatedAtUtc: new Date(now - 3 * 60 * 60_000).toISOString(),
          expiresAtUtc: new Date(now + 60_000).toISOString(),
          fillWaitMs: 2 * 60 * 60_000,
        },
      },
    } satisfies Order;
    vi.mocked(orderRepo.findById).mockReturnValue(savedOrder);
    (gateway as any).getFillsResult = vi.fn().mockResolvedValue({ ok: true, data: [] });
    (gateway as any).getOrderResult = vi.fn().mockResolvedValue({
      ok: true,
      data: { orderId: String(savedOrder.orderId), status: "CANCELLED", sizeFilled: 0 },
    });
    const liveMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeMode: "live-lite",
      runtimeControl: { isPaused: () => false },
    });
    await liveMod.start();

    (liveMod as any).pendingReservations.set("matching-submit", {
      clientOrderId: savedOrder.clientOrderId,
      conditionId: savedOrder.conditionId,
      tokenId: savedOrder.tokenId,
      side: "buy",
      size: savedOrder.size,
      price: savedOrder.price,
      entryStyle: "maker",
    });
    await bus.publish("CancelOrderRequested", {
      command: makeCancelCmd({ reason: "stale_entry_ttl", orderId: savedOrder.orderId }),
      timestamp: now,
    });
    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    (liveMod as any).pendingReservations.delete("matching-submit");

    await bus.publish("CancelOrderRequested", {
      command: makeCancelCmd({
        commandId: createCommandId("expired-capture-cancel"),
        reason: "stale_entry_ttl",
        orderId: savedOrder.orderId,
      }),
      timestamp: now,
    });

    expect(gateway.cancelOrder).toHaveBeenCalledOnce();
    await liveMod.stop();
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

  it("releases a pending SELL replacement after exact cancellation rejection", async () => {
    const savedOrder = openSellAt(0.5, {
      orderId: createOrderId("sim-ord-1"),
      exchangeOrderId: "sim-ord-1",
    });
    (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue(savedOrder);
    (gateway as any).getFillsResult = vi.fn().mockResolvedValue({ ok: true, data: [] });
    (gateway as any).getOrderResult = vi.fn().mockResolvedValue({
      ok: true,
      data: { orderId: "sim-ord-1", status: "REJECTED", sizeFilled: 0 },
    });
    (mod as any).sellReplaceLocks.set(String(savedOrder.tokenId), {
      orderId: savedOrder.orderId,
      command: makePlaceCmd({ side: "sell" }),
      createdAt: Date.now(),
    });
    await mod.start();

    await (mod as any).executeCancel(makeCancelCmd());

    expect((mod as any).sellReplaceLocks.size).toBe(0);
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
    // The resting SELL belongs to the SAME cycle as the shared `mod` fixture's
    // position (pos-1), and that position is reported active — this keeps the
    // P6 pre-BUY cross-cycle gate (Release A Phase 3) a no-op here, isolating
    // the assertion to the SELL-replacement-tolerance behavior under test.
    const samePosition = makePosition({ positionId: createPositionId("pos-1") });
    const samePositionRepo = createMockPositionRepo(samePosition);
    samePositionRepo.findActiveByTokenId = vi.fn().mockReturnValue([samePosition]);
    const noReplaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: samePositionRepo,
      inventoryLotRepo: createMockInventoryLotRepo(samePosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    orderRepo.findByTokenId = vi
      .fn()
      .mockReturnValue([openSellAt(0.3, { positionId: createPositionId("pos-1") })]);
    await noReplaceMod.start();

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
    await noReplaceMod.stop();
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

  // Release A Phase 3 (P6) — executor-owned per-token transition barrier
  // (docs/plans/2026-07-24-release-a-phase3-owner-servicing.md).
  describe("Release A Phase 3 (P6) — transition barrier", () => {
    it("blocks a reopening BUY while a stale prior-cycle SELL drains, then admits a retry once it is confirmed-cancelled", async () => {
      let cancelled = false;
      const staleSell = openSellAt(0.3, {
        orderId: createOrderId("stale-sell-1"),
        exchangeOrderId: "stale-sell-1",
        positionId: createPositionId("pos-old-cycle"),
      });
      orderRepo.findByTokenId = vi.fn().mockImplementation(() => (cancelled ? [] : [staleSell]));
      orderRepo.findById = vi
        .fn()
        .mockImplementation((id: unknown) =>
          String(id) === String(staleSell.orderId)
            ? { ...staleSell, status: cancelled ? "cancelled" : "open" }
            : null,
        );
      orderRepo.updateStatus = vi.fn().mockImplementation(() => {
        cancelled = true;
      });
      // The shared `mod` fixture's positionRepo.findActiveByTokenId() always
      // returns [] — "pos-old-cycle" is active nowhere, so the resting SELL
      // is a genuine prior/closed cycle (the reopening scenario Part 2 guards).
      await mod.start();

      const rejected: Array<{ reason: string }> = [];
      bus.subscribe("OrderRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("reopen-buy-1"),
          clientOrderId: "plk_reopen_buy_1" as ClientOrderId,
          side: "buy",
        }),
        timestamp: Date.now(),
      });

      // The stale SELL is drained instead of being left to fill alongside a
      // newly (re)admitted cycle, and the exposing BUY itself is deferred.
      expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "stale-sell-1" });
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBe("transition-draining");

      // The drain's terminal confirmation (the local cancel-result path, via
      // the executeCommand finally-block re-check) already closed the
      // barrier within the same call above — a retried BUY is now admitted.
      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("reopen-buy-2-retry"),
          clientOrderId: "plk_reopen_buy_2" as ClientOrderId,
          side: "buy",
        }),
        timestamp: Date.now(),
      });

      expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
      await mod.stop();
    });

    it("blocks a competing PlaceOrderCommand while a token is draining, and admits again only once the drain target is confirmed terminal", async () => {
      let sellStatus: "open" | "cancelled" = "open";
      const stuckSell = openSellAt(0.35, {
        orderId: createOrderId("stuck-sell-1"),
        exchangeOrderId: "stuck-sell-1",
        positionId: createPositionId("pos-old-cycle-2"),
      });
      orderRepo.findByTokenId = vi
        .fn()
        .mockImplementation(() =>
          sellStatus === "open" ? [{ ...stuckSell, status: sellStatus }] : [],
        );
      orderRepo.findById = vi
        .fn()
        .mockImplementation((id: unknown) =>
          String(id) === String(stuckSell.orderId) ? { ...stuckSell, status: sellStatus } : null,
        );
      // Simulates an ambiguous/unknown exchange cancel outcome (P6 spec: must
      // NOT be treated as terminal) — the target stays in `targets` and the
      // token keeps draining.
      (gateway.cancelOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: false });

      await mod.start();
      const rejected: Array<{ reason: string }> = [];
      bus.subscribe("OrderRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("drain-open-buy"),
          clientOrderId: "plk_drain_open_buy" as ClientOrderId,
          side: "buy",
        }),
        timestamp: Date.now(),
      });
      expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBe("transition-draining");

      // A second, competing command for the SAME token arrives while still
      // draining — rejected too. Finding 4: the barrier now SELF-HEALS on each
      // placement attempt — the first cancel came back ambiguous (success:false)
      // and the target is still working, so the self-heal RETRIES the cancel
      // (a stuck/failed cancel must be re-attempted, not left blocking forever).
      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("competing-buy"),
          clientOrderId: "plk_competing_buy" as ClientOrderId,
          side: "buy",
        }),
        timestamp: Date.now(),
      });
      expect(gateway.cancelOrder).toHaveBeenCalledTimes(2); // retried the stuck cancel
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(rejected).toHaveLength(2);
      expect(rejected[1]!.reason).toBe("transition-draining");

      // Terminal confirmation arrives via the OTHER source — an independent
      // OrderCancelled echo (user-order-stream-module.ts), not executeCancel.
      sellStatus = "cancelled";
      await bus.publish("OrderCancelled", {
        commandId: createCommandId("external-cancel-echo"),
        orderId: stuckSell.orderId,
        tokenId: stuckSell.tokenId,
        conditionId: stuckSell.conditionId,
        reason: "operator",
        signalReason: null,
        timestamp: Date.now(),
      });

      // The token is quiescent again — a fresh command is admitted.
      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("post-drain-buy"),
          clientOrderId: "plk_post_drain_buy" as ClientOrderId,
          side: "buy",
        }),
        timestamp: Date.now(),
      });
      expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

      await mod.stop();
    });

    it("keeps a startup exchange-live/local-terminal mismatch fenced through duplicate cancel ACKs", async () => {
      const staleSell = openSellAt(0.35, {
        orderId: createOrderId("startup-local-terminal"),
        exchangeOrderId: "startup-local-terminal",
        positionId: createPositionId("pos-old-startup-cycle"),
        status: "cancelled",
        cancelReason: "operator",
      });
      orderRepo.findById = vi.fn().mockReturnValue(staleSell);
      (gateway as any).getFillsResult = vi.fn().mockResolvedValue({ ok: true, data: [] });
      (gateway as any).getOrderResult = vi.fn().mockResolvedValue({
        ok: true,
        data: { orderId: "startup-local-terminal", status: "OPEN", sizeFilled: 0 },
      });
      const liveMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeMode: "live-lite",
        runtimeControl: { isPaused: () => false },
      });
      await liveMod.start();

      await liveMod.seedStartupTransitions([
        { tokenId: staleSell.tokenId, activePositionId: null, orders: [staleSell] },
      ]);
      expect(liveMod.hasTransitionTarget(staleSell.orderId)).toBe(true);

      for (const suffix of ["one", "two"]) {
        await bus.publish("CancelOrderRequested", {
          command: makeCancelCmd({
            commandId: createCommandId(`duplicate-terminal-${suffix}`),
            orderId: staleSell.orderId,
          }),
          timestamp: Date.now(),
        });
      }

      expect(gateway.cancelOrder).toHaveBeenCalledTimes(3);
      expect(liveMod.hasTransitionTarget(staleSell.orderId)).toBe(true);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
      await liveMod.stop();
    });

    it("autonomous reconciliation retries but does not prune a locally terminal drain target", async () => {
      vi.useFakeTimers();
      try {
        const staleSell = openSellAt(0.35, {
          orderId: createOrderId("autonomous-local-terminal"),
          exchangeOrderId: "autonomous-local-terminal",
          positionId: createPositionId("pos-old-autonomous-cycle"),
          status: "cancelled",
          cancelReason: "operator",
        });
        orderRepo.findById = vi.fn().mockReturnValue(staleSell);
        (gateway as any).getFillsResult = vi.fn().mockResolvedValue({ ok: true, data: [] });
        (gateway as any).getOrderResult = vi.fn().mockResolvedValue({
          ok: true,
          data: { orderId: "autonomous-local-terminal", status: "OPEN", sizeFilled: 0 },
        });
        const liveMod = new ExecutionModule({
          gateway,
          bus,
          marketRepo: marketRepo as any,
          orderRepo,
          fillRepo,
          log: silentLog,
          botRunId: BOT_RUN_ID,
          runtimeMode: "live-lite",
          runtimeControl: { isPaused: () => false },
        });
        await liveMod.start();
        await liveMod.seedStartupTransitions([
          { tokenId: staleSell.tokenId, activePositionId: null, orders: [staleSell] },
        ]);

        await vi.advanceTimersByTimeAsync(5_000);

        expect(gateway.cancelOrder).toHaveBeenCalledTimes(2);
        expect(liveMod.hasTransitionTarget(staleSell.orderId)).toBe(true);
        await liveMod.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancel-side lookups only act on positionId-matching orders — a cross-cycle resting SELL is never picked as the replacement target", async () => {
      const currentCyclePosition = makePosition({ positionId: createPositionId("pos-1") });
      const scopedPositionRepo = createMockPositionRepo(currentCyclePosition);
      // The shared helper's findActiveByTokenId ignores its constructor arg
      // (a pre-existing fixture gap, unrelated to P6) — override it here so
      // the P5 exit-owner identity check (a single active cycle matching
      // cmd.positionId) passes and this test isolates Part 4's cancel-side
      // scoping in findOpenSellOrdersForToken/identifyReplacementCancelTarget.
      scopedPositionRepo.findActiveByTokenId = vi.fn().mockReturnValue([currentCyclePosition]);

      // Resting SELL left over from a DIFFERENT (older/closed) cycle on the
      // SAME token. Before Part 4's positionId scoping, a token-only lookup
      // would treat this as "the existing sell to replace" and cancel a
      // prior cycle's order out from under it.
      const crossCycleSell = openSellAt(0.3, { positionId: createPositionId("pos-old-cycle") });
      orderRepo.findByTokenId = vi.fn().mockReturnValue([crossCycleSell]);
      orderRepo.findById = vi.fn().mockReturnValue(crossCycleSell);

      const scopedMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: scopedPositionRepo,
        inventoryLotRepo: createMockInventoryLotRepo(currentCyclePosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      });
      await scopedMod.start();

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({
          commandId: createCommandId("sell-current-cycle"),
          clientOrderId: "plk_sell_current_cycle" as ClientOrderId,
          side: "sell",
          price: 0.4,
          size: 5,
          positionId: createPositionId("pos-1"),
        }),
        timestamp: Date.now(),
      });

      // No cancel of the cross-cycle order — the new SELL is placed fresh,
      // never treated as a "replacement" of a different cycle's resting order.
      expect(gateway.cancelOrder).not.toHaveBeenCalled();
      expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
      await scopedMod.stop();
    });
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

  it("recovers a blocked S1 exit: hydrates once, then the identical retry places", async () => {
    const requestMinOrderSizeHydration = vi.fn();
    // Entry at 0.40 so the 0.95 exit clears the loss-floor gate — this test is
    // about the minimum, not the floor.
    const exitPosition = makePosition({ size: 0.8, avgEntryPrice: 0.4, costBasisUsdc: 0.32 });
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(exitPosition),
      inventoryLotRepo: createMockInventoryLotRepo(exitPosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
      requestMinOrderSizeHydration,
    });
    await mod2.start();

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });
    const skipped: any[] = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push(p);
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: null, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });

    // The REAL deterministic S1 identity: `s1_<tokenId>_<ladderId>_<tierIndex>`
    // with `ladderId` hashed from (token, openedAt, avgEntryPrice). A phantom
    // release re-places the same tier and rebuilds this byte-for-byte, so the
    // retry below is the exact command the ladder republishes — not a fresh id
    // that would trivially bypass the idempotency set.
    const tokenId = createTokenId("tok-yes");
    const ladderId = buildS1LadderId({
      tokenId,
      openedAt: "2026-07-30T00:00:00.000Z",
      avgEntryPrice: 0.42,
    });
    const signalId = buildS1SignalId(tokenId, ladderId, 0);
    const s1Command = makePlaceCmd({
      commandId: createCommandId(`s1_${String(tokenId)}_${ladderId}_0`),
      clientOrderId: "krb_s1laddertier0" as ClientOrderId,
      side: "sell",
      price: 0.95,
      size: 0.8,
      postOnly: true,
      signalId,
      decisionRuleId: S1_LADDER_RULE_ID,
      metadata: { s1: { ladderId, tierIndex: 0 } },
    });

    // An S1 ladder re-places every tier on each reprice, so the same token gets
    // blocked repeatedly — the throttle must collapse that into one /books fetch.
    await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });
    await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });

    // Two rejections, not one: the second publish of the SAME commandId must not
    // be swallowed by `processedCommandIds` — nothing was ever submitted.
    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason).toBe("sell-residual-unknown-min");
    expect(requestMinOrderSizeHydration).toHaveBeenCalledTimes(1);
    expect(requestMinOrderSizeHydration).toHaveBeenCalledWith("tok-yes");
    expect(gateway.placeOrder).not.toHaveBeenCalled();

    // What the hydration produces: the `/books` minimum lands in the market cache.
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: 0.5, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });

    await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });

    // End to end: the exit the unknown minimum was blocking now reaches the CLOB.
    expect(skipped).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(gateway.submitPreparedOrder).toHaveBeenCalledTimes(1);
    expect((gateway.prepareOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      tokenId: "tok-yes",
      side: "sell",
      size: 0.8,
    });

    await mod2.stop();
  });

  /**
   * The CONCURRENT half of the release, which the sequential test above cannot reach: there, each
   * publish fully unwinds before the next starts, so the mark is only ever released with no accounting
   * left behind. Here the duplicate is delivered while the first attempt is still suspended inside
   * `rejectOrder` — its reservation and in-flight slot are still live.
   *
   * Releasing the mark at the block site (rather than deferring it to `executeCommand`'s `finally`) lets
   * that duplicate past the idempotency check into a `reserved-token-limit` reject — a branch that does
   * NOT release — so the id is re-marked for good and the post-hydration retry is dropped silently. The
   * exit stays blocked forever, which is the very tight loop this whole fix exists to end.
   */
  it("survives an identical command delivered while the first rejection is still unwinding", async () => {
    const requestMinOrderSizeHydration = vi.fn();
    const exitPosition = makePosition({ size: 0.8, avgEntryPrice: 0.4, costBasisUsdc: 0.32 });
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(exitPosition),
      inventoryLotRepo: createMockInventoryLotRepo(exitPosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
      requestMinOrderSizeHydration,
    });
    await mod2.start();

    const tokenId = createTokenId("tok-yes");
    const ladderId = buildS1LadderId({
      tokenId,
      openedAt: "2026-07-30T00:00:00.000Z",
      avgEntryPrice: 0.42,
    });
    const s1Command = makePlaceCmd({
      commandId: createCommandId(`s1_${String(tokenId)}_${ladderId}_0`),
      clientOrderId: "krb_s1laddertier0" as ClientOrderId,
      side: "sell",
      price: 0.95,
      size: 0.8,
      postOnly: true,
      signalId: buildS1SignalId(tokenId, ladderId, 0),
      decisionRuleId: S1_LADDER_RULE_ID,
      metadata: { s1: { ladderId, tierIndex: 0 } },
    });

    // The window is opened from INSIDE the first rejection, not by publishing twice up front: the
    // idempotency mark is set synchronously at admission, so a duplicate published before the first
    // attempt suspends is swallowed no matter where the release lives — such a test passes either way
    // and proves nothing. Awaiting here parks `rejectOrder`, so the first attempt sits PAST the block
    // site (where the buggy version already released the mark) and BEFORE `executeCommand`'s `finally`
    // (where its reservation and in-flight slot are still live). That is the only observable window.
    const rejected: any[] = [];
    let duplicate: Promise<void> | undefined;
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
      if (rejected.length > 1) return;
      duplicate = bus.publish("PlaceOrderRequested", {
        command: s1Command,
        timestamp: Date.now(),
      });
      await duplicate;
    });
    const skipped: any[] = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push(p);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: null, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });

    await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });
    await duplicate;

    // Exactly one rejection, and it is the block — not a `reserved-token-limit` from the duplicate
    // colliding with its own predecessor's still-live reservation. `reserved-token-limit` is decided at
    // admission (`execution-module.ts:1906`), before the reservation is registered and before
    // `executeCommand` runs at all, so it never reaches the `finally` that releases: one such reject
    // re-marks the id for good.
    expect(rejected.map((r) => r.reason)).toEqual(["sell-residual-unknown-min"]);
    expect(gateway.placeOrder).not.toHaveBeenCalled();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: 0.5, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });

    // The release still happened, just later: the identical retry the ladder republishes gets through.
    expect(skipped).toEqual([]);
    expect(gateway.submitPreparedOrder).toHaveBeenCalledTimes(1);

    await mod2.stop();
  });

  /**
   * The SHUTDOWN half of the deferred release. `stop()` does not await in-flight bus handlers, so a
   * blocked SELL suspended inside its own `OrderRejected` publish reaches `executeCommand`'s
   * `finally` AFTER `stop()` has already run: dropping the pending intents there leaves the id
   * marked in `processedCommandIds`, which `stop()` deliberately does not clear. The S1 commandId is
   * deterministic, so every post-hydration retry rebuilds the same id and is swallowed as a
   * duplicate for the life of the process — the tight loop, re-created by a restart.
   */
  it("releases a pending mark when stop() lands before the unwind finishes", async () => {
    const exitPosition = makePosition({ size: 0.8, avgEntryPrice: 0.4, costBasisUsdc: 0.32 });
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(exitPosition),
      inventoryLotRepo: createMockInventoryLotRepo(exitPosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
      requestMinOrderSizeHydration: vi.fn(),
    });
    await mod2.start();

    const tokenId = createTokenId("tok-yes");
    const ladderId = buildS1LadderId({
      tokenId,
      openedAt: "2026-07-30T00:00:00.000Z",
      avgEntryPrice: 0.42,
    });
    const s1Command = makePlaceCmd({
      commandId: createCommandId(`s1_${String(tokenId)}_${ladderId}_0`),
      clientOrderId: "krb_s1stoprelease0" as ClientOrderId,
      side: "sell",
      price: 0.95,
      size: 0.8,
      postOnly: true,
      signalId: buildS1SignalId(tokenId, ladderId, 0),
      decisionRuleId: S1_LADDER_RULE_ID,
      metadata: { s1: { ladderId, tierIndex: 0 } },
    });

    // Started, NOT awaited, from inside the rejection: `stop()` runs synchronously up to its first
    // await, and the intents are handled before it — so this reproduces the real interleaving
    // (block site done, `finally` still pending) without the test itself waiting on a queue drain
    // that cannot finish until this very handler returns.
    let stopping: Promise<void> | undefined;
    bus.subscribe("OrderRejected", async () => {
      stopping ??= mod2.stop();
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: null, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });
    await stopping;
    expect(gateway.placeOrder).not.toHaveBeenCalled();

    await mod2.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: 0.5, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });

    expect(gateway.submitPreparedOrder).toHaveBeenCalledTimes(1);

    await mod2.stop();
  });

  /**
   * The restart the test above relies on only works because the queue is re-opened. Production
   * ALWAYS builds one (`index.ts` passes `executionMaxConcurrency`, default 16), and
   * `ExecutionQueue.shutdown()` latches `accepting = false` permanently — so without a re-open a
   * restarted module accepts commands, marks them, reserves for them, and then drops every one of
   * them at `enqueue`: zero orders placed, marks and reservations stranded, for the life of the
   * process. The queue-less shape the other tests use cannot see it.
   */
  it("dispatches again after a restart in the production queue shape", async () => {
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      maxConcurrency: 16,
    });

    await mod2.start();
    await mod2.stop();
    await mod2.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-restart-queue"),
        clientOrderId: "krb_restartqueue" as ClientOrderId,
      }),
      timestamp: Date.now(),
    });

    // The queue executes off the publish, so drain before asserting.
    await mod2.stop();
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
  });

  /**
   * The queue refuses SILENTLY once shut down, and a refused command never reaches
   * `executeCommand` — so nothing unwinds what admission already recorded. The idempotency mark is
   * the damaging one: S1 ids are deterministic, so the identical retry is swallowed as a duplicate
   * forever and the exit stays blocked — the tight loop again, this time entered through the
   * shutdown window rather than through the block site.
   */
  it("leaves no trace when the queue refuses a command mid-shutdown", async () => {
    const exitPosition = makePosition({ size: 0.8, avgEntryPrice: 0.4, costBasisUsdc: 0.32 });
    const positionRepo = createMockPositionRepo(exitPosition);
    let stopping: Promise<void> | undefined;
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo: createMockInventoryLotRepo(exitPosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
      maxConcurrency: 16,
    });
    // `getReservationDecision` is the first thing to ask for the position, and it runs AFTER the
    // idempotency mark and BEFORE the dispatch — the exact window in which a shutdown turns an
    // admitted command into a silently dropped one.
    positionRepo.findByTokenId = vi.fn(() => {
      stopping ??= mod2.stop();
      return exitPosition;
    });
    await mod2.start();

    const sell = makePlaceCmd({
      commandId: createCommandId("cmd-refused-dispatch"),
      clientOrderId: "krb_refuseddispatch" as ClientOrderId,
      side: "sell",
      price: 0.95,
      size: 0.8,
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: 0.5, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", { command: sell, timestamp: Date.now() });
    await stopping;
    expect(gateway.placeOrder).not.toHaveBeenCalled();

    await mod2.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket({ minOrderSize: 0.5, bestAsk: 0.9 })],
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", { command: sell, timestamp: Date.now() });

    await mod2.stop();
    expect(gateway.submitPreparedOrder).toHaveBeenCalledTimes(1);
  });

  it("does not inherit the hydration throttle window across a module restart", async () => {
    const requestMinOrderSizeHydration = vi.fn();
    const blockedPosition = makePosition({ size: 0.8 });
    const mod2 = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(blockedPosition),
      inventoryLotRepo: createMockInventoryLotRepo(blockedPosition),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
      requestMinOrderSizeHydration,
    });

    const blockedSell = {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-restart-hydrate"),
        clientOrderId: "krb_restarthydrate" as ClientOrderId,
        side: "sell",
        price: 0.5,
        size: 0.8,
        postOnly: false,
        metadata: { marketData: { minOrderSize: null } },
      }),
      timestamp: Date.now(),
    };

    for (const run of [1, 2]) {
      await mod2.start();
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ minOrderSize: null, bestAsk: 0.9 })],
        timestamp: Date.now(),
      });
      await bus.publish("PlaceOrderRequested", blockedSell);
      // The restarted module rebuilds its book cache too, so the value the
      // throttle was suppressing a refetch of is gone — inheriting the window
      // would leave the exit blocked for the rest of it.
      expect(requestMinOrderSizeHydration).toHaveBeenCalledTimes(run);
      await mod2.stop();
    }
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
      findById: vi.fn(() => null),
      findActiveByTokenId: vi.fn(() => []),
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
      findById: vi.fn(() => null),
      findActiveByTokenId: vi.fn(() => []),
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
      findById: vi.fn(() => null),
      findActiveByTokenId: vi.fn(() => []),
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
      findById: vi.fn(() => null),
      findActiveByTokenId: vi.fn(() => []),
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

  it("a restart overlapping an in-flight stop does not leave the module half-started", async () => {
    // `stop()` parks inside the queue drain. A `start()` landing in that window used to re-open
    // the queue and re-subscribe on top of a teardown that had not finished — and the resuming
    // `stop()` then set `started = false` underneath it. The supervisor is told the module is
    // down while its subscriptions are live and its queue accepts commands, i.e. it places
    // orders after `stop()` returned.
    let resolvePlace: () => void;
    const slowPlace = new Promise<PlaceOrderResult>((r) => {
      resolvePlace = () => r({ success: true, orderId: "sim-ord-slow" });
    });
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPlace);

    const restartMod = new ExecutionModule({
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

    await restartMod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    const stopping = restartMod.stop();
    const starting = restartMod.start(); // lands while the drain is still parked
    resolvePlace!();
    await Promise.all([stopping, starting]);

    // The restart must win outright — not be silently un-started by the teardown it raced.
    expect(await restartMod.healthCheck()).toMatchObject({ ok: true });

    // …and the module the supervisor now believes is up really does execute.
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-after-restart"),
        clientOrderId: "plk_after_restart" as ClientOrderId,
      }),
      timestamp: Date.now(),
    });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);

    await restartMod.stop();
  });

  it("a stop that follows a start wins, even with the start still mid-flight", async () => {
    // The mirror of the test above, and the one a "join the teardown in progress" guard cannot
    // cover: here the START is the transition already running. It yields mid-body, the later
    // `stop()` runs to completion in that window, and the resuming start then re-opens the queue
    // and re-subscribes on top of a teardown that has already finished — a module the supervisor
    // believes is down, still placing orders.
    const lifecycleMod = new ExecutionModule({
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

    const starting = lifecycleMod.start();
    const stopping = lifecycleMod.stop(); // the LAST intent — it must decide the final state
    await Promise.all([starting, stopping]);

    expect(await lifecycleMod.healthCheck()).toMatchObject({ ok: false });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd(),
      timestamp: Date.now(),
    });
    expect(gateway.placeOrder).not.toHaveBeenCalled();
  });

  it("a stop that gave up waiting for a mid-flight start is not undone when that start resumes", async () => {
    // The window the test above cannot reach: there the stop WAITS for the start, so call order
    // alone settles it. Here the start parks past LIFECYCLE_STOP_WAIT_MS, the stop escapes its
    // ceiling and completes the whole teardown, and only THEN does the start resume — the one case
    // no `stopping`-style flag can see, because the restart that normally follows an escape resets
    // it. What the resuming start re-arms is not cosmetic: `started` is the guard that stops a
    // torn-down module from placing a deferred backstop from a chain still in flight.
    vi.useFakeTimers();
    try {
      const existingSell = openSellAt(0.4);
      orderRepo.findOpen = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findByTokenId = vi.fn().mockReturnValue([existingSell]);
      orderRepo.findById = vi.fn().mockReturnValue(existingSell);
      // 1.0/share cost basis against a 0.4 resting SELL — below the exit loss floor, so the
      // startup scan issues the managed cancel this test parks on.
      const belowFloorPosition = makePosition({ size: 5, costBasisUsdc: 5 });

      // Parks the startup scan inside its own cancel publish. `publish` awaits `allSettled` over
      // the subscribers, so the module's own handler still runs — only the publish stays pending.
      let releaseScan!: () => void;
      bus.subscribe(
        "CancelOrderRequested",
        () =>
          new Promise<void>((resolve) => {
            releaseScan = resolve;
          }),
      );

      const escapeMod = new ExecutionModule({
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

      const starting = escapeMod.start();
      const stopping = escapeMod.stop();
      await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_WAIT_MS);
      await stopping;
      expect(await escapeMod.healthCheck()).toMatchObject({ ok: false });

      releaseScan();
      await starting;

      // The teardown was the last intent — a start resuming on top of it must not report up.
      expect(await escapeMod.healthCheck()).toMatchObject({ ok: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop → start → stop leaves the module down, not up", async () => {
    // A second `stop()` that merely joins the first one loses: it settles when the FIRST teardown
    // does, the start queued between them then resumes and wins, and the module ends up live
    // although the latest requested transition was a stop.
    let resolvePlace: () => void;
    const slowPlace = new Promise<PlaceOrderResult>((r) => {
      resolvePlace = () => r({ success: true, orderId: "sim-ord-seq" });
    });
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockReturnValueOnce(slowPlace);

    const seqMod = new ExecutionModule({
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

    await seqMod.start();
    await bus.publish("PlaceOrderRequested", { command: makePlaceCmd(), timestamp: Date.now() });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    const stopping1 = seqMod.stop(); // parks in the queue drain
    const starting = seqMod.start();
    const stopping2 = seqMod.stop();
    resolvePlace!();
    await Promise.all([stopping1, starting, stopping2]);

    expect(await seqMod.healthCheck()).toMatchObject({ ok: false });
    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({
        commandId: createCommandId("cmd-after-seq"),
        clientOrderId: "plk_after_seq" as ClientOrderId,
      }),
      timestamp: Date.now(),
    });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
  });

  /**
   * The release of a deferred idempotency mark is ordered AFTER the drain for one reason: while
   * the command is still running, its reservation and in-flight slot are live, so a duplicate that
   * gets past the idempotency check takes a NON-releasing admission branch and burns the
   * deterministic S1 id for good. A shutdown that returned at its DEADLINE has not drained — it
   * still has commands executing — so releasing there re-creates exactly that defect. The set is
   * left intact instead: each command releases its own id in `executeCommand`'s `finally`.
   */
  it("does not release pending marks when the queue shutdown times out", async () => {
    vi.useFakeTimers();
    try {
      const exitPosition = makePosition({ size: 0.8, avgEntryPrice: 0.4, costBasisUsdc: 0.32 });
      const timeoutMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(exitPosition),
        inventoryLotRepo: createMockInventoryLotRepo(exitPosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        runtimeMode: "live-lite",
        requestMinOrderSizeHydration: vi.fn(),
        maxConcurrency: 4,
      });
      await timeoutMod.start();

      const tokenId = createTokenId("tok-yes");
      const ladderId = buildS1LadderId({
        tokenId,
        openedAt: "2026-07-30T00:00:00.000Z",
        avgEntryPrice: 0.42,
      });
      const s1Command = makePlaceCmd({
        commandId: createCommandId(`s1_${String(tokenId)}_${ladderId}_0`),
        clientOrderId: "krb_s1timeout0" as ClientOrderId,
        side: "sell",
        price: 0.95,
        size: 0.8,
        postOnly: true,
        signalId: buildS1SignalId(tokenId, ladderId, 0),
        decisionRuleId: S1_LADDER_RULE_ID,
        metadata: { s1: { ladderId, tierIndex: 0 } },
      });

      // The blocked SELL suspends inside its own `OrderRejected` publish and never reaches
      // `executeCommand`'s `finally` — so the queue cannot drain and the shutdown must time out.
      // Only the FIRST rejection parks: a released mark lets the retry through to the
      // non-releasing `reserved-token-limit` branch, and parking THAT one too would deadlock the
      // test instead of letting the burned id show up as a failed assertion.
      let releaseBlocked!: () => void;
      const blocked = new Promise<void>((r) => {
        releaseBlocked = r;
      });
      let parked = false;
      bus.subscribe("OrderRejected", async () => {
        if (parked) return;
        parked = true;
        await blocked;
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ minOrderSize: null, bestAsk: 0.9 })],
        timestamp: Date.now(),
      });
      await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });

      const stopping = timeoutMod.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;

      // The original command is STILL running, so its id must still be marked: an identical
      // retry has to be swallowed as a duplicate rather than admitted alongside it.
      await timeoutMod.start();
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ minOrderSize: 0.5, bestAsk: 0.9 })],
        timestamp: Date.now(),
      });
      await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });
      expect(gateway.placeOrder).not.toHaveBeenCalled();

      // …and once it finishes, its own `finally` performs the release the stop skipped, so the
      // retry is admitted exactly as it would have been after a clean drain.
      releaseBlocked();
      await vi.advanceTimersByTimeAsync(0);
      await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });
      await vi.advanceTimersByTimeAsync(0);
      expect(gateway.submitPreparedOrder).toHaveBeenCalledTimes(1);

      await timeoutMod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same defect in the queue-less shape (`maxConcurrency` unset — a supported constructor
   * configuration). With no queue there is nothing whose drain verdict to consult, and declaring
   * the module drained unconditionally released every pending mark while the command was still
   * inside `executePlace`: its reservation and in-flight slot are live, so the duplicate that the
   * released mark now admits takes the non-releasing `reserved-token-limit` branch and burns the
   * deterministic S1 id for good.
   */
  it("does not release pending marks while a queue-less command is still executing", async () => {
    vi.useFakeTimers();
    try {
      const exitPosition = makePosition({ size: 0.8, avgEntryPrice: 0.4, costBasisUsdc: 0.32 });
      const directMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo: createMockPositionRepo(exitPosition),
        inventoryLotRepo: createMockInventoryLotRepo(exitPosition),
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        runtimeMode: "live-lite",
        requestMinOrderSizeHydration: vi.fn(),
      });
      await directMod.start();

      const tokenId = createTokenId("tok-yes");
      const ladderId = buildS1LadderId({
        tokenId,
        openedAt: "2026-07-30T00:00:00.000Z",
        avgEntryPrice: 0.42,
      });
      const s1Command = makePlaceCmd({
        commandId: createCommandId(`s1_${String(tokenId)}_${ladderId}_0`),
        clientOrderId: "krb_s1direct0" as ClientOrderId,
        side: "sell",
        price: 0.95,
        size: 0.8,
        postOnly: true,
        signalId: buildS1SignalId(tokenId, ladderId, 0),
        decisionRuleId: S1_LADDER_RULE_ID,
        metadata: { s1: { ladderId, tierIndex: 0 } },
      });

      let releaseBlocked!: () => void;
      const blocked = new Promise<void>((r) => {
        releaseBlocked = r;
      });
      let parked = false;
      bus.subscribe("OrderRejected", async () => {
        if (parked) return;
        parked = true;
        await blocked;
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ minOrderSize: null, bestAsk: 0.9 })],
        timestamp: Date.now(),
      });
      // NOT awaited: without a queue the publish runs the command inline, so it cannot resolve
      // until the parked `OrderRejected` handler returns — which is the whole point of the case.
      const placing = bus.publish("PlaceOrderRequested", {
        command: s1Command,
        timestamp: Date.now(),
      });
      await vi.advanceTimersByTimeAsync(0);

      const stopping = directMod.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;

      await directMod.start();
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ minOrderSize: 0.5, bestAsk: 0.9 })],
        timestamp: Date.now(),
      });
      await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });
      expect(gateway.placeOrder).not.toHaveBeenCalled();

      releaseBlocked();
      await placing;
      await vi.advanceTimersByTimeAsync(0);
      await bus.publish("PlaceOrderRequested", { command: s1Command, timestamp: Date.now() });
      expect(gateway.submitPreparedOrder).toHaveBeenCalledTimes(1);

      await directMod.stop();
    } finally {
      vi.useRealTimers();
    }
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
    it("authorizes only an exact captureNextR23 command at the execution boundary", () => {
      const now = Date.now();
      orderRepo.getMakerBuyWindowUsage = vi.fn().mockReturnValue(makerWindowUsage());
      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live" as const,
            whitelistConditionIds: [],
            microLiveWindow: {
              activatedAtUtc: new Date(now - 60_000).toISOString(),
              expiresAtUtc: new Date(now + 60_000).toISOString(),
              maxCumulativeAcceptedPendingUsdc: 1,
              captureNextR23: true,
            },
          },
        }),
      });
      const command = makePlaceCmd({
        entryStyle: "maker",
        postOnly: true,
        decisionRuleId: "R23_DIP_TRIGGER",
        signalReason: "probe-entry",
        signalTimestamp: new Date(now).toISOString(),
      });

      expect((microMod as any).makerBuyLiveRejection(command, 0.5)).toBeNull();
      for (const forged of [
        { source: "operator" as const },
        { postOnly: false },
        { decisionRuleId: "OTHER_RULE" },
        { signalReason: "confirm-scale" },
        { signalTimestamp: new Date(now - 120_000).toISOString() },
        { signalTimestamp: new Date(now + 60_000).toISOString() },
      ]) {
        expect(
          (microMod as any).makerBuyLiveRejection({ ...command, ...forged }, 0.5)?.reason,
        ).toBe("maker-mode-inactive");
      }
    });

    it("blocks maker BUY admission while fast-cancel is latched and owns readiness lifecycle", async () => {
      const setReady = vi.fn();
      const makerBuyFastCancel = {
        isLatched: () => true,
        setReady,
      } as unknown as MakerBuyFastCancel;
      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
        makerBuyFastCancel,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live" as const,
            whitelistConditionIds: ["cond-1"],
          },
        }),
      });
      const rejected: Array<{ reason: string }> = [];
      bus.subscribe("OrderRejected", async (event) => {
        rejected.push(event);
      });

      await microMod.start();
      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({ entryStyle: "maker", side: "buy" }),
        timestamp: Date.now(),
      });

      expect(rejected[0]?.reason).toBe("maker-fast-cancel-active");
      expect(gateway.placeOrder).not.toHaveBeenCalled();
      await microMod.stop();
      expect(setReady.mock.calls).toEqual([[true], [false]]);
    });

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

    it("atomically check-before-reserves simultaneous Promise.all maker BUY admissions", async () => {
      let finishPlace!: () => void;
      (gateway.placeOrder as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishPlace = () => resolve({ success: true, orderId: "maker-atomic" });
          }),
      );
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
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 10,
            microMaxOpenUsdc: 10,
          },
        }),
      });
      await microMod.start();
      const rejected: Array<{ reason: string }> = [];
      bus.subscribe("OrderRejected", async (event) => {
        rejected.push(event);
      });
      const commands = ["atomic-a", "atomic-b"].map((id) =>
        makePlaceCmd({
          commandId: createCommandId(id),
          clientOrderId: `plk_${id}` as ClientOrderId,
          entryStyle: "maker",
          side: "buy",
          price: 0.6,
          size: 10,
        }),
      );

      const simultaneous = Promise.all(
        commands.map((command) =>
          bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() }),
        ),
      );
      await vi.waitFor(() => expect(rejected).toHaveLength(1));
      expect(rejected[0]?.reason).toBe("maker-micro-open-cap-exceeded");
      expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
      expect(microMod.makerBuyInFlightCount()).toBe(1);

      finishPlace();
      await simultaneous;
      expect(microMod.makerBuyInFlightCount()).toBe(0);
      await microMod.stop();
    });

    it("rejects when durable committed notional plus the candidate exceeds the window cap", async () => {
      orderRepo.getMakerBuyWindowUsage = vi
        .fn()
        .mockReturnValue(makerWindowUsage({ committedUsdc: 0.6, conditionCommittedUsdc: 0.6 }));
      const now = Date.now();
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
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 10,
            microMaxOpenUsdc: 10,
            microLiveWindow: {
              activatedAtUtc: new Date(now - 60_000).toISOString(),
              expiresAtUtc: new Date(now + 60_000).toISOString(),
              maxCumulativeAcceptedPendingUsdc: 1,
            },
          },
        }),
      });
      const rejected: Array<{ reason: string }> = [];
      bus.subscribe("OrderRejected", async (event) => {
        rejected.push(event);
      });
      await microMod.start();

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({ entryStyle: "maker", side: "buy", price: 0.5, size: 1 }),
        timestamp: now,
      });

      expect(gateway.placeOrder).not.toHaveBeenCalled();
      expect(rejected[0]?.reason).toBe("maker-micro-cumulative-cap-exceeded");
      expect(orderRepo.getMakerBuyWindowUsage).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        "cond-1",
        "plk_abc123",
      );
      await microMod.stop();
    });

    it.each([
      [
        "per-condition lifetime",
        makerWindowUsage({ committedUsdc: 0.6, conditionCommittedUsdc: 0.6 }),
        "maker-micro-condition-cap-exceeded",
      ],
      [
        "distinct-condition lifetime",
        makerWindowUsage({
          committedUsdc: 40,
          distinctAcceptedConditions: 44,
          committedConditionIds: Array.from({ length: 44 }, (_, index) => `other-${index}`),
        }),
        "maker-micro-distinct-condition-cap-exceeded",
      ],
      [
        "filled plus conservatively committed",
        makerWindowUsage({ committedUsdc: 4.5, conditionCommittedUsdc: 0, filledUsdc: 4.5 }),
        "maker-micro-filled-cap-exceeded",
      ],
    ])("enforces the %s series rail", (_label, usage, expectedReason) => {
      const now = Date.now();
      orderRepo.getMakerBuyWindowUsage = vi.fn().mockReturnValue(usage);
      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live",
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 1,
            microMaxOpenUsdc: 5,
            microLiveWindow: {
              activatedAtUtc: new Date(now - 60_000).toISOString(),
              expiresAtUtc: new Date(now + 60_000).toISOString(),
              maxCumulativeAcceptedPendingUsdc: 44,
              maxCumulativeAcceptedPendingUsdcPerCondition: 1,
              maxDistinctAcceptedConditions: 44,
              maxCumulativeFilledUsdc: 5,
            },
          },
        }),
      });

      const rejection = (microMod as any).makerBuyLiveRejection(
        makePlaceCmd({ entryStyle: "maker", price: 0.6, size: 1 }),
        0.6,
      );
      expect(rejection?.reason).toBe(expectedReason);
    });

    it("counts a complementary-token in-flight reservation against the same condition", () => {
      const now = Date.now();
      orderRepo.getMakerBuyWindowUsage = vi.fn().mockReturnValue(makerWindowUsage());
      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live",
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 1,
            microMaxOpenUsdc: 5,
            microLiveWindow: {
              activatedAtUtc: new Date(now - 60_000).toISOString(),
              expiresAtUtc: new Date(now + 60_000).toISOString(),
              maxCumulativeAcceptedPendingUsdc: 44,
              maxCumulativeAcceptedPendingUsdcPerCondition: 1,
            },
          },
        }),
      });
      (microMod as any).pendingReservations.set("other-command", {
        clientOrderId: "plk_complement" as ClientOrderId,
        conditionId: createConditionId("cond-1"),
        tokenId: createTokenId("tok-no"),
        side: "buy",
        size: 1,
        price: 0.6,
        entryStyle: "maker",
      });

      const rejection = (microMod as any).makerBuyLiveRejection(
        makePlaceCmd({ entryStyle: "maker", price: 0.5, size: 1 }),
        0.5,
      );
      expect(rejection?.reason).toBe("maker-micro-condition-cap-exceeded");
    });

    it("deduplicates an in-memory reservation already represented by a prepared pending row", () => {
      const now = Date.now();
      const otherClientOrderId = "plk_other_pending" as ClientOrderId;
      orderRepo.findOpen = vi.fn().mockReturnValue([
        {
          orderId: createOrderId("prepared-other"),
          clientOrderId: otherClientOrderId,
          tokenId: createTokenId("tok-other"),
          conditionId: createConditionId("cond-1"),
          side: "buy",
          orderType: "GTC",
          price: 0.4,
          size: 1,
          sizeUsdc: 0.4,
          status: "pending",
          exchangeOrderId: "prepared-other",
          signalId: null,
          signalReason: "probe-entry",
          entryStyle: "maker",
          botRunId: BOT_RUN_ID,
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
        } as Order,
      ]);
      orderRepo.getMakerBuyWindowUsage = vi
        .fn()
        .mockReturnValue(makerWindowUsage({ committedUsdc: 0.4, conditionCommittedUsdc: 0.4 }));
      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live" as const,
            whitelistConditionIds: ["cond-1"],
            microMaxOrderUsdc: 10,
            microMaxOpenUsdc: 10,
            microLiveWindow: {
              activatedAtUtc: new Date(now - 60_000).toISOString(),
              expiresAtUtc: new Date(now + 60_000).toISOString(),
              maxCumulativeAcceptedPendingUsdc: 1,
            },
          },
        }),
      });
      (microMod as any).pendingReservations.set("other-command", {
        clientOrderId: otherClientOrderId,
        conditionId: createConditionId("cond-1"),
        tokenId: createTokenId("tok-other"),
        side: "buy",
        size: 1,
        price: 0.4,
        entryStyle: "maker",
      });

      const rejection = (microMod as any).makerBuyLiveRejection(
        makePlaceCmd({ entryStyle: "maker", side: "buy", price: 0.5, size: 1 }),
        0.5,
      );

      expect(rejection).toBeNull();
    });

    it("rechecks expiry after prepared pending persistence and before the live POST", async () => {
      let expired = false;
      const now = Date.now();
      orderRepo.getMakerBuyWindowUsage = vi.fn().mockReturnValue(makerWindowUsage());
      vi.mocked(gateway.prepareOrder!).mockImplementationOnce(async () => {
        expired = true;
        return { orderId: "prepared-expiry", __preparedOrderBrand: "PreparedOrder" as const };
      });
      const policy = () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: {
          ...DEFAULT_EXECUTION_POLICY.makerEntry,
          mode: "micro_live" as const,
          whitelistConditionIds: ["cond-1"],
          microMaxOrderUsdc: 10,
          microMaxOpenUsdc: 10,
          microLiveWindow: {
            activatedAtUtc: new Date(now - 60_000).toISOString(),
            expiresAtUtc: new Date(expired ? now - 1 : now + 60_000).toISOString(),
            maxCumulativeAcceptedPendingUsdc: 1,
          },
        },
      });
      const microMod = new ExecutionModule({
        gateway,
        bus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeMode: "live-lite",
        runtimeControl: { isPaused: () => false },
        executionPolicy: policy,
      });
      const rejected: Array<{ reason: string }> = [];
      bus.subscribe("OrderRejected", async (event) => {
        rejected.push(event);
      });
      await microMod.start();

      await bus.publish("PlaceOrderRequested", {
        command: makePlaceCmd({ entryStyle: "maker", side: "buy", price: 0.5, size: 2 }),
        timestamp: now,
      });

      expect(gateway.prepareOrder).toHaveBeenCalledTimes(1);
      expect(gateway.submitPreparedOrder).not.toHaveBeenCalled();
      expect(rejected[0]?.reason).toBe("maker-micro-window-inactive");
      expect(orderRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
      expect(orderRepo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "rejected" }));
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
        findById: vi.fn(() => null),
        findActiveByTokenId: vi.fn(() => []),
        findDust: vi.fn().mockReturnValue([
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

      await microMod.stop();
      expect(order2CheckDone).toBe(true);
      // order-2 admitted (not falsely rejected by a double-counted order-1).
      expect(rejected).toHaveLength(0);
    });
  });
});
