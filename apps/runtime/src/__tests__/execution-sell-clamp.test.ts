/**
 * SELL size clamp tests (ADR-008).
 *
 * Verifies that SELL orders with intent > availableSize:
 *   1. are clamped to availableSize when ALLOW_SELL_SIZE_CLAMP is true (default)
 *   2. are rejected when ALLOW_SELL_SIZE_CLAMP is false
 *   3. are rejected before clamp when the available residual would be below
 *      the exchange minOrderSize.
 *
 * Ref: docs/adr/008-sell-size-clamp-policy.md
 *      docs/audits/2026-04-19-algo-spec-remediation-plan.md §7.3
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createCommandId,
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
} from "@krabs/domain";
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
  Position,
  PositionRepository,
  TokenId,
  ClientOrderId,
  Order,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { isExecutableOrderSize } from "../min-order-size.js";

const BOT_RUN_ID = createBotRunId("test-sell-clamp-run");
const SELL_TOKEN = createTokenId("tok-clamp-yes");
const SELL_COND = createConditionId("cond-clamp-1");

function makeSellCmd(size: number, overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId(`cmd-sell-${size}-${Math.random()}`),
    clientOrderId: `plk_sell_${size}_${Math.random()}` as ClientOrderId,
    source: "strategy",
    tokenId: SELL_TOKEN,
    conditionId: SELL_COND,
    side: "sell",
    size,
    price: 0.5,
    orderType: "GTC",
    tickSize: 0.01,
    negRisk: false,
    sequenceInTick: 0,
    signalReason: null,
    ...overrides,
  };
}

function createMockGateway(): ExchangeGateway {
  return {
    placeOrder: vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue({ success: true, orderId: "sim-ord-clamp" }),
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

function createMockPositionRepo(
  positionSize: number,
  status: Position["status"] = "open",
): PositionRepository {
  const pos: Position = {
    positionId: createPositionId("pos-clamp-1"),
    tokenId: SELL_TOKEN,
    conditionId: SELL_COND,
    side: "buy",
    size: positionSize,
    avgEntryPrice: 0.5,
    costBasisUsdc: positionSize * 0.5,
    currentValueUsdc: positionSize * 0.5,
    realizedPnl: 0,
    status,
    entryStyle: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
  };
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByTokenId: vi.fn().mockReturnValue(pos),
    findByConditionId: vi.fn().mockReturnValue([]),
    findAllOpen: vi.fn().mockReturnValue([pos]),
    updateSize: vi.fn(),
    close: vi.fn(),
  } as unknown as PositionRepository;
}

function makeOpenSellOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("ord-open-sell"),
    clientOrderId: "plk_open_sell" as ClientOrderId,
    tokenId: SELL_TOKEN,
    conditionId: SELL_COND,
    side: "sell",
    orderType: "GTC",
    price: 0.83,
    size: 6.987804878048781,
    sizeUsdc: 5.79987804878049,
    status: "open",
    exchangeOrderId: "ord-open-sell",
    signalId: null,
    signalReason: "repricing-exit",
    botRunId: BOT_RUN_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
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

function collectRejections(b: InProcessEventBus): Array<{ reason: string; errorCode: string }> {
  const rejected: Array<{ reason: string; errorCode: string }> = [];
  b.subscribe("OrderRejected", async (p) => {
    rejected.push({ reason: p.reason, errorCode: p.errorCode as string });
  });
  return rejected;
}

function reservationDecision(
  mod: ExecutionModule,
  cmd: PlaceOrderCommand,
): { kind: string; reason?: string; newSize?: number; details?: Record<string, unknown> } {
  return (
    mod as unknown as {
      getReservationDecision(
        cmd: PlaceOrderCommand,
        notional: number,
      ): { kind: string; reason?: string; newSize?: number; details?: Record<string, unknown> };
    }
  ).getReservationDecision(cmd, cmd.size * cmd.price);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ExecutionModule — SELL size clamp (ADR-008)", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let bus: InProcessEventBus;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: ReturnType<typeof createMockFillRepo>;

  beforeEach(() => {
    gateway = createMockGateway();
    bus = new InProcessEventBus();
    marketRepo = createMockMarketRepo();
    orderRepo = createMockOrderRepo();
    fillRepo = createMockFillRepo();
    silentLog.info.mockClear();
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    silentLog.debug.mockClear();
  });

  it("uses a 1-share fallback when market min order size metadata is missing", () => {
    expect(isExecutableOrderSize(0.5, null)).toBe(false);
    expect(isExecutableOrderSize(1, null)).toBe(true);
    expect(isExecutableOrderSize(2, null)).toBe(true);
  });

  it("clamps SELL up to available residual when intent is below min and residual can satisfy min", () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(6.85),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    const decision = reservationDecision(
      mod,
      makeSellCmd(3.67, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
    );

    expect(decision).toMatchObject({
      kind: "clamp",
      newSize: 6.85,
      details: {
        availableSize: 6.85,
        intentSize: 3.67,
        minOrderSize: 5,
        clampDirection: "up-to-available",
        reason: "intent-below-min-residual-above-min",
      },
    });
  });

  it("rejects SELL as dust when intent is below min and residual is also below min", () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(2),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    const decision = reservationDecision(
      mod,
      makeSellCmd(3.67, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
    );

    expect(decision).toMatchObject({
      kind: "reject",
      reason: "sell-residual-below-min-order-size",
      details: {
        availableSize: 2,
        orderSize: 3.67,
        minOrderSize: 5,
      },
    });
  });

  it("rejects SELL as dust when below-min intent fits a residual that remains below min", () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(4),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    const decision = reservationDecision(
      mod,
      makeSellCmd(3.67, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
    );

    expect(decision).toMatchObject({
      kind: "reject",
      reason: "sell-residual-below-min-order-size",
      details: {
        availableSize: 4,
        orderSize: 3.67,
        minOrderSize: 5,
      },
    });
  });

  it("does not clamp up when SELL intent already meets min", () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(6.85),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    const decision = reservationDecision(
      mod,
      makeSellCmd(5, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
    );

    expect(decision.kind).toBe("accept");
  });

  it("preserves DOWN clamp when SELL intent exceeds available residual", () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(6.85),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    const decision = reservationDecision(
      mod,
      makeSellCmd(10, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
    );

    expect(decision).toMatchObject({
      kind: "clamp",
      newSize: 6.85,
      details: {
        availableSize: 6.85,
        intentSize: 10,
      },
    });
  });

  it("accepts below-min SELL intent when no minOrderSize is known", () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(6.85),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    expect(reservationDecision(mod, makeSellCmd(3.67)).kind).toBe("accept");
  });

  it("does not trigger clamp-up for invalid zero minOrderSize metadata", () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(6.85),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    const decision = reservationDecision(
      mod,
      makeSellCmd(3.67, {
        metadata: { marketData: { minOrderSize: 0 } } as unknown as Record<string, unknown>,
      }),
    );

    expect(decision.kind).toBe("accept");
  });

  it("lets handlePlace route below-min SELL through reservation clamp-up", async () => {
    const positionRepo = createMockPositionRepo(6.85);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(3.67, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(6.85);
    expect(mod.getDiagnostics().sellSizeClamps).toBe(1);

    await mod.stop();
  });

  it("keeps BUY below-min rejection on the pre-flight guard", async () => {
    const positionRepo = createMockPositionRepo(6.85);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(3.67, {
        side: "buy",
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!).toEqual({
      reason: "exchange-min-order-size-rejected",
      errorCode: "INVALID_SIZE",
    });

    await mod.stop();
  });

  // ── Case 1: intent > available, clamp enabled → clamped to available ──

  it("clamps SELL size down to availableSize when intent exceeds position (default allow)", async () => {
    const positionRepo = createMockPositionRepo(2.0);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      // allowSellSizeClamp defaults to true (env-wired)
    });

    await mod.start();
    const rejected = collectRejections(bus);

    // intent=5.73 (R37 D5), available=2.0 → clamp to 2.0
    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5.73),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    const call = vi.mocked(gateway.placeOrder).mock.calls[0]![0];
    expect(call.size).toBe(2.0);
    expect(call.side).toBe("sell");

    expect(mod.getDiagnostics().sellSizeClamps).toBe(1);

    await mod.stop();
  });

  // ── Case 2: intent > available, clamp disabled → reject ──

  it("rejects SELL when clamp is disabled and intent exceeds availableSize", async () => {
    const positionRepo = createMockPositionRepo(2.0);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: false,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5.73),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("reserved-token-limit");
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);

    await mod.stop();
  });

  // ── Case 3: available residual below minOrderSize → reject ──

  it("rejects SELL with sell-residual-below-min-order-size before clamp", async () => {
    const positionRepo = createMockPositionRepo(0.5);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5.73, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      } as Partial<PlaceOrderCommand>),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!).toEqual({
      reason: "sell-residual-below-min-order-size",
      errorCode: "INVALID_SIZE",
    });
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);
    expect(silentLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "sell order rejected — clamped size below exchange minimum",
    );

    await mod.stop();
  });

  it("rejects SELL when open sell reservations leave a residual below minOrderSize", async () => {
    const positionRepo = createMockPositionRepo(10.21);
    orderRepo.findOpen = vi.fn().mockReturnValue([makeOpenSellOrder()]);
    orderRepo.findByTokenId = vi.fn().mockReturnValue([]);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5.73, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      } as Partial<PlaceOrderCommand>),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!).toEqual({
      reason: "sell-residual-below-min-order-size",
      errorCode: "INVALID_SIZE",
    });
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);
    expect(silentLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "sell order rejected — clamped size below exchange minimum",
    );

    await mod.stop();
  });

  it("clamps live-lite SELL below the 1-share fallback up to available residual", async () => {
    const positionRepo = createMockPositionRepo(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(0.5),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(10);
    expect(mod.getDiagnostics().sellSizeClamps).toBe(1);

    await mod.stop();
  });

  // ── Case 4: availableSize == 0 → plain reject (no clamp to zero) ──

  it("rejects SELL when position has zero available size (no clamp to zero)", async () => {
    const positionRepo = createMockPositionRepo(0);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(2.0),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("reserved-token-limit");
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);

    await mod.stop();
  });

  // ── Case 5: intent ≤ available → no clamp ──

  it("does not clamp when intent fits within available size", async () => {
    const positionRepo = createMockPositionRepo(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5.73),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(5.73);
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);

    await mod.stop();
  });

  it("allows SELL against a dust-labelled position that still has enough shares", async () => {
    const positionRepo = createMockPositionRepo(10, "dust");
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5.73, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      } as Partial<PlaceOrderCommand>),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(5.73);

    await mod.stop();
  });
});
