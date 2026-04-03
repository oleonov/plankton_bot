/**
 * Builder for FamilyConfig test fixtures used in scenario harness.
 */

import type { FamilyConfig } from "@plankton/config";

/** Create a FamilyConfig with sensible defaults for scenario tests. */
export function makeFamilyConfig(overrides: {
  familyId: string;
  familyKey?: string;
  slugPattern?: string | null;
  regime?:
    | "threshold"
    | "price-range"
    | "directional-updown"
    | "social-activity"
    | "geopolitics"
    | "generic"
    | "tournament"
    | "weather-range";
  enabled?: boolean;
  action?: "trade" | "monitor" | "reduce-only" | "blocked";
  entryMode?: "probe-first" | "conviction-only" | "disabled";
  maxInitialNotionalUsdc?: number;
  defaultMaxBuysPerLeg?: number;
  maxOpenValueUsdc?: number;
}): FamilyConfig {
  const {
    familyId,
    familyKey = `key-${familyId}`,
    slugPattern = null,
    regime = "threshold",
    enabled = true,
    action = "trade",
    entryMode = "probe-first",
    maxInitialNotionalUsdc = 50,
    defaultMaxBuysPerLeg = 3,
    maxOpenValueUsdc = 500,
  } = overrides;

  return {
    identity: {
      familyId,
      familyKey,
      primaryCategory: "test",
      regime,
      horizon: "short",
      cadence: "daily",
      strategyProfile: "scalp",
      feeTier: null,
      liveWalletRequirement: null,
      requiresPostOnlyForLive: null,
      topicKey: null,
      slugPattern,
      notes: null,
    },
    evidence: {
      familyId,
      evidenceStatus: "confirmed",
      evidenceScore: 80,
      promotionState: "scaled",
      localTradeCount: 10,
      localMarketCount: 5,
      localRealizedPnlFifo: 100,
      openTailCostUsdc: 0,
      tailAdjustedPnl: 100,
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
    },
    rules: {
      familyId,
      universe: {
        enabled,
        action,
        priorityRank: 1,
        allowWeekends: true,
        sessionMode: "active-window",
      },
      entry: {
        entryMode,
        minEntryPrice: 0.05,
        maxEntryPrice: 0.95,
        maxInitialNotionalUsdc,
        allowHighPriceOneShot: false,
        highPriceThreshold: 0.85,
        requireProvenFamilyAbovePrice: 0.6,
        preferredEntryBand: null,
        maxProbeCountPerMarket: null,
        entryCooldownSeconds: null,
        maxNewMarketsPerSession: null,
        probeSizeUsdc: 5,
        addSizeUsdc: 4,
      },
      scaleIn: {
        scaleMode: "confirm-only",
        defaultMaxBuysPerLeg,
        heavyMaxBuysPerLeg: 5,
        allowHeavyCampaigns: false,
        requirePositiveRecycleHistoryForScale: true,
      },
      exit: {
        exitMode: "repricing-sell",
        primaryProfitModel: "sell-into-strength",
        allowRunnerExtension: false,
        preferFastRecycle: true,
        resolutionHoldingAllowed: false,
        resolutionBufferMinutes: 60,
        targetRoiBandLow: null,
        targetRoiBandHigh: null,
        maxUnmovedHoldHours: null,
        maxTailHoldHours: null,
      },
      twoSided: {
        allowTwoSided: false,
        twoSidedMode: "disabled",
        minActivityForTwoSided: null,
      },
      tailSuppression: {
        maxOpenValueUsdc,
        maxActiveMarkets: 10,
        maxDustPositions: 5,
        tailQuarantineThresholdUsdc: 100,
        tailQuarantineThresholdRatio: 0.5,
        staleTailPruneEnabled: true,
        thresholdCleanupRequired: false,
        autoSettleResolvedMarkets: true,
      },
      session: {
        activeWindowsUtc: [{ start: "00:00", end: "23:59" }],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
        weekendMode: "normal",
      },
    },
  };
}
