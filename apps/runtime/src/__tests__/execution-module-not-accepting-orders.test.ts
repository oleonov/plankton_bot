/**
 * Phase 3 tests — not-accepting-orders suppression in ExecutionModule.
 *
 * Verifies:
 *  1. Not-accepting market → order suppressed (OrderSkipped "not_accepting_orders"),
 *     no gateway call, marketRepo.deactivate NOT called.
 *  2. Open position held + not-accepting → same suppression; deactivate still NOT called
 *     (active=1 must remain for pricing on held positions).
 *  3. Accepting market → order placed normally (unaffected).
 *  4. Unknown liveness (not in marketCache) → fail-open, order placed normally.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createCommandId,
  createBotRunId,
  createConditionId,
  createPositionId,
} from "@krabs/domain";
import type {
  ExchangeGateway,
  PlaceOrderParams,
  PlaceOrderResult,
  CancelOrderParams,
  CancelOrderResult,
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  OrderRepository,
  FillRepository,
  PlaceOrderCommand,
  TokenId,
  ClientOrderId,
  NormalizedMarket,
  PositionRepository,
  Position,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BOT_RUN_ID = createBotRunId("test-run-p3");
const TOKEN_ID = createTokenId("tok-p3");
const CONDITION_ID = createConditionId("cond-p3");

function makePlaceCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId("cmd-p3"),
    clientOrderId: "plk_p3_abc" as ClientOrderId,
    source: "strategy",
    tokenId: TOKEN_ID,
    conditionId: CONDITION_ID,
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

function makeNormalizedMarket(acceptingOrders: boolean): NormalizedMarket {
  return {
    tokenId: TOKEN_ID,
    conditionId: CONDITION_ID,
    slug: "test-p3",
    eventSlug: null,
    question: "Test P3?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders,
    enableOrderBook: true,
    bestBid: 0.48,
    bestAsk: 0.52,
    midPrice: 0.5,
    spread: 0.04,
    minOrderSize: null,
    bookSource: "clob",
    gammaCreatedAt: null,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
  };
}

function createMockGateway(): ExchangeGateway {
  return {
    placeOrder: vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue({ success: true, orderId: "ord-p3-1" }),
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

function makeOpenPosition(): Position {
  return {
    positionId: createPositionId("pos-p3"),
    tokenId: TOKEN_ID,
    conditionId: CONDITION_ID,
    side: "buy",
    size: 5,
    avgEntryPrice: 0.48,
    costBasisUsdc: 2.4,
    currentValueUsdc: 2.4,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

function getExecutePlaceCaller(mod: ExecutionModule): {
  executePlace(cmd: PlaceOrderCommand): Promise<void>;
} {
  return mod as unknown as {
    executePlace(cmd: PlaceOrderCommand): Promise<void>;
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExecutionModule — not-accepting-orders suppression (Phase 3)", () => {
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

  /** Publish NormalizedMarketUpdated so the ExecutionModule's marketCache is populated. */
  async function injectMarket(mod: ExecutionModule, market: NormalizedMarket): Promise<void> {
    await bus.publish("NormalizedMarketUpdated", { markets: [market], timestamp: Date.now() });
  }

  it("suppresses order when market is not accepting orders — no gateway call, OrderSkipped published, deactivate not called", async () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await mod.start();
    await injectMarket(mod, makeNormalizedMarket(false));

    const skippedEvents: unknown[] = [];
    bus.subscribe("OrderSkipped", async (e) => {
      skippedEvents.push(e);
    });

    await getExecutePlaceCaller(mod).executePlace(makePlaceCmd());

    // Gateway must NOT be called.
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    // No rejected row persisted.
    expect(orderRepo.save).not.toHaveBeenCalled();
    // marketRepo.deactivate must NOT be called.
    expect(marketRepo.deactivate).not.toHaveBeenCalled();
    // OrderSkipped published with the correct reason code.
    expect(skippedEvents).toHaveLength(1);
    expect((skippedEvents[0] as any).reasonCode).toBe("not_accepting_orders");

    await mod.stop();
  });

  it("suppresses order even when we hold an open position — deactivate never called (active=1 preserved)", async () => {
    const position = makeOpenPosition();
    const positionRepo = createMockPositionRepo(position);

    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      positionRepo,
    });
    await mod.start();
    // Market is not accepting orders even though we hold a position on it.
    await injectMarket(mod, makeNormalizedMarket(false));

    await getExecutePlaceCaller(mod).executePlace(makePlaceCmd());

    // Suppressed.
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    // Critical: deactivate must NEVER be called for a transient liveness state.
    expect(marketRepo.deactivate).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("places order normally when market is accepting orders", async () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await mod.start();
    await injectMarket(mod, makeNormalizedMarket(true));

    await getExecutePlaceCaller(mod).executePlace(makePlaceCmd());

    // Gateway called — placement not suppressed.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    // Order persisted as open.
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
    expect((orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0].status).toBe("open");

    await mod.stop();
  });

  it("fail-open: places order normally when market is NOT in marketCache (unknown liveness)", async () => {
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
    });
    await mod.start();
    // Deliberately do NOT inject any NormalizedMarket — marketCache is empty.

    await getExecutePlaceCaller(mod).executePlace(makePlaceCmd());

    // Fail-open: gateway called despite unknown liveness.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(marketRepo.deactivate).not.toHaveBeenCalled();

    await mod.stop();
  });
});
