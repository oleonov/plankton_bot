import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId, createOrderId, createConditionId } from "@krabs/domain";
import type {
  OrderRepository,
  MarketRepository,
  Market,
  NormalizedMarket,
  Order,
  ClientOrderId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  cleanStaleEntryOrders,
  CANCEL_BACKOFF_MS,
  PROBE_LIKE_DAILY_TTL_MS,
  PROBE_LIKE_INTRADAY_TTL_MS,
  recordSellDownpriceCancelSucceeded,
  type SellDownpriceRepriceStateMap,
} from "../modules/reconciliation/stale-order-cleaner.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const TOK = createTokenId("tok-yes");

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

function createMockMarketRepo(): MarketRepository {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
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

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_abc" as ClientOrderId,
    tokenId: TOK,
    conditionId: createConditionId("cond-1"),
    side: "buy",
    orderType: "GTC",
    price: 0.3,
    size: 10,
    sizeUsdc: 3,
    status: "open",
    exchangeOrderId: "ex-1",
    signalId: null,
    signalReason: "probe-entry",
    botRunId: "run-1" as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides?: Partial<Market>): Market {
  return {
    tokenId: TOK,
    conditionId: "cond-1",
    slug: "test-market",
    eventSlug: null,
    question: "Test?",
    outcome: "YES",
    regime: "threshold",
    horizon: "daily",
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makePricing(
  overrides?: Partial<
    Pick<
      NormalizedMarket,
      "bestBid" | "bestAsk" | "bestAskSize" | "askDepthExcludingOurs" | "tickSize"
    >
  >,
) {
  return {
    bestBid: 0.32,
    bestAsk: null,
    bestAskSize: null,
    askDepthExcludingOurs: null,
    tickSize: 0.01,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("cleanStaleEntryOrders", () => {
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let bus: InProcessEventBus;
  let backoffMap: Map<string, number>;

  beforeEach(() => {
    vi.clearAllMocks();
    orderRepo = createMockOrderRepo();
    marketRepo = createMockMarketRepo();
    bus = new InProcessEventBus();
    backoffMap = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function run() {
    return cleanStaleEntryOrders({ orderRepo, marketRepo, bus, log: silentLog }, backoffMap);
  }

  function runWithLifetime(
    decision: Partial<
      ReturnType<
        NonNullable<
          Parameters<typeof cleanStaleEntryOrders>[0]["exitOrderLifetime"]
        >["resolveExitOrder"]
      >
    >,
  ) {
    return cleanStaleEntryOrders(
      {
        orderRepo,
        marketRepo,
        bus,
        log: silentLog,
        exitOrderLifetime: {
          resolveExitOrder: () => ({
            enabled: true,
            enforcement: "enforce",
            mode: "PASSIVE",
            confidence: "low",
            modeStatus: "confirmed",
            flatTtlMs: 300_000,
            modeTtlMs: 21_600_000,
            effectiveTtlMs: 21_600_000,
            ageMs: 360_000,
            timeToEndMs: null,
            resolutionCapApplied: false,
            rateLimited: false,
            wouldCancelUnderFlat: true,
            wouldCancelUnderMode: false,
            cancelReason: null,
            ...decision,
          }),
        },
      },
      backoffMap,
    );
  }

  function runWithDownprice(
    order: Order,
    bestBid: number,
    stateMap: SellDownpriceRepriceStateMap = new Map(),
    opts: {
      bestAsk?: number | null;
      bestAskSize?: number | null;
      askDepthExcludingOurs?: number | null;
      maxRepricesPerOrder?: number;
      extraOpenOrders?: Order[];
    } = {},
  ) {
    orderRepo.findOpen = vi.fn().mockReturnValue([order, ...(opts.extraOpenOrders ?? [])]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket());
    return cleanStaleEntryOrders(
      {
        orderRepo,
        marketRepo,
        bus,
        log: silentLog,
        exitRepriceOnDownprice: {
          policy: () => ({
            enabled: true,
            thresholdTicks: 5,
            maxRepricesPerOrder: opts.maxRepricesPerOrder ?? 3,
            stuckWarningEnabled: true,
            stuckWarningAgeMs: 4 * 60 * 60_000,
            stuckWarningGapPct: 0.1,
          }),
          getMarket: () =>
            makePricing({
              bestBid,
              bestAsk: opts.bestAsk ?? null,
              bestAskSize: opts.bestAskSize ?? null,
              askDepthExcludingOurs: opts.askDepthExcludingOurs ?? null,
              tickSize: 0.01,
            }),
        },
      },
      backoffMap,
      stateMap,
    );
  }

  // ─── TTL cancellation ──────────────────────────────────────────────

  it("cancels old open buy entry order exceeding TTL", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
    expect(result.staleEndDateCancelled).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
    expect(cancelled[0].command.orderId).toBe(order.orderId);
  });

  it("keeps regular stale TTL cancellation for ladder entry orders", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalId: "ladder-signal-1",
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
  });

  it("does not cancel fresh open buy entry order within TTL", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: twoMinutesAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(0);
    expect(result.staleEndDateCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("cancels fresh buy entry order for outbid reprice when best bid moved up by one tick", async () => {
    const order = makeOrder({
      price: 0.3,
      signalId: "sig-1",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await cleanStaleEntryOrders(
      {
        orderRepo,
        marketRepo,
        bus,
        log: silentLog,
        entryRepriceOnOutbid: {
          policy: () => ({ enabled: true, maxRepriceCount: 5 }),
          getRepriceCount: () => 0,
          getMarket: () => makePricing({ bestBid: 0.31, tickSize: 0.01 }),
        },
      },
      backoffMap,
    );
    await bus.drain();

    expect(result.outbidRepriceCancelled).toBe(1);
    expect(result.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("outbid_repriced");
  });

  it("keeps endDate safety ahead of outbid reprice near resolution", async () => {
    const order = makeOrder({
      price: 0.3,
      signalId: "sig-1",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi
      .fn()
      .mockReturnValue(makeMarket({ endDate: new Date(Date.now() + 30 * 60_000).toISOString() }));

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await cleanStaleEntryOrders(
      {
        orderRepo,
        marketRepo,
        bus,
        log: silentLog,
        entryRepriceOnOutbid: {
          policy: () => ({ enabled: true, maxRepriceCount: 5 }),
          getRepriceCount: () => 0,
          getMarket: () => makePricing({ bestBid: 0.31, tickSize: 0.01 }),
        },
      },
      backoffMap,
    );
    await bus.drain();

    expect(result.outbidRepriceCancelled).toBe(0);
    expect(result.staleEndDateCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_enddate");
  });

  it("does not outbid-reprice when best bid has not moved by a full tick", async () => {
    const order = makeOrder({
      price: 0.3,
      signalId: "sig-1",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await cleanStaleEntryOrders(
      {
        orderRepo,
        marketRepo,
        bus,
        log: silentLog,
        entryRepriceOnOutbid: {
          policy: () => ({ enabled: true, maxRepriceCount: 5 }),
          getRepriceCount: () => 0,
          getMarket: () => makePricing({ bestBid: 0.3, tickSize: 0.01 }),
        },
      },
      backoffMap,
    );
    await bus.drain();

    expect(result.outbidRepriceCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("does not outbid-reprice when the feature flag is disabled", async () => {
    const order = makeOrder({
      price: 0.3,
      signalId: "sig-1",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await cleanStaleEntryOrders(
      {
        orderRepo,
        marketRepo,
        bus,
        log: silentLog,
        entryRepriceOnOutbid: {
          policy: () => ({ enabled: false, maxRepriceCount: 5 }),
          getRepriceCount: () => 0,
          getMarket: () => makePricing({ bestBid: 0.31, tickSize: 0.01 }),
        },
      },
      backoffMap,
    );
    await bus.drain();

    expect(result.outbidRepriceCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("falls back to stale TTL cancellation after max outbid reprice attempts", async () => {
    const order = makeOrder({
      price: 0.3,
      signalId: "sig-1",
      createdAt: new Date(Date.now() - 7 * 60 * 60_000).toISOString(),
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await cleanStaleEntryOrders(
      {
        orderRepo,
        marketRepo,
        bus,
        log: silentLog,
        entryRepriceOnOutbid: {
          policy: () => ({ enabled: true, maxRepriceCount: 5 }),
          getRepriceCount: () => 5,
          getMarket: () => makePricing({ bestBid: 0.32, tickSize: 0.01 }),
        },
      },
      backoffMap,
    );
    await bus.drain();

    expect(result.outbidRepriceCancelled).toBe(0);
    expect(result.staleTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
  });

  it("cancels stale intraday probe orders on a short leash", async () => {
    const sixMinutesAgo = new Date(Date.now() - PROBE_LIKE_INTRADAY_TTL_MS - 60_000).toISOString();
    const order = makeOrder({
      createdAt: sixMinutesAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ horizon: "intraday-4h" }));

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
  });

  it("does not cancel fresh intraday probe orders before the short TTL", async () => {
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    const order = makeOrder({
      createdAt: thirtySecondsAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ horizon: "intraday-4h" }));

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
  });

  it("cancels probe-entry orders on daily horizon after the probe TTL", async () => {
    const sixMinutesAgo = new Date(Date.now() - PROBE_LIKE_DAILY_TTL_MS - 30_000).toISOString();
    const order = makeOrder({
      createdAt: sixMinutesAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(
      makeMarket({
        horizon: "daily",
      }),
    );

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
  });

  it("uses horizon TTL for conviction entries on intraday markets", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: tenMinutesAgo,
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ horizon: "intraday-4h" }));

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
  });

  // ─── Side filtering ────────────────────────────────────────────────

  it("does not cancel open sell orders", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("cancels stale open sell exit orders on the exit TTL", async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: sixMinutesAgo,
      signalReason: "repricing-exit",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleExitTtlCancelled).toBe(1);
    expect(result.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_exit_ttl");
  });

  it("uses mode-aware exit TTL when enforcement is enabled", async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: sixMinutesAgo,
      signalReason: "repricing-exit",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithLifetime({ wouldCancelUnderMode: false });
    await bus.drain();

    expect(result.staleExitTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("keeps mode-aware PASSIVE high exit orders before the 6h TTL", async () => {
    const fiveHoursFiftyNineMinutesAgo = new Date(
      Date.now() - (6 * 60 * 60_000 - 60_000),
    ).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: fiveHoursFiftyNineMinutesAgo,
      signalReason: "repricing-exit",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithLifetime({
      mode: "PASSIVE",
      confidence: "high",
      modeTtlMs: 6 * 60 * 60_000,
      effectiveTtlMs: 6 * 60 * 60_000,
      ageMs: 6 * 60 * 60_000 - 60_000,
      wouldCancelUnderMode: false,
    });
    await bus.drain();

    expect(result.staleExitTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("cancels mode-aware PASSIVE high exit orders after the 6h TTL", async () => {
    const sixHoursOneMinuteAgo = new Date(Date.now() - (6 * 60 * 60_000 + 60_000)).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: sixHoursOneMinuteAgo,
      signalReason: "repricing-exit",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithLifetime({
      mode: "PASSIVE",
      confidence: "high",
      modeTtlMs: 6 * 60 * 60_000,
      effectiveTtlMs: 6 * 60 * 60_000,
      ageMs: 6 * 60 * 60_000 + 60_000,
      wouldCancelUnderMode: true,
      cancelReason: "ttl_exceeded",
    });
    await bus.drain();

    expect(result.staleExitTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_exit_ttl");
  });

  it("restores flat exit TTL when orderLifetime.enabled=false", async () => {
    const sixMinutesAgo = new Date(Date.now() - 6 * 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: sixMinutesAgo,
      signalReason: "repricing-exit",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithLifetime({
      enabled: false,
      wouldCancelUnderMode: false,
    });
    await bus.drain();

    expect(result.staleExitTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_exit_ttl");
  });

  it("does not cancel sell exit orders within the 300s TTL", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: twoMinutesAgo,
      signalReason: "repricing-exit",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleExitTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("does not downprice-reprice a SELL when the best bid is only one tick lower", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.28);
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("downprice-reprices a SELL when the best bid is five ticks lower", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.24);
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("downpriced_reprice");
  });

  it("downprice-reprices a SELL when the best bid is six ticks lower", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23);
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("downpriced_reprice");
  });

  it("falls through to exit TTL after the third downprice reprice attempt", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const stateMap: SellDownpriceRepriceStateMap = new Map([
      [
        String(order.tokenId),
        {
          repriceCount: 3,
          lastBestBid: 0.24,
          pendingOrderId: null,
          pendingSinceMs: null,
          lastWarningAtMs: null,
        },
      ],
    ]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, stateMap);
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(result.staleExitTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_exit_ttl");
  });

  it("resets the downprice reprice counter after a three-tick best-bid recovery", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const stateMap: SellDownpriceRepriceStateMap = new Map([
      [
        String(order.tokenId),
        {
          repriceCount: 3,
          lastBestBid: 0.2,
          pendingOrderId: null,
          pendingSinceMs: null,
          lastWarningAtMs: null,
        },
      ],
    ]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, stateMap);
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(stateMap.get(String(order.tokenId))).toMatchObject({
      repriceCount: 0,
      pendingOrderId: String(order.orderId),
    });
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("downpriced_reprice");
  });

  it("skips downprice reprice when our order is the only visible ask", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      size: 41,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, new Map(), {
      bestAsk: 0.29,
      askDepthExcludingOurs: 0,
    });
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("skips downprice reprice through best-ask size inference when depth excluding ours is absent", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      size: 41,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, new Map(), {
      bestAsk: 0.29,
      bestAskSize: 41,
    });
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("does not treat a partially filled order plus another ask as only ours", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      size: 22.47,
      fillProgressShares: 5,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, new Map(), {
      bestAsk: 0.29,
      bestAskSize: 20.47,
    });
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
  });

  it("sums multiple open bot SELL orders at the same best ask before skipping reprice", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      size: 11,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const sibling = makeOrder({
      orderId: "ord-sibling" as Order["orderId"],
      side: "sell",
      price: 0.29,
      size: 11,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, new Map(), {
      bestAsk: 0.29,
      bestAskSize: 22,
      extraOpenOrders: [sibling],
    });
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("does not skip downprice reprice when another ask remains at our price", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      size: 41,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, new Map(), {
      bestAsk: 0.29,
      askDepthExcludingOurs: 5,
    });
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
  });

  it("keeps the downprice counter pending until the cancel event confirms", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const stateMap: SellDownpriceRepriceStateMap = new Map();

    const result = await runWithDownprice(order, 0.23, stateMap);

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(stateMap.get(String(order.tokenId))).toMatchObject({
      repriceCount: 0,
      pendingOrderId: String(order.orderId),
    });

    recordSellDownpriceCancelSucceeded(stateMap, order.tokenId, order.orderId);

    expect(stateMap.get(String(order.tokenId))).toMatchObject({
      repriceCount: 1,
      pendingOrderId: null,
      pendingSinceMs: null,
    });
  });

  it("does not fire repeated downprice cancels while a token cancel is pending", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const stateMap: SellDownpriceRepriceStateMap = new Map([
      [
        String(order.tokenId),
        {
          repriceCount: 2,
          lastBestBid: 0.23,
          pendingOrderId: String(order.orderId),
          pendingSinceMs: Date.now() - 30_000,
          lastWarningAtMs: null,
        },
      ],
    ]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.22, stateMap);
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("logs a stuck SELL warning for old wide-gap exit orders", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
      signalReason: "repricing-exit",
    });

    const result = await runWithDownprice(order, 0.25);

    expect(result.stuckSellWarnings).toBe(1);
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: String(order.orderId),
        tokenId: String(order.tokenId),
        slug: "test-market",
        orderPrice: order.price,
      }),
      "stuck_sell_detected",
    );
  });

  it("rate-limits stuck SELL warnings to once per token per hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 5 * 60 * 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const stateMap: SellDownpriceRepriceStateMap = new Map();

    const first = await runWithDownprice(order, 0.25, stateMap);
    const second = await runWithDownprice(order, 0.25, stateMap);

    expect(first.stuckSellWarnings).toBe(1);
    expect(second.stuckSellWarnings).toBe(0);
    expect(silentLog.warn).toHaveBeenCalledTimes(1);
  });

  // ─── Signal reason filtering ───────────────────────────────────────

  it("does not cancel buy orders with non-entry signal reason", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "repricing-exit",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("does not cancel buy orders with null signal reason", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: null,
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
  });

  // ─── endDate proximity ─────────────────────────────────────────────

  it("cancels order near market endDate", async () => {
    const thirtyMinFromNow = new Date(Date.now() + 30 * 60_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: oneHourAgo,
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ endDate: thirtyMinFromNow }));

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleEndDateCancelled).toBe(1);
    expect(result.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_enddate");
  });

  it("does not cancel order when endDate is far away", async () => {
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: oneHourAgo,
      signalReason: "scale-in",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ endDate: twoHoursFromNow }));

    const result = await run();

    expect(result.staleEndDateCancelled).toBe(0);
    expect(result.staleTtlCancelled).toBe(0);
  });

  it("does not cancel order when market has no endDate", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: oneHourAgo,
      signalReason: "heavy-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ endDate: null }));

    const result = await run();

    expect(result.staleEndDateCancelled).toBe(0);
  });

  // ─── Anti-churn backoff ────────────────────────────────────────────

  it("does not re-cancel within backoff window", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    // First pass — should cancel
    const r1 = await run();
    expect(r1.staleTtlCancelled).toBe(1);

    // Second pass — within backoff, should skip
    const r2 = await run();
    await bus.drain();

    expect(r2.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(1); // only the first cancel
  });

  it("re-cancels after backoff expires", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    // First pass
    await run();

    // Simulate backoff expiry
    const ordKey = String(order.orderId);
    backoffMap.set(ordKey, Date.now() - CANCEL_BACKOFF_MS - 1);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    // Second pass — backoff expired, should re-cancel
    const r2 = await run();
    await bus.drain();

    expect(r2.staleTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
  });

  // ─── Backoff map eviction ──────────────────────────────────────────

  it("evicts backoff entries for orders no longer open", async () => {
    const ordKey = String(createOrderId("ord-gone"));
    backoffMap.set(ordKey, Date.now());

    // No open orders — the entry should be evicted
    orderRepo.findOpen = vi.fn().mockReturnValue([]);

    await run();

    expect(backoffMap.has(ordKey)).toBe(false);
  });

  // ─── TTL takes priority over endDate ───────────────────────────────

  it("TTL cancel short-circuits before endDate check", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const thirtyMinFromNow = new Date(Date.now() + 30 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ endDate: thirtyMinFromNow }));

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    // Should be counted as TTL, not endDate
    expect(result.staleTtlCancelled).toBe(1);
    expect(result.staleEndDateCancelled).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
  });

  // ─── Multiple entry reasons ────────────────────────────────────────

  it("handles all entry signal reasons", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const reasons = ["probe-entry", "confirm-scale", "scale-in", "heavy-scale"];
    const orders = reasons.map((r, i) =>
      makeOrder({
        orderId: createOrderId(`ord-${i}`),
        createdAt: sevenHoursAgo,
        signalReason: r,
      }),
    );
    orderRepo.findOpen = vi.fn().mockReturnValue(orders);

    const result = await run();

    expect(result.staleTtlCancelled).toBe(reasons.length);
  });
});
