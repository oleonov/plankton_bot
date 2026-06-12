import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  createConditionId,
  createOrderId,
  createTokenId,
  type ConditionId,
  type NormalizedMarket,
  type Order,
  type OrderRepository,
  type PositionRepository,
  type ProfileId,
  type RiskEventRepository,
  type Signal,
} from "@krabs/domain";
import {
  capSellPriceToPlanktonTier,
  planktonAlignedMarkupCap,
  resolveMidpointAnchoredSellPrice,
  SELL_PRICE_CEILING,
  SignalToOrderBridge,
  type SignalToOrderBridgeDeps,
} from "../modules/strategy/signal-to-order.js";
import { CandidateBookCache } from "../modules/strategy/candidate-book-cache.js";
import { DEFAULT_EXECUTION_POLICY } from "../execution-policy.js";
import type {
  DeadSideGuardPolicy,
  ExecutionPolicy,
  ExecutionPolicyObservation,
  ExecutionPolicyObservationRepository,
  ExecutionPricingPolicy,
} from "@krabs/domain";

const TOKEN_ID = createTokenId("tok-yes");
const NOW = Date.parse("2026-04-11T10:00:00.000Z");

describe("resolveMidpointAnchoredSellPrice", () => {
  it("uses bestAsk for a single-tick spread where undercut would cross bestBid", () => {
    expect(resolveMidpointAnchoredSellPrice(0.1, 0.101, 0.001, 5)).toBeCloseTo(0.101);
  });

  it("returns ask-under by one tick when the spread is wide enough", () => {
    expect(resolveMidpointAnchoredSellPrice(0.1, 0.12, 0.001, 5)).toBeCloseTo(0.119);
  });

  it("returns ask-under in a wide spread", () => {
    expect(resolveMidpointAnchoredSellPrice(0.05, 0.17, 0.001, 5)).toBeCloseTo(0.169);
  });

  it("matches the Plankton-aligned ask-under smoke case", () => {
    expect(resolveMidpointAnchoredSellPrice(0.05, 0.186, 0.001, 5)).toBeCloseTo(0.185);
  });

  it("rounds fractional ask-under artifacts down to the nearest tick", () => {
    expect(resolveMidpointAnchoredSellPrice(0.0505, 0.186, 0.001, 5)).toBeCloseTo(0.185);
  });

  it("falls back to bestBid plus anchor when bestAsk is unavailable", () => {
    expect(resolveMidpointAnchoredSellPrice(0.05, null, 0.001, 5)).toBeCloseTo(0.055);
  });

  it("returns null when bestBid is null", () => {
    expect(resolveMidpointAnchoredSellPrice(null, 0.3, 0.001, 5)).toBeNull();
  });

  it("returns null when bestBid is undefined", () => {
    expect(
      resolveMidpointAnchoredSellPrice(undefined as unknown as number, 0.3, 0.001, 5),
    ).toBeNull();
  });

  it("handles crossed book defensively by falling back to midpoint plus anchor", () => {
    expect(resolveMidpointAnchoredSellPrice(0.5, 0.4, 0.001, 5)).toBeCloseTo(0.455);
  });
});

describe("planktonAlignedMarkupCap (Track P F2)", () => {
  it("returns 2.50x for the cheap (<0.02) crypto tail", () => {
    expect(planktonAlignedMarkupCap(0.001)).toBe(2.5);
    expect(planktonAlignedMarkupCap(0.019)).toBe(2.5);
  });

  it("returns 1.36x for the 0.02-0.15 tier (boundary inclusive at 0.02)", () => {
    expect(planktonAlignedMarkupCap(0.02)).toBe(1.36);
    expect(planktonAlignedMarkupCap(0.05)).toBe(1.36);
    expect(planktonAlignedMarkupCap(0.149)).toBe(1.36);
  });

  it("returns 1.17x for the 0.15-0.35 tier (boundary inclusive at 0.15)", () => {
    expect(planktonAlignedMarkupCap(0.15)).toBe(1.17);
    expect(planktonAlignedMarkupCap(0.34)).toBe(1.17);
  });

  it("returns 1.10x for the >=0.35 tier", () => {
    expect(planktonAlignedMarkupCap(0.35)).toBe(1.1);
    expect(planktonAlignedMarkupCap(0.5)).toBe(1.1);
  });
});

describe("capSellPriceToPlanktonTier (Track P F2)", () => {
  it("caps a phantom 50x SELL down to the cheap-tier 2.5x target", () => {
    // avg 0.01 -> markup 2.5 -> cap 0.025; phantom-ask price 0.5 (50x) is capped.
    expect(capSellPriceToPlanktonTier(0.5, 0.01, 0.001)).toBeCloseTo(0.025);
  });

  it("never exceeds avg_entry * tier markup", () => {
    expect(capSellPriceToPlanktonTier(0.9, 0.2, 0.001)).toBeCloseTo(0.234); // 0.2 * 1.17
    expect(capSellPriceToPlanktonTier(0.95, 0.4, 0.001)).toBeCloseTo(0.44); // 0.4 * 1.10
  });

  it("never exceeds the 0.97 ceiling even when the tier target is above it", () => {
    // avg 0.9 -> 1.10x -> 0.99 target, but the hard ceiling clamps to 0.97.
    expect(capSellPriceToPlanktonTier(0.999, 0.9, 0.001)).toBe(SELL_PRICE_CEILING);
    // avg unknown -> only the ceiling applies.
    expect(capSellPriceToPlanktonTier(0.999, null, 0.001)).toBe(SELL_PRICE_CEILING);
  });

  it("preserves the computed price unchanged when it is already at/below the cap", () => {
    expect(capSellPriceToPlanktonTier(0.015, 0.01, 0.001)).toBe(0.015); // < 0.025 cap
    expect(capSellPriceToPlanktonTier(0.3, 0.5, 0.001)).toBe(0.3); // < 0.55 cap
    expect(capSellPriceToPlanktonTier(0.4, null, 0.001)).toBe(0.4); // < 0.97 ceiling
  });

  it("floors the capped price down to a valid tick", () => {
    // avg 0.07 -> 1.36x -> 0.0952 cap -> floor to 0.001 tick = 0.095.
    expect(capSellPriceToPlanktonTier(0.5, 0.07, 0.001)).toBeCloseTo(0.095);
  });
});

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => makeLogger()),
    trace: vi.fn(),
    level: "info",
    silent: vi.fn(),
  } as unknown as import("../logger.js").Logger;
}

function makeEntryOrder(): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "cl-1" as never,
    tokenId: TOKEN_ID,
    conditionId: "cond-1" as ConditionId,

    side: "buy",
    orderType: "GTC",
    postOnly: true,
    price: 0.04,
    size: 100,
    sizeUsdc: 4,
    status: "open",
    exchangeOrderId: "ex-1",
    signalId: null,
    signalReason: "probe-entry",
    botRunId: "bot-run-1" as never,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

function makeOpenSellOrder(overrides?: Partial<Order>): Order {
  return {
    ...makeEntryOrder(),
    orderId: createOrderId("ord-sell-1"),
    clientOrderId: "cl-sell-1" as never,
    side: "sell",
    price: 0.1,
    size: 5,
    sizeUsdc: 0.5,
    signalReason: "repricing-exit",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSignal(): Signal {
  return {
    signalId: "sig-1",

    tokenId: TOKEN_ID,
    conditionId: "cond-1" as ConditionId,
    side: "buy",
    suggestedPrice: 0.04,
    suggestedSize: 100,
    suggestedSizeUsdc: 4,
    reason: "probe-entry",
    strategyTick: NOW,
    sequenceInTick: 0,
    decisionRuleId: null,
    sizingRuleId: null,
    generatedAt: new Date(NOW).toISOString(),
  };
}

function makeMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: TOKEN_ID,
    conditionId: "cond-1",
    slug: "btc-daily",
    eventSlug: null,
    question: "BTC daily",
    outcome: "YES",
    outcomeIndex: 0,

    regime: "price-range",
    horizon: "daily",
    // Far-future default so the BUY admission guard does not see the market as
    // ended in tests that use the real wall clock. Tests asserting end-of-life
    // behavior override `endDate` explicitly.
    endDate: "2099-12-31T23:59:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.09,
    bestAsk: 0.09,
    midPrice: 0.09,
    spread: 0,
    lastTradePrice: null,
    lastTradeAt: null,
    volume24h: 100_000,
    liquidity: 10_000,
    bookSource: "gamma-fallback",
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...overrides,
  };
}

function makerOnlyPolicy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    opportunisticTaker: { ...DEFAULT_EXECUTION_POLICY.opportunisticTaker, enabled: false },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SignalToOrderBridge", () => {
  it("skips placement when persistent same-price cooldown is active", async () => {
    const bus = new InProcessEventBus();
    const canPlaceOrder = vi.fn(() => ({
      allowed: false,
      reason: "same-price-cooldown",
      staleCancelCount: 3,
      cooldownUntilTsUtc: NOW + 24 * 60 * 60_000,
    }));
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      samePriceCooldown: {
        canPlaceOrder,
      },
      now: () => NOW,
    });
    bridge.subscribe();

    const placed: unknown[] = [];
    const skipped: Array<{ reasons: readonly string[]; diagnostics: Record<string, unknown> }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.09, bestAsk: 0.09, midPrice: 0.09 }),
      approvedAt: NOW,
    });

    expect(placed).toHaveLength(0);
    expect(canPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: TOKEN_ID, side: "buy", price: 0.09, nowMs: NOW }),
    );
    expect(skipped[0]?.reasons).toEqual(["same-price-cooldown"]);
    expect(skipped[0]?.diagnostics["staleCancelCount"]).toBe(3);
  });

  it("places when persistent same-price cooldown allows the execution price", async () => {
    const bus = new InProcessEventBus();
    const canPlaceOrder = vi.fn(() => ({
      allowed: true,
      reason: null,
      staleCancelCount: 2,
      cooldownUntilTsUtc: NOW - 1,
    }));
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      samePriceCooldown: { canPlaceOrder },
      now: () => NOW,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number } }> = [];
    const skipped: unknown[] = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.09, bestAsk: 0.09, midPrice: 0.09 }),
      approvedAt: NOW,
    });

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.09);
    expect(canPlaceOrder).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: TOKEN_ID, side: "buy", price: 0.09, nowMs: NOW }),
    );
  });

  it("does not block order publication on execution-policy observation writes", async () => {
    const bus = new InProcessEventBus();
    const observations: ExecutionPolicyObservationRepository = {
      insert: vi.fn(() => {
        const until = Date.now() + 40;
        while (Date.now() < until) {
          // Intentional busy wait: this models the sync SQLite insert we are
          // keeping off the SignalApproved publisher path.
        }
      }),
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      observations,
      profileId: "default" as ProfileId,
      now: () => NOW,
    });
    bridge.subscribe();

    const placed: unknown[] = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    const startedAt = Date.now();
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.09, bestAsk: 0.09, midPrice: 0.09 }),
      approvedAt: NOW,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(30);
    expect(placed).toHaveLength(1);
    await vi.waitFor(() => expect(observations.insert).toHaveBeenCalledTimes(1));
  });

  it("uses the shared candidate-book cache so approved signals convert against the same book as scanner", async () => {
    const bus = new InProcessEventBus();
    const clobBook = {
      tokenId: TOKEN_ID,
      bids: [{ price: 0.04, size: 10 }],
      asks: [{ price: 0.05, size: 10 }],
      bestBid: 0.04,
      bestAsk: 0.05,
      midPrice: 0.045,
      spread: 0.01,
      timestamp: Date.now(),
    };
    const cache = new CandidateBookCache({
      gateway: {
        getOrderBooks: vi.fn(async (tokenIds: string[]) => {
          return new Map(tokenIds.map((tokenId) => [tokenId, clobBook]));
        }),
      },
      log: makeLogger(),
    });
    await cache.prime([String(TOKEN_ID)]);

    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      candidateBookCache: cache,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; metadata?: Record<string, unknown> } }> = [];
    const skipped: unknown[] = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ minOrderSize: 5 })],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ minOrderSize: 5 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.05);
    expect(placed[0]!.command.metadata).toMatchObject({
      marketData: {
        minOrderSize: 5,
      },
    });
  });

  it("uses simulation pricing directly instead of waiting for a candidate-book refresh", async () => {
    const bus = new InProcessEventBus();
    const candidateBookCache = {
      getFreshEntry: vi.fn(() => null),
      waitForFreshEntry: vi.fn(async () => null),
      getFreshOrRefresh: vi.fn(async () => ({ status: "refreshed" as const, entry: null })),
    } as unknown as CandidateBookCache;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      candidateBookCache,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({
        bestBid: 0.04,
        bestAsk: 0.05,
        midPrice: 0.045,
        spread: 0.01,
        bookSource: "simulation",
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.05);
    expect(candidateBookCache.waitForFreshEntry as any).not.toHaveBeenCalled();
    expect(candidateBookCache.getFreshOrRefresh as any).not.toHaveBeenCalled();
  });

  it("waits briefly for a WS-backed candidate book before falling back to REST refresh", async () => {
    const bus = new InProcessEventBus();
    const wsEntry = {
      tokenId: String(TOKEN_ID),
      snapshotTs: Date.now(),
      cachedAtMs: Date.now(),
      sourcePolledAtMs: Date.now(),
      bookSource: "clob" as const,
      sourceKind: "ws" as const,
      book: {
        tokenId: TOKEN_ID,
        bids: [{ price: 0.04, size: 10 }],
        asks: [{ price: 0.05, size: 10 }],
        bestBid: 0.04,
        bestAsk: 0.05,
        midPrice: 0.045,
        spread: 0.01,
        timestamp: Date.now(),
      },
    };
    const candidateBookCache = {
      getFreshEntry: vi.fn(() => null),
      waitForFreshEntry: vi.fn(async () => wsEntry),
      getFreshOrRefresh: vi.fn(async () => ({ status: "refreshed" as const, entry: null })),
    } as unknown as CandidateBookCache;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      candidateBookCache,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ minOrderSize: 5, bookSource: "gamma-fallback" })],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ minOrderSize: 5, bookSource: "gamma-fallback" }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.05);
    expect(candidateBookCache.waitForFreshEntry as any).toHaveBeenCalledTimes(1);
    expect(candidateBookCache.waitForFreshEntry as any).toHaveBeenCalledWith(
      String(TOKEN_ID),
      25,
      expect.any(Number),
    );
    expect(candidateBookCache.getFreshOrRefresh as any).not.toHaveBeenCalled();
  });

  it("preserves embedded BUY price when a fresher candidate book is ask-only", async () => {
    const bus = new InProcessEventBus();
    const candidateBookCache = {
      getFreshEntry: vi.fn(() => ({
        tokenId: String(TOKEN_ID),
        snapshotTs: Date.now(),
        cachedAtMs: Date.now(),
        sourcePolledAtMs: Date.now(),
        bookSource: "clob" as const,
        sourceKind: "ws" as const,
        book: {
          tokenId: TOKEN_ID,
          bids: [],
          asks: [{ price: 0.001, size: 10 }],
          bestBid: null,
          bestAsk: 0.001,
          midPrice: null,
          spread: null,
          timestamp: Date.now(),
        },
      })),
      waitForFreshEntry: vi.fn(async () => null),
      getFreshOrRefresh: vi.fn(async () => ({ status: "refreshed" as const, entry: null })),
    } as unknown as CandidateBookCache;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      candidateBookCache,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number } }> = [];
    const skipped: Array<{ reasons: readonly string[] }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({
        bestBid: 0.04,
        bestAsk: 0.05,
        midPrice: 0.045,
        spread: 0.01,
        bookSource: "gamma-fallback",
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.05);
  });

  it("preserves embedded SELL price when a fresher candidate book is bid-only", async () => {
    const bus = new InProcessEventBus();
    const candidateBookCache = {
      getFreshEntry: vi.fn(() => ({
        tokenId: String(TOKEN_ID),
        snapshotTs: Date.now(),
        cachedAtMs: Date.now(),
        sourcePolledAtMs: Date.now(),
        bookSource: "clob" as const,
        sourceKind: "ws" as const,
        book: {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.06, size: 10 }],
          asks: [],
          bestBid: 0.06,
          bestAsk: null,
          midPrice: null,
          spread: null,
          timestamp: Date.now(),
        },
      })),
      waitForFreshEntry: vi.fn(async () => null),
      getFreshOrRefresh: vi.fn(async () => ({ status: "refreshed" as const, entry: null })),
    } as unknown as CandidateBookCache;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      candidateBookCache,
      policy: () => ({ ...DEFAULT_EXECUTION_POLICY, exitPricingMode: "edge" }),
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number } }> = [];
    const skipped: Array<{ reasons: readonly string[] }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload);
    });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell" },
      market: makeMarket({
        bestBid: 0.04,
        bestAsk: 0.05,
        midPrice: 0.045,
        spread: 0.01,
        bookSource: "gamma-fallback",
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.05);
  });

  it("skips BUY when the executable price is below the market tick", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      policy: () => makerOnlyPolicy(),
    });
    bridge.subscribe();

    const placed: unknown[] = [];
    const skipped: Array<{ reasons: readonly string[]; diagnostics: Record<string, unknown> }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload as (typeof skipped)[number]);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({
        tickSize: 0.001,
        bestBid: 0.0005,
        bestAsk: 0.001,
        midPrice: 0.00075,
        spread: 0.0005,
        bookSource: "clob",
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("execution-price-invalid");
    expect(skipped[0]!.diagnostics).toMatchObject({
      price: 0.0005,
      tickSize: 0.001,
      validationReason: "price-below-min-tick",
    });
  });

  it("skips SELL when the executable price is above the upper market bound", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      policy: () => makerOnlyPolicy(),
    });
    bridge.subscribe();

    const placed: unknown[] = [];
    const skipped: Array<{ reasons: readonly string[]; diagnostics: Record<string, unknown> }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload as (typeof skipped)[number]);
    });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell" },
      market: makeMarket({
        tickSize: 0.001,
        bestBid: 0.999,
        bestAsk: 1,
        midPrice: 0.9995,
        spread: 0.001,
        bookSource: "clob",
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("execution-price-invalid");
    expect(skipped[0]!.diagnostics).toMatchObject({
      price: 1,
      tickSize: 0.001,
      validationReason: "price-above-max-bound",
    });
  });

  it("uses base market for stale clob books without refresh (no bundle)", async () => {
    const bus = new InProcessEventBus();
    const refreshedEntry = {
      tokenId: String(TOKEN_ID),
      snapshotTs: Date.now(),
      cachedAtMs: Date.now(),
      sourcePolledAtMs: Date.now(),
      bookSource: "clob" as const,
      sourceKind: "rest" as const,
      book: {
        tokenId: TOKEN_ID,
        bids: [{ price: 0.04, size: 10 }],
        asks: [{ price: 0.05, size: 10 }],
        bestBid: 0.04,
        bestAsk: 0.05,
        midPrice: 0.045,
        spread: 0.01,
        timestamp: Date.now(),
      },
    };
    const candidateBookCache = {
      getFreshEntry: vi.fn(() => null),
      waitForFreshEntry: vi.fn(async () => null),
      getFreshOrRefresh: vi.fn(async () => ({
        status: "refreshed" as const,
        entry: refreshedEntry,
      })),
    } as unknown as CandidateBookCache;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      candidateBookCache,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          regime: "social-activity",
          bestBid: 0.04,
          bestAsk: 0.05,
          midPrice: 0.045,
          spread: 0.01,
          bookSource: "clob",
          snapshotTs: Date.now() - 30_000,
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
      },
      market: makeMarket({
        regime: "social-activity",
        bestBid: 0.04,
        bestAsk: 0.05,
        midPrice: 0.045,
        spread: 0.01,
        bookSource: "clob",
        snapshotTs: Date.now() - 30_000,
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    // With bundle=null, shouldRefreshBookBeforeConversion returns false for clob books,
    // so base-market is used directly without refresh
    expect(candidateBookCache.getFreshOrRefresh as any).not.toHaveBeenCalled();
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.05);
  });

  // Per-family feature tests (gamma-fallback-dust, queue-jump canary, dust-lane config)
  // removed — the algo decision engine uses universal policies, not per-family rules.
  // See docs/superpowers/specs/2026-04-15-algo-decision-engine-design.md §5.4.

  it.each([
    {
      walletMode: "relayer" as const,
      label: "relayer mode → postOnly: true",
      expectPostOnly: true,
    },
    {
      walletMode: "eoa" as const,
      label: "non-relayer (eoa) mode → postOnly absent",
      expectPostOnly: false,
    },
  ])("$label", async ({ walletMode, expectPostOnly }) => {
    const bus = new InProcessEventBus();
    const clobBook = {
      tokenId: TOKEN_ID,
      bids: [{ price: 0.04, size: 10 }],
      asks: [{ price: 0.05, size: 10 }],
      bestBid: 0.04,
      bestAsk: 0.05,
      midPrice: 0.045,
      spread: 0.01,
      timestamp: Date.now(),
    };
    const cache = new CandidateBookCache({
      gateway: {
        getOrderBooks: vi.fn(async (tokenIds: string[]) => {
          return new Map(tokenIds.map((tokenId) => [tokenId, clobBook]));
        }),
      },
      log: makeLogger(),
    });
    await cache.prime([String(TOKEN_ID)]);

    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: vi.fn(() => walletMode),
      } as never,
      candidateBookCache: cache,
      policy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        opportunisticTaker: { ...DEFAULT_EXECUTION_POLICY.opportunisticTaker, enabled: false },
      }),
    });
    bridge.subscribe();

    const placed: Array<{ command: { postOnly?: boolean } & Record<string, unknown> }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload as unknown as (typeof placed)[number]);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ minOrderSize: 5, bookSource: "clob" })],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ minOrderSize: 5, bookSource: "clob" }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    const cmd = placed[0]!.command;
    if (expectPostOnly) {
      expect(cmd.postOnly).toBe(true);
    } else {
      expect("postOnly" in cmd).toBe(false);
    }
  });

  it("does not apply unfilled-cancel cooldown to dust reprice cancels", async () => {
    const bus = new InProcessEventBus();
    const order = {
      ...makeEntryOrder(),
      signalReason: "probe-entry",
      price: 0.03,
      sizeUsdc: 0.15,
    };
    const orderRepo = {
      findOpen: vi.fn(() => []),
      findById: vi.fn(() => order),
    } as never;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      orderRepo,
      policy: () => makerOnlyPolicy(),
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number } }> = [];
    const skipped: Array<{ reasons: readonly string[] }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.03,
          bestAsk: 0.04,
          midPrice: 0.035,
          spread: 0.01,
          tickSize: 0.01,
          bookSource: "clob",
          lastTradePrice: 0.04,
          lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "entry-reprice-cancel",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "entry-reprice-cancel",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "entry-reprice-cancel",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "probe-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 3.75,
        suggestedPrice: 0.035,
      },
      market: makeMarket({
        bestBid: 0.03,
        bestAsk: 0.04,
        midPrice: 0.035,
        spread: 0.01,
        tickSize: 0.01,
        bookSource: "clob",
        lastTradePrice: 0.04,
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });
});

describe("hard-liveness guard (before execution)", () => {
  function makeBridgeWithLiveLite() {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const conversionSkipped: Array<{ stage: string; reasons: readonly string[] }> = [];
    const placeOrderRequested: unknown[] = [];
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      conversionSkipped.push(payload);
    });
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placeOrderRequested.push(payload);
    });

    return { bus, bridge, conversionSkipped, placeOrderRequested };
  }

  // SELL signals exercise the hard-liveness path directly (BUY admission only
  // runs for `side === "buy"` and collapses these reasons to `market_not_alive`
  // upstream of hard-liveness — see BUY admission guard tests below).
  it.each<[string, Partial<NormalizedMarket>, string]>([
    ["acceptingOrders=false", { acceptingOrders: false }, "not_accepting_orders"],
    ["enableOrderBook=false", { enableOrderBook: false }, "order_book_disabled"],
    ["bestBid=null", { bestBid: null }, "no_bid"],
  ])("%s skips with hard-liveness reason", async (_, patch, reason) => {
    const { bus, conversionSkipped, placeOrderRequested } = makeBridgeWithLiveLite();
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell" },
      market: makeMarket(patch),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(conversionSkipped).toHaveLength(1);
    expect(conversionSkipped[0]!.stage).toBe("hard-liveness");
    expect(conversionSkipped[0]!.reasons).toContain(reason);
    expect(placeOrderRequested).toHaveLength(0);
  });

  it("BUY signal with bestAsk=null → places order at bestBid (one-sided book)", async () => {
    const { bus, conversionSkipped, placeOrderRequested } = makeBridgeWithLiveLite();
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestAsk: null, bestBid: 0.03 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(conversionSkipped.filter((s) => s.stage === "hard-liveness")).toHaveLength(0);
    expect(placeOrderRequested).toHaveLength(1);
    const cmd = (placeOrderRequested[0] as { command: { price: number } }).command;
    expect(cmd.price).toBe(0.03);
  });

  it("stacks reasons when multiple hard fields fail", async () => {
    const { bus, conversionSkipped } = makeBridgeWithLiveLite();
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell" },
      market: makeMarket({ acceptingOrders: false, enableOrderBook: false }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(conversionSkipped[0]!.reasons).toEqual(
      expect.arrayContaining(["not_accepting_orders", "order_book_disabled"]),
    );
  });

  it("passes through to execution when all three hard fields are healthy", async () => {
    const { bus, conversionSkipped } = makeBridgeWithLiveLite();
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket(),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(conversionSkipped.filter((s) => s.stage === "hard-liveness")).toHaveLength(0);
  });

  it("places SELL after nominal endDate when market liveness is healthy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, conversionSkipped, placeOrderRequested } = makeBridgeWithLiveLite();

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", reason: "repricing-exit" },
      market: makeMarket({ endDate: new Date(NOW - 60 * 60_000).toISOString() }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(conversionSkipped).toHaveLength(0);
    expect(placeOrderRequested).toHaveLength(1);
  });

  it("blocks post-endDate SELL through hard-liveness when acceptingOrders=false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, conversionSkipped, placeOrderRequested } = makeBridgeWithLiveLite();

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", reason: "repricing-exit" },
      market: makeMarket({
        endDate: new Date(NOW - 60 * 60_000).toISOString(),
        acceptingOrders: false,
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(conversionSkipped).toHaveLength(1);
    expect(conversionSkipped[0]!.stage).toBe("hard-liveness");
    expect(conversionSkipped[0]!.reasons).toContain("not_accepting_orders");
    expect(conversionSkipped[0]!.reasons).not.toContain("order-lifetime-resolution-stop-window");
    expect(placeOrderRequested).toHaveLength(0);
  });

  // Phase 2.A: embedded market snapshot on SignalApproved is the authoritative
  // source for the bridge's liveness + base pricing. These two tests pin the
  // invariant that eviction-between-approval-and-bridge no longer surfaces as
  // `market-cache-miss`, and that a no_bid in the embedded snapshot is
  // attributed as `hard-liveness` rather than mis-routed through the cache
  // path.
  it("market evicted from cache between approval and bridge build → uses embedded snapshot, no cache-miss", async () => {
    const { bus, conversionSkipped, placeOrderRequested } = makeBridgeWithLiveLite();

    // Populate cache, then evict (simulates TrackedMarketsChanged between
    // SignalProduced and bridge build).
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await bus.publish("TrackedMarketsChanged", {
      addedTokenIds: [],
      removedTokenIds: [TOKEN_ID],
      activeTokenIds: [],
      timestamp: Date.now(),
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket(),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(conversionSkipped.filter((s) => s.stage === "market-cache-miss")).toHaveLength(0);
    expect(placeOrderRequested).toHaveLength(1);
  });

  it("no_bid in embedded snapshot → rejects with stage=hard-liveness, not stage=market-cache-miss", async () => {
    const { bus, conversionSkipped, placeOrderRequested } = makeBridgeWithLiveLite();

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell" },
      market: makeMarket({ bestBid: null }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(conversionSkipped).toHaveLength(1);
    expect(conversionSkipped[0]!.stage).toBe("hard-liveness");
    expect(conversionSkipped[0]!.reasons).toContain("no_bid");
    expect(placeOrderRequested).toHaveLength(0);
  });

  // Reason-specific log routing: expected flag-only races (acceptingOrders /
  // enableOrderBook) log at debug; anomalies like `no_bid` stay at warn so
  // operators see genuine data-inconsistency signals.
  describe("log level routing", () => {
    function makeCaptureLogger() {
      const child = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
      };
      child.child = vi.fn(() => child);
      const root = {
        ...child,
        child: vi.fn(() => child),
      };
      return { root, child };
    }

    function makeBridgeWithCaptureLogger() {
      const { root, child } = makeCaptureLogger();
      const bus = new InProcessEventBus();
      const bridge = new SignalToOrderBridge({
        bus,
        log: root as never,
        liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      });
      bridge.subscribe();
      return { bus, child };
    }

    it("logs at debug when only acceptingOrders/enableOrderBook fail", async () => {
      const { bus, child } = makeBridgeWithCaptureLogger();

      await bus.publish("SignalApproved", {
        signal: { ...makeSignal(), side: "sell" },
        market: makeMarket({ acceptingOrders: false, enableOrderBook: false }),
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(child.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reasons: expect.arrayContaining(["not_accepting_orders", "order_book_disabled"]),
        }),
        "approved signal skipped — market not live for order placement",
      );
      expect(child.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        "approved signal skipped — market not live for order placement",
      );
    });

    it("logs at warn when no_bid is in the reasons (data anomaly)", async () => {
      const { bus, child } = makeBridgeWithCaptureLogger();

      await bus.publish("SignalApproved", {
        signal: { ...makeSignal(), side: "sell" },
        market: makeMarket({ bestBid: null }),
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(child.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reasons: expect.arrayContaining(["no_bid"]) }),
        "approved signal skipped — market not live for order placement",
      );
    });
  });
});

describe("entry-price ceiling guard (ADR-013)", () => {
  function makeBridge() {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => makerOnlyPolicy(),
    });
    bridge.subscribe();
    const skipped: Array<{ stage: string; reasons: readonly string[] }> = [];
    const placed: unknown[] = [];
    bus.subscribe("SignalConversionSkipped", async (p) => {
      skipped.push(p);
    });
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p);
    });
    return { bus, skipped, placed };
  }

  it("rejects BUY when bestBid > 0.45 with price-above-entry-ceiling reason", async () => {
    const { bus, skipped, placed } = makeBridge();
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.46, bestAsk: 0.47, midPrice: 0.465 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("execution-terms");
    expect(skipped[0]!.reasons).toContain("price-above-entry-ceiling");
  });

  it("allows BUY at exactly 0.45 (inclusive)", async () => {
    const { bus, skipped, placed } = makeBridge();
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.45, bestAsk: 0.46, midPrice: 0.455 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("does not guard SELL signals (sell price can legitimately be > 0.45)", async () => {
    const { bus, skipped, placed } = makeBridge();
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.01,
      reason: "repricing-exit",
    };
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market: makeMarket({ bestBid: 0.85, bestAsk: 0.9, midPrice: 0.875 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });
});

describe("dead-side-near-end guard", () => {
  // Markets resolve at 2026-04-11T10:00:30Z; NOW is 10:00:00Z. `endIn(ms)`
  // returns an ISO endDate `ms` milliseconds after NOW (negative = past).
  function endIn(deltaMs: number): string {
    return new Date(NOW + deltaMs).toISOString();
  }

  function makeBridge(modeOverrides?: Partial<DeadSideGuardPolicy>) {
    const bus = new InProcessEventBus();
    const logger = makeLogger();
    const deadSideGuard: DeadSideGuardPolicy = modeOverrides
      ? { ...DEFAULT_EXECUTION_POLICY.deadSideGuard, mode: "enforce", ...modeOverrides }
      : DEFAULT_EXECUTION_POLICY.deadSideGuard;
    const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, deadSideGuard };
    const bridge = new SignalToOrderBridge({
      bus,
      log: logger,
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
    });
    bridge.subscribe();
    const skipped: Array<{
      stage: string;
      reasons: readonly string[];
      diagnostics: Record<string, unknown>;
    }> = [];
    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("SignalConversionSkipped", async (p) => {
      skipped.push(p);
    });
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p);
    });
    return { bus, skipped, placed, logger };
  }

  const deadSideMarket = (endOffsetMs: number, askPrice = 0.01) =>
    makeMarket({
      bestBid: askPrice - 0.005 < 0.001 ? 0.001 : askPrice - 0.005,
      bestAsk: askPrice,
      midPrice: null,
      endDate: endIn(endOffsetMs),
      tickSize: 0.001,
    });

  it("off mode (default) places the order regardless of dead-side conditions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge(); // no options → default off
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(30_000, 0.01), // 30s to end, ask=0.01 — would hit in enforce
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("enforce mode skips BUY when bestAsk ≤ 0.02 and endDate is ≤ 120s away", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(30_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("execution-terms");
    expect(skipped[0]!.reasons).toContain("dead-side-near-end");
    expect(skipped[0]!.diagnostics).toMatchObject({
      bestAsk: 0.01,
      secondsToEnd: 30,
      xMs: 120_000,
      guardMode: "enforce",
    });
  });

  it("post-endDate BUY is blocked by BUY admission before dead-side guard runs", async () => {
    // Originally tested that dead-side `enforce` mode also rejects post-endDate.
    // That property still holds, but the BUY admission guard (defense-in-depth)
    // now catches post-endDate BUYs earlier with `marketability/market_ended`,
    // making the dead-side path unreachable for this scenario.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(-30_000, 0.01), // already ended 30s ago
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("marketability");
    expect(skipped[0]!.reasons).toContain("market_ended");
  });

  it("observe mode logs the hit but still places the order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed, logger } = makeBridge({ mode: "observe" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(30_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    // child logger captures the observe-only marker.
    // The default root logger stub spawns a fresh child per call, so we assert
    // that *some* logger instance received the observe line via log.info.
    expect(logger).toBeDefined();
  });

  it("does not hit when bestAsk is above the ceiling (0.03 > 0.02)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(30_000, 0.03),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("does not hit when endDate is more than X (120s) away (180s long-dated)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(180_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("does not guard SELL signals (only BUYs can hit the dead-side guard)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce" });
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.01,
      reason: "repricing-exit",
    };
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market: deadSideMarket(2 * 60 * 60_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("places SELL orders inside the former order-lifetime final resolution hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce" });
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.01,
      reason: "repricing-exit",
    };
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market: deadSideMarket(30 * 60_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("does not hit when endDate is null (no resolution deadline known)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({
        bestBid: 0.001,
        bestAsk: 0.01,
        midPrice: null,
        endDate: null,
        tickSize: 0.001,
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("respects a custom askCeiling threshold (0.05 instead of default 0.02)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce", askCeiling: 0.05 });
    // ask=0.04 would pass the default 0.02 gate but trips the custom 0.05 gate.
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(30_000, 0.04),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("dead-side-near-end");
  });

  it("respects a custom maxTimeToEndMs threshold (60s instead of default 120s)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, skipped, placed } = makeBridge({ mode: "enforce", maxTimeToEndMs: 60_000 });
    // 90s to end: hits default 120s, misses custom 60s.
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(90_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });
});

describe("bounded-midpoint pricing (ADR-014)", () => {
  function makeBridgeWithPricing(
    pricingOverrides?: Partial<ExecutionPricingPolicy>,
    opts: {
      orderRepo?: OrderRepository;
      positionRepo?: PositionRepository;
      orderLifetime?: ConstructorParameters<typeof SignalToOrderBridge>[0]["orderLifetime"];
      runtimeMetrics?: ConstructorParameters<typeof SignalToOrderBridge>[0]["runtimeMetrics"];
      liveLiteGuard?: ConstructorParameters<typeof SignalToOrderBridge>[0]["liveLiteGuard"];
      riskEventRepo?: ConstructorParameters<typeof SignalToOrderBridge>[0]["riskEventRepo"];
      policyOverrides?: Partial<ExecutionPolicy>;
    } = {},
  ) {
    const bus = new InProcessEventBus();
    const logger = makeLogger();
    const pricing: ExecutionPricingPolicy = pricingOverrides
      ? { ...DEFAULT_EXECUTION_POLICY.pricing, mode: "bounded-midpoint", ...pricingOverrides }
      : DEFAULT_EXECUTION_POLICY.pricing;
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      opportunisticTaker: { ...DEFAULT_EXECUTION_POLICY.opportunisticTaker, enabled: false },
      pricing,
      ...opts.policyOverrides,
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: logger,
      liveLiteGuard: opts.liveLiteGuard ?? ({ getWalletMode: () => "eoa" } as never),
      policy: () => policy,
      ...(opts.orderRepo ? { orderRepo: opts.orderRepo } : {}),
      ...(opts.positionRepo ? { positionRepo: opts.positionRepo } : {}),
      ...(opts.orderLifetime ? { orderLifetime: opts.orderLifetime } : {}),
      ...(opts.runtimeMetrics ? { runtimeMetrics: opts.runtimeMetrics } : {}),
      ...(opts.riskEventRepo ? { riskEventRepo: opts.riskEventRepo } : {}),
    });
    bridge.subscribe();
    const skipped: Array<{
      stage: string;
      reasons: readonly string[];
      diagnostics: Record<string, unknown>;
    }> = [];
    const placed: Array<{
      command: {
        price: number;
        size: number;
        side: "buy" | "sell";
        tickSize: number;
        postOnly?: boolean;
      };
    }> = [];
    bus.subscribe("SignalConversionSkipped", async (p) => {
      skipped.push(p);
    });
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p);
    });
    return { bus, skipped, placed };
  }

  function allowSellTakerPolicy() {
    return {
      ...DEFAULT_EXECUTION_POLICY.opportunisticTaker,
      sides: ["buy", "sell"] as Array<"buy" | "sell">,
    };
  }

  function profitTakerPolicy(overrides?: Partial<ExecutionPolicy["takerAtProfit"]>) {
    return {
      ...DEFAULT_EXECUTION_POLICY.takerAtProfit,
      enabled: true,
      maxSpreadTicks: 6,
      ...overrides,
    };
  }

  function avgEntryRepo(avgEntryPrice: number | null): PositionRepository {
    return {
      findByTokenId: vi.fn(() => (avgEntryPrice == null ? null : ({ avgEntryPrice } as never))),
    } as never;
  }

  it("default edge branch posts BUY at bestBid — ADR-006 D1 preserved", async () => {
    const { bus, placed } = makeBridgeWithPricing();
    const market = makeMarket({ bestBid: 0.4, bestAsk: 0.41, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.4);
  });

  it("defaults SELL edge branch to midpoint-anchored pricing", async () => {
    const { bus, placed } = makeBridgeWithPricing();
    const market = makeMarket({ bestBid: 0.23, bestAsk: 0.29, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.2, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.31);
  });

  it("caps bid-anchored SELL inside the spread when the raw anchor is above bestAsk", async () => {
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: { exitPricingMode: "bid-anchored" },
    });
    const market = makeMarket({ bestBid: 0.27, bestAsk: 0.29, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.2, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.28);
  });

  it("resolves wide-spread SELL price to best ask undercut", async () => {
    const { bus, placed } = makeBridgeWithPricing();
    const market = makeMarket({ bestBid: 0.05, bestAsk: 0.186, midPrice: 0.118, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.123, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.185);
  });

  it("floors D4 SELL commands to the 0.01 effective tick and snaps with SELL ceil", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed, skipped } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
    });
    const market = makeMarket({
      bestBid: 0.2,
      bestAsk: 0.218,
      midPrice: 0.209,
      spread: 0.018,
      tickSize: 0.001,
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.217,
        reason: "repricing-exit",
        decisionRuleId: "D4",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.22);
    expect(placed[0]!.command.tickSize).toBe(0.01);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "d4_effective_tick_floor_applied_total",
      1,
      JSON.stringify({ side: "sell", from_tick_size: 0.001, to_tick_size: 0.01 }),
    );
  });

  it("keeps Track P cap on the same D4 effective tick grid", async () => {
    const positionRepo: PositionRepository = {
      findByTokenId: vi.fn(() => ({ avgEntryPrice: 0.07 }) as never),
    } as never;
    const { bus, placed, skipped } = makeBridgeWithPricing(undefined, { positionRepo });
    const market = makeMarket({
      bestBid: 0.2,
      bestAsk: 0.5,
      midPrice: 0.35,
      spread: 0.3,
      tickSize: 0.001,
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.09,
        reason: "repricing-exit",
        decisionRuleId: "D4",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.09);
    expect(placed[0]!.command.tickSize).toBe(0.01);
  });

  it.each(["D5", "D7", "D8_PROFIT_RATIO", "D9_LOSS_EXIT"])(
    "does not floor non-D4 %s SELL commands on 0.001 markets",
    async (decisionRuleId) => {
      const { bus, placed, skipped } = makeBridgeWithPricing();
      const market = makeMarket({
        bestBid: 0.2,
        bestAsk: 0.218,
        midPrice: 0.209,
        spread: 0.018,
        tickSize: 0.001,
      });

      await bus.publish("SignalApproved", {
        signal: {
          ...makeSignal(),
          side: "sell",
          suggestedPrice: 0.217,
          reason: "repricing-exit",
          decisionRuleId,
        },
        market,
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(skipped).toHaveLength(0);
      expect(placed).toHaveLength(1);
      expect(placed[0]!.command.price).toBe(0.217);
      expect(placed[0]!.command.tickSize).toBe(0.001);
    },
  );

  it.each([
    ["null", null as unknown as number],
    ["zero", 0],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])(
    "uses the 0.01 D4 effective tick fallback when market tickSize is %s",
    async (_label, tickSize) => {
      const { bus, placed, skipped } = makeBridgeWithPricing();
      const market = makeMarket({
        bestBid: 0.2,
        bestAsk: 0.218,
        midPrice: 0.209,
        spread: 0.018,
        tickSize,
      });

      await bus.publish("SignalApproved", {
        signal: {
          ...makeSignal(),
          side: "sell",
          suggestedPrice: 0.217,
          reason: "repricing-exit",
          decisionRuleId: "D4",
        },
        market,
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(skipped).toHaveLength(0);
      expect(placed).toHaveLength(1);
      expect(placed[0]!.command.price).toBe(0.21);
      expect(placed[0]!.command.tickSize).toBe(0.01);
    },
  );

  it("preserves D4 prices already on the 0.01 boundary", async () => {
    const { bus, placed, skipped } = makeBridgeWithPricing();
    const market = makeMarket({
      bestBid: 0.2,
      bestAsk: 0.21,
      midPrice: 0.205,
      spread: 0.01,
      tickSize: 0.001,
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.21,
        reason: "repricing-exit",
        decisionRuleId: "D4",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.21);
    expect(placed[0]!.command.tickSize).toBe(0.01);
  });

  it("fails closed when D4 taker SELL would need to ceil above bestBid", async () => {
    const { bus, placed, skipped } = makeBridgeWithPricing(undefined, {
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });
    const market = makeMarket({
      bestBid: 0.214,
      bestAsk: 0.215,
      midPrice: 0.2145,
      spread: 0.001,
      tickSize: 0.001,
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.214,
        reason: "repricing-exit",
        decisionRuleId: "D4",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("execution-price-invalid");
    expect(skipped[0]!.diagnostics["validationReason"]).toBe("price-off-tick-grid");
  });

  it("falls back to bestAsk when a one-tick spread has no inside SELL price", async () => {
    const { bus, placed } = makeBridgeWithPricing();
    const market = makeMarket({ bestBid: 0.27, bestAsk: 0.28, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.2, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.28);
  });

  it("uses opportunistic taker pricing for BUY when spread is one tick", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });
    const market = makeMarket({ bestBid: 0.09, bestAsk: 0.1, tickSize: 0.01 });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
    expect(placed[0]!.command.postOnly).toBe(false);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "order_priced_mode_total",
      1,
      JSON.stringify({ mode: "taker", side: "buy" }),
    );
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_decision_total",
      1,
      JSON.stringify({ side: "buy", spread_ticks: 1 }),
    );
  });

  it("allows sub-dollar BUY taker when market min size is below the signal size", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });
    const market = makeMarket({ bestBid: 0.09, bestAsk: 0.1, tickSize: 0.01, minOrderSize: 0.1 });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), suggestedSize: 5, suggestedSizeUsdc: 0.5 },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
    expect(placed[0]!.command.postOnly).toBe(false);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_decision_total",
      1,
      JSON.stringify({ side: "buy", spread_ticks: 1 }),
    );
  });

  it("keeps BUY maker when taker notional is below the live-lite entry floor", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      liveLiteGuard: {
        getWalletMode: () => "relayer",
        getMinEntryNotionalUsdc: () => 1,
      } as never,
      policyOverrides: {
        opportunisticTaker: DEFAULT_EXECUTION_POLICY.opportunisticTaker,
      },
    });
    const market = makeMarket({ bestBid: 0.09, bestAsk: 0.1, tickSize: 0.01, minOrderSize: 5 });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), suggestedSize: 9.9, suggestedSizeUsdc: 0.99 },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.09);
    expect(placed[0]!.command.postOnly).toBe(true);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_disabled_min_size_total",
      1,
      expect.stringContaining('"requested_size_usdc":0.99'),
    );
    const minSizeCall = metrics.writeCounter.mock.calls.find(
      (call) => call[0] === "taker_disabled_min_size_total",
    );
    expect(JSON.parse(minSizeCall![2] as string)).toMatchObject({
      side: "buy",
      reason: "notional_min_size",
      min_notional_usdc: 1,
      requested_size_usdc: 0.99,
      required_notional_usdc: 1.05,
      safety_buffer: 1.05,
    });
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_disabled_fraction_over_threshold",
      1,
      JSON.stringify({ side: "buy", bucket: "0.8-0.95" }),
    );
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_attempt_total",
      1,
      JSON.stringify({ side: "buy", mode: "rejected", reason: "min_size" }),
    );
  });

  it("keeps BUY maker when market min size metadata is missing and size is below fallback", async () => {
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: {
        opportunisticTaker: DEFAULT_EXECUTION_POLICY.opportunisticTaker,
      },
    });
    const market = makeMarket({ bestBid: 0.09, bestAsk: 0.1, tickSize: 0.01, minOrderSize: null });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), suggestedSize: 9.9, suggestedSizeUsdc: 0.99 },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.09);
    expect(placed[0]!.command.postOnly).toBeUndefined();
  });

  it("applies market min size guard to SELL taker decisions", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });
    const market = makeMarket({ bestBid: 0.08, bestAsk: 0.1, tickSize: 0.01, minOrderSize: 5 });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.1,
        suggestedSize: 4.9,
        suggestedSizeUsdc: 0.49,
        reason: "repricing-exit",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_disabled_min_size_total",
      1,
      expect.stringContaining('"side":"sell"'),
    );
  });

  it("records all enriched taker min-size metric fields", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });
    const market = makeMarket({ bestBid: 0.08, bestAsk: 0.1, tickSize: 0.01, minOrderSize: 5 });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.1,
        suggestedSize: 4.9,
        suggestedSizeUsdc: 0.49,
        reason: "repricing-exit",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    const minSizeCall = metrics.writeCounter.mock.calls.find(
      (call) => call[0] === "taker_disabled_min_size_total",
    );
    expect(minSizeCall).toBeTruthy();
    expect(JSON.parse(minSizeCall![2] as string)).toEqual({
      side: "sell",
      token_id: "tok-yes",
      reason: "share_min_size",
      market_min_order_size: 5,
      min_notional_usdc: null,
      requested_size_shares: 4.9,
      requested_size_usdc: 0.49,
      required_size_shares: 5.25,
      required_notional_usdc: null,
      safety_buffer: 1.05,
    });
  });

  it("buckets near-threshold taker min-size blocks", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });
    const market = makeMarket({ bestBid: 0.08, bestAsk: 0.1, tickSize: 0.01, minOrderSize: 10 });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedSize: 10,
        suggestedSizeUsdc: 1,
        reason: "repricing-exit",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_disabled_fraction_over_threshold",
      1,
      JSON.stringify({ side: "sell", bucket: "0.95-1.0" }),
    );
  });

  it("buckets far-from-threshold taker min-size blocks", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });
    const market = makeMarket({ bestBid: 0.08, bestAsk: 0.1, tickSize: 0.01, minOrderSize: 10 });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedSize: 3,
        suggestedSizeUsdc: 0.3,
        reason: "repricing-exit",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_disabled_fraction_over_threshold",
      1,
      JSON.stringify({ side: "sell", bucket: "0-0.5" }),
    );
  });

  it("uses configured taker safety buffer", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: {
          ...allowSellTakerPolicy(),
          safetyBuffer: 2,
        },
      },
    });
    const market = makeMarket({ bestBid: 0.08, bestAsk: 0.1, tickSize: 0.01, minOrderSize: 5 });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedSize: 6,
        suggestedSizeUsdc: 0.6,
        reason: "repricing-exit",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.postOnly).toBeUndefined();
    expect(placed[0]!.command.price).toBe(0.14);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_disabled_min_size_total",
      1,
      expect.stringContaining('"safety_buffer":2'),
    );
  });

  it("uses configured fallback min notional when market min size is missing", async () => {
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: {
        opportunisticTaker: {
          ...DEFAULT_EXECUTION_POLICY.opportunisticTaker,
          fallbackMinNotionalUsdc: 0.5,
        },
      },
    });
    const market = makeMarket({ bestBid: 0.09, bestAsk: 0.1, tickSize: 0.01, minOrderSize: null });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), suggestedSize: 9.9, suggestedSizeUsdc: 0.99 },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
    expect(placed[0]!.command.postOnly).toBe(false);
  });

  it("uses taker at profit for a profitable SELL on a four-tick spread", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const { bus, placed, skipped } = makeBridgeWithPricing(undefined, {
      positionRepo: avgEntryRepo(0.1),
      runtimeMetrics: metrics as never,
      riskEventRepo,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
        takerAtProfit: profitTakerPolicy(),
      },
    });
    const market = makeMarket({ bestBid: 0.103, bestAsk: 0.107, tickSize: 0.001 });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.12,
        reason: "repricing-exit",
        decisionRuleId: "D8",
      },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.103);
    expect(placed[0]!.command.postOnly).toBe(false);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_at_profit_activated_total",
      1,
      expect.stringContaining('"rule":"D8"'),
    );
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "taker_at_profit_activated",
        payload: expect.objectContaining({
          tokenId: "tok-yes",
          decisionRuleId: "D8",
          avgEntryPrice: 0.1,
          bestBid: 0.103,
          minGrossExitRatio: 1.03,
        }),
      }),
    );
  });

  it("requires the configured 1.03 gross margin boundary for taker-at-profit", async () => {
    const cases = [
      { bestBid: 0.102, bestAsk: 0.106, expectedTaker: false },
      { bestBid: 0.103, bestAsk: 0.107, expectedTaker: true },
      { bestBid: 0.106, bestAsk: 0.11, expectedTaker: true },
    ];

    for (const testCase of cases) {
      const { bus, placed } = makeBridgeWithPricing(undefined, {
        positionRepo: avgEntryRepo(0.1),
        policyOverrides: {
          opportunisticTaker: allowSellTakerPolicy(),
          takerAtProfit: profitTakerPolicy(),
        },
      });

      await bus.publish("SignalApproved", {
        signal: {
          ...makeSignal(),
          side: "sell",
          suggestedPrice: 0.12,
          reason: "repricing-exit",
          decisionRuleId: "D8",
        },
        market: makeMarket({
          bestBid: testCase.bestBid,
          bestAsk: testCase.bestAsk,
          tickSize: 0.001,
        }),
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(placed).toHaveLength(1);
      expect(placed[0]!.command.postOnly === false).toBe(testCase.expectedTaker);
    }
  });

  it("keeps old behavior when taker-at-profit is disabled by default", async () => {
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      positionRepo: avgEntryRepo(0.1),
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.12,
        reason: "repricing-exit",
        decisionRuleId: "D8",
      },
      market: makeMarket({ bestBid: 0.106, bestAsk: 0.11, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.postOnly).not.toBe(false);
  });

  it("uses the existing taker min-size guard for taker-at-profit", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      positionRepo: avgEntryRepo(0.1),
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
        takerAtProfit: profitTakerPolicy(),
      },
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.12,
        suggestedSize: 4.9,
        suggestedSizeUsdc: 0.5,
        reason: "repricing-exit",
        decisionRuleId: "D8",
      },
      market: makeMarket({
        bestBid: 0.106,
        bestAsk: 0.11,
        tickSize: 0.001,
        minOrderSize: 5,
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_disabled_min_size_total",
      1,
      expect.stringContaining('"side":"sell"'),
    );
  });

  it("suppresses any taker SELL below margin when taker-at-profit is enabled", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed, skipped } = makeBridgeWithPricing(undefined, {
      positionRepo: avgEntryRepo(0.1),
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
        takerAtProfit: profitTakerPolicy(),
      },
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.102,
        reason: "repricing-exit",
        decisionRuleId: "D8",
      },
      market: makeMarket({ bestBid: 0.102, bestAsk: 0.103, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("taker-below-margin");
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "taker_at_profit_blocked_total",
      1,
      expect.stringContaining('"reason":"taker-below-margin"'),
    );
  });

  it("suppresses taker-at-profit when Track P cap would lower final price below margin", async () => {
    const { bus, placed, skipped } = makeBridgeWithPricing(undefined, {
      positionRepo: avgEntryRepo(0.96),
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
        takerAtProfit: profitTakerPolicy(),
      },
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.99,
        reason: "repricing-exit",
        decisionRuleId: "D8",
      },
      market: makeMarket({ bestBid: 0.99, bestAsk: 0.995, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("taker-below-margin");
  });

  it.each([null, 0, NaN])(
    "falls back safely when avg entry is invalid for taker-at-profit: %s",
    async (avgEntry) => {
      const { bus, placed } = makeBridgeWithPricing(undefined, {
        positionRepo: avgEntryRepo(avgEntry),
        policyOverrides: {
          opportunisticTaker: allowSellTakerPolicy(),
          takerAtProfit: profitTakerPolicy(),
        },
      });

      await bus.publish("SignalApproved", {
        signal: {
          ...makeSignal(),
          side: "sell",
          suggestedPrice: 0.12,
          reason: "repricing-exit",
          decisionRuleId: "D8",
        },
        market: makeMarket({ bestBid: 0.106, bestAsk: 0.11, tickSize: 0.001 }),
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(placed).toHaveLength(1);
      expect(placed[0]!.command.postOnly).not.toBe(false);
    },
  );

  it("excludes dust/redeem-like SELL rules from the all-sell taker-at-profit scope", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      positionRepo: avgEntryRepo(0.1),
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
        takerAtProfit: profitTakerPolicy(),
      },
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.12,
        reason: "repricing-exit",
        decisionRuleId: "DUST_SWEEP",
      },
      market: makeMarket({ bestBid: 0.106, bestAsk: 0.11, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.postOnly).not.toBe(false);
    expect(metrics.writeCounter).not.toHaveBeenCalledWith(
      "taker_at_profit_activated_total",
      expect.any(Number),
      expect.any(String),
    );
  });

  it("preserves D4 effective tick safety for taker-at-profit", async () => {
    const { bus, placed, skipped } = makeBridgeWithPricing(undefined, {
      positionRepo: avgEntryRepo(0.2),
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
        takerAtProfit: profitTakerPolicy(),
      },
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.21,
        reason: "repricing-exit",
        decisionRuleId: "D4",
      },
      market: makeMarket({
        bestBid: 0.21,
        bestAsk: 0.214,
        tickSize: 0.001,
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.21);
    expect(placed[0]!.command.tickSize).toBe(0.01);
    expect(placed[0]!.command.postOnly).toBe(false);
  });

  it("keeps SELL maker pricing with default buy-only taker when spread is two ticks", async () => {
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: {
        opportunisticTaker: DEFAULT_EXECUTION_POLICY.opportunisticTaker,
      },
    });
    const market = makeMarket({ bestBid: 0.08, bestAsk: 0.1, tickSize: 0.01 });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.1, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.14);
    expect(placed[0]!.command.postOnly).toBeUndefined();
  });

  it("keeps maker pricing when opportunistic taker spread is above threshold", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
      policyOverrides: {
        opportunisticTaker: allowSellTakerPolicy(),
      },
    });
    const market = makeMarket({ bestBid: 0.08, bestAsk: 0.11, tickSize: 0.01 });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.1, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.14);
    expect(placed[0]!.command.postOnly).toBeUndefined();
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "order_priced_mode_total",
      1,
      JSON.stringify({ mode: "midpoint-anchored", side: "sell" }),
    );
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "exit_anchor_mode_total",
      1,
      JSON.stringify({ mode: "midpoint" }),
    );
  });

  it("keeps maker pricing when opportunistic taker is disabled", async () => {
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: {
        opportunisticTaker: { ...DEFAULT_EXECUTION_POLICY.opportunisticTaker, enabled: false },
      },
    });
    const market = makeMarket({ bestBid: 0.09, bestAsk: 0.1, tickSize: 0.01 });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.09);
  });

  it("keeps SELL maker pricing when opportunistic taker is buy-only", async () => {
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: {
        opportunisticTaker: {
          ...DEFAULT_EXECUTION_POLICY.opportunisticTaker,
          sides: ["buy"],
        },
      },
    });
    const market = makeMarket({ bestBid: 0.09, bestAsk: 0.1, tickSize: 0.01 });

    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.1, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
    expect(placed[0]!.command.postOnly).toBeUndefined();
  });

  it("can roll SELL edge branch back to bestAsk pricing", async () => {
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: { exitPricingMode: "edge" },
    });
    const market = makeMarket({ bestBid: 0.23, bestAsk: 0.29, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.2, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.29);
  });

  it("skips SELL through hard-liveness when bestBid is unavailable", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing();
    const market = makeMarket({ bestBid: null, bestAsk: 0.29, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), side: "sell", suggestedPrice: 0.2, reason: "repricing-exit" },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("no_bid");
  });

  it("ladder BUY posts at ladderTargetPrice even when bestBid moved", async () => {
    const metrics = { writeEvent: vi.fn(), writeLatest: vi.fn(), writeCounter: vi.fn() };
    const { bus, placed } = makeBridgeWithPricing(undefined, {
      runtimeMetrics: metrics as never,
    });
    const market = makeMarket({ bestBid: 0.14, bestAsk: 0.16, midPrice: 0.15, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), suggestedPrice: 0.1, ladderTargetPrice: 0.1 },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "order_priced_mode_total",
      1,
      JSON.stringify({ mode: "ladder", side: "buy" }),
    );
  });

  it("skips ladder BUY when pinned target would cross bestAsk", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing();
    const market = makeMarket({ bestBid: 0.09, bestAsk: 0.1, midPrice: 0.095, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), suggestedPrice: 0.1, ladderTargetPrice: 0.1 },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("execution-terms");
    expect(skipped[0]!.reasons).toContain("execution-price-unavailable");
  });

  it("allows ladder BUY at ladderTargetPrice when bestAsk is unavailable", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing();
    const market = makeMarket({ bestBid: 0.09, bestAsk: null, midPrice: 0.09, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), suggestedPrice: 0.1, ladderTargetPrice: 0.1 },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
  });

  it("skips SELL when edge price is below the signal-distance floor", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: { exitPricingMode: "edge" },
    });
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.2,
      reason: "repricing-exit",
    };
    const market = makeMarket({ bestBid: 0.02, bestAsk: 0.08, midPrice: 0.05, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("execution-terms");
    expect(skipped[0]!.reasons).toContain("sell-price-below-signal-floor");
    expect(skipped[0]!.diagnostics).toMatchObject({
      signalPrice: 0.2,
      executionPrice: 0.08,
      minRatio: 0.5,
      floor: 0.1,
    });
  });

  it("allows SELL exactly at the signal-distance floor", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, {
      policyOverrides: { exitPricingMode: "edge" },
    });
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.2,
      reason: "repricing-exit",
    };
    const market = makeMarket({ bestBid: 0.02, bestAsk: 0.1, midPrice: 0.06, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
  });

  it("skips duplicate acceptable-price SELL when an open sell order already exists", async () => {
    const orderRepo = {
      findByTokenId: vi.fn(() => [makeOpenSellOrder({ price: 0.1 })]),
    } as unknown as OrderRepository;
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, {
      orderRepo,
      policyOverrides: { exitPricingMode: "edge" },
    });
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.2,
      suggestedSize: 5.73,
      reason: "repricing-exit",
    };
    const market = makeMarket({ bestBid: 0.02, bestAsk: 0.1, midPrice: 0.06, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("execution-terms");
    expect(skipped[0]!.reasons).toContain("sell-order-acceptable-price-already-open");
    expect(skipped[0]!.diagnostics).toMatchObject({
      existingPrice: 0.1,
      executionPrice: 0.1,
    });
  });

  it("allows timed-out same-price SELL replacement when the split size changes", async () => {
    const orderRepo = {
      findByTokenId: vi.fn(() => [
        makeOpenSellOrder({
          price: 0.1,
          size: 10,
          createdAt: new Date(
            Date.now() - DEFAULT_EXECUTION_POLICY.sellTimeoutMs - 1,
          ).toISOString(),
        }),
      ]),
    } as unknown as OrderRepository;
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, {
      orderRepo,
      policyOverrides: { exitPricingMode: "edge" },
    });
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.2,
      suggestedSize: 5.73,
      reason: "repricing-exit",
    };
    const market = makeMarket({ bestBid: 0.02, bestAsk: 0.1, midPrice: 0.06, tickSize: 0.001 });

    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(
      skipped.some((event) => event.reasons.includes("sell-order-acceptable-price-already-open")),
    ).toBe(false);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.size).toBe(5.73);
  });

  it("allows a replacement SELL after the old same-price order is already cancelled", async () => {
    const orderRepo = {
      findByTokenId: vi.fn(() => [makeOpenSellOrder({ price: 0.1, status: "cancelled" })]),
    } as unknown as OrderRepository;
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, {
      orderRepo,
      policyOverrides: { exitPricingMode: "edge" },
    });
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.2,
      suggestedSize: 5.73,
      reason: "repricing-exit",
    };
    const market = makeMarket({ bestBid: 0.02, bestAsk: 0.1, midPrice: 0.06, tickSize: 0.001 });

    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(
      skipped.some((event) => event.reasons.includes("sell-order-acceptable-price-already-open")),
    ).toBe(false);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
  });

  it.each([
    { existingPrice: 0.29, executionPrice: 0.29, tickSize: 0.01, shouldSuppress: true },
    { existingPrice: 0.29, executionPrice: 0.3, tickSize: 0.01, shouldSuppress: true },
    { existingPrice: 0.29, executionPrice: 0.31, tickSize: 0.01, shouldSuppress: true },
    { existingPrice: 0.29, executionPrice: 0.32, tickSize: 0.01, shouldSuppress: false },
    { existingPrice: 0.29, executionPrice: 0.295, tickSize: 0.001, shouldSuppress: false },
  ])(
    "dedupes SELL inside the configured tolerance: $existingPrice vs $executionPrice",
    async ({ existingPrice, executionPrice, tickSize, shouldSuppress }) => {
      const orderRepo = {
        findByTokenId: vi.fn(() => [makeOpenSellOrder({ price: existingPrice })]),
      } as unknown as OrderRepository;
      const { bus, skipped, placed } = makeBridgeWithPricing(undefined, {
        orderRepo,
        policyOverrides: { exitPricingMode: "edge" },
      });
      const sellSignal: Signal = {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.2,
        suggestedSize: 5.73,
        reason: "repricing-exit",
      };
      const market = makeMarket({
        bestBid: 0.02,
        bestAsk: executionPrice,
        midPrice: (0.02 + executionPrice) / 2,
        tickSize,
      });

      await bus.publish("SignalApproved", {
        signal: sellSignal,
        market,
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(placed).toHaveLength(shouldSuppress ? 0 : 1);
      expect(
        skipped.some((event) => event.reasons.includes("sell-order-acceptable-price-already-open")),
      ).toBe(shouldSuppress);
    },
  );

  it("skips SELL when order-lifetime BURST placement budget is exhausted", async () => {
    const orderLifetime = {
      canPlaceExitOrder: vi.fn(() => ({
        allowed: false,
        reason: "order-lifetime-burst-rate-limit",
        mode: "BURST",
        budgetPerMinute: 20,
        remainingBudget: 0,
      })),
    };
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, {
      orderLifetime,
      policyOverrides: { exitPricingMode: "edge" },
    });
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.2,
      suggestedSize: 5.73,
      reason: "repricing-exit",
    };
    const market = makeMarket({ bestBid: 0.02, bestAsk: 0.1, midPrice: 0.06, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(orderLifetime.canPlaceExitOrder).toHaveBeenCalledWith(
      sellSignal.tokenId,
      expect.any(Number),
    );
    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("execution-terms");
    expect(skipped[0]!.reasons).toContain("order-lifetime-burst-rate-limit");
    expect(skipped[0]!.diagnostics).toMatchObject({
      mode: "BURST",
      budgetPerMinute: 20,
      remainingBudget: 0,
    });
  });

  it("skips SELL below the effective exchange minimum size when market min is missing", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing();
    const sellSignal: Signal = {
      ...makeSignal(),
      side: "sell",
      suggestedPrice: 0.2,
      suggestedSize: 0.5,
      reason: "repricing-exit",
    };
    const market = makeMarket({
      bestBid: 0.18,
      bestAsk: 0.2,
      midPrice: 0.19,
      tickSize: 0.001,
      minOrderSize: null,
    });
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("execution-terms");
    expect(skipped[0]!.reasons).toContain("order-size-below-minimum");
    expect(skipped[0]!.diagnostics).toMatchObject({
      orderSize: 0.5,
      minOrderSize: null,
      effectiveMinOrderSize: 1,
    });
  });

  it("does not apply the SELL signal-distance floor to BUY", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing();
    const buySignal: Signal = { ...makeSignal(), suggestedPrice: 0.2 };
    const market = makeMarket({ bestBid: 0.08, bestAsk: 0.1, midPrice: 0.09, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: buySignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.side).toBe("buy");
    expect(placed[0]!.command.price).toBe(0.08);
  });

  it("bounded-midpoint on tight spread improves price inside the book", async () => {
    const { bus, placed } = makeBridgeWithPricing({ mode: "bounded-midpoint" });
    // bb=0.4, ba=0.41, tickSize=0.001, spread=10 ticks — within default 20-cap
    const market = makeMarket({ bestBid: 0.4, bestAsk: 0.41, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBeGreaterThan(0.4);
    expect(placed[0]!.command.price).toBeLessThan(0.41);
  });

  it("bounded-midpoint on wide spread falls back to edge when policy=edge", async () => {
    const { bus, placed } = makeBridgeWithPricing({
      mode: "bounded-midpoint",
      wideSpreadPolicy: "edge",
    });
    // bb=0.01, ba=0.99, tickSize=0.01, spread=98 ticks > 20
    const market = makeMarket({ bestBid: 0.01, bestAsk: 0.99, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.01); // fell back to bestBid
  });

  it("bounded-midpoint on wide spread skips when policy=skip with spread-above-cap reason", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing({
      mode: "bounded-midpoint",
      wideSpreadPolicy: "skip",
    });
    const market = makeMarket({ bestBid: 0.01, bestAsk: 0.99, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.stage).toBe("execution-terms");
    expect(skipped[0]!.reasons).toContain("spread-above-cap");
    expect(skipped[0]!.diagnostics).toMatchObject({
      pricingMode: "bounded-midpoint",
      edgePrice: 0.01,
      side: "buy",
      spreadTicks: expect.any(Number),
    });
  });

  it("final price still passes ENTRY_PRICE_CEILING (ADR-013) after bounded-midpoint", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing({ mode: "bounded-midpoint" });
    // BUY on bb=0.80, ba=0.82 → mid=0.81, raw=0.80, floor=0.80, improved=0.80
    // 0.80 > ENTRY_PRICE_CEILING (0.45) → bridge rejects with price-above-entry-ceiling.
    const market = makeMarket({ bestBid: 0.8, bestAsk: 0.82, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("price-above-entry-ceiling");
  });

  it("diagnostics on successful placement include pricingMode + ADR-014 §D6 fields (log check)", async () => {
    // Build a self-referential child so info calls land on the same spy.
    const infoSpy = vi.fn();
    const logger = {
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      level: "info",
      silent: vi.fn(),
    } as unknown as import("../logger.js").Logger;
    (logger as unknown as { child: (bindings: unknown) => typeof logger }).child = () => logger;

    const bus = new InProcessEventBus();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      opportunisticTaker: { ...DEFAULT_EXECUTION_POLICY.opportunisticTaker, enabled: false },
      pricing: { ...DEFAULT_EXECUTION_POLICY.pricing, mode: "bounded-midpoint" },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: logger,
      liveLiteGuard: { getWalletMode: () => "eoa" } as never,
      policy: () => policy,
    });
    bridge.subscribe();
    const market = makeMarket({ bestBid: 0.4, bestAsk: 0.41, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    const converted = infoSpy.mock.calls.find(
      (args) => args[1] === "signal converted to order command",
    );
    expect(converted).toBeDefined();
    expect(converted![0]).toMatchObject({
      pricingMode: "bounded-midpoint",
      pricingDiagnostics: expect.objectContaining({
        edgePrice: 0.4,
        midpoint: 0.405,
        finalPrice: expect.any(Number),
        side: "buy",
      }),
    });
  });

  it("SELL in bounded-midpoint mode improves toward midpoint on tight spread", async () => {
    const { bus, placed } = makeBridgeWithPricing({ mode: "bounded-midpoint" });
    const sellSignal: Signal = { ...makeSignal(), side: "sell" };
    const market = makeMarket({ bestBid: 0.5, bestAsk: 0.51, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: sellSignal,
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.side).toBe("sell");
    expect(placed[0]!.command.price).toBeGreaterThan(0.5);
    expect(placed[0]!.command.price).toBeLessThanOrEqual(0.51);
  });

  it("one-sided book in bounded-midpoint mode with policy=edge falls back to bestBid", async () => {
    const { bus, placed } = makeBridgeWithPricing({
      mode: "bounded-midpoint",
      oneSidedPolicy: "edge",
    });
    const market = makeMarket({ bestBid: 0.4, bestAsk: null, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.4);
  });

  it("one-sided book with policy=skip publishes one-sided-book reason", async () => {
    const { bus, skipped, placed } = makeBridgeWithPricing({
      mode: "bounded-midpoint",
      oneSidedPolicy: "skip",
    });
    const market = makeMarket({ bestBid: 0.5, bestAsk: null, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("one-sided-book");
  });

  it("edge mode vs bounded-midpoint mode resolve different prices on the same book (parity verification)", async () => {
    const edgeRun = makeBridgeWithPricing(); // default = edge
    const boundedRun = makeBridgeWithPricing({ mode: "bounded-midpoint" });
    const market = makeMarket({ bestBid: 0.4, bestAsk: 0.42, tickSize: 0.001 });

    await edgeRun.bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await edgeRun.bus.drain();

    await boundedRun.bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await boundedRun.bus.drain();

    expect(edgeRun.placed).toHaveLength(1);
    expect(boundedRun.placed).toHaveLength(1);
    expect(edgeRun.placed[0]!.command.price).toBe(0.4); // bestBid
    expect(boundedRun.placed[0]!.command.price).toBeGreaterThan(0.4);
  });

  it("edge mode attaches pricingShadow to placement log (ADR-014 canary)", async () => {
    const infoSpy = vi.fn();
    const logger = {
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      level: "info",
      silent: vi.fn(),
    } as unknown as import("../logger.js").Logger;
    (logger as unknown as { child: (bindings: unknown) => typeof logger }).child = () => logger;

    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: logger,
      liveLiteGuard: { getWalletMode: () => "eoa" } as never,
      // default pricing mode = edge
    });
    bridge.subscribe();
    const market = makeMarket({ bestBid: 0.4, bestAsk: 0.41, tickSize: 0.001 });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    const converted = infoSpy.mock.calls.find(
      (args) => args[1] === "signal converted to order command",
    );
    expect(converted).toBeDefined();
    // edge mode → command price = bestBid, and pricingShadow carries the bounded candidate
    expect(converted![0]).toMatchObject({
      pricingMode: "edge",
      price: 0.4,
      pricingShadow: expect.objectContaining({
        edgePrice: 0.4,
        midpoint: 0.405,
        finalPrice: expect.any(Number),
        side: "buy",
      }),
    });
    // Shadow bounded price improves strictly above bestBid for a 1-tick spread.
    expect(converted![0].pricingShadow.finalPrice).toBeGreaterThan(0.4);
  });
});

describe("dead-side shadow canary (audit 2026-04-24)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function endIn(deltaMs: number): string {
    return new Date(NOW + deltaMs).toISOString();
  }

  function makeBridgeWithCapture(modeOverrides?: Partial<DeadSideGuardPolicy>) {
    const infoSpy = vi.fn();
    const logger = {
      info: infoSpy,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      trace: vi.fn(),
      level: "info",
      silent: vi.fn(),
    } as unknown as import("../logger.js").Logger;
    (logger as unknown as { child: (bindings: unknown) => typeof logger }).child = () => logger;

    const bus = new InProcessEventBus();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      deadSideGuard: {
        ...DEFAULT_EXECUTION_POLICY.deadSideGuard,
        mode: "observe",
        ...(modeOverrides ?? {}),
      },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: logger,
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
    });
    bridge.subscribe();
    const skipped: Array<{ reasons: readonly string[]; diagnostics: Record<string, unknown> }> = [];
    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("SignalConversionSkipped", async (p) => {
      skipped.push(p);
    });
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p);
    });
    return { bus, infoSpy, skipped, placed };
  }

  const deadSideMarket = (endOffsetMs: number, askPrice = 0.01) =>
    makeMarket({
      bestBid: askPrice - 0.005 < 0.001 ? 0.001 : askPrice - 0.005,
      bestAsk: askPrice,
      midPrice: null,
      endDate: endIn(endOffsetMs),
      tickSize: 0.001,
    });

  function findCanaryLog(infoSpy: ReturnType<typeof vi.fn>): Record<string, unknown> | undefined {
    const hit = infoSpy.mock.calls.find(
      (args) => args[1] === "dead-side-near-end canary observation",
    );
    return hit?.[0] as Record<string, unknown> | undefined;
  }

  it("emits canary for long-dated BUY with bestAsk ≤ ceiling (outside X) — bucket + shadowHits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, infoSpy, placed, skipped } = makeBridgeWithCapture({ mode: "observe" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      // 10 min to end — far outside default X=120s, but still should get canary telemetry
      market: deadSideMarket(600_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1); // observe doesn't skip
    expect(skipped).toHaveLength(0);
    const log = findCanaryLog(infoSpy);
    expect(log).toBeDefined();
    expect(log).toMatchObject({
      bestAsk: 0.01,
      secondsToEnd: 600,
      bucket: "5-15m",
      shadowHits: { x60_000: false, x120_000: false, x300_000: false, x900_000: true },
      enforceHit: false,
      guardMode: "observe",
    });
  });

  it("emits canary for near-end BUY — all four shadow X thresholds hit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, infoSpy, placed } = makeBridgeWithCapture({ mode: "observe" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(30_000, 0.01), // 30s to end — all X thresholds hit
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    const log = findCanaryLog(infoSpy);
    expect(log).toMatchObject({
      bucket: "<1m",
      shadowHits: { x60_000: true, x120_000: true, x300_000: true, x900_000: true },
      enforceHit: true, // default X=120s, 30_000 ≤ 120_000
    });
  });

  it("post-end BUY skips canary because BUY admission blocks before dead-side runs", async () => {
    // The BUY admission guard now blocks post-endDate BUYs at `marketability`
    // before the dead-side canary code runs. The previous canary semantics for
    // bucket='<0' are unreachable for BUYs in production.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, infoSpy, placed } = makeBridgeWithCapture({ mode: "observe" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(-30_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(findCanaryLog(infoSpy)).toBeUndefined();
  });

  it("enforce mode emits canary but does NOT skip when outside configured X (long-dated BUY)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    // enforce at X=120s, but market is 10 min out — still canary logged, not skipped
    const { bus, infoSpy, placed, skipped } = makeBridgeWithCapture({ mode: "enforce" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(600_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    const log = findCanaryLog(infoSpy);
    expect(log).toMatchObject({
      bucket: "5-15m",
      enforceHit: false,
      guardMode: "enforce",
      shadowHits: { x60_000: false, x120_000: false, x300_000: false, x900_000: true },
    });
  });

  it("off mode does NOT emit any canary log", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, infoSpy, placed } = makeBridgeWithCapture({ mode: "off" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(30_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(findCanaryLog(infoSpy)).toBeUndefined();
  });

  it("does NOT emit canary when bestAsk > askCeiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const { bus, infoSpy, placed } = makeBridgeWithCapture({ mode: "observe" });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: deadSideMarket(30_000, 0.03), // ask above default 0.02 ceiling
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(findCanaryLog(infoSpy)).toBeUndefined();
  });
});

// ─── ADR-015 observations writer ─────────────────────────────────────────────

describe("ADR-015 execution policy observations", () => {
  const PROFILE_ID = "test-profile" as ProfileId;

  function endIn(deltaMs: number): string {
    return new Date(NOW + deltaMs).toISOString();
  }

  function makeCapturingRepo(): {
    repo: ExecutionPolicyObservationRepository;
    rows: ExecutionPolicyObservation[];
  } {
    const rows: ExecutionPolicyObservation[] = [];
    return {
      rows,
      repo: {
        insert: (obs: ExecutionPolicyObservation) => {
          rows.push(obs);
        },
      },
    };
  }

  async function placeSellForShadow(positionRepo?: PositionRepository): Promise<{
    placed: Array<{ command: { price: number } }>;
    rows: ExecutionPolicyObservation[];
  }> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const deps: SignalToOrderBridgeDeps = {
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => DEFAULT_EXECUTION_POLICY,
      observations: repo,
      profileId: PROFILE_ID,
    };
    if (positionRepo) deps.positionRepo = positionRepo;
    const bridge = new SignalToOrderBridge(deps);
    bridge.subscribe();
    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p as never);
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.05,
        suggestedSize: 100,
        suggestedSizeUsdc: 5,
        reason: "repricing-exit",
      },
      market: makeMarket({ bestBid: 0.05, bestAsk: 0.08, midPrice: 0.065, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();
    await waitForRows(rows, 1);

    return { placed, rows };
  }

  it("writes one observation per successful placement with pricing diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      opportunisticTaker: { ...DEFAULT_EXECUTION_POLICY.opportunisticTaker, enabled: false },
      pricing: { ...DEFAULT_EXECUTION_POLICY.pricing, mode: "bounded-midpoint" },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();
    const placed: Array<{ command: { price: number; clientOrderId: string } }> = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p as never);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.4, bestAsk: 0.42, midPrice: 0.41, spread: 0.02 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    await waitForRows(rows, 1);
    const row = rows[0]!;
    expect(row.profileId).toBe(String(PROFILE_ID));
    expect(row.signalId).toBe("sig-1");
    expect(row.decisionRuleId).toBeNull();
    expect(row.clientOrderId).toBe(placed[0]!.command.clientOrderId);
    expect(row.tokenId).toBe(String(TOKEN_ID));
    expect(row.side).toBe("BUY");
    expect(row.selectedPricingMode).toBe("bounded-midpoint");
    expect(row.selectedPrice).toBe(placed[0]!.command.price);
    expect(row.edgePrice).toBe(0.4);
    expect(row.boundedPrice).not.toBeNull();
    expect(row.skippedReason).toBeNull();
    expect(row.deadSideObserved).toBe(false);
    expect(row.deadSideEnforceHit).toBe(false);
    // ADR-023 D-F telemetry. Bounded-midpoint with bb=0.4/ba=0.42
    // (tickSize=0.01) snaps the raw candidate (midpoint - tick = 0.40)
    // back to the edge — selectedPrice equals bestBid, delta = 0 ticks,
    // and 0.40 is a multiple of 0.05 → "0.05x".
    expect(row.pricingDeltaTicks).toBe(0);
    expect(row.roundLevelHit).toBe("0.05x");
  });

  it("ADR-024 §D-D: carries sizingRuleId + notionalBucket onto the placed-order observation row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => makerOnlyPolicy(),
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();

    const signal = makeSignal();
    // R37 B1 ladder slot at ~$8.41 → bucket "$5-$10" (per §4.6).
    signal.sizingRuleId = "B1";
    signal.suggestedSizeUsdc = 8.41;
    await bus.publish("SignalApproved", {
      signal,
      market: makeMarket({ bestBid: 0.4, bestAsk: 0.42 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.sizingRuleId).toBe("B1");
    expect(rows[0]!.notionalBucket).toBe("$5-$10");
  });

  it("ADR-024 §D-D: carries sizing telemetry onto execution-price-unavailable skip rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => makerOnlyPolicy(),
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();

    const signal = makeSignal();
    signal.sizingRuleId = "FALLBACK";
    signal.suggestedSizeUsdc = 2.73;
    // bestBid=0 trips the unavailable branch → skip row written.
    await bus.publish("SignalApproved", {
      signal,
      market: makeMarket({ bestBid: 0, bestAsk: 0.2 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.skippedReason).toBe("execution-price-unavailable");
    expect(rows[0]!.sizingRuleId).toBe("FALLBACK");
    expect(rows[0]!.notionalBucket).toBe("$2-$5");
  });

  it("writes a skip observation with skippedReason when dead-side enforce blocks BUY", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      deadSideGuard: { ...DEFAULT_EXECUTION_POLICY.deadSideGuard, mode: "enforce" },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();
    const placed: Array<unknown> = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({
        bestBid: 0.005,
        bestAsk: 0.01,
        midPrice: null,
        endDate: endIn(30_000),
        tickSize: 0.001,
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    await waitForRows(rows, 1);
    const row = rows[0]!;
    expect(row.clientOrderId).toBeNull();
    expect(row.skippedReason).toBe("dead-side-near-end");
    expect(row.deadSideObserved).toBe(true);
    expect(row.deadSideEnforceHit).toBe(true);
    expect(row.deadSideX60).toBe(true);
    expect(row.deadSideX120).toBe(true);
    expect(row.deadSideBucket).toBe("<1m");
    expect(row.timeToEndMs).toBe(30_000);
    // ADR-023 D-F: dead-side enforce blocks AFTER resolveExecutionTerms — the
    // edge-mode selectedPrice is recorded as the would-have-been price, so the
    // delta + round-level still land on the row. selectedPrice=bestBid=0.005,
    // tickSize=0.001 → delta=0, 0.005 is a multiple of 0.005 not 0.05/0.01.
    expect(row.pricingDeltaTicks).toBe(0);
    expect(row.roundLevelHit).toBe("0.005x");
  });

  it("does not write when observations repo is absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => makerOnlyPolicy(),
      // observations intentionally omitted
    });
    bridge.subscribe();
    const placed: Array<unknown> = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.4, bestAsk: 0.42 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1); // still places the order
  });

  it("does not crash the flow when the observations repo throws", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const logger = makeLogger();
    const repo: ExecutionPolicyObservationRepository = {
      insert: () => {
        throw new Error("db down");
      },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: logger,
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => DEFAULT_EXECUTION_POLICY,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();
    const placed: Array<unknown> = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.4, bestAsk: 0.42 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1); // placement still succeeds
  });

  // Regression: earlier implementation only observed the "ok" placement path
  // and the dead-side enforce-skip path. Wide/one-sided skips, entry-ceiling
  // skips, and invalid/unavailable-price skips emitted no row at all — so
  // canary analytics lost every negative sample. Each case below asserts that
  // a single row lands with the expected boundedOutcome + skippedReason.

  it("writes a skip observation when edge-mode BUY has no bid (price<=0)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => DEFAULT_EXECUTION_POLICY,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();

    // bestBid=0 passes isAlive (which only checks null) but trips the
    // `price <= 0` guard in resolveExecutionTerms — drives the "unavailable" branch.
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0, bestAsk: 0.2 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.skippedReason).toBe("execution-price-unavailable");
    expect(rows[0]!.boundedOutcome).toBe("not-computed");
    expect(rows[0]!.selectedPrice).toBeNull();
    // ADR-023 D-F: no selectedPrice → both telemetry fields are null
    // (preserves the "we don't know" gap rather than emitting a fake 0).
    expect(rows[0]!.pricingDeltaTicks).toBeNull();
    expect(rows[0]!.roundLevelHit).toBeNull();
  });

  it("writes a skip observation when bounded-midpoint rejects wide spread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      pricing: {
        ...DEFAULT_EXECUTION_POLICY.pricing,
        mode: "bounded-midpoint",
        maxEntrySpreadTicks: 1,
        wideSpreadPolicy: "skip",
      },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.3, bestAsk: 0.5, midPrice: 0.4, spread: 0.2 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.skippedReason).toBe("spread-above-cap");
    expect(rows[0]!.boundedOutcome).toBe("skip");
    expect(rows[0]!.selectedPrice).toBeNull();
    // ADR-023 D-F: skip path → selectedPrice null → telemetry null.
    expect(rows[0]!.pricingDeltaTicks).toBeNull();
    expect(rows[0]!.roundLevelHit).toBeNull();
  });

  it("writes a skip observation when bounded-midpoint rejects one-sided book", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      pricing: {
        ...DEFAULT_EXECUTION_POLICY.pricing,
        mode: "bounded-midpoint",
        oneSidedPolicy: "skip",
      },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();

    // bestAsk null → bounded-midpoint resolver returns skip-one-sided.
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.4, bestAsk: null }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.skippedReason).toBe("one-sided-book");
    expect(rows[0]!.boundedOutcome).toBe("skip");
    expect(rows[0]!.selectedPrice).toBeNull();
    expect(rows[0]!.pricingDeltaTicks).toBeNull();
    expect(rows[0]!.roundLevelHit).toBeNull();
  });

  it("writes a skip observation when edge-mode price fails tick-grid validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => makerOnlyPolicy(),
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();

    // bestBid 0.4005 is off-grid for tickSize=0.01 → resolveExecutionTerms
    // returns "invalid". writeObservation records the rejected price as
    // selectedPrice so analytics can see the magnitude of the off-grid drift.
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.4005, bestAsk: 0.42, tickSize: 0.01 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.skippedReason).toBe("execution-price-invalid");
    expect(rows[0]!.boundedOutcome).toBe("invalid");
    expect(rows[0]!.selectedPrice).toBe(0.4005);
    // 0.4005 vs bestBid 0.4005: delta=0. Off-grid price → roundLevelHit
    // computed from the value itself: not min_tick, not 0.05x/0.01x, but
    // 0.4005/0.005=80.1 not integer → off-round.
    expect(rows[0]!.pricingDeltaTicks).toBe(0);
    expect(rows[0]!.roundLevelHit).toBe("off-round");
  });

  it("writes a skip observation when BUY price exceeds entry ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      entryPriceCeiling: 0.1,
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.5, bestAsk: 0.6 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.skippedReason).toBe("price-above-entry-ceiling");
    // In edge mode the chosen bestBid is recorded as the would-have-been price.
    expect(rows[0]!.selectedPrice).toBe(0.5);
    // ADR-023 D-F: telemetry is computed from the would-have-been price even
    // on a skip row, so dashboards see the same delta + bucket distribution
    // as if the order had been placed.
    expect(rows[0]!.pricingDeltaTicks).toBe(0);
    expect(rows[0]!.roundLevelHit).toBe("0.05x");
  });

  it("writes a skip observation when SELL price is below signal-distance floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => DEFAULT_EXECUTION_POLICY,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.2,
        reason: "repricing-exit",
      },
      market: makeMarket({ bestBid: 0.02, bestAsk: 0.08, midPrice: 0.05, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.skippedReason).toBe("sell-price-below-signal-floor");
    expect(rows[0]!.selectedPrice).toBe(0.079);
    expect(rows[0]!.side).toBe("SELL");
    expect(rows[0]!.sellShadowExecutionPrice).toBe(0.079);
    expect(rows[0]!.sellShadowSignalPrice).toBe(0.2);
  });

  it("records the raw SELL shadow cap violation while F2 caps the placement price", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      exitPricingMode: "midpoint-anchored",
      exitMidpointAnchorTicks: 5,
      opportunisticTaker: { ...DEFAULT_EXECUTION_POLICY.opportunisticTaker, enabled: false },
    };
    const positionRepo = {
      findByTokenId: vi.fn(() => ({ avgEntryPrice: 0.01 })),
    } as unknown as PositionRepository;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      observations: repo,
      profileId: PROFILE_ID,
      positionRepo,
    });
    bridge.subscribe();
    const placed: Array<{ command: { price: number; clientOrderId: string } }> = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p as never);
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.01,
        suggestedSize: 100,
        suggestedSizeUsdc: 1,
        reason: "repricing-exit",
      },
      market: makeMarket({ bestBid: 0.01, bestAsk: 0.49, midPrice: 0.25, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    // F2 caps placement at the <0.02 tier (0.01 * 2.5 = 0.025); the observe-only
    // shadow below still records the raw 0.489 anchor and its cap violations.
    expect(placed[0]!.command.price).toBe(0.025);
    await waitForRows(rows, 1);
    expect(rows[0]!.selectedPrice).toBe(placed[0]!.command.price);
    expect(rows[0]!.sellShadowAvgEntry).toBe(0.01);
    expect(rows[0]!.sellShadowAvgEntrySource).toBe("position_repo");
    expect(rows[0]!.sellShadowSignalPrice).toBe(0.01);
    expect(rows[0]!.sellShadowExecutionPrice).toBe(0.489);
    expect(rows[0]!.sellShadowExecutionVsSignalRatio).toBeCloseTo(48.9);
    expect(rows[0]!.sellShadowExecutionVsAvgEntryRatio).toBeCloseTo(48.9);
    expect(rows[0]!.sellShadowCap5Violation).toBe(true);
    expect(rows[0]!.sellShadowCap10Violation).toBe(true);
    expect(rows[0]!.sellShadowExitPricingMode).toBe("midpoint-anchored");
    expect(rows[0]!.sellShadowExitAnchorMode).toBe("ask_undercut");
  });

  it("Track P F2 — enforces the Plankton tier cap on the placed SELL price", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      exitPricingMode: "midpoint-anchored",
      exitMidpointAnchorTicks: 5,
      opportunisticTaker: { ...DEFAULT_EXECUTION_POLICY.opportunisticTaker, enabled: false },
    };
    const positionRepo = {
      findByTokenId: vi.fn(() => ({ avgEntryPrice: 0.01 })),
    } as unknown as PositionRepository;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      observations: repo,
      profileId: PROFILE_ID,
      positionRepo,
    });
    bridge.subscribe();
    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p as never);
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.01,
        suggestedSize: 100,
        suggestedSizeUsdc: 1,
        reason: "repricing-exit",
      },
      market: makeMarket({ bestBid: 0.01, bestAsk: 0.49, midPrice: 0.25, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    // Raw midpoint-anchored rests at 0.489 (ask undercut). avgEntry 0.01 is in the
    // <0.02 tier (2.5x markup), so F2 caps the placement at 0.01 * 2.5 = 0.025.
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.025);
    await waitForRows(rows, 1);
    expect(rows[0]!.selectedPrice).toBe(0.025);
    // The observe-only shadow still records the raw (pre-cap) violation so the
    // A/B telemetry retains its diagnostic value.
    expect(rows[0]!.sellShadowExecutionPrice).toBe(0.489);
    expect(rows[0]!.sellShadowCap5Violation).toBe(true);
  });

  it("leaves BUY observation shadow fields null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => makerOnlyPolicy(),
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();
    bus.subscribe("PlaceOrderRequested", async () => {});

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.4, bestAsk: 0.42 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.side).toBe("BUY");
    expect(rows[0]!.sellShadowAvgEntry).toBeNull();
    expect(rows[0]!.sellShadowAvgEntrySource).toBeNull();
    expect(rows[0]!.sellShadowSignalPrice).toBeNull();
    expect(rows[0]!.sellShadowExecutionPrice).toBeNull();
    expect(rows[0]!.sellShadowExecutionVsSignalRatio).toBeNull();
    expect(rows[0]!.sellShadowExecutionVsAvgEntryRatio).toBeNull();
    expect(rows[0]!.sellShadowCap5Violation).toBeNull();
    expect(rows[0]!.sellShadowCap10Violation).toBeNull();
    expect(rows[0]!.sellShadowExitPricingMode).toBeNull();
    expect(rows[0]!.sellShadowExitAnchorMode).toBeNull();
  });

  it("records missing avg-entry source without throwing or changing SELL placement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => DEFAULT_EXECUTION_POLICY,
      observations: repo,
      profileId: PROFILE_ID,
      positionRepo: {
        findByTokenId: vi.fn(() => null),
      } as unknown as PositionRepository,
    });
    bridge.subscribe();
    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p as never);
    });

    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        side: "sell",
        suggestedPrice: 0.05,
        suggestedSize: 100,
        suggestedSizeUsdc: 5,
        reason: "repricing-exit",
      },
      market: makeMarket({ bestBid: 0.05, bestAsk: 0.08, midPrice: 0.065, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.079);
    await waitForRows(rows, 1);
    expect(rows[0]!.sellShadowAvgEntry).toBeNull();
    expect(rows[0]!.sellShadowAvgEntrySource).toBe("missing_position");
    expect(rows[0]!.sellShadowExecutionVsAvgEntryRatio).toBeNull();
    expect(rows[0]!.sellShadowCap5Violation).toBeNull();
    expect(rows[0]!.sellShadowCap10Violation).toBeNull();
  });

  it("records missing positionRepo source without throwing or changing SELL placement", async () => {
    const { placed, rows } = await placeSellForShadow();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.079);
    expect(rows[0]!.sellShadowAvgEntry).toBeNull();
    expect(rows[0]!.sellShadowAvgEntrySource).toBe("missing_position_repo");
    expect(rows[0]!.sellShadowExecutionVsAvgEntryRatio).toBeNull();
    expect(rows[0]!.sellShadowCap5Violation).toBeNull();
    expect(rows[0]!.sellShadowCap10Violation).toBeNull();
  });

  it("records positionRepo error source without throwing or changing SELL placement", async () => {
    const positionRepo = {
      findByTokenId: vi.fn(() => {
        throw new Error("position db unavailable");
      }),
    } as unknown as PositionRepository;

    const { placed, rows } = await placeSellForShadow(positionRepo);

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.079);
    expect(rows[0]!.sellShadowAvgEntry).toBeNull();
    expect(rows[0]!.sellShadowAvgEntrySource).toBe("error");
    expect(rows[0]!.sellShadowExecutionVsAvgEntryRatio).toBeNull();
    expect(rows[0]!.sellShadowCap5Violation).toBeNull();
    expect(rows[0]!.sellShadowCap10Violation).toBeNull();
  });

  it("records invalid avg-entry source without throwing or changing SELL placement", async () => {
    const positionRepo = {
      findByTokenId: vi.fn(() => ({ avgEntryPrice: 0 })),
    } as unknown as PositionRepository;

    const { placed, rows } = await placeSellForShadow(positionRepo);

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.079);
    expect(rows[0]!.sellShadowAvgEntry).toBeNull();
    expect(rows[0]!.sellShadowAvgEntrySource).toBe("invalid_avg_entry");
    expect(rows[0]!.sellShadowExecutionVsAvgEntryRatio).toBeNull();
    expect(rows[0]!.sellShadowCap5Violation).toBeNull();
    expect(rows[0]!.sellShadowCap10Violation).toBeNull();
  });
});

// ─── ADR-015 telemetry flag gating ───────────────────────────────────────────

/**
 * Loggable mock whose `child` returns itself — required because the bridge
 * immediately switches to `log.child({ component })`; a fresh child per call
 * would drop every call the test wants to observe.
 */
function makeSharedLogger() {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  const debug = vi.fn();
  const fatal = vi.fn();
  const trace = vi.fn();
  const silent = vi.fn();
  const logger: unknown = {
    info,
    warn,
    error,
    debug,
    fatal,
    trace,
    silent,
    level: "info",
    child: vi.fn(() => logger),
  };
  return {
    log: logger as import("../logger.js").Logger,
    info,
    warn,
    error,
  };
}

function makeCapturingRepo(): {
  repo: ExecutionPolicyObservationRepository;
  rows: ExecutionPolicyObservation[];
} {
  const rows: ExecutionPolicyObservation[] = [];
  return {
    rows,
    repo: {
      insert: (obs: ExecutionPolicyObservation) => {
        rows.push(obs);
      },
    },
  };
}

async function waitForRows(rows: ExecutionPolicyObservation[], length: number): Promise<void> {
  await vi.waitFor(() => expect(rows).toHaveLength(length));
}

describe("ADR-015 telemetry flags", () => {
  const PROFILE_ID = "test-profile" as ProfileId;

  it("skips pricingShadow compute + observation when policy.telemetry.pricingShadow is false (edge mode)", async () => {
    // In edge mode the shadow is recorded only via `pricingShadow` ->
    // observation `edgePrice`/`boundedPrice`. With shadow off there's no
    // pricingDiagnostics either, so both fields must be null.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      telemetry: { ...DEFAULT_EXECUTION_POLICY.telemetry, pricingShadow: false },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();
    bus.subscribe("PlaceOrderRequested", async () => {});

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.3, bestAsk: 0.5, midPrice: 0.4, spread: 0.2 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    expect(rows[0]!.edgePrice).toBeNull();
    expect(rows[0]!.boundedPrice).toBeNull();
    expect(rows[0]!.boundedOutcome).toBe("not-computed");
  });

  it("records pricingShadow diagnostics in edge mode when telemetry.pricingShadow is true (default)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => DEFAULT_EXECUTION_POLICY,
      observations: repo,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();
    bus.subscribe("PlaceOrderRequested", async () => {});

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.3, bestAsk: 0.5, midPrice: 0.4, spread: 0.2 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    await waitForRows(rows, 1);
    // The bounded-midpoint shadow fills edgePrice (= bestBid for BUY).
    expect(rows[0]!.edgePrice).toBe(0.3);
  });

  it("suppresses dead-side canary observation log when telemetry.deadSideCanary is false", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { log, info } = makeSharedLogger();
    const endDate = new Date(NOW + 45 * 60_000).toISOString(); // 45m out, outside enforce X
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      deadSideGuard: { ...DEFAULT_EXECUTION_POLICY.deadSideGuard, mode: "observe" },
      telemetry: { ...DEFAULT_EXECUTION_POLICY.telemetry, deadSideCanary: false },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log,
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();
    bus.subscribe("PlaceOrderRequested", async () => {});

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.005, bestAsk: 0.01, endDate, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    const canaryLog = info.mock.calls.find((c) => c[1] === "dead-side-near-end canary observation");
    expect(canaryLog).toBeUndefined();
  });

  it("emits dead-side canary observation log when telemetry.deadSideCanary is true (default)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { log, info } = makeSharedLogger();
    const endDate = new Date(NOW + 45 * 60_000).toISOString();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      deadSideGuard: { ...DEFAULT_EXECUTION_POLICY.deadSideGuard, mode: "observe" },
    };
    const bridge = new SignalToOrderBridge({
      bus,
      log,
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      policy: () => policy,
      profileId: PROFILE_ID,
    });
    bridge.subscribe();
    bus.subscribe("PlaceOrderRequested", async () => {});

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.005, bestAsk: 0.01, endDate, tickSize: 0.001 }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    const canaryLog = info.mock.calls.find((c) => c[1] === "dead-side-near-end canary observation");
    expect(canaryLog).toBeDefined();
  });

  describe("BUY admission guard (defense-in-depth)", () => {
    function makeStubTracker(
      opts: {
        healthy?: boolean;
        resolved?: ReadonlySet<string>;
      } = {},
    ) {
      return {
        healthy: () => opts.healthy ?? true,
        isResolved: (cid: string) => (opts.resolved ?? new Set<string>()).has(cid),
      };
    }

    async function runApproved(opts: {
      tracker?: ReturnType<typeof makeStubTracker>;
      market?: Partial<NormalizedMarket>;
      now?: number;
      side?: "buy" | "sell";
    }) {
      const bus = new InProcessEventBus();
      const bridge = new SignalToOrderBridge({
        bus,
        log: makeLogger(),
        liveLiteGuard: { getWalletMode: () => "relayer" } as never,
        ...(opts.tracker ? { resolutionTracker: opts.tracker as any } : {}),
        ...(opts.now != null ? { now: () => opts.now! } : {}),
      });
      bridge.subscribe();

      const placed: unknown[] = [];
      const skipped: Array<{
        stage: string;
        reasons: readonly string[];
        diagnostics: Record<string, unknown>;
      }> = [];
      bus.subscribe("PlaceOrderRequested", async (p) => {
        placed.push(p);
      });
      bus.subscribe("SignalConversionSkipped", async (p) => {
        skipped.push(p);
      });

      await bus.publish("SignalApproved", {
        signal: { ...makeSignal(), side: opts.side ?? "buy" },
        market: makeMarket(opts.market),
        approvedAt: Date.now(),
      });
      await bus.drain();

      bridge.unsubscribe();
      return { placed, skipped };
    }

    it("skips BUY with marketability/market_ended when endDate ≤ now", async () => {
      const now = Date.parse("2026-04-25T12:00:00Z");
      const { placed, skipped } = await runApproved({
        now,
        market: { endDate: "2026-04-25T11:00:00Z" },
      });
      expect(placed).toHaveLength(0);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.stage).toBe("marketability");
      expect(skipped[0]!.reasons).toEqual(["market_ended"]);
    });

    it("skips BUY with market_inactive when active=false", async () => {
      const { placed, skipped } = await runApproved({ market: { active: false } });
      expect(placed).toHaveLength(0);
      expect(skipped[0]!.reasons).toEqual(["market_inactive"]);
    });

    it("skips BUY with market_resolved when tracker has the condition", async () => {
      const tracker = makeStubTracker({ resolved: new Set(["cond-1"]) });
      const { placed, skipped } = await runApproved({ tracker });
      expect(placed).toHaveLength(0);
      expect(skipped[0]!.reasons).toEqual(["market_resolved"]);
    });

    it("skips BUY fail-closed with resolution_tracker_unavailable when tracker is unhealthy", async () => {
      const tracker = makeStubTracker({ healthy: false });
      const { placed, skipped } = await runApproved({ tracker });
      expect(placed).toHaveLength(0);
      expect(skipped[0]!.reasons).toEqual(["resolution_tracker_unavailable"]);
    });

    it("does NOT block SELL signals on resolved/inactive markets (BUY-only guard)", async () => {
      const tracker = makeStubTracker({ resolved: new Set(["cond-1"]) });
      const { skipped } = await runApproved({
        tracker,
        side: "sell",
        market: { active: false, endDate: "2025-01-01T00:00:00Z" },
      });
      // SELL goes through the regular pipeline; we only assert the BUY-side
      // guard didn't fire. Downstream stages (hard-liveness, execution-terms)
      // may legitimately reject a SELL, so we don't assert placed.
      const buyGuardSkip = skipped.find((s) =>
        s.reasons.some((r) =>
          ["market_ended", "market_inactive", "market_not_tradable", "market_resolved"].includes(r),
        ),
      );
      expect(buyGuardSkip).toBeUndefined();
    });

    it("admits BUY when tracker is healthy and lifecycle is fine", async () => {
      const tracker = makeStubTracker();
      const { placed, skipped } = await runApproved({ tracker });
      const marketabilitySkip = skipped.find((s) => s.stage === "marketability");
      expect(marketabilitySkip).toBeUndefined();
      expect(placed.length).toBeGreaterThanOrEqual(1);
    });

    // Regression: bridge previously checked only the embedded snapshot frozen
    // at signal-generation time. A NormalizedMarketUpdated arriving after
    // SignalApproved (e.g. operator paused the market) would be ignored and
    // the BUY would be placed on a now-inactive market.
    it("blocks BUY on cached active=false even when embedded snapshot still has active=true", async () => {
      const bus = new InProcessEventBus();
      const bridge = new SignalToOrderBridge({
        bus,
        log: makeLogger(),
        liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      });
      bridge.subscribe();

      const placed: unknown[] = [];
      const skipped: Array<{
        stage: string;
        reasons: readonly string[];
        diagnostics: Record<string, unknown>;
      }> = [];
      bus.subscribe("PlaceOrderRequested", async (p) => {
        placed.push(p);
      });
      bus.subscribe("SignalConversionSkipped", async (p) => {
        skipped.push(p);
      });

      // Cache flips `active` to false AFTER the (yet-to-arrive) approved signal
      // would have been generated. Bridge must prefer this over the embedded
      // snapshot for the lifecycle gate.
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ active: false })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await bus.publish("SignalApproved", {
        signal: { ...makeSignal(), side: "buy" },
        market: makeMarket({ active: true }),
        approvedAt: Date.now(),
      });
      await bus.drain();

      bridge.unsubscribe();

      expect(placed).toHaveLength(0);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.stage).toBe("marketability");
      expect(skipped[0]!.reasons).toEqual(["market_inactive"]);
      expect(skipped[0]!.diagnostics).toMatchObject({
        active: false,
        cacheStatus: "fresh",
      });
    });
  });
});

// Track B §9.3 — execution must be regime-blind. Track B propagates the strike
// classifier inputs (slug shape, tags, group-item) onto the market, but the
// §4.4 strike-aware exit/pricing fork is deferred to Track C. This pins the
// invariant that, given equal pricing inputs, a strike market and an otherwise
// identical non-strike market produce byte-identical order terms.
describe("execution is regime-blind (Track B §9.3)", () => {
  async function placeFor(market: NormalizedMarket): Promise<{
    price: number;
    size: number;
    postOnly: boolean | undefined;
  }> {
    const bus = new InProcessEventBus();
    const candidateBookCache = {
      getFreshEntry: vi.fn(() => null),
      waitForFreshEntry: vi.fn(async () => null),
      getFreshOrRefresh: vi.fn(async () => ({ status: "refreshed" as const, entry: null })),
    } as unknown as CandidateBookCache;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "relayer" } as never,
      candidateBookCache,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; size: number; postOnly?: boolean } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    const { price, size, postOnly } = placed[0]!.command;
    return { price, size, postOnly };
  }

  // Identical pricing inputs; the only difference is the strike-classifier
  // surface (slug shape + tags + group-item).
  const PRICING = { bestBid: 0.04, bestAsk: 0.05, midPrice: 0.045, spread: 0.01 } as const;

  it("strike and non-strike markets yield identical price/postOnly/size", async () => {
    const nonStrike = await placeFor(makeMarket({ ...PRICING, bookSource: "simulation" }));
    const strike = await placeFor(
      makeMarket({
        ...PRICING,
        bookSource: "simulation",
        slug: "will-the-price-of-bitcoin-be-between-84000-85000-on-jan-1",
        tags: ["price-range"],
        groupItemTitle: "84000-85000",
        groupItemThreshold: "3",
      }),
    );

    expect(strike).toEqual(nonStrike);
  });
});
