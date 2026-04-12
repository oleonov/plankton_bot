import { describe, expect, it } from "vitest";
import {
  createBotRunId,
  createFamilyId,
  createOrderId,
  createTokenId,
  type ClientOrderId,
  type FamilyRuleBundle,
  type NormalizedMarket,
  type Order,
  type Signal,
} from "@plankton/domain";
import {
  buildRestingOrderSnapshot,
  evaluateMarketability,
  resolveMakerOnlyPrice,
  resolveMarketabilityPolicy,
} from "../modules/strategy/marketability.js";

const FAM_ID = createFamilyId("fam-btc");
const TOKEN_ID = createTokenId("token-yes");
const NOW = Date.parse("2026-04-10T15:00:00.000Z");

function makeBundle(overrides?: Partial<FamilyRuleBundle>): FamilyRuleBundle {
  const bundle: FamilyRuleBundle = {
    identity: {
      familyId: FAM_ID,
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
    },
    evidence: {
      familyId: FAM_ID,
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
      familyId: FAM_ID,
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
        fastLaneEnabled: true,
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

  return { ...bundle, ...overrides };
}

function makeMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: TOKEN_ID,
    conditionId: "cond-1",
    slug: "bitcoin-price-on-april-10",
    eventSlug: null,
    question: "Bitcoin price?",
    outcome: "YES",
    outcomeIndex: 0,
    familyId: FAM_ID,
    familyKey: "bitcoin-price",
    regime: "price-range",
    horizon: "daily",
    endDate: "2026-04-10T23:59:00.000Z",
    active: true,
    tickSize: 0.001,
    negRisk: false,
    bestBid: 0.03,
    bestAsk: 0.034,
    midPrice: 0.032,
    spread: 0.004,
    lastTradePrice: null,
    lastTradeAt: null,
    volume24h: 100_000,
    liquidity: 10_000,
    snapshotTs: NOW,
    ...overrides,
  };
}

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    signalId: "sig-1",
    familyId: FAM_ID,
    tokenId: TOKEN_ID,
    side: "buy",
    suggestedPrice: 0.04,
    suggestedSize: 100,
    suggestedSizeUsdc: 4,
    reason: "probe-entry",
    strategyTick: NOW,
    sequenceInTick: 0,
    generatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("order-1"),
    clientOrderId: "client-1" as ClientOrderId,
    tokenId: TOKEN_ID,
    familyId: FAM_ID,
    side: "buy",
    orderType: "GTC",
    postOnly: true,
    price: 0.03,
    size: 100,
    sizeUsdc: 3,
    status: "open",
    exchangeOrderId: "order-1",
    signalId: null,
    signalReason: "probe-entry",
    botRunId: createBotRunId("bot-run-1"),
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("marketability gate", () => {
  it("allows tight spread core markets with fresh two-sided books", () => {
    const decision = evaluateMarketability({
      signal: makeSignal(),
      market: makeMarket(),
      bundle: makeBundle(),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("spread-tight");
  });

  it("rejects stale books before maker improvement or taker mode", () => {
    const decision = evaluateMarketability({
      signal: makeSignal(),
      market: makeMarket({ snapshotTs: NOW - 16_000 }),
      bundle: makeBundle(),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("book-stale");
  });

  it("classifies synthetic gamma fallback zero-spread books separately", () => {
    const decision = evaluateMarketability({
      signal: makeSignal(),
      market: makeMarket({
        bestBid: 0.09,
        bestAsk: 0.09,
        spread: 0,
        bookSource: "gamma-fallback",
      }),
      bundle: makeBundle(),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("gamma-fallback-no-real-book");
  });

  it("approves gamma fallback dust entries with fresh trade context", () => {
    const decision = evaluateMarketability({
      signal: makeSignal({
        reason: "spray-entry",
        suggestedPrice: 0.021,
        suggestedSize: 7.5,
        suggestedSizeUsdc: 0.15,
      }),
      market: makeMarket({
        bestBid: null,
        bestAsk: null,
        midPrice: 0.021,
        spread: null,
        bookSource: "gamma-fallback",
        lastTradePrice: 0.02,
        lastTradeAt: new Date(NOW - 60_000).toISOString(),
      }),
      bundle: {
        ...makeBundle(),
        rules: {
          ...makeBundle().rules,
          entry: { ...makeBundle().rules.entry, entryMode: "spray-first" },
          throughput: {
            ...makeBundle().rules.throughput!,
            dustLaneEnabled: true,
          },
        },
      },
      nowMs: NOW,
    });

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("gamma-fallback-dust-ok");
  });

  it("rejects high-volume markets when spread is still above the hard tier cap", () => {
    const decision = evaluateMarketability({
      signal: makeSignal(),
      market: makeMarket({ bestBid: 0.3, bestAsk: 0.39, spread: 0.09, volume24h: 1_000_000 }),
      bundle: makeBundle(),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("spread-too-wide");
  });

  it("uses reduce-only family state as a hard no-new-entry override", () => {
    const decision = evaluateMarketability({
      signal: makeSignal(),
      market: makeMarket(),
      bundle: makeBundle({
        evidence: { ...makeBundle().evidence!, promotionState: "reduce-only" },
      }),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("family-reduce-only");
  });

  it("rejects when a family has already saturated resting buy reservation", () => {
    const market = makeMarket();
    const snapshot = buildRestingOrderSnapshot(
      [
        makeOrder({ orderId: createOrderId("order-1"), sizeUsdc: 13 }),
        makeOrder({
          orderId: createOrderId("order-2"),
          tokenId: createTokenId("token-no"),
          sizeUsdc: 13,
        }),
      ],
      new Map([[String(TOKEN_ID), market]]),
    );

    const decision = evaluateMarketability({
      signal: makeSignal(),
      market,
      bundle: makeBundle(),
      nowMs: NOW,
      restingSnapshot: snapshot,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("resting-family-reservation-cap");
  });

  it("rejects when the new entry would exceed family resting buy reservation", () => {
    const market = makeMarket();
    const snapshot = buildRestingOrderSnapshot(
      [makeOrder({ orderId: createOrderId("order-1"), sizeUsdc: 22 })],
      new Map([[String(TOKEN_ID), market]]),
    );

    const decision = evaluateMarketability({
      signal: makeSignal({ suggestedSizeUsdc: 4 }),
      market,
      bundle: makeBundle(),
      nowMs: NOW,
      restingSnapshot: snapshot,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("resting-family-reservation-cap");
  });

  it("rejects while token is in cancel-without-fill cooldown", () => {
    const decision = evaluateMarketability({
      signal: makeSignal(),
      market: makeMarket(),
      bundle: makeBundle(),
      nowMs: NOW,
      cooldownUntilMs: NOW + 60_000,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("unfilled-cancel-cooldown");
  });

  it("allows reduced-fast probe entries through the widened spread gate", () => {
    const decision = evaluateMarketability({
      signal: makeSignal({ suggestedSizeUsdc: 4, reason: "probe-entry" }),
      market: makeMarket({
        familyKey: "ethereum-price",
        bestBid: 0.07,
        bestAsk: 0.09,
        midPrice: 0.08,
        spread: 0.02,
        volume24h: 50_000,
      }),
      bundle: makeBundle({
        identity: {
          ...makeBundle().identity,
          familyKey: "ethereum-price",
        },
        rules: {
          ...makeBundle().rules,
          throughput: {
            maxConcurrentOrdersPerFamily: 3,
            maxProbeInFlightPerToken: 1,
            maxEntrySignalsPerTickPerFamily: 1,
            fastLaneEnabled: true,
          },
        },
      }),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("spread-tight");
  });

  it("keeps stricter follow-up spread caps for reduced-fast scale-ins", () => {
    const decision = evaluateMarketability({
      signal: makeSignal({ suggestedSizeUsdc: 4, reason: "scale-in" }),
      market: makeMarket({
        familyKey: "ethereum-price",
        bestBid: 0.07,
        bestAsk: 0.11,
        midPrice: 0.09,
        spread: 0.04,
        volume24h: 50_000,
      }),
      bundle: makeBundle({
        identity: {
          ...makeBundle().identity,
          familyKey: "ethereum-price",
        },
        rules: {
          ...makeBundle().rules,
          throughput: {
            maxConcurrentOrdersPerFamily: 3,
            maxProbeInFlightPerToken: 1,
            maxEntrySignalsPerTickPerFamily: 1,
            fastLaneEnabled: true,
          },
        },
      }),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("spread-too-wide");
  });

  it("allows one-sided dust books only for fresh spray entries", () => {
    const decision = evaluateMarketability({
      signal: makeSignal({ reason: "spray-entry", suggestedSizeUsdc: 0.15 }),
      market: makeMarket({
        bestBid: 0.03,
        bestAsk: null,
        midPrice: null,
        spread: null,
        bookSource: "clob",
        lastTradePrice: 0.031,
        lastTradeAt: new Date(NOW - 60_000).toISOString(),
      }),
      bundle: makeBundle(),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("book-one-sided-dust-ok");
    expect(decision.checksPassed).toContain("spread-one-sided-dust-ok");
  });

  it("rejects one-sided dust books when the trade context is stale", () => {
    const decision = evaluateMarketability({
      signal: makeSignal({ reason: "spray-entry", suggestedSizeUsdc: 0.15 }),
      market: makeMarket({
        bestBid: 0.03,
        bestAsk: null,
        midPrice: null,
        spread: null,
        bookSource: "clob",
        lastTradePrice: 0.031,
        lastTradeAt: new Date(NOW - 10 * 60_000).toISOString(),
      }),
      bundle: makeBundle(),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("book-one-sided");
  });
});

describe("maker-only price improvement", () => {
  it("moves BUY orders inside a tight spread without crossing the ask", () => {
    const policy = resolveMarketabilityPolicy(makeBundle());
    const price = resolveMakerOnlyPrice({
      side: "buy",
      suggestedPrice: 0.04,
      market: makeMarket(),
      policy,
    });

    expect(price).toBe(0.033);
  });

  it("keeps BUY orders at the strategy price when it is already improved inside the spread", () => {
    const policy = resolveMarketabilityPolicy(makeBundle());
    const price = resolveMakerOnlyPrice({
      side: "buy",
      suggestedPrice: 0.032,
      market: makeMarket(),
      policy,
    });

    expect(price).toBe(0.032);
  });

  it("does not place a BUY below best bid when the strategy price is too low", () => {
    const policy = resolveMarketabilityPolicy(makeBundle());
    const price = resolveMakerOnlyPrice({
      side: "buy",
      suggestedPrice: 0.029,
      market: makeMarket(),
      policy,
    });

    expect(price).toBeNull();
  });

  it("returns null when there is no legal maker price below the ask", () => {
    const policy = resolveMarketabilityPolicy(makeBundle());
    const price = resolveMakerOnlyPrice({
      side: "buy",
      suggestedPrice: 0.04,
      market: makeMarket({ bestBid: 0.04, bestAsk: 0.04, spread: 0 }),
      policy,
    });

    expect(price).toBeNull();
  });

  it("anchors one-sided dust BUY pricing to bid + tick and recent trade cap", () => {
    const policy = resolveMarketabilityPolicy(makeBundle());
    const price = resolveMakerOnlyPrice({
      side: "buy",
      suggestedPrice: 0.031,
      suggestedSizeUsdc: 0.15,
      signalReason: "spray-entry",
      nowMs: NOW,
      market: makeMarket({
        bestBid: 0.03,
        bestAsk: null,
        midPrice: null,
        spread: null,
        tickSize: 0.001,
        lastTradePrice: 0.031,
        lastTradeAt: new Date(NOW - 60_000).toISOString(),
      }),
      policy,
    });

    expect(price).toBe(0.031);
  });
});

describe("marketability policy retuning", () => {
  it("uses relaxed core-fast policy for proven high-recycle families", () => {
    const policy = resolveMarketabilityPolicy(makeBundle());

    expect(policy.tier).toBe("core");
    expect(policy.speedTier).toBe("core-fast");
    expect(policy.maxEntrySpreadCents).toBe(0.03);
    expect(policy.maxWideEntrySpreadCents).toBe(0.08);
    expect(policy.makerImprovementTicks).toBe(3);
    expect(policy.unfilledCancelCooldownMs).toBe(2 * 60_000);
  });

  it("uses reduced-fast policy only for selected reduced families", () => {
    const reducedFast = resolveMarketabilityPolicy(
      makeBundle({
        identity: {
          ...makeBundle().identity,
          familyKey: "will-bitcoin-reach",
        },
        rules: {
          ...makeBundle().rules,
          throughput: {
            maxConcurrentOrdersPerFamily: 3,
            maxProbeInFlightPerToken: 1,
            maxEntrySignalsPerTickPerFamily: 1,
            fastLaneEnabled: true,
          },
        },
      }),
    );
    const reducedStandard = resolveMarketabilityPolicy(
      makeBundle({
        identity: {
          ...makeBundle().identity,
          familyKey: "bitcoin-above",
        },
        rules: {
          ...makeBundle().rules,
          throughput: {
            maxConcurrentOrdersPerFamily: 3,
            maxProbeInFlightPerToken: 1,
            maxEntrySignalsPerTickPerFamily: 1,
          },
        },
      }),
    );

    expect(reducedFast.tier).toBe("reduced");
    expect(reducedFast.speedTier).toBe("reduced-fast");
    expect(reducedFast.maxEntrySpreadCents).toBe(0.025);
    expect(reducedFast.maxWideEntrySpreadCents).toBe(0.045);
    expect(reducedFast.minWideSpreadVolume24h).toBe(7_500);
    expect(reducedFast.makerImprovementTicks).toBe(2);
    expect(reducedFast.unfilledCancelCooldownMs).toBe(60_000);

    expect(reducedStandard.tier).toBe("reduced");
    expect(reducedStandard.speedTier).toBe("standard");
    expect(reducedStandard.maxEntrySpreadCents).toBe(0.01);
    expect(reducedStandard.makerImprovementTicks).toBe(1);
    expect(reducedStandard.unfilledCancelCooldownMs).toBe(5 * 60_000);
  });

  it("allows reduced-fast first entries through the widened spread gate at 7.5k volume", () => {
    const decision = evaluateMarketability({
      signal: makeSignal({
        reason: "probe-entry",
        suggestedPrice: 0.05,
        suggestedSizeUsdc: 4,
      }),
      market: makeMarket({
        familyKey: "ethereum-price",
        bestBid: 0.04,
        bestAsk: 0.08,
        spread: 0.04,
        volume24h: 8_000,
      }),
      bundle: makeBundle({
        identity: {
          ...makeBundle().identity,
          familyKey: "ethereum-price",
        },
        rules: {
          ...makeBundle().rules,
          throughput: {
            maxConcurrentOrdersPerFamily: 10,
            maxProbeInFlightPerToken: 2,
            maxEntrySignalsPerTickPerFamily: 10,
            fastLaneEnabled: true,
          },
        },
      }),
      nowMs: NOW,
    });

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("spread-wide-volume-qualified");
  });

  it("approves gamma-fallback dust entries when live-lite min entry notional raises dust size to $1", () => {
    const bundle = makeBundle({
      identity: {
        ...makeBundle().identity,
        familyKey: "ethereum-price",
      },
      rules: {
        ...makeBundle().rules,
        entry: { ...makeBundle().rules.entry, entryMode: "spray-first" },
        throughput: {
          maxConcurrentOrdersPerFamily: 10,
          maxProbeInFlightPerToken: 2,
          maxEntrySignalsPerTickPerFamily: 10,
          fastLaneEnabled: true,
          dustLaneEnabled: true,
        },
      },
    });
    const decision = evaluateMarketability({
      signal: makeSignal({
        reason: "spray-entry",
        suggestedPrice: 0.02,
        suggestedSizeUsdc: 1,
      }),
      market: makeMarket({
        familyKey: "ethereum-price",
        bestBid: null,
        bestAsk: null,
        midPrice: 0.021,
        spread: null,
        bookSource: "gamma-fallback",
        lastTradePrice: 0.02,
        lastTradeAt: new Date(NOW - 60_000).toISOString(),
      }),
      bundle,
      nowMs: NOW,
      executionMinNotionalUsdc: 1,
    });

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("gamma-fallback-dust-ok");
  });

  it("does not promote reduced families to core just because throughput overrides are high", () => {
    const policy = resolveMarketabilityPolicy(
      makeBundle({
        identity: {
          ...makeBundle().identity,
          familyKey: "ethereum-price",
        },
        rules: {
          ...makeBundle().rules,
          throughput: {
            maxConcurrentOrdersPerFamily: 20,
            maxProbeInFlightPerToken: 2,
            maxEntrySignalsPerTickPerFamily: 20,
            fastLaneEnabled: true,
          },
        },
      }),
    );

    expect(policy.tier).toBe("reduced");
    expect(policy.speedTier).toBe("reduced-fast");
  });
});
