import { describe, expect, it } from "vitest";
import { createFamilyId, createTokenId } from "@plankton/domain";
import type {
  FamilyEvidence,
  FamilyIdentity,
  FamilyRuleBundle,
  FamilyRules,
  NormalizedMarket,
  Regime,
} from "@plankton/domain";
import {
  rejectOutcomeCandidate,
  scoreOutcomeCandidate,
  selectFirstEntryOutcomeForCondition,
  selectFirstEntryTokenForCondition,
} from "../modules/strategy/outcome-selection.js";

const FAMILY_ID = createFamilyId("fam-btc");

function makeMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  const bestBid = overrides?.bestBid ?? 0.03;
  const bestAsk = overrides?.bestAsk ?? 0.04;
  return {
    tokenId: createTokenId("tok-yes"),
    conditionId: "cond-1",
    slug: "will-btc-reach-100k",
    eventSlug: null,
    question: "Will BTC reach 100k?",
    outcome: "YES",
    outcomeIndex: 0,
    familyId: FAMILY_ID,
    familyKey: "btc-price",
    regime: "threshold" as Regime,
    horizon: "short",
    endDate: null,
    active: true,
    tickSize: 0.01,
    negRisk: false,
    bestBid,
    bestAsk,
    midPrice: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    volume24h: 50_000,
    liquidity: null,
    minOrderSize: 5,
    bookSource: "clob",
    snapshotTs: Date.now(),
    ...overrides,
  };
}

function makeRules(overrides?: Partial<FamilyRules>): FamilyRules {
  return {
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
      maxEntryPrice: 0.5,
      maxInitialNotionalUsdc: 5,
      allowHighPriceOneShot: false,
      highPriceThreshold: 0.85,
      requireProvenFamilyAbovePrice: 1,
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
      allowHeavyCampaigns: false,
      requirePositiveRecycleHistoryForScale: false,
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
    twoSided: { allowTwoSided: false, twoSidedMode: "disabled", minActivityForTwoSided: null },
    throughput: {
      maxConcurrentOrdersPerFamily: null,
      maxProbeInFlightPerToken: null,
      maxEntrySignalsPerTickPerFamily: null,
    },
    tailSuppression: {
      maxOpenValueUsdc: 100,
      maxActiveMarkets: 5,
      maxDustPositions: 3,
      tailQuarantineThresholdUsdc: 50,
      tailQuarantineThresholdRatio: 0.5,
      staleTailPruneEnabled: false,
      thresholdCleanupRequired: false,
      autoSettleResolvedMarkets: true,
    },
    session: {
      activeWindowsUtc: [{ start: "00:00", end: "23:59" }],
      reducedWindowsUtc: [],
      weekdayBias: "normal",
    },
    ...overrides,
  };
}

function makeBundle(rules?: Partial<FamilyRules>): FamilyRuleBundle {
  const identity: FamilyIdentity = {
    familyId: FAMILY_ID,
    familyKey: "btc-price",
    primaryCategory: "crypto",
    regime: "threshold" as Regime,
    horizon: "short",
    cadence: "daily",
    strategyProfile: "scalp",
    topicKey: null,
    slugPattern: null,
    notes: null,
  };
  const evidence: FamilyEvidence = {
    familyId: FAMILY_ID,
    evidenceStatus: "confirmed",
    evidenceScore: 80,
    promotionState: "scaled",
    localTradeCount: 10,
    localMarketCount: 5,
    localRealizedPnlFifo: 0,
    openTailCostUsdc: 0,
    tailAdjustedPnl: 0,
    remoteClosedRealizedPnl: null,
    openPositionCount: null,
    openDustCount: null,
    bothSidedEligible: false,
    heavyCampaignEligible: false,
    activeWindowEdgeScore: null,
    recurrenceScore: null,
    recycleScore: null,
    liveViabilityScore: null,
    toxicityPenalty: null,
    lastValidatedAt: null,
    probeSubstate: null,
    repricingExitCount: 0,
  };
  return { identity, evidence, rules: makeRules(rules) };
}

describe("outcome selection", () => {
  it("selects the cheaper outcome when spread quality is comparable", () => {
    const bundle = makeBundle();
    const yes = makeMarket({ tokenId: createTokenId("tok-yes"), bestBid: 0.49, bestAsk: 0.5 });
    const no = makeMarket({
      tokenId: createTokenId("tok-no"),
      outcome: "NO",
      outcomeIndex: 1,
      bestBid: 0.04,
      bestAsk: 0.05,
    });

    expect(selectFirstEntryTokenForCondition([yes, no], bundle)).toBe("tok-no");
  });

  it("rejects explicit Gamma fallback books for live entry selection", () => {
    const bundle = makeBundle();
    const rejected = rejectOutcomeCandidate(makeMarket({ bookSource: "gamma-fallback" }), bundle);

    expect(rejected).toBe("gamma-fallback");
  });

  it("allows Gamma fallback books for dust-first micro entries with fresh trade context", () => {
    const bundle = makeBundle({
      entry: { ...makeRules().entry, entryMode: "spray-first" },
      throughput: {
        maxConcurrentOrdersPerFamily: 10,
        maxProbeInFlightPerToken: 2,
        maxEntrySignalsPerTickPerFamily: 10,
        dustLaneEnabled: true,
      },
    });
    const selection = selectFirstEntryOutcomeForCondition(
      [
        makeMarket({
          tokenId: createTokenId("tok-fallback"),
          bookSource: "gamma-fallback",
          bestBid: null,
          bestAsk: null,
          midPrice: 0.021,
          spread: null,
          lastTradePrice: 0.02,
          lastTradeAt: new Date().toISOString(),
        }),
      ],
      bundle,
      {
        allowGammaFallbackDust: true,
        dustSuggestedSizeUsdc: 0.15,
        nowMs: Date.now(),
      },
    );

    expect(selection.tokenId).toBe("tok-fallback");
  });

  it("does not allow Gamma fallback books above the hard $0.25 dust cap", () => {
    const bundle = makeBundle({
      entry: { ...makeRules().entry, entryMode: "spray-first" },
      throughput: {
        maxConcurrentOrdersPerFamily: 10,
        maxProbeInFlightPerToken: 2,
        maxEntrySignalsPerTickPerFamily: 10,
        dustLaneEnabled: true,
      },
    });
    const selection = selectFirstEntryOutcomeForCondition(
      [
        makeMarket({
          tokenId: createTokenId("tok-fallback-live-floor"),
          bookSource: "gamma-fallback",
          bestBid: null,
          bestAsk: null,
          midPrice: 0.021,
          spread: null,
          lastTradePrice: 0.02,
          lastTradeAt: new Date().toISOString(),
        }),
      ],
      bundle,
      {
        allowGammaFallbackDust: true,
        dustSuggestedSizeUsdc: 1,
        executionMinNotionalUsdc: 1,
        nowMs: Date.now(),
      },
    );

    expect(selection.tokenId).toBeNull();
  });

  it("does not let ultra-cheap tokens win when relative spread is broken", () => {
    const bundle = makeBundle();
    const brokenCheap = makeMarket({
      tokenId: createTokenId("tok-cheap"),
      bestBid: 0.01,
      bestAsk: 0.02,
    });
    const cleanCheap = makeMarket({
      tokenId: createTokenId("tok-clean"),
      bestBid: 0.045,
      bestAsk: 0.05,
    });

    expect(selectFirstEntryTokenForCondition([brokenCheap, cleanCheap], bundle)).toBe("tok-clean");
  });

  it("lets tighter liquidity beat a slightly cheaper but sloppy token", () => {
    const cheaperButSloppy = makeMarket({
      tokenId: createTokenId("tok-cheap"),
      bestBid: 0.02,
      bestAsk: 0.028,
      volume24h: 5_000,
    });
    const cleaner = makeMarket({
      tokenId: createTokenId("tok-clean"),
      bestBid: 0.045,
      bestAsk: 0.046,
      volume24h: 50_000,
    });

    expect(scoreOutcomeCandidate(cleaner)).toBeGreaterThan(scoreOutcomeCandidate(cheaperButSloppy));
  });

  it("rejects all candidates when every outcome is outside entry quality gates", () => {
    const bundle = makeBundle();
    const fallback = makeMarket({
      tokenId: createTokenId("tok-fallback"),
      bookSource: "gamma-fallback",
    });
    const wide = makeMarket({ tokenId: createTokenId("tok-wide"), bestBid: 0.1, bestAsk: 0.2 });

    expect(selectFirstEntryTokenForCondition([fallback, wide], bundle)).toBeNull();
  });
});
