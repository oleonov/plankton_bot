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
  DEFAULT_EXECUTION_POLICY,
  createTokenId,
  createCommandId,
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
  createLotId,
  createFillId,
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
  InventoryLotRepository,
  TokenId,
  ClientOrderId,
  Order,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { LIFECYCLE_STOP_WAIT_MS } from "../lifecycle-chain.js";
import { evaluateSellPreSubmitGuard, isExecutableOrderSize } from "../min-order-size.js";
import { RiskEventWriter } from "../risk-event-writer.js";

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
    findByTokenId: vi.fn().mockReturnValue({ active: true, conditionId: SELL_COND }),
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
    claimForReconciliation: vi.fn().mockReturnValue(true),
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
    findActiveByTokenId: vi.fn(() => []),
    findByTokenId: vi.fn().mockReturnValue(pos),
    findByConditionId: vi.fn().mockReturnValue([]),
    findAllOpen: vi.fn().mockReturnValue([pos]),
    findOpen: vi.fn().mockReturnValue([pos]),
    updateSize: vi.fn(),
    close: vi.fn(),
  } as unknown as PositionRepository;
}

// A single FIFO lot spanning the whole position — entryPrice matches
// createMockPositionRepo's avgEntryPrice (0.5) exactly, so the exit-loss-floor
// gate sees a consistent cost basis (Σ remainingSize == position.size,
// Σ remainingSize*entryPrice == position.costBasisUsdc) for any position size.
function createMockInventoryLotRepo(positionSize: number): InventoryLotRepository {
  const lot = {
    lotId: createLotId("lot-clamp-1"),
    positionId: createPositionId("pos-clamp-1"),
    tokenId: SELL_TOKEN,
    side: "buy" as const,
    size: positionSize,
    remainingSize: positionSize,
    entryPrice: 0.5,
    costUsdc: positionSize * 0.5,
    fillId: createFillId("fill-clamp-1"),
    createdAt: new Date().toISOString(),
  };
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([lot]),
    findOpen: vi.fn().mockReturnValue([lot]),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

// Same position/lot shape as createMockPositionRepo/createMockInventoryLotRepo
// above, except costBasisUsdc is caller-supplied so the exit-loss-floor gate
// (docs/plans/2026-07-20-exit-loss-floor.md) can be exercised with a cost
// basis that does NOT equal positionSize * 0.5.
function createMockPositionRepoWithBasis(
  positionSize: number,
  costBasisUsdc: number,
): PositionRepository {
  const pos: Position = {
    positionId: createPositionId("pos-clamp-floor-1"),
    tokenId: SELL_TOKEN,
    conditionId: SELL_COND,
    side: "buy",
    size: positionSize,
    avgEntryPrice: costBasisUsdc / positionSize,
    costBasisUsdc,
    currentValueUsdc: costBasisUsdc,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
  };
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findActiveByTokenId: vi.fn(() => []),
    findByTokenId: vi.fn().mockReturnValue(pos),
    findByConditionId: vi.fn().mockReturnValue([]),
    findAllOpen: vi.fn().mockReturnValue([pos]),
    findOpen: vi.fn().mockReturnValue([pos]),
    updateSize: vi.fn(),
    close: vi.fn(),
  } as unknown as PositionRepository;
}

// Two heterogeneous FIFO lots (oldest cheap, newer expensive) — lets a test
// prove the exit-loss-floor gate (docs/plans/2026-07-20-exit-loss-floor.md
// §Phase 1 "critical ordering") consumes the ACTUAL post-clamp submit size,
// not the pre-clamp intent: a clamp-up to the full position pulls in the
// pricier lot and can tip a loss that looked safe at the smaller intent past
// the floor.
function createMockInventoryLotRepoWithLots(
  positionId: ReturnType<typeof createPositionId>,
  lots: ReadonlyArray<{ remainingSize: number; entryPrice: number }>,
): InventoryLotRepository {
  const built = lots.map((lot, index) => ({
    lotId: createLotId(`lot-floor-${index}`),
    positionId,
    tokenId: SELL_TOKEN,
    side: "buy" as const,
    size: lot.remainingSize,
    remainingSize: lot.remainingSize,
    entryPrice: lot.entryPrice,
    costUsdc: lot.remainingSize * lot.entryPrice,
    fillId: createFillId(`fill-floor-${index}`),
    createdAt: new Date(Date.now() - (lots.length - index) * 60_000).toISOString(),
  }));
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(built),
    findOpen: vi.fn().mockReturnValue(built),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

function createMockLegStateRepo() {
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
      return {
        count,
        markedAbandoned,
      };
    }),
    markAbandoned: vi.fn(),
    recoverAbandoned: vi.fn(),
  };
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

  it("pre-submit guard blocks SELL size below known min order size", () => {
    expect(evaluateSellPreSubmitGuard(1.72, 5)).toEqual({
      proceed: false,
      reason: "sell-residual-below-min-order-size",
      minOrderSize: 5,
    });
  });

  it("pre-submit guard allows SELL size equal to min order size", () => {
    expect(evaluateSellPreSubmitGuard(5, 5)).toEqual({ proceed: true, minOrderSize: 5 });
  });

  it("pre-submit guard allows SELL size above min order size", () => {
    expect(evaluateSellPreSubmitGuard(5.1, 5)).toEqual({ proceed: true, minOrderSize: 5 });
  });

  it("pre-submit guard blocks SELL when min order size is unknown", () => {
    expect(evaluateSellPreSubmitGuard(50, null)).toEqual({
      proceed: false,
      reason: "sell-residual-unknown-min",
      minOrderSize: null,
    });
  });

  it("pre-submit guard blocks SELL when min order size is invalid zero", () => {
    expect(evaluateSellPreSubmitGuard(50, 0)).toEqual({
      proceed: false,
      reason: "sell-residual-unknown-min",
      minOrderSize: null,
    });
  });

  it("does not apply the strict SELL pre-submit guard to BUY orders with unknown min", async () => {
    const prepared = {
      orderId: "prepared-buy-unknown-min",
      __preparedOrderBrand: "PreparedOrder" as const,
    };
    gateway.prepareOrder = vi.fn().mockResolvedValue(prepared);
    gateway.submitPreparedOrder = vi.fn().mockResolvedValue({
      kind: "accepted",
      orderId: prepared.orderId,
    });
    const command = makeSellCmd(2, {
      side: "buy",
      metadata: { marketData: { minOrderSize: null } } as unknown as Record<string, unknown>,
    });
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(0),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command,
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(0);
    expect(gateway.prepareOrder).toHaveBeenCalledExactlyOnceWith({
      clientOrderId: command.clientOrderId,
      tokenId: command.tokenId,
      side: "buy",
      size: 2,
      price: 0.5,
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
    });
    expect(gateway.submitPreparedOrder).toHaveBeenCalledExactlyOnceWith(
      prepared,
      expect.any(Function),
    );
    expect(gateway.placeOrder).not.toHaveBeenCalled();

    await mod.stop();
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

  it("clamps to full available size when a SELL would leave an orphan residual", () => {
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

    expect(decision).toMatchObject({
      kind: "clamp",
      newSize: 6.85,
      details: {
        availableSize: 6.85,
        intentSize: 5,
        minOrderSize: 5,
        clampDirection: "up-to-available",
        reason: "orphan-residual-below-min",
      },
    });
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

  it("increments dust counter only when the actual position is below min order size", async () => {
    const legStateRepo = createMockLegStateRepo();
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(2),
      legStateRepo: legStateRepo as any,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
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

    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("sell-residual-below-min-order-size");
    expect(legStateRepo.incrementSellResidualReject).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("pre-submit guard writes order_rejected risk event with dust residual reason", async () => {
    const riskEventRepo = { insert: vi.fn() };
    const writer = new RiskEventWriter(riskEventRepo as any, {
      rejectCooldownMs: 15 * 60_000,
      exposureBreachCooldownMs: 15 * 60_000,
    });
    const legStateRepo = createMockLegStateRepo();
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(1.72),
      legStateRepo: legStateRepo as any,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    bus.subscribe("OrderRejected", async (event) => writer.onOrderRejected(event as any));

    await mod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(1.72, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "order_rejected",
        payload: expect.objectContaining({
          reason: "sell-residual-below-min-order-size",
          errorCode: "INVALID_SIZE",
          exchangeRejectionReason: null,
        }),
      }),
    );

    await mod.stop();
  });

  it("pre-submit guard increments dust counter for below-min residual", async () => {
    const legStateRepo = createMockLegStateRepo();
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(1.72),
      legStateRepo: legStateRepo as any,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    await mod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(1.72, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(legStateRepo.incrementSellResidualReject).toHaveBeenCalledTimes(1);
    expect(legStateRepo.incrementSellResidualReject).toHaveBeenCalledWith(
      SELL_TOKEN,
      expect.any(String),
      {
        threshold: DEFAULT_EXECUTION_POLICY.dustAbandonment.maxConsecutiveRejects,
        price: 0.5,
      },
    );

    await mod.stop();
  });

  it("blocks repeated below-min residual SELL attempts before CLOB and advances dust counter", async () => {
    const legStateRepo = createMockLegStateRepo();
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(1.72),
      legStateRepo: legStateRepo as any,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    await mod.start();
    const rejected = collectRejections(bus);

    for (let idx = 0; idx < 10; idx++) {
      await bus.publish("PlaceOrderRequested", {
        command: makeSellCmd(1.72, {
          commandId: createCommandId(`cmd-dust-storm-${idx}`),
          clientOrderId: `plk_dust_storm_${idx}` as ClientOrderId,
          metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
        }),
        timestamp: Date.now(),
      });
    }
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(10);
    expect(rejected.every((event) => event.reason === "sell-residual-below-min-order-size")).toBe(
      true,
    );
    expect(legStateRepo.incrementSellResidualReject).toHaveBeenCalledTimes(10);
    expect(vi.mocked(legStateRepo.incrementSellResidualReject).mock.results.at(-1)?.value).toEqual({
      count: 10,
      markedAbandoned: true,
    });

    await mod.stop();
  });

  it("does not increment dust counter for a below-min intent on a sellable position", async () => {
    const legStateRepo = createMockLegStateRepo();
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(6.85),
      inventoryLotRepo: createMockInventoryLotRepo(6.85),
      legStateRepo: legStateRepo as any,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
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
    expect(legStateRepo.incrementSellResidualReject).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("does not increment dust counter for acceptable-open-order rejects", async () => {
    const legStateRepo = createMockLegStateRepo();
    orderRepo.findByTokenId = vi.fn().mockReturnValue([
      makeOpenSellOrder({
        price: 0.5,
        size: 5,
        createdAt: new Date().toISOString(),
      }),
    ]);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: createMockPositionRepo(10),
      legStateRepo: legStateRepo as any,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("sell-order-acceptable-price-already-open");
    expect(legStateRepo.incrementSellResidualReject).not.toHaveBeenCalled();

    await mod.stop();
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
      inventoryLotRepo: createMockInventoryLotRepo(6.85),
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
      inventoryLotRepo: createMockInventoryLotRepo(2.0),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      // allowSellSizeClamp defaults to true (env-wired)
    });

    await mod.start();
    const rejected = collectRejections(bus);

    // intent=5.73 (R37 D5), available=2.0 → clamp to 2.0
    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5.73, {
        metadata: { marketData: { minOrderSize: 1 } } as unknown as Record<string, unknown>,
      }),
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

  it("blocks live-lite SELL when market min order size is unavailable", async () => {
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

    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("sell-residual-unknown-min");
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);

    await mod.stop();
  });

  it("blocks live-lite SELL with effectiveMinOrderSize=1 fallback but no real exchange min", async () => {
    const riskEventRepo = { insert: vi.fn() };
    const writer = new RiskEventWriter(riskEventRepo as any, {
      rejectCooldownMs: 15 * 60_000,
      exposureBreachCooldownMs: 15 * 60_000,
    });
    const legStateRepo = createMockLegStateRepo();
    const positionRepo = createMockPositionRepo(1.72413);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      legStateRepo: legStateRepo as any,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "live-lite",
      allowSellSizeClamp: true,
    });

    bus.subscribe("OrderRejected", async (event) => writer.onOrderRejected(event as any));

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(1.7241, {
        signalReason: "repricing-exit",
        decisionRuleId: "D9_LOSS_EXIT",
        metadata: {
          marketData: {
            minOrderSize: null,
            effectiveMinOrderSize: 1,
          },
        } as unknown as Record<string, unknown>,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(1);
    expect(rejected[0]!).toEqual({
      reason: "sell-residual-unknown-min",
      errorCode: "INVALID_SIZE",
    });
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "order_rejected",
        payload: expect.objectContaining({
          reason: "sell-residual-unknown-min",
          errorCode: "INVALID_SIZE",
        }),
      }),
    );
    expect(legStateRepo.incrementSellResidualReject).not.toHaveBeenCalled();

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
      inventoryLotRepo: createMockInventoryLotRepo(10),
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(5.73, {
        metadata: { marketData: { minOrderSize: 1 } } as unknown as Record<string, unknown>,
      }),
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
    const positionRepo = createMockPositionRepo(12, "dust");
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo: createMockInventoryLotRepo(12),
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

  // docs/plans/2026-07-20-exit-loss-floor.md §Phase 1 "critical ordering" +
  // §Phase 7 tests: "clamp/effective-size + floor".
  it("evaluates the exit loss floor on the CLAMPED size, not the pre-clamp intent", async () => {
    // 7-share position, 2 FIFO lots consumed oldest-first: 2 cheap shares
    // @0.05 then 5 pricier shares @0.90 (total cost 4.60). A 2-share intent
    // alone would only touch the cheap lot (~25% loss at price 0.04 — under
    // the default 50% floor), but the intent is below minOrderSize(5) while
    // the residual (7, no other reservations) satisfies it, so ADR-008
    // clamps UP to the full 7-share position. Selling all 7 pulls in the
    // expensive lot (~94% loss at 0.04) — past the floor. The gate must
    // block using the CLAMPED (post-ADR-008) size, or this dump would slip
    // through disguised as a small, safe-looking intent.
    const positionSize = 7;
    const costBasisUsdc = 2 * 0.05 + 5 * 0.9; // 4.6
    const positionRepo = createMockPositionRepoWithBasis(positionSize, costBasisUsdc);
    const inventoryLotRepo = createMockInventoryLotRepoWithLots(
      createPositionId("pos-clamp-floor-1"),
      [
        { remainingSize: 2, entryPrice: 0.05 },
        { remainingSize: 5, entryPrice: 0.9 },
      ],
    );
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      allowSellSizeClamp: true,
    });

    await mod.start();
    const rejected = collectRejections(bus);
    const skipped: Array<{ reasonCode: string; details?: Record<string, unknown> }> = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push({ reasonCode: p.reasonCode, details: p.details as Record<string, unknown> });
    });

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(2, {
        price: 0.04,
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasonCode).toBe("exit_loss_floor_blocked");
    expect(skipped[0]!.details).toMatchObject({
      exitLossFloorReason: "exit_loss_floor_blocked",
      effectiveSellShares: 7,
    });

    await mod.stop();
  });

  it("abandons the startup rescan mid-loop when an escaped stop supersedes the start", async () => {
    // The token is re-read PER ORDER, not once on entry. A stop that gives up waiting for this
    // parked scan has already unsubscribed, cleared the reconcile timer and left `started = false`;
    // the restart that normally follows installs its own subscriptions. Resuming this loop then
    // publishes a fresh cancel through the REPLACEMENT's live subscriptions — real exchange work
    // ordered by a startup whose own stop() already returned. Checking only after the loop is too
    // late by however many resting sells remain.
    vi.useFakeTimers();
    try {
      const positionRepo = createMockPositionRepoWithBasis(7, 2 * 0.05 + 5 * 0.9);
      const inventoryLotRepo = createMockInventoryLotRepoWithLots(
        createPositionId("pos-clamp-floor-1"),
        [
          { remainingSize: 2, entryPrice: 0.05 },
          { remainingSize: 5, entryPrice: 0.9 },
        ],
      );
      // Two resting exit SELLs, both below the floor at 0.04 — the second one is what the guard
      // has to refuse; with a single order the loop would end on its own and prove nothing.
      orderRepo.findOpen = vi
        .fn()
        .mockReturnValue([
          makeOpenSellOrder({ orderId: createOrderId("ord-startup-1"), price: 0.04 }),
          makeOpenSellOrder({ orderId: createOrderId("ord-startup-2"), price: 0.04 }),
        ]);

      const cancelled: string[] = [];
      let releaseFirstCancel!: () => void;
      const parkedBus = {
        // Parking the FIRST cancel is what puts the start past an await while the stop runs — the
        // only interleaving in which `superseded` can flip mid-loop.
        publish: vi.fn(async (event: string, payload: unknown) => {
          if (event !== "CancelOrderRequested") return;
          cancelled.push(String((payload as { command: { orderId: unknown } }).command.orderId));
          if (cancelled.length === 1) {
            await new Promise<void>((resolve) => (releaseFirstCancel = resolve));
          }
        }),
        subscribe: vi.fn(() => () => undefined),
      } as unknown as InProcessEventBus;

      const mod = new ExecutionModule({
        gateway,
        bus: parkedBus,
        marketRepo: marketRepo as any,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        executionPolicy: () => DEFAULT_EXECUTION_POLICY,
        log: silentLog,
        botRunId: BOT_RUN_ID,
        runtimeControl: { isPaused: () => false },
      });

      const superseded = mod.start();
      const escapedStop = mod.stop();
      // The stop's own ceiling: it stops waiting for the parked start and proceeds without it.
      await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_WAIT_MS);
      await escapedStop;

      releaseFirstCancel();
      await superseded;

      expect(cancelled).toEqual(["ord-startup-1"]);
      expect(silentLog.warn).toHaveBeenCalledWith(
        "execution module startup scan abandoned — a later stop superseded it",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
