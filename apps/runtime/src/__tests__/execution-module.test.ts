import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createFamilyId,
  createOrderId,
  createCommandId,
  createBotRunId,
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
  TokenId,
  ClientOrderId,
  Order,
  Fill,
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
    side: "buy",
    size: 10,
    price: 0.5,
    orderType: "GTC",
    tickSize: 0.01,
    negRisk: false,
    familyId: createFamilyId("fam-1"),
    sequenceInTick: 0,
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
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
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
    mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
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
      fee: 0,
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
      familyId: createFamilyId("fam-1"),
      side: "buy",
      orderType: "GTC",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      status: "open",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
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
      fee: 0,
      timestamp: Date.now(),
    };
    (gateway.getFills as ReturnType<typeof vi.fn>).mockResolvedValue([partialFill]);

    const savedOrder: Order = {
      orderId: createOrderId("sim-ord-1"),
      clientOrderId: "plk_abc123" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      familyId: createFamilyId("fam-1"),
      side: "buy",
      orderType: "GTC",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      status: "open",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
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
      fee: 0,
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
      fee: 0,
      timestamp: Date.now(),
    };
    (gateway.getFills as ReturnType<typeof vi.fn>).mockResolvedValue([fill1, fill2]);

    const savedOrder: Order = {
      orderId: createOrderId("sim-ord-1"),
      clientOrderId: "plk_abc123" as ClientOrderId,
      tokenId: createTokenId("tok-yes"),
      familyId: createFamilyId("fam-1"),
      side: "buy",
      orderType: "GTC",
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      status: "open",
      exchangeOrderId: "sim-ord-1",
      signalId: null,
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

  // ─── Live-lite allowlist ──────────────────────────────────────────

  it("rejects order for non-allowlisted family (live-lite allowlist)", async () => {
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
      command: makePlaceCmd({ familyId: createFamilyId("fam-bad") }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("live-lite-allowlist-rejected");

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
      fee: 0,
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

    // Resolve the gateway call
    resolvePlace!();

    // Drain the queue
    await queuedMod.stop();
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
});
