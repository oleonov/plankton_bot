import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  createConditionId,
  createFamilyId,
  createOrderId,
  createTokenId,
  type ConditionId,
  type NormalizedMarket,
  type Order,
  type Signal,
} from "@plankton/domain";
import { SignalToOrderBridge } from "../modules/strategy/signal-to-order.js";
import { CandidateBookCache } from "../modules/strategy/candidate-book-cache.js";

const FAMILY_ID = createFamilyId("bitcoin-price:generic:daily");
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
    familyId: FAMILY_ID,
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
    familyId: FAMILY_ID,
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
    familyId: FAMILY_ID,
    familyKey: "bitcoin-price",
    regime: "price-range",
    horizon: "daily",
    endDate: "2026-04-11T23:59:00.000Z",
    active: true,
    tickSize: 0.01,
    negRisk: false,
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
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.04);
    expect(candidateBookCache.waitForFreshEntry as any).toHaveBeenCalledTimes(1);
    expect(candidateBookCache.getFreshOrRefresh as any).not.toHaveBeenCalled();
  });

  it("refreshes stale clob books for hot entry families before marketability rejection", async () => {
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
          familyKey: "donald-trump-of-truth-social-posts",
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
        familyId: createFamilyId("donald-trump-of-truth-social-posts:social-activity:ad-hoc"),
      },
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
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
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
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "ttl-expired",
      familyId: FAMILY_ID,
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
      signalReason: "spray-entry",
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
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "entry-reprice-cancel",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "entry-reprice-cancel",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 3.75,
        suggestedPrice: 0.035,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });
});
