/**
 * SELL size clamp tests (ADR-008).
 *
 * Verifies that SELL orders with intent > availableSize:
 *   1. are clamped to availableSize when ALLOW_SELL_SIZE_CLAMP is true (default)
 *   2. are rejected when ALLOW_SELL_SIZE_CLAMP is false
 *   3. are rejected with `clamped-below-min-order-size` when the clamp would
 *      push size below the exchange minOrderSize.
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
  createPositionId,
} from "@plankton/domain";
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
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";

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

function createMockPositionRepo(positionSize: number): PositionRepository {
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
    status: "open",
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

    // intent=6.31 (D5), available=2.0 → clamp to 2.0
    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd(6.31),
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
      command: makeSellCmd(6.31),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("reserved-token-limit");
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);

    await mod.stop();
  });

  // ── Case 3: clamp would drop below minOrderSize → reject ──

  it("rejects SELL with clamped-below-min-order-size when clamp would be below exchange minimum", async () => {
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
      command: makeSellCmd(6.31, {
        metadata: { marketData: { minOrderSize: 5 } } as unknown as Record<string, unknown>,
      } as Partial<PlaceOrderCommand>),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("clamped-below-min-order-size");
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);

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
      command: makeSellCmd(6.31),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(6.31);
    expect(mod.getDiagnostics().sellSizeClamps).toBe(0);

    await mod.stop();
  });
});
