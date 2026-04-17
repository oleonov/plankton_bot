import { afterEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  createConditionId,
  createFamilyId,
  createOrderId,
  createTokenId,
  type FamilyRuleBundle,
  type NormalizedMarket,
  type Order,
  type OrderBookSnapshot,
  type Signal,
} from "@plankton/domain";
import { CandidateBookCache } from "../modules/strategy/candidate-book-cache.js";
import {
  HotFamilyExecutionModule,
  resolveNextDustSuppressBackoffMs,
} from "../modules/hot-lane/hot-family-execution-module.js";
import { HotQuoteBusModule } from "../modules/hot-lane/hot-quote-bus-module.js";
import { FastExitCleanupModule } from "../modules/hot-lane/fast-exit-cleanup-module.js";
import { HotMarketDataModule } from "../modules/hot-lane/hot-market-data-module.js";
import { runHotLaneReplay } from "../modules/hot-lane/replay-harness.js";

const FAMILY_ID = createFamilyId("who-will-be-next-supreme-leader-of-iran");
const TOKEN_ID = createTokenId("tok-hot");
const TOKEN_ID_2 = createTokenId("tok-hot-2");

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

function makeBundle(): FamilyRuleBundle {
  return {
    identity: {
      familyId: FAMILY_ID,
      familyKey: "who-will-be-next-supreme-leader-of-iran",
      primaryCategory: "geopolitics",
      regime: "threshold",
      horizon: "ad-hoc",
      cadence: "ad-hoc",
      strategyProfile: "event-driven",
      topicKey: null,
      slugPattern: null,
      notes: null,
      feeTier: "fee-free",
      liveWalletRequirement: "eoa-ok",
      requiresPostOnlyForLive: false,
    },
    rules: {
      familyId: FAMILY_ID,
      universe: {
        enabled: true,
        action: "trade",
        priorityRank: 1,
        sessionMode: "active-window",
      },
      entry: {
        entryMode: "probe-first",
        minEntryPrice: 0.01,
        maxEntryPrice: 0.2,
        maxInitialNotionalUsdc: 5,
        allowHighPriceOneShot: false,
        highPriceThreshold: 0.85,
        requireProvenFamilyAbovePrice: 0.2,
        preferredEntryBand: null,
        maxProbeCountPerMarket: null,
        entryCooldownSeconds: null,
        maxNewMarketsPerSession: null,
        probeSizeUsdc: 5,
        addSizeUsdc: 4,
      },
      scaleIn: {
        scaleMode: "confirm-only",
        defaultMaxBuysPerLeg: 3,
        heavyMaxBuysPerLeg: 5,
        allowHeavyCampaigns: true,
        requirePositiveRecycleHistoryForScale: true,
      },
      exit: {
        exitMode: "repricing-sell",
        primaryProfitModel: "sell-into-strength",
        allowRunnerExtension: false,
        preferFastRecycle: true,
        resolutionHoldingAllowed: false,
        resolutionBufferMinutes: 60,
        targetRoiBandLow: 20,
        targetRoiBandHigh: 50,
        maxUnmovedHoldHours: null,
        maxTailHoldHours: null,
      },
      twoSided: {
        allowTwoSided: false,
        twoSidedMode: "disabled",
        minActivityForTwoSided: null,
      },
      throughput: {
        maxConcurrentOrdersPerFamily: 10,
        maxProbeInFlightPerToken: 2,
        maxEntrySignalsPerTickPerFamily: 10,
        fastLaneEnabled: true,
        dustLaneEnabled: true,
      },
      tailSuppression: {
        maxOpenValueUsdc: 75,
        maxActiveMarkets: 100,
        maxDustPositions: 3,
        tailQuarantineThresholdUsdc: 50,
        tailQuarantineThresholdRatio: 0.5,
        staleTailPruneEnabled: true,
        thresholdCleanupRequired: false,
        autoSettleResolvedMarkets: true,
      },
      session: {
        activeWindowsUtc: [{ start: "00:00", end: "23:59" }],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
      },
    },
  };
}

function makeMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: TOKEN_ID,
    conditionId: "cond-1",
    slug: "iran",
    eventSlug: null,
    question: "Iran",
    outcome: "YES",
    outcomeIndex: 0,
    familyId: FAMILY_ID,
    familyKey: "who-will-be-next-supreme-leader-of-iran",
    regime: "threshold",
    horizon: "ad-hoc",
    endDate: "2026-04-12T00:00:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    bestBid: 0.03,
    bestAsk: 0.04,
    midPrice: 0.035,
    spread: 0.01,
    lastTradePrice: 0.06,
    lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
    volume24h: 100_000,
    liquidity: 10_000,
    minOrderSize: 5,
    bookSource: "clob",
    snapshotTs: Date.now(),
    ...overrides,
  };
}

function makeOpenOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-hot"),
    clientOrderId: "client-hot" as never,
    tokenId: TOKEN_ID,
    conditionId: createConditionId("cond-1"),
    familyId: FAMILY_ID,
    side: "buy",
    orderType: "GTC",
    postOnly: true,
    price: 0.03,
    size: 5,
    sizeUsdc: 0.15,
    status: "open",
    exchangeOrderId: "ex-hot",
    signalId: null,
    signalReason: "spray-entry",
    botRunId: "bot-run-1" as never,
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveNextDustSuppressBackoffMs", () => {
  it("backs off progressively when price has not moved and resets when it does", () => {
    expect(resolveNextDustSuppressBackoffMs(null, 0.02, 0.001)).toBe(3_000);
    expect(
      resolveNextDustSuppressBackoffMs({ referencePrice: 0.02, backoffMs: 3_000 }, 0.02, 0.001),
    ).toBe(6_000);
    expect(
      resolveNextDustSuppressBackoffMs({ referencePrice: 0.02, backoffMs: 6_000 }, 0.02, 0.001),
    ).toBe(12_000);
    expect(
      resolveNextDustSuppressBackoffMs({ referencePrice: 0.02, backoffMs: 12_000 }, 0.021, 0.001),
    ).toBe(1_000);
  });
});

describe("HotFamilyExecutionModule", () => {
  it("publishes hot-lane state transitions across quote, reprice, and cooling states", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const openOrder = makeOpenOrder({
      orderId: createOrderId("ord-stateful"),
      price: 0.05,
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    });
    let headSize = 20;
    const orderRepo = {
      findOpen: vi.fn(() => [openOrder]),
    } as never;
    const gateway = {
      getOrderBooks: vi.fn(async () => {
        const book: OrderBookSnapshot = {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.05, size: headSize }],
          asks: [{ price: 0.08, size: 100 }],
          bestBid: 0.05,
          bestAsk: 0.08,
          midPrice: 0.065,
          spread: 0.03,
          minOrderSize: 5,
          timestamp: Date.now(),
        };
        return new Map([[String(TOKEN_ID), book]]);
      }),
    };
    const cache = new CandidateBookCache({ gateway, log: makeLogger() });
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotFamilyExecutionModule({
      bus,
      rulesProvider: rulesProvider as never,
      orderRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 500, dustEntryRepriceIntervalMs: 0 },
    });

    const states: string[] = [];
    bus.subscribe("HotLaneStateChanged", async (payload) => {
      states.push(payload.nextState);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(),
          bestBid: 0.05,
          bestAsk: 0.08,
          midPrice: 0.065,
          spread: 0.03,
          lastTradePrice: 0.05,
        },
      ],
      timestamp: Date.now(),
    });
    await cache.prime([String(TOKEN_ID)]);
    await bus.publish("OrderPlaced", {
      commandId: "cmd-state-1" as never,
      clientOrderId: "client-state-1" as never,
      orderId: openOrder.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "buy",
      price: openOrder.price,
      size: openOrder.size,
      orderType: "GTC",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });

    headSize = 120;
    await cache.prime([String(TOKEN_ID)]);
    await vi.advanceTimersByTimeAsync(600);
    await bus.publish("OrderCancelled", {
      commandId: "cmd-state-cancel" as never,
      orderId: openOrder.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "entry-reprice-cancel",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });
    await bus.drain();
    await mod.stop();

    expect(states).toContain("quote-active");
    expect(states).toContain("needs-reprice");
    expect(states).toContain("cooling");
  });

  it("cancels dust orders that lost queue position", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const openOrder = makeOpenOrder();
    const orderRepo = {
      findOpen: vi.fn(() => [openOrder]),
    } as never;
    const gateway = {
      getOrderBooks: vi.fn(async () => {
        const book: OrderBookSnapshot = {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.05, size: 100 }],
          asks: [{ price: 0.06, size: 100 }],
          bestBid: 0.05,
          bestAsk: 0.06,
          midPrice: 0.055,
          spread: 0.01,
          minOrderSize: 5,
          timestamp: Date.now(),
        };
        return new Map([[String(TOKEN_ID), book]]);
      }),
    };
    const cache = new CandidateBookCache({ gateway, log: makeLogger() });
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotFamilyExecutionModule({
      bus,
      rulesProvider: rulesProvider as never,
      orderRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 1_000, dustEntryRepriceIntervalMs: 0 },
    });

    const cancels: Array<{ command: { reason: string } }> = [];
    bus.subscribe("CancelOrderRequested", async (payload) => {
      cancels.push(payload);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await cache.prime([String(TOKEN_ID)]);
    await vi.advanceTimersByTimeAsync(1_100);
    await bus.drain();
    await mod.stop();

    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.command.reason).toBe("entry-reprice-cancel");
  });

  it("cancels dust orders when queue pressure explodes at the same best bid", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const openOrder = makeOpenOrder({
      price: 0.05,
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    });
    let headSize = 20;
    const orderRepo = {
      findOpen: vi.fn(() => [openOrder]),
    } as never;
    const gateway = {
      getOrderBooks: vi.fn(async () => {
        const book: OrderBookSnapshot = {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.05, size: headSize }],
          asks: [{ price: 0.08, size: 100 }],
          bestBid: 0.05,
          bestAsk: 0.08,
          midPrice: 0.065,
          spread: 0.03,
          minOrderSize: 5,
          timestamp: Date.now(),
        };
        return new Map([[String(TOKEN_ID), book]]);
      }),
    };
    const cache = new CandidateBookCache({ gateway, log: makeLogger() });
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotFamilyExecutionModule({
      bus,
      rulesProvider: rulesProvider as never,
      orderRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 1_000, dustEntryRepriceIntervalMs: 0 },
    });

    const cancels: Array<{ command: { reason: string } }> = [];
    bus.subscribe("CancelOrderRequested", async (payload) => {
      cancels.push(payload);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(),
          bestBid: 0.05,
          bestAsk: 0.08,
          midPrice: 0.065,
          spread: 0.03,
          lastTradePrice: 0.05,
        },
      ],
      timestamp: Date.now(),
    });
    await cache.prime([String(TOKEN_ID)]);
    await bus.publish("OrderPlaced", {
      commandId: "cmd-hot" as never,
      clientOrderId: "client-hot" as never,
      orderId: openOrder.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "buy",
      price: 0.05,
      size: openOrder.size,
      orderType: "GTC",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });
    headSize = 120;
    await cache.prime([String(TOKEN_ID)]);
    await vi.advanceTimersByTimeAsync(1_100);
    await bus.drain();
    await mod.stop();

    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.command.reason).toBe("entry-reprice-cancel");
  });

  it("limits maintenance to the bounded hot-token set", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const firstOrder = makeOpenOrder({
      orderId: createOrderId("ord-hot-1"),
      tokenId: TOKEN_ID,
      price: 0.03,
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const secondOrder = makeOpenOrder({
      orderId: createOrderId("ord-hot-2"),
      tokenId: TOKEN_ID_2,
      price: 0.03,
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    });
    const orderRepo = {
      findOpen: vi.fn(() => [firstOrder, secondOrder]),
    } as never;
    const gateway = {
      getOrderBooks: vi.fn(async () => {
        const books = new Map<string, OrderBookSnapshot>();
        books.set(String(TOKEN_ID), {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.05, size: 100 }],
          asks: [{ price: 0.06, size: 100 }],
          bestBid: 0.05,
          bestAsk: 0.06,
          midPrice: 0.055,
          spread: 0.01,
          minOrderSize: 5,
          timestamp: Date.now(),
        });
        books.set(String(TOKEN_ID_2), {
          tokenId: TOKEN_ID_2,
          bids: [{ price: 0.09, size: 100 }],
          asks: [{ price: 0.1, size: 100 }],
          bestBid: 0.09,
          bestAsk: 0.1,
          midPrice: 0.095,
          spread: 0.01,
          minOrderSize: 5,
          timestamp: Date.now(),
        });
        return books;
      }),
    };
    const cache = new CandidateBookCache({ gateway, log: makeLogger() });
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotFamilyExecutionModule({
      bus,
      rulesProvider: rulesProvider as never,
      orderRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: {
        hotQuoteRefreshIntervalMs: 1_000,
        dustEntryRepriceIntervalMs: 0,
        maxTokensPerCycle: 1,
      },
    });

    const cancels: Array<{ command: { orderId: string; reason: string } }> = [];
    bus.subscribe("CancelOrderRequested", async (payload) => {
      cancels.push(payload as never);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenId: TOKEN_ID, bestBid: 0.05, bestAsk: 0.06, midPrice: 0.055 }),
        makeMarket({
          tokenId: TOKEN_ID_2,
          conditionId: "cond-2",
          bestBid: 0.09,
          bestAsk: 0.1,
          midPrice: 0.095,
        }),
      ],
      timestamp: Date.now(),
    });
    await cache.prime([String(TOKEN_ID), String(TOKEN_ID_2)]);
    await vi.advanceTimersByTimeAsync(1_100);
    await bus.drain();
    await mod.stop();

    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.command.orderId).toBe(String(firstOrder.orderId));
    expect(cancels[0]!.command.reason).toBe("entry-reprice-cancel");
  });

  it("throttles repeated entry reprices for the same token across quick replacements", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    let currentOrder = makeOpenOrder({
      orderId: createOrderId("order-1"),
      price: 0.05,
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    });
    let headSize = 20;
    const orderRepo = {
      findOpen: vi.fn(() => [currentOrder]),
    } as never;
    const gateway = {
      getOrderBooks: vi.fn(async () => {
        const book: OrderBookSnapshot = {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.05, size: headSize }],
          asks: [{ price: 0.08, size: 100 }],
          bestBid: 0.05,
          bestAsk: 0.08,
          midPrice: 0.065,
          spread: 0.03,
          minOrderSize: 5,
          timestamp: Date.now(),
        };
        return new Map([[String(TOKEN_ID), book]]);
      }),
    };
    const cache = new CandidateBookCache({ gateway, log: makeLogger() });
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotFamilyExecutionModule({
      bus,
      rulesProvider: rulesProvider as never,
      orderRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: {
        hotQuoteRefreshIntervalMs: 500,
        dustEntryRepriceIntervalMs: 0,
        minRepriceCancelIntervalMs: 3_000,
      },
    });

    const cancels: Array<{ command: { reason: string } }> = [];
    bus.subscribe("CancelOrderRequested", async (payload) => {
      cancels.push(payload);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(),
          bestBid: 0.05,
          bestAsk: 0.08,
          midPrice: 0.065,
          spread: 0.03,
          lastTradePrice: 0.05,
        },
      ],
      timestamp: Date.now(),
    });
    await cache.prime([String(TOKEN_ID)]);
    await bus.publish("OrderPlaced", {
      commandId: "cmd-hot-1" as never,
      clientOrderId: "client-hot-1" as never,
      orderId: currentOrder.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "buy",
      price: 0.05,
      size: currentOrder.size,
      orderType: "GTC",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });

    headSize = 120;
    await cache.prime([String(TOKEN_ID)]);
    await vi.advanceTimersByTimeAsync(600);
    await bus.drain();

    expect(cancels).toHaveLength(1);

    await bus.publish("OrderCancelled", {
      commandId: "cmd-cancel-1" as never,
      orderId: currentOrder.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      reason: "entry-reprice-cancel",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });
    currentOrder = makeOpenOrder({
      orderId: createOrderId("order-2"),
      price: 0.05,
      createdAt: new Date(Date.now() - 2_000).toISOString(),
    });
    await bus.publish("OrderPlaced", {
      commandId: "cmd-hot-2" as never,
      clientOrderId: "client-hot-2" as never,
      orderId: currentOrder.orderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "buy",
      price: 0.05,
      size: currentOrder.size,
      orderType: "GTC",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await bus.drain();
    await mod.stop();

    expect(cancels).toHaveLength(1);
  });
});

describe("HotQuoteBusModule", () => {
  it("publishes refreshed hot quote batches", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const gateway = {
      getOrderBooks: vi.fn(async () => {
        const book: OrderBookSnapshot = {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.05, size: 100 }],
          asks: [{ price: 0.06, size: 100 }],
          bestBid: 0.05,
          bestAsk: 0.06,
          midPrice: 0.055,
          spread: 0.01,
          minOrderSize: 5,
          timestamp: Date.now(),
        };
        return new Map([[String(TOKEN_ID), book]]);
      }),
    };
    const cache = new CandidateBookCache({ gateway, log: makeLogger() });
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const orderRepo = { findOpen: vi.fn(() => [makeOpenOrder()]) } as never;
    const mod = new HotQuoteBusModule({
      bus,
      rulesProvider: rulesProvider as never,
      orderRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 500 },
    });

    const hotQuotes: Array<{ tokenIds: readonly string[] }> = [];
    bus.subscribe("HotQuoteUpdated", async (payload) => {
      hotQuotes.push({ tokenIds: payload.tokenIds.map(String) });
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(600);
    await bus.drain();
    await mod.stop();

    expect(gateway.getOrderBooks).toHaveBeenCalled();
    expect(hotQuotes.length).toBeGreaterThanOrEqual(1);
    expect(hotQuotes.some((entry) => entry.tokenIds.includes(String(TOKEN_ID)))).toBe(true);
  });
});

describe("FastExitCleanupModule", () => {
  it("emits repricing exits for open spray positions without a sell order", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const gateway = {
      getOrderBooks: vi.fn(async () => {
        const book: OrderBookSnapshot = {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.05, size: 100 }],
          asks: [{ price: 0.06, size: 100 }],
          bestBid: 0.05,
          bestAsk: 0.06,
          midPrice: 0.055,
          spread: 0.01,
          minOrderSize: 5,
          timestamp: Date.now(),
        };
        return new Map([[String(TOKEN_ID), book]]);
      }),
    };
    const cache = new CandidateBookCache({ gateway, log: makeLogger() });
    await cache.prime([String(TOKEN_ID)]);

    const positionRepo = {
      findOpen: vi.fn(() => [
        {
          positionId: "pos-1" as never,
          tokenId: TOKEN_ID,
          familyId: FAMILY_ID,
          side: "buy",
          size: 5,
          avgEntryPrice: 0.04,
          costBasisUsdc: 0.2,
          currentValueUsdc: null,
          realizedPnl: 0,
          status: "open",
          entryStyle: "spray",
          openedAt: new Date(Date.now() - 30_000).toISOString(),
          closedAt: null,
          updatedAt: new Date().toISOString(),
        },
      ]),
    } as never;
    const orderRepo = { findOpen: vi.fn(() => []) } as never;
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new FastExitCleanupModule({
      bus,
      rulesProvider: rulesProvider as never,
      positionRepo,
      orderRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 500 },
    });

    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(600);
    await bus.drain();
    await mod.stop();

    expect(signals).toHaveLength(1);
    expect(signals[0]!.reason).toBe("repricing-exit");
    expect(signals[0]!.side).toBe("sell");
  });

  it("uses family-specific fast-exit intervals instead of a single global timer", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const cache = new CandidateBookCache({
      gateway: { getOrderBooks: vi.fn(async () => new Map()) },
      log: makeLogger(),
    });
    const positionRepo = {
      findOpen: vi.fn(() => [
        {
          positionId: "pos-1" as never,
          tokenId: TOKEN_ID,
          familyId: FAMILY_ID,
          side: "buy",
          size: 5,
          avgEntryPrice: 0.04,
          costBasisUsdc: 0.2,
          currentValueUsdc: null,
          realizedPnl: 0,
          status: "open",
          entryStyle: "spray",
          openedAt: new Date(Date.now() - 30_000).toISOString(),
          closedAt: null,
          updatedAt: new Date().toISOString(),
        },
      ]),
    } as never;
    const orderRepo = { findOpen: vi.fn(() => []) } as never;
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new FastExitCleanupModule({
      bus,
      rulesProvider: rulesProvider as never,
      positionRepo,
      orderRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 500 },
    });

    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(600);
    await bus.drain();
    await vi.advanceTimersByTimeAsync(600);
    await bus.drain();
    await vi.advanceTimersByTimeAsync(500);
    await bus.drain();
    await mod.stop();

    expect(signals).toHaveLength(2);
  });
});

describe("runHotLaneReplay", () => {
  it("reports suppressions after repeated dust ttl cancels", () => {
    const startMs = Date.now();
    const result = runHotLaneReplay({
      order: makeOpenOrder({ createdAt: new Date(startMs - 20_000).toISOString() }),
      bundle: makeBundle(),
      policy: { dustRepriceSuppressAfter: 2 },
      frames: [
        { nowMs: startMs, market: makeMarket() },
        { nowMs: startMs + 30_000, market: makeMarket() },
      ],
    });

    expect(result.cancels).toBe(2);
    expect(result.suppressions).toBe(1);
  });

  it("uses ask-side queue baselines for repricing exits", () => {
    const startMs = Date.now();
    const result = runHotLaneReplay({
      order: makeOpenOrder({
        side: "sell",
        signalReason: "repricing-exit",
        price: 0.05,
        sizeUsdc: 0.25,
        createdAt: new Date(startMs - 9_000).toISOString(),
      }),
      bundle: makeBundle(),
      policy: {
        dustExitRepriceIntervalMs: 0,
        queuePressureSizeMultiple: 2,
        queuePressureAbsoluteShares: 10,
      },
      frames: [
        {
          nowMs: startMs,
          market: {
            ...makeMarket(),
            bestBid: 0.03,
            bestAsk: 0.05,
            lastTradePrice: 0.05,
            midPrice: 0.04,
          },
          book: {
            tokenId: TOKEN_ID,
            bids: [{ price: 0.03, size: 10 }],
            asks: [{ price: 0.05, size: 10 }],
            bestBid: 0.03,
            bestAsk: 0.05,
            midPrice: 0.04,
            spread: 0.02,
            minOrderSize: 5,
            timestamp: startMs,
          },
        },
        {
          nowMs: startMs + 1_000,
          market: {
            ...makeMarket(),
            bestBid: 0.03,
            bestAsk: 0.05,
            lastTradePrice: 0.05,
            midPrice: 0.04,
          },
          book: {
            tokenId: TOKEN_ID,
            bids: [{ price: 0.03, size: 10 }],
            asks: [{ price: 0.05, size: 60 }],
            bestBid: 0.03,
            bestAsk: 0.05,
            midPrice: 0.04,
            spread: 0.02,
            minOrderSize: 5,
            timestamp: startMs + 1_000,
          },
        },
      ],
    });

    expect(result.reprices).toBe(1);
    expect(result.actions[1]?.reason).toBe("exit-reprice-cancel");
    expect(result.actions[1]?.desiredPrice).toBe(0.04);
  });

  it("reports fill-rate and recycle latency metrics", () => {
    const startMs = Date.now();
    const result = runHotLaneReplay({
      order: makeOpenOrder({ createdAt: new Date(startMs - 5_000).toISOString() }),
      bundle: makeBundle(),
      frames: [
        { nowMs: startMs, market: makeMarket() },
        { nowMs: startMs + 2_000, market: makeMarket(), fillOccurred: true },
      ],
    });

    expect(result.orderCount).toBe(1);
    expect(result.fills).toBe(1);
    expect(result.fillRate).toBe(1);
    expect(result.avgFillLatencyMs).toBe(7_000);
    expect(result.avgRecycleLatencyMs).toBe(7_000);
    expect(result.tailOpenOrdersAtEnd).toBe(0);
  });
});

describe("HotMarketDataModule", () => {
  it("publishes fast normalized updates for hot families without waiting for the 5s poll", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const gateway = {
      getMarketPricing: vi.fn(
        async () =>
          new Map([
            [
              String(TOKEN_ID),
              {
                bestBid: 0.08,
                bestAsk: 0.09,
                lastTradePrice: 0.085,
                lastTradeAt: new Date(Date.now()).toISOString(),
                volume24h: 200_000,
                liquidity: 50_000,
                minOrderSize: 5,
                bookSource: "clob",
              },
            ],
          ]),
      ),
    };
    const orderRepo = {
      findOpen: vi.fn(() => []),
    } as never;
    const positionRepo = {
      findOpen: vi.fn(() => []),
    } as never;
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotMarketDataModule({
      bus,
      gateway: gateway as never,
      rulesProvider: rulesProvider as never,
      orderRepo,
      positionRepo,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 500 },
    });

    const updates: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async ({ markets }) => {
      updates.push([...markets]);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await bus.drain();
    updates.length = 0;

    await vi.advanceTimersByTimeAsync(600);
    await bus.drain();
    await mod.stop();

    expect(gateway.getMarketPricing).toHaveBeenCalledWith([String(TOKEN_ID)]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]?.bestBid).toBe(0.08);
    expect(updates[0]?.[0]?.bestAsk).toBe(0.09);
    expect(updates[0]?.[0]?.lastTradePrice).toBe(0.085);
  });

  it("uses market pricing stream updates and seeds candidate book cache for hot families", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    let streamHandlers:
      | {
          onUpdates: (
            updates: ReadonlyArray<{
              tokenId: string;
              pricing: {
                bestBid: number | null;
                bestAsk: number | null;
                lastTradePrice: number | null;
                lastTradeAt?: string | null;
                volume24h?: number | null;
                liquidity?: number | null;
                minOrderSize?: number | null;
                bookSource?: "clob" | "gamma" | "gamma-fallback" | "simulation" | "unknown" | null;
              };
              book?: OrderBookSnapshot | null;
            }>,
          ) => Promise<void> | void;
          onError?: ((error: unknown) => Promise<void> | void) | undefined;
        }
      | undefined;
    const stream = {
      setTokenIds: vi.fn(),
      close: vi.fn(),
    };
    const gateway = {
      getMarketPricing: vi.fn(async () => new Map()),
      createMarketPricingStream: vi.fn((handlers) => {
        streamHandlers = handlers;
        return stream;
      }),
    };
    const cache = new CandidateBookCache({
      gateway: { getOrderBooks: vi.fn(async () => new Map()) },
      log: makeLogger(),
    });
    const orderRepo = {
      findOpen: vi.fn(() => []),
    } as never;
    const positionRepo = {
      findOpen: vi.fn(() => []),
    } as never;
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotMarketDataModule({
      bus,
      gateway: gateway as never,
      rulesProvider: rulesProvider as never,
      orderRepo,
      positionRepo,
      candidateBookCache: cache,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 500 },
    });

    const updates: NormalizedMarket[][] = [];
    bus.subscribe("NormalizedMarketUpdated", async ({ markets }) => {
      updates.push([...markets]);
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await bus.drain();
    updates.length = 0;

    await vi.advanceTimersByTimeAsync(600);
    expect(stream.setTokenIds).toHaveBeenCalledWith([String(TOKEN_ID)]);

    await streamHandlers?.onUpdates([
      {
        tokenId: String(TOKEN_ID),
        pricing: {
          bestBid: 0.08,
          bestAsk: 0.09,
          lastTradePrice: 0.085,
          lastTradeAt: new Date(Date.now()).toISOString(),
          volume24h: 200_000,
          liquidity: 50_000,
          minOrderSize: 5,
          bookSource: "clob",
        },
        book: {
          tokenId: TOKEN_ID,
          bids: [{ price: 0.08, size: 10 }],
          asks: [{ price: 0.09, size: 20 }],
          bestBid: 0.08,
          bestAsk: 0.09,
          midPrice: 0.085,
          spread: 0.01,
          minOrderSize: 5,
          timestamp: Date.now(),
        },
      },
    ]);
    await bus.drain();
    await mod.stop();

    expect(updates).toHaveLength(1);
    expect(updates[0]?.[0]?.bestBid).toBe(0.08);
    expect(cache.getFreshEntry(String(TOKEN_ID), Date.now())?.book.bestAsk).toBe(0.09);
  });

  it("sets narrow full-book interest for hot, open-order, open-position, and bridge-candidate tokens", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const positionTokenId = createTokenId("tok-hot-pos");
    const bridgeTokenId = createTokenId("tok-hot-bridge");
    const stream = {
      setTokenIds: vi.fn(),
      setFullBookTokenIds: vi.fn(),
      close: vi.fn(),
    };
    const gateway = {
      getMarketPricing: vi.fn(async () => new Map()),
      createMarketPricingStream: vi.fn(() => stream),
    };
    const orderRepo = {
      findOpen: vi.fn(() => [{ tokenId: TOKEN_ID_2 }]),
    } as never;
    const positionRepo = {
      findOpen: vi.fn(() => [{ tokenId: positionTokenId }]),
    } as never;
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotMarketDataModule({
      bus,
      gateway: gateway as never,
      rulesProvider: rulesProvider as never,
      orderRepo,
      positionRepo,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 500 },
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        tokenId: bridgeTokenId,
      } as never,
      approvedAt: Date.now(),
    });
    await bus.drain();

    await vi.advanceTimersByTimeAsync(600);

    expect(stream.setFullBookTokenIds).toHaveBeenCalledWith("hot-set", [String(TOKEN_ID)]);
    expect(stream.setFullBookTokenIds).toHaveBeenCalledWith("open-order", [String(TOKEN_ID_2)]);
    expect(stream.setFullBookTokenIds).toHaveBeenCalledWith("open-position", [
      String(positionTokenId),
    ]);
    expect(stream.setFullBookTokenIds).toHaveBeenCalledWith("bridge-candidate", [
      String(bridgeTokenId),
    ]);

    await mod.stop();
  });

  it("holds the hot stream subscription steady across minor ranking flips until hold window expires", async () => {
    vi.useFakeTimers();
    const bus = new InProcessEventBus();
    const stream = {
      setTokenIds: vi.fn(),
      close: vi.fn(),
    };
    const gateway = {
      getMarketPricing: vi.fn(async () => new Map()),
      createMarketPricingStream: vi.fn(() => stream),
    };
    const orderRepo = {
      findOpen: vi.fn(() => []),
    } as never;
    const positionRepo = {
      findOpen: vi.fn(() => []),
    } as never;
    const rulesProvider = {
      getRule: vi.fn(() => makeBundle()),
      isEnabled: vi.fn(() => true),
      getAllFamilies: vi.fn(() => []),
      getRulesForRegime: vi.fn(() => []),
    };
    const mod = new HotMarketDataModule({
      bus,
      gateway: gateway as never,
      rulesProvider: rulesProvider as never,
      orderRepo,
      positionRepo,
      log: makeLogger(),
      policy: { hotQuoteRefreshIntervalMs: 500, hotSetHoldWindowMs: 5_000, maxTokensPerCycle: 1 },
    });

    await mod.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOKEN_ID,
          bestBid: 0.03,
          bestAsk: 0.04,
          midPrice: 0.035,
          snapshotTs: Date.now(),
        }),
        makeMarket({
          tokenId: TOKEN_ID_2,
          conditionId: "cond-2",
          bestBid: 0.08,
          bestAsk: 0.09,
          midPrice: 0.085,
          snapshotTs: Date.now(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.drain();

    await vi.advanceTimersByTimeAsync(600);
    expect(stream.setTokenIds).toHaveBeenLastCalledWith([String(TOKEN_ID)]);

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOKEN_ID,
          bestBid: 0.09,
          bestAsk: 0.1,
          midPrice: 0.095,
          snapshotTs: Date.now(),
        }),
        makeMarket({
          tokenId: TOKEN_ID_2,
          conditionId: "cond-2",
          bestBid: 0.02,
          bestAsk: 0.03,
          midPrice: 0.025,
          snapshotTs: Date.now(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.drain();

    await vi.advanceTimersByTimeAsync(600);
    expect(stream.setTokenIds).toHaveBeenLastCalledWith([String(TOKEN_ID)]);

    await vi.advanceTimersByTimeAsync(5_100);
    expect(stream.setTokenIds).toHaveBeenLastCalledWith([String(TOKEN_ID_2)]);

    await mod.stop();
  });
});
