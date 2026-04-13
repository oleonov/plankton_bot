import { describe, expect, it } from "vitest";
import { createFamilyId, type FamilyRuleBundle } from "@plankton/domain";
import {
  shouldPromoteFallbackMarketability,
  shouldRelaxNegativeTailProbeOnly,
} from "../proven-family-policy.js";

function makeBundle(
  overrides?: Partial<NonNullable<FamilyRuleBundle["evidence"]>>,
): FamilyRuleBundle {
  return {
    identity: {
      familyId: createFamilyId("fam-1"),
      familyKey: "elon-musk-of-tweets",
      primaryCategory: "other",
      regime: "social-activity",
      horizon: "weekly",
      cadence: "weekly-window",
      strategyProfile: "event-driven",
      topicKey: null,
      slugPattern: null,
      notes: null,
      feeTier: null,
      liveWalletRequirement: null,
      requiresPostOnlyForLive: null,
    },
    evidence: {
      familyId: createFamilyId("fam-1"),
      evidenceStatus: "partial",
      evidenceScore: 80,
      promotionState: "scaled",
      localTradeCount: 250,
      localMarketCount: 10,
      localRealizedPnlFifo: 20,
      openTailCostUsdc: 5,
      tailAdjustedPnl: 15,
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
      ...overrides,
    },
    rules: {
      familyId: createFamilyId("fam-1"),
      universe: {
        enabled: true,
        action: "trade",
        priorityRank: 1,
        sessionMode: "active-window",
      },
      entry: {
        entryMode: "probe-first",
        minEntryPrice: 0.05,
        maxEntryPrice: 0.3,
        maxInitialNotionalUsdc: 10,
        allowHighPriceOneShot: false,
        highPriceThreshold: 0.3,
        requireProvenFamilyAbovePrice: 0.3,
        preferredEntryBand: null,
        maxProbeCountPerMarket: null,
        entryCooldownSeconds: 30,
        maxNewMarketsPerSession: null,
        probeSizeUsdc: 1,
        addSizeUsdc: 1,
      },
      scaleIn: {
        scaleMode: "confirm-only",
        defaultMaxBuysPerLeg: 3,
        heavyMaxBuysPerLeg: 6,
        allowHeavyCampaigns: true,
        requirePositiveRecycleHistoryForScale: true,
      },
      exit: {
        exitMode: "repricing-sell",
        primaryProfitModel: "sell-into-strength",
        allowRunnerExtension: true,
        preferFastRecycle: true,
        resolutionHoldingAllowed: true,
        resolutionBufferMinutes: 30,
        targetRoiBandLow: 0.1,
        targetRoiBandHigh: 0.2,
        maxUnmovedHoldHours: null,
        maxTailHoldHours: null,
      },
      twoSided: {
        allowTwoSided: false,
        twoSidedMode: "disabled",
        minActivityForTwoSided: null,
      },
      throughput: {
        maxConcurrentOrdersPerFamily: null,
        maxProbeInFlightPerToken: null,
        maxEntrySignalsPerTickPerFamily: null,
        fastLaneEnabled: true,
        dustLaneEnabled: false,
        queueJumpCanaryEnabled: false,
      },
      tailSuppression: {
        maxOpenValueUsdc: 50,
        maxActiveMarkets: 10,
        maxDustPositions: 5,
        tailQuarantineThresholdUsdc: 1000,
        tailQuarantineThresholdRatio: 1000,
        staleTailPruneEnabled: true,
        thresholdCleanupRequired: false,
        autoSettleResolvedMarkets: true,
      },
      session: {
        activeWindowsUtc: [],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
      },
    },
  };
}

describe("proven-family-policy", () => {
  it("treats scaled families with strong evidence as proven", () => {
    const bundle = makeBundle();
    expect(shouldRelaxNegativeTailProbeOnly(bundle)).toBe(true);
    expect(shouldPromoteFallbackMarketability(bundle, 0.01)).toBe(true);
  });

  it("does not relax probe-only families even with strong evidence", () => {
    const bundle = makeBundle({ promotionState: "probe-only" });
    expect(shouldRelaxNegativeTailProbeOnly(bundle)).toBe(false);
    expect(shouldPromoteFallbackMarketability(bundle, 0.01)).toBe(false);
  });
});
