import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createFamilyId,
  createOrderId,
  createCommandId,
  createBotRunId,
  createPositionId,
  createConditionId,
} from "@plankton/domain";
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
  FamilyRulesProvider,
  TokenId,
  ClientOrderId,
  Order,
  Fill,
  Position,
  PositionRepository,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

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
    familyId: createFamilyId("fam-1"),
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
    reason: "strategy_exit",
    familyId: createFamilyId("fam-1"),
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
    redeemPositions: vi.fn<(conditionIds: string[]) => Promise<void>>().mockResolvedValue(),
    mergePositions: vi
      .fn<(merges: { conditionId: string; amount: number }[]) => Promise<void>>()
      .mockResolvedValue(),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  };
}

function createMockMarketRepo() {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue({ active: true }),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findByFamily: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    upsertAll: vi.fn(),
    deactivate: vi.fn(),
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
    familyId: createFamilyId("fam-1"),
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

function createMockPositionRepo(position: Position | null = null): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(position),
    findByFamily: vi.fn().mockReturnValue(position ? [position] : []),
    findOpen: vi.fn().mockReturnValue(position?.status === "open" ? [position] : []),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue(position ? [position] : []),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
  };
}

function createMockRulesProvider(
  identityOverrides: Record<string, unknown> = {},
): FamilyRulesProvider {
  return {
    getRule: vi.fn().mockReturnValue({
      identity: {
        familyId: createFamilyId("fam-1"),
        familyKey: "fam-1",
        primaryCategory: "geopolitics",
        regime: "generic",
        horizon: "short",
        cadence: "daily",
        strategyProfile: "scalp",
        topicKey: null,
        slugPattern: null,
        notes: null,
        feeTier: null,
        liveWalletRequirement: null,
        requiresPostOnlyForLive: null,
        ...identityOverrides,
      },
    }),
    isEnabled: vi.fn().mockReturnValue(true),
    getAllFamilies: vi.fn().mockReturnValue([]),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  } as FamilyRulesProvider;
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
  let rulesProvider: FamilyRulesProvider;
  let mod: ExecutionModule;

  beforeEach(() => {
    gateway = createMockGateway();
    bus = new InProcessEventBus();
    marketRepo = createMockMarketRepo();
    orderRepo = createMockOrderRepo();
    fillRepo = createMockFillRepo();
    rulesProvider = createMockRulesProvider();
    mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      rulesProvider,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
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

  it("publishes OrderRejected when gateway rejects", async () => {
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      errorCode: "INSUFFICIENT_BALANCE",
      errorMessage: "no funds",
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
    expect(rejected[0].errorCode).toBe("INSUFFICIENT_BALANCE");
    expect(rejected[0].reason).toBe("no funds");

    // Rejected order should still be persisted
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Order;
    expect(savedOrder.status).toBe("rejected");

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
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "existing",
      status: "open",
    });

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("cmd-new") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();

    await mod.stop();
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

  it("allows re-entry when prior clientOrderId order is filled", async () => {
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "old-filled",
      status: "filled",
    });

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("cmd-reentry") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("allows re-entry when prior clientOrderId order is cancelled", async () => {
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "old-cancelled",
      status: "cancelled",
    });

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("cmd-retry") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("allows re-entry when prior clientOrderId order is rejected", async () => {
    (orderRepo.findByClientOrderId as ReturnType<typeof vi.fn>).mockReturnValue({
      orderId: "old-rejected",
      status: "rejected",
    });

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ commandId: createCommandId("cmd-retry2") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await mod.stop();
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

    // importExchangeFills needs order lookup to resolve familyId + status.
    // findByClientOrderId must return null for dedup check (handlePlace),
    // then return the order when called by importExchangeFills after placement.
    const savedOrder: Order = {
      orderId: createOrderId("sim-ord-1"),
      clientOrderId: "plk_abc123" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),
      familyId: createFamilyId("fam-1"),
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
      familyId: createFamilyId("fam-1"),
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
      familyId: createFamilyId("fam-1"),
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
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("sim-ord-1"), "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].reason).toBe("strategy_exit");

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

    const reserveMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      rulesProvider,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      maxConcurrency: 1,
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
    expect(reserveMod.getDiagnostics()).toMatchObject({
      reservedSellTokenCount: 1,
      internalReservationRejectsLast10m: 1,
    });

    resolvePlace!();
    await reserveMod.stop();
  });

  it("cancels an existing SELL before submitting the replacement order", async () => {
    let cancelled = false;
    const existingSell: Order = {
      orderId: createOrderId("existing-sell"),
      clientOrderId: "plk_existing_sell" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),
      familyId: createFamilyId("fam-1"),
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
    orderRepo.updateStatus = vi.fn().mockImplementation(() => {
      cancelled = true;
    });

    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 10 })),
      rulesProvider,
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
        price: 0.5,
        size: 5,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "existing-sell" });
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect((gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      clientOrderId: "plk_sell_replace",
      side: "sell",
      price: 0.5,
    });
    expect(rejected.some((event) => event.reason === "sell-replace-pending")).toBe(true);
    expect(replaceMod.getDiagnostics().cancelReplacePendingCount).toBe(0);

    await replaceMod.stop();
  });

  it("rejects a sub-min SELL replacement before canceling the existing order", async () => {
    const existingSell: Order = {
      orderId: createOrderId("existing-sell"),
      clientOrderId: "plk_existing_sell" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      conditionId: createConditionId("cond-1"),
      familyId: createFamilyId("fam-1"),
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

    const replaceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(makePosition({ size: 6 })),
      rulesProvider,
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
        price: 0.5,
        size: 3.1,
        metadata: {
          marketData: {
            minOrderSize: 5,
          },
        },
      }),
      timestamp: Date.now(),
    });

    expect(cancelRequested).toHaveLength(0);
    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("exchange-min-order-size-rejected");
    expect(rejected[0].errorCode).toBe("INVALID_SIZE");
    expect(replaceMod.getDiagnostics().cancelReplacePendingCount).toBe(0);

    await replaceMod.stop();
  });

  // ─── Live-lite allowlist (removed) ──────────────────────────────────────────
  // The per-family allowlist gate was removed from ExecutionModule.
  // Orders are no longer rejected based on family allowlist membership.

  it("places order for any family (family allowlist gate removed)", async () => {
    const guard = new LiveLiteGuard({
      familyAllowlist: ["fam-allowed"],
      maxFamilies: 10,
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
      rulesProvider,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ familyId: createFamilyId("fam-not-in-allowlist") }),
      timestamp: Date.now(),
    });

    // Family allowlist gate is removed — order reaches the gateway
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("rejects order exceeding max order cap (live-lite order cap)", async () => {
    const guard = new LiveLiteGuard({
      familyAllowlist: ["fam-1"],
      maxFamilies: 10,
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
      rulesProvider,
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

  it("places fee-enabled EOA orders to gateway (family policy gate removed)", async () => {
    const guard = new LiveLiteGuard({
      familyAllowlist: ["fam-1"],
      maxFamilies: 10,
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
      rulesProvider: createMockRulesProvider({
        primaryCategory: "crypto",
        feeTier: "fee-enabled",
        liveWalletRequirement: "relayer-required",
        requiresPostOnlyForLive: true,
      }),
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
      familyAllowlist: ["fam-1"],
      maxFamilies: 10,
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
      rulesProvider: createMockRulesProvider({
        primaryCategory: "crypto",
        feeTier: "fee-enabled",
        liveWalletRequirement: "relayer-required",
        requiresPostOnlyForLive: true,
      }),
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

  it("places relayer fee-enabled orders to gateway without post-only (family policy gate removed)", async () => {
    const guard = new LiveLiteGuard({
      familyAllowlist: ["fam-1"],
      maxFamilies: 10,
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
      rulesProvider: createMockRulesProvider({
        primaryCategory: "crypto",
        feeTier: "fee-enabled",
        liveWalletRequirement: "relayer-required",
        requiresPostOnlyForLive: true,
      }),
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
      familyAllowlist: ["fam-1"],
      maxFamilies: 10,
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
      rulesProvider: createMockRulesProvider({
        primaryCategory: "geopolitics",
        feeTier: "fee-free",
        liveWalletRequirement: "eoa-ok",
        requiresPostOnlyForLive: false,
      }),
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
      familyAllowlist: ["fam-1"],
      maxFamilies: 10,
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
      rulesProvider: createMockRulesProvider({
        primaryCategory: "geopolitics",
        feeTier: "fee-free",
        liveWalletRequirement: "eoa-ok",
        requiresPostOnlyForLive: false,
      }),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.12, size: 5, signalReason: "spray-entry" }),
      timestamp: Date.now(),
    });

    // Family policy gate is removed — order reaches the gateway regardless of CLOB minimum check
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await guardedMod.stop();
  });

  it("allows relayer buy entries at the CLOB minimum despite floating-point drift", async () => {
    const guard = new LiveLiteGuard({
      familyAllowlist: ["fam-1"],
      maxFamilies: 10,
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
      rulesProvider: createMockRulesProvider({
        primaryCategory: "geopolitics",
        feeTier: "fee-free",
        liveWalletRequirement: "eoa-ok",
        requiresPostOnlyForLive: false,
      }),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      liveLiteGuard: guard,
    });

    await guardedMod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makePlaceCmd({ price: 0.09, size: 1 / 0.09, signalReason: "spray-entry" }),
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
      rulesProvider,
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
      rulesProvider,
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
      rulesProvider,
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
      rulesProvider,
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
      rulesProvider,
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
      rulesProvider,
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
      rulesProvider,
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
      rulesProvider,
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
      rulesProvider,
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

    const balanceMod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      rulesProvider,
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
      rulesProvider,
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
      rulesProvider,
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
});
