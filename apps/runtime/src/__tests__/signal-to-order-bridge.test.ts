import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  createConditionId,
  createOrderId,
  createTokenId,
  type ConditionId,
  type NormalizedMarket,
  type Order,
  type Signal,
} from "@plankton/domain";
import { SignalToOrderBridge } from "../modules/strategy/signal-to-order.js";
import { CandidateBookCache } from "../modules/strategy/candidate-book-cache.js";

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
    endDate: "2026-04-11T23:59:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
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

  it("keeps token in cooldown when the book did not materially move", async () => {
    const bus = new InProcessEventBus();
    const order = makeEntryOrder();
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

    const skipped: Array<{ reasons: readonly string[] }> = [];
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload);
    });

    const market = makeMarket({
      bestBid: 0.03,
      bestAsk: 0.04,
      midPrice: 0.035,
      spread: 0.01,
      bookSource: "clob",
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market,
      approvedAt: Date.now(),
    });
    await bus.drain();

    // Fallback policy maxUnfilledCancelsBeforeCooldown=3 → cooldown kicks in
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("token-cooling-down");
  });

  it("bypasses cooldown when top-of-book materially moved and emits the bypass reason", async () => {
    const bus = new InProcessEventBus();
    const order = makeEntryOrder();
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

    const bypasses: Array<{ reason: string }> = [];
    const placed: Array<{ command: { price: number } }> = [];
    bus.subscribe("CooldownBypassApplied", async (payload) => {
      bypasses.push(payload);
    });
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.03,
          bestAsk: 0.04,
          midPrice: 0.035,
          spread: 0.01,
          bookSource: "clob",
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-1" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.04,
          bestAsk: 0.05,
          midPrice: 0.045,
          spread: 0.01,
          bookSource: "clob",
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      market: makeMarket({
        bestBid: 0.04,
        bestAsk: 0.05,
        midPrice: 0.045,
        spread: 0.01,
        bookSource: "clob",
      }),
      approvedAt: Date.now(),
    });
    await bus.drain();

    // Fallback policy maxUnfilledCancelsBeforeCooldown=3 → cooldown set, then bypass on book move
    expect(bypasses).toHaveLength(1);
    expect(placed).toHaveLength(1);
  });

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

  it.each<[string, Partial<NormalizedMarket>, string]>([
    ["acceptingOrders=false", { acceptingOrders: false }, "not_accepting_orders"],
    ["enableOrderBook=false", { enableOrderBook: false }, "order_book_disabled"],
    ["bestBid=null", { bestBid: null }, "no_bid"],
  ])("%s skips with hard-liveness reason", async (_, patch, reason) => {
    const { bus, conversionSkipped, placeOrderRequested } = makeBridgeWithLiveLite();
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
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
      signal: makeSignal(),
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
      signal: makeSignal(),
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
        signal: makeSignal(),
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
        signal: makeSignal(),
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
