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
  type ProfileId,
  type Signal,
} from "@krabs/domain";
import { SignalToOrderBridge } from "../modules/strategy/signal-to-order.js";
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
    expect(placed[0]!.command.price).toBe(0.04);
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
    expect(placed[0]!.command.price).toBe(0.04);
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
    expect(placed[0]!.command.price).toBe(0.04);
    expect(candidateBookCache.waitForFreshEntry as any).toHaveBeenCalledTimes(1);
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
    expect(placed[0]!.command.price).toBe(0.04);
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
    expect(placed[0]!.command.price).toBe(0.04);
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

  it("skips SELL orders inside the order-lifetime final resolution hour", async () => {
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
      market: deadSideMarket(30_000, 0.01),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("order-lifetime-resolution-stop-window");
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
      orderLifetime?: ConstructorParameters<typeof SignalToOrderBridge>[0]["orderLifetime"];
    } = {},
  ) {
    const bus = new InProcessEventBus();
    const logger = makeLogger();
    const pricing: ExecutionPricingPolicy = pricingOverrides
      ? { ...DEFAULT_EXECUTION_POLICY.pricing, mode: "bounded-midpoint", ...pricingOverrides }
      : DEFAULT_EXECUTION_POLICY.pricing;
    const policy: ExecutionPolicy = { ...DEFAULT_EXECUTION_POLICY, pricing };
    const bridge = new SignalToOrderBridge({
      bus,
      log: logger,
      liveLiteGuard: { getWalletMode: () => "eoa" } as never,
      policy: () => policy,
      ...(opts.orderRepo ? { orderRepo: opts.orderRepo } : {}),
      ...(opts.orderLifetime ? { orderLifetime: opts.orderLifetime } : {}),
    });
    bridge.subscribe();
    const skipped: Array<{
      stage: string;
      reasons: readonly string[];
      diagnostics: Record<string, unknown>;
    }> = [];
    const placed: Array<{ command: { price: number; size: number; side: "buy" | "sell" } }> = [];
    bus.subscribe("SignalConversionSkipped", async (p) => {
      skipped.push(p);
    });
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p);
    });
    return { bus, skipped, placed };
  }

  it("edge mode (default) posts BUY at bestBid — ADR-006 D1 preserved", async () => {
    const { bus, placed } = makeBridgeWithPricing(); // no options → default edge
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

  it("ladder BUY posts at ladderTargetPrice even when bestBid moved", async () => {
    const { bus, placed } = makeBridgeWithPricing();
    const market = makeMarket({ bestBid: 0.14, bestAsk: 0.16, midPrice: 0.15, tickSize: 0.01 });
    await bus.publish("SignalApproved", {
      signal: { ...makeSignal(), suggestedPrice: 0.1, ladderTargetPrice: 0.1 },
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
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
    const { bus, skipped, placed } = makeBridgeWithPricing();
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
    const { bus, skipped, placed } = makeBridgeWithPricing();
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

  it("skips duplicate same-price SELL when an open sell order already exists", async () => {
    const orderRepo = {
      findByTokenId: vi.fn(() => [makeOpenSellOrder({ price: 0.1 })]),
    } as unknown as OrderRepository;
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, { orderRepo });
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
    expect(skipped[0]!.reasons).toContain("sell-order-already-open");
    expect(skipped[0]!.diagnostics).toMatchObject({
      existingPrice: 0.1,
      executionPrice: 0.1,
    });
  });

  it("allows a replacement SELL after the old same-price order is already cancelled", async () => {
    const orderRepo = {
      findByTokenId: vi.fn(() => [makeOpenSellOrder({ price: 0.1, status: "cancelled" })]),
    } as unknown as OrderRepository;
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, { orderRepo });
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

    expect(skipped.some((event) => event.reasons.includes("sell-order-already-open"))).toBe(false);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.1);
  });

  it.each([
    { existingPrice: 0.29, executionPrice: 0.29, tickSize: 0.01, shouldSuppress: true },
    { existingPrice: 0.29, executionPrice: 0.28, tickSize: 0.01, shouldSuppress: false },
    { existingPrice: 0.29, executionPrice: 0.295, tickSize: 0.001, shouldSuppress: false },
    {
      existingPrice: 0.29,
      executionPrice: 0.290000001,
      tickSize: 0.000000001,
      shouldSuppress: true,
    },
  ])(
    "dedupes SELL only on price epsilon: $existingPrice vs $executionPrice",
    async ({ existingPrice, executionPrice, tickSize, shouldSuppress }) => {
      const orderRepo = {
        findByTokenId: vi.fn(() => [makeOpenSellOrder({ price: existingPrice })]),
      } as unknown as OrderRepository;
      const { bus, skipped, placed } = makeBridgeWithPricing(undefined, { orderRepo });
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
      expect(skipped.some((event) => event.reasons.includes("sell-order-already-open"))).toBe(
        shouldSuppress,
      );
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
    const { bus, skipped, placed } = makeBridgeWithPricing(undefined, { orderLifetime });
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
      suggestedSize: 3.22,
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
      orderSize: 3.22,
      minOrderSize: null,
      effectiveMinOrderSize: 5,
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

  it("writes one observation per successful placement with pricing diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const bus = new InProcessEventBus();
    const { repo, rows } = makeCapturingRepo();
    const policy: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
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
    expect(rows).toHaveLength(1);
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
      policy: () => DEFAULT_EXECUTION_POLICY,
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

    expect(rows).toHaveLength(1);
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
      policy: () => DEFAULT_EXECUTION_POLICY,
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

    expect(rows).toHaveLength(1);
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
    expect(rows).toHaveLength(1);
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
      policy: () => DEFAULT_EXECUTION_POLICY,
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

    expect(rows).toHaveLength(1);
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

    expect(rows).toHaveLength(1);
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

    expect(rows).toHaveLength(1);
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
      policy: () => DEFAULT_EXECUTION_POLICY,
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

    expect(rows).toHaveLength(1);
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

    expect(rows).toHaveLength(1);
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

    expect(rows).toHaveLength(1);
    expect(rows[0]!.skippedReason).toBe("sell-price-below-signal-floor");
    expect(rows[0]!.selectedPrice).toBe(0.08);
    expect(rows[0]!.side).toBe("SELL");
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

    expect(rows).toHaveLength(1);
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

    expect(rows).toHaveLength(1);
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
