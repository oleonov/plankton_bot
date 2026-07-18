import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_REPRICE_CHAIN_POLICY,
  GATE_ENTRY_RULE_ID,
  createTokenId,
  createOrderId,
  createConditionId,
} from "@krabs/domain";
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
  CONFIRM_SCALE_TTL_MS,
  EXIT_ORDER_TTL_MS,
  PROBE_LIKE_AD_HOC_TTL_MS,
  PROBE_LIKE_DAILY_TTL_MS,
  PROBE_LIKE_INTRADAY_TTL_MS,
  SCALE_IN_DEFAULT_TTL_MS,
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
      | "bestBid"
      | "bestAsk"
      | "bestAskSize"
      | "askDepthExcludingOurs"
      | "tickSize"
      | "publicTradeCount24h"
    >
  >,
) {
  return {
    bestBid: 0.32,
    bestAsk: null,
    bestAskSize: null,
    askDepthExcludingOurs: null,
    tickSize: 0.01,
    publicTradeCount24h: null,
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

  it("uses a 4 hour default exit order TTL", () => {
    expect(EXIT_ORDER_TTL_MS).toBe(4 * 60 * 60_000);
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
      publicTradeCount24h?: number | null;
      repriceChainEvents24h?: number;
      tickSize?: number;
      metrics?: { writeCounter: ReturnType<typeof vi.fn> };
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
        ...(opts.metrics ? { metrics: opts.metrics } : {}),
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
              tickSize: opts.tickSize ?? 0.01,
              publicTradeCount24h: opts.publicTradeCount24h ?? null,
            }),
        },
        ...(opts.repriceChainEvents24h != null
          ? {
              repriceChainGate: {
                policy: () => DEFAULT_REPRICE_CHAIN_POLICY,
                legStateRepo: {
                  get: () => {
                    const now = Date.now();
                    const timestamps = Array.from(
                      { length: opts.repriceChainEvents24h ?? 0 },
                      (_, index) => new Date(now - index * 60_000).toISOString(),
                    );
                    return {
                      tokenId: TOK,
                      repriceChainEvents24hJson: JSON.stringify(timestamps),
                      repriceChainCount24h: timestamps.length,
                      repriceChainWindowStartTs: timestamps.at(-1) ?? null,
                    } as any;
                  },
                },
                metrics: opts.metrics,
              },
            }
          : {}),
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

  it("does NOT cancel a GATE entry order within its 12h cap (adaptive TTL, not probe 10-min)", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: oneHourAgo,
      signalReason: "probe-entry",
      decisionRuleId: GATE_ENTRY_RULE_ID,
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

  it("cancels a GATE entry order once older than the 12h cap", async () => {
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: thirteenHoursAgo,
      signalReason: "probe-entry",
      decisionRuleId: GATE_ENTRY_RULE_ID,
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
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

  it("uses an explicit 10 minute cap for probe-entry orders without a market horizon", async () => {
    const order = makeOrder({
      createdAt: new Date(Date.now() - PROBE_LIKE_AD_HOC_TTL_MS - 1_000).toISOString(),
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(null);

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

  it("keeps probe-entry orders before the explicit 10 minute cap", async () => {
    const order = makeOrder({
      createdAt: new Date(Date.now() - PROBE_LIKE_AD_HOC_TTL_MS + 1_000).toISOString(),
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(null);

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
  });

  it("caps confirm-scale BUY TTL at three hours", async () => {
    const order = makeOrder({
      createdAt: new Date(Date.now() - CONFIRM_SCALE_TTL_MS - 1_000).toISOString(),
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

  it("keeps confirm-scale BUY orders before the three hour cap", async () => {
    const order = makeOrder({
      createdAt: new Date(Date.now() - CONFIRM_SCALE_TTL_MS + 1_000).toISOString(),
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
  });

  it("uses the conservative three hour cap for scale-in BUY orders", async () => {
    const order = makeOrder({
      createdAt: new Date(Date.now() - SCALE_IN_DEFAULT_TTL_MS - 1_000).toISOString(),
      signalReason: "scale-in",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const result = await run();

    expect(result.staleTtlCancelled).toBe(1);
  });

  it("keeps scale-in BUY orders before the conservative three hour cap", async () => {
    const order = makeOrder({
      createdAt: new Date(Date.now() - SCALE_IN_DEFAULT_TTL_MS + 1_000).toISOString(),
      signalReason: "scale-in",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
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
    const afterExitTtl = new Date(Date.now() - EXIT_ORDER_TTL_MS - 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: afterExitTtl,
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
    const afterExitTtl = new Date(Date.now() - EXIT_ORDER_TTL_MS - 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: afterExitTtl,
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

  it("does not cancel sell exit orders within the 4h TTL", async () => {
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

  it("uses the thin-market extended exit TTL before stale_exit_ttl cancellation", async () => {
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: fiveHoursAgo,
      signalReason: "repricing-exit",
    });
    const metrics = { writeCounter: vi.fn() };
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket());

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
        exitOrderTtlMs: DEFAULT_EXECUTION_POLICY.exitOrderTtlMs,
        exitTtlByLiquidity: DEFAULT_EXECUTION_POLICY.exitTtlByLiquidity,
        metrics,
        exitRepriceOnDownprice: {
          policy: () => ({
            enabled: false,
            thresholdTicks: 5,
            maxRepricesPerOrder: 3,
            stuckWarningEnabled: false,
            stuckWarningAgeMs: 4 * 60 * 60_000,
            stuckWarningGapPct: 0.1,
          }),
          getMarket: () => makePricing({ bestBid: order.price, publicTradeCount24h: 4 }),
        },
      },
      backoffMap,
    );
    await bus.drain();

    expect(result.staleExitTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "exit_ttl_resolved_total",
      1,
      JSON.stringify({ tier: "thin" }),
    );
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

  it("downprice-reprices a SELL when the predicted replacement improves by one tick", async () => {
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

  it("excludes S1_LADDER SELL orders at scan level while processing non-S1 exits normally", async () => {
    const s1Order = makeOrder({
      orderId: createOrderId("ord-s1"),
      clientOrderId: "s1-client" as ClientOrderId,
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
      decisionRuleId: "S1_LADDER",
    });
    const normalOrder = makeOrder({
      orderId: createOrderId("ord-normal"),
      clientOrderId: "normal-client" as ClientOrderId,
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
      decisionRuleId: "D8_PROFIT_RATIO",
    });

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(s1Order, 0.23, new Map(), {
      extraOpenOrders: [normalOrder],
    });
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.orderId).toBe(normalOrder.orderId);
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

  it("blocks no-op downprice reprice when midpoint-anchored replacement equals current price", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.022,
      size: 67.621,
      sizeUsdc: 1.487662,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const metrics = { writeCounter: vi.fn() };

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.015, new Map(), {
      bestAsk: 0.019,
      tickSize: 0.001,
      publicTradeCount24h: 7,
      repriceChainEvents24h: 0,
      metrics,
    });
    await bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(result.repriceChainCapBlocked).toBe(0);
    expect(cancelled).toHaveLength(0);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "track_l_noop_guard_total",
      1,
      JSON.stringify({ mode: "midpoint-anchored" }),
    );
    expect(metrics.writeCounter).not.toHaveBeenCalledWith(
      "exit_chain_cap_resolved_total",
      expect.any(Number),
      expect.any(String),
    );
  });

  it("uses the dynamic thin-market cap for downpriced reprice gating", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const metrics = { writeCounter: vi.fn() };

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, new Map(), {
      publicTradeCount24h: 4,
      repriceChainEvents24h: 13,
      metrics,
    });
    await bus.drain();

    expect(result.repriceChainCapBlocked).toBe(0);
    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "exit_chain_cap_resolved_total",
      1,
      JSON.stringify({ bucket: "50", source: "downpriced_reprice" }),
    );
  });

  it("uses the dynamic liquid-market cap for downpriced reprice gating", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      signalReason: "repricing-exit",
    });
    const metrics = { writeCounter: vi.fn() };

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await runWithDownprice(order, 0.23, new Map(), {
      publicTradeCount24h: 100,
      repriceChainEvents24h: 13,
      metrics,
    });
    await bus.drain();

    expect(result.repriceChainCapBlocked).toBe(1);
    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "exit_chain_cap_resolved_total",
      1,
      JSON.stringify({ bucket: "13", source: "downpriced_reprice" }),
    );
  });

  it("falls through to exit TTL after the third downprice reprice attempt", async () => {
    const order = makeOrder({
      side: "sell",
      price: 0.29,
      createdAt: new Date(Date.now() - EXIT_ORDER_TTL_MS - 60_000).toISOString(),
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

    const result = await runWithDownprice(order, 0.15, new Map(), {
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

    const result = await runWithDownprice(order, 0.17, new Map(), {
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
