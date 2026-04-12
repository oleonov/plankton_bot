import { describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  createFamilyId,
  createOrderId,
  createTokenId,
  type FamilyRuleBundle,
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

function makeBundle(overrides?: {
  throughput?: FamilyRuleBundle["rules"]["throughput"];
  identity?: Partial<FamilyRuleBundle["identity"]>;
}): FamilyRuleBundle {
  return {
    identity: {
      familyId: FAMILY_ID,
      familyKey: "bitcoin-price",
      primaryCategory: "crypto-btc",
      regime: "price-range",
      horizon: "daily",
      cadence: "daily",
      strategyProfile: "scalp",
      topicKey: null,
      slugPattern: null,
      notes: null,
      feeTier: "fee-enabled",
      liveWalletRequirement: "relayer-required",
      requiresPostOnlyForLive: true,
      ...overrides?.identity,
    },
    evidence: {
      familyId: FAMILY_ID,
      evidenceStatus: "confirmed",
      evidenceScore: 80,
      promotionState: "scaled",
      localTradeCount: 20,
      localMarketCount: 10,
      localRealizedPnlFifo: 10,
      openTailCostUsdc: 0,
      tailAdjustedPnl: 10,
      remoteClosedRealizedPnl: null,
      openPositionCount: null,
      openDustCount: null,
      bothSidedEligible: true,
      heavyCampaignEligible: true,
      activeWindowEdgeScore: null,
      recurrenceScore: null,
      recycleScore: null,
      liveViabilityScore: null,
      toxicityPenalty: null,
      lastValidatedAt: null,
      probeSubstate: null,
      repricingExitCount: 0,
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
        allowTwoSided: true,
        twoSidedMode: "active",
        minActivityForTwoSided: 11,
      },
      throughput: {
        maxConcurrentOrdersPerFamily: 10,
        maxProbeInFlightPerToken: 2,
        maxEntrySignalsPerTickPerFamily: 10,
        ...overrides?.throughput,
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

function makeEntryOrder(): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "cl-1" as never,
    tokenId: TOKEN_ID,
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
    side: "buy",
    suggestedPrice: 0.04,
    suggestedSize: 100,
    suggestedSizeUsdc: 4,
    reason: "probe-entry",
    strategyTick: NOW,
    sequenceInTick: 0,
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
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              fastLaneEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
      candidateBookCache: cache,
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

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
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
  });

  it("publishes a precise conversion skip reason for gamma-fallback zero-spread books", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              fastLaneEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const skipped: Array<{ reasons: readonly string[] }> = [];
    bus.subscribe("SignalConversionSkipped", async (payload) => {
      skipped.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: makeSignal(),
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("gamma-fallback-no-real-book");
  });

  it("converts one-sided dust spray entries when recent trade context is present", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              fastLaneEnabled: true,
              dustLaneEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; signalReason?: string | null } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.03,
          bestAsk: null,
          midPrice: null,
          spread: null,
          tickSize: 0.001,
          bookSource: "clob",
          lastTradePrice: 0.031,
          lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 5,
        suggestedPrice: 0.031,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.031);
  });

  it("converts gamma-fallback dust spray entries without requiring a real CLOB book", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
              queueJumpCanaryEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
        getMinEntryNotionalUsdc: () => 1,
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; metadata?: Record<string, unknown> } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: null,
          bestAsk: null,
          midPrice: 0.021,
          spread: null,
          bookSource: "gamma-fallback",
          lastTradePrice: 0.02,
          lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedPrice: 0.021,
        suggestedSizeUsdc: 1,
        suggestedSize: 50,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.02);
    expect(
      (placed[0]!.command.metadata?.marketData as Record<string, unknown>)?.gammaFallbackDust,
    ).toBe(true);
  });

  it("falls back to gamma-fallback dust when targeted book refresh fails", async () => {
    const bus = new InProcessEventBus();
    const candidateBookCache = {
      getFreshEntry: vi.fn(() => null),
      getFreshOrRefresh: vi.fn(async () => ({ status: "refresh-failed", entry: null })),
    } as unknown as CandidateBookCache;
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      candidateBookCache,
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
            },
            identity: {
              familyKey: "ethereum-price",
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
        getMinEntryNotionalUsdc: () => 1,
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { metadata?: Record<string, unknown> } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          familyKey: "ethereum-price",
          bestBid: null,
          bestAsk: null,
          midPrice: 0.021,
          spread: null,
          bookSource: "gamma-fallback",
          lastTradePrice: 0.02,
          lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        familyId: createFamilyId("ethereum-price:generic:daily"),
        reason: "spray-entry",
        suggestedPrice: 0.021,
        suggestedSizeUsdc: 1,
        suggestedSize: 50,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(candidateBookCache.getFreshOrRefresh).toHaveBeenCalledWith(
      String(TOKEN_ID),
      expect.any(Number),
    );
    expect(placed).toHaveLength(1);
    expect((placed[0]!.command.metadata as Record<string, unknown>)?.cacheStatus).toBe(
      "refresh-failed",
    );
    expect(
      (placed[0]!.command.metadata?.marketData as Record<string, unknown>)?.gammaFallbackDust,
    ).toBe(true);
  });

  it("uses queue-jump execution terms for event-driven geopolitics dust canary", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            identity: {
              familyKey: "who-will-be-next-supreme-leader-of-iran",
              primaryCategory: "geopolitics",
              strategyProfile: "event-driven",
              feeTier: "fee-free",
              liveWalletRequirement: "eoa-ok",
              requiresPostOnlyForLive: false,
            },
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
              queueJumpCanaryEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; postOnly?: boolean } }> = [];
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
          tickSize: 0.01,
          bookSource: "clob",
          lastTradePrice: 0.04,
          lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
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

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.04);
    expect(placed[0]!.command.postOnly).toBeUndefined();
  });

  it("uses queue-jump execution terms for recurring crypto dust canary", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            identity: {
              primaryCategory: "crypto-btc",
              cadence: "daily-dated",
              strategyProfile: "scalp",
              requiresPostOnlyForLive: true,
            },
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
              queueJumpCanaryEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; postOnly?: boolean } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.02,
          bestAsk: 0.021,
          midPrice: 0.0205,
          spread: 0.001,
          tickSize: 0.001,
          bookSource: "clob",
          lastTradePrice: 0.02,
          lastTradeAt: new Date(Date.now() - 30_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 7.5,
        suggestedPrice: 0.02,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.021);
    expect(placed[0]!.command.postOnly).toBeUndefined();
  });

  it("keeps non-canary dust families maker-only even when dust lane is enabled", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            identity: {
              primaryCategory: "crypto-btc",
              cadence: "daily-dated",
              strategyProfile: "scalp",
              requiresPostOnlyForLive: true,
            },
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
              queueJumpCanaryEnabled: false,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; postOnly?: boolean } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.02,
          bestAsk: 0.021,
          midPrice: 0.0205,
          spread: 0.001,
          tickSize: 0.001,
          bookSource: "clob",
          lastTradePrice: 0.02,
          lastTradeAt: new Date(Date.now() - 30_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 7.5,
        suggestedPrice: 0.02,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.02);
    expect(placed[0]!.command.postOnly).toBe(true);
  });

  it("allows queue-jump on ask-only books for explicit canary families", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            identity: {
              familyKey: "who-will-be-next-supreme-leader-of-iran",
              primaryCategory: "geopolitics",
              strategyProfile: "event-driven",
              feeTier: "fee-free",
              liveWalletRequirement: "eoa-ok",
              requiresPostOnlyForLive: false,
            },
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
              queueJumpCanaryEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; postOnly?: boolean } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: null,
          bestAsk: 0.04,
          midPrice: 0.04,
          spread: null,
          tickSize: 0.01,
          bookSource: "clob",
          lastTradePrice: 0.04,
          lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 3.75,
        suggestedPrice: 0.04,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.04);
    expect(placed[0]!.command.postOnly).toBeUndefined();
  });

  it("keeps stale-trade canaries maker-only instead of queue-jumping", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            identity: {
              primaryCategory: "crypto-btc",
              cadence: "daily-dated",
              strategyProfile: "scalp",
              requiresPostOnlyForLive: true,
            },
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
              queueJumpCanaryEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; postOnly?: boolean } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.02,
          bestAsk: 0.021,
          midPrice: 0.0205,
          spread: 0.001,
          tickSize: 0.001,
          bookSource: "clob",
          lastTradePrice: 0.02,
          lastTradeAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 7.5,
        suggestedPrice: 0.02,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.02);
    expect(placed[0]!.command.postOnly).toBe(true);
  });

  it("keeps gamma-fallback dust canaries maker-only instead of queue-jumping", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            identity: {
              primaryCategory: "crypto-btc",
              cadence: "daily-dated",
              strategyProfile: "scalp",
              requiresPostOnlyForLive: true,
            },
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
              queueJumpCanaryEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; postOnly?: boolean } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.02,
          bestAsk: 0.021,
          midPrice: 0.0205,
          spread: 0.001,
          tickSize: 0.001,
          bookSource: "gamma-fallback",
          lastTradePrice: 0.02,
          lastTradeAt: new Date(Date.now() - 30_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 7.5,
        suggestedPrice: 0.02,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.02);
    expect(placed[0]!.command.postOnly).toBe(true);
  });

  it("keeps slippage-breached canaries maker-only instead of queue-jumping", async () => {
    const bus = new InProcessEventBus();
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            identity: {
              primaryCategory: "crypto-btc",
              cadence: "daily-dated",
              strategyProfile: "scalp",
              requiresPostOnlyForLive: true,
            },
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
              queueJumpCanaryEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
      liveLiteGuard: {
        getWalletMode: () => "relayer",
      } as never,
    });
    bridge.subscribe();

    const placed: Array<{ command: { price: number; postOnly?: boolean } }> = [];
    bus.subscribe("PlaceOrderRequested", async (payload) => {
      placed.push(payload);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          bestBid: 0.019,
          bestAsk: 0.05,
          midPrice: 0.0345,
          spread: 0.031,
          tickSize: 0.001,
          bookSource: "clob",
          lastTradePrice: 0.02,
          lastTradeAt: new Date(Date.now() - 30_000).toISOString(),
        }),
      ],
      timestamp: Date.now(),
    });
    await bus.publish("SignalApproved", {
      signal: {
        ...makeSignal(),
        reason: "spray-entry",
        suggestedSizeUsdc: 0.15,
        suggestedSize: 7.5,
        suggestedPrice: 0.02,
      },
      approvedAt: Date.now(),
    });
    await bus.drain();

    expect(placed).toHaveLength(1);
    expect(placed[0]!.command.price).toBe(0.02);
    expect(placed[0]!.command.postOnly).toBe(true);
  });

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
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            throughput: {
              maxConcurrentOrdersPerFamily: 1,
              maxProbeInFlightPerToken: 1,
              maxEntrySignalsPerTickPerFamily: 1,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
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
      reason: "ttl-expired",
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      reason: "ttl-expired",
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
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

    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toContain("unfilled-cancel-cooldown");
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
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            throughput: {
              maxConcurrentOrdersPerFamily: 1,
              maxProbeInFlightPerToken: 1,
              maxEntrySignalsPerTickPerFamily: 1,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
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
      reason: "ttl-expired",
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      reason: "ttl-expired",
      familyId: FAMILY_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
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

    expect(bypasses).toHaveLength(1);
    expect(bypasses[0]!.reason).toBe("price-moved");
    expect(placed).toHaveLength(1);
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
      rulesProvider: {
        getRule: vi.fn(() =>
          makeBundle({
            identity: {
              familyKey: "who-will-be-next-supreme-leader-of-iran",
              primaryCategory: "geopolitics",
              strategyProfile: "event-driven",
              feeTier: "fee-free",
              liveWalletRequirement: "eoa-ok",
              requiresPostOnlyForLive: false,
            },
            throughput: {
              maxConcurrentOrdersPerFamily: 10,
              maxProbeInFlightPerToken: 2,
              maxEntrySignalsPerTickPerFamily: 10,
              dustLaneEnabled: true,
            },
          }),
        ),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => []),
        getRulesForRegime: vi.fn(() => []),
      },
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
      reason: "entry-reprice-cancel",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-2" as never,
      orderId: order.orderId,
      reason: "entry-reprice-cancel",
      familyId: FAMILY_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });
    await bus.publish("OrderCancelled", {
      commandId: "cmd-3" as never,
      orderId: order.orderId,
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
