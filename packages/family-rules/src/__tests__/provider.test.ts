import { describe, it, expect } from "vitest";
import { createFamilyRulesProvider } from "../provider.js";
import { createFamilyId } from "@plankton/domain";
import type { FamilyConfig } from "@plankton/config";

function makeFamilyConfig(overrides: {
  familyId: string;
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
}): FamilyConfig {
  const { familyId, regime = "threshold", enabled = true, action = "trade" } = overrides;

  return {
    identity: {
      familyId,
      familyKey: `key-${familyId}`,
      primaryCategory: "test",
      regime,
      horizon: "short",
      cadence: "daily",
      strategyProfile: "scalp",
      topicKey: null,
      slugPattern: null,
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
        allowWeekends: false,
        sessionMode: "active-window",
      },
      entry: {
        entryMode: "probe-first",
        minEntryPrice: 0.05,
        maxEntryPrice: 0.95,
        maxInitialNotionalUsdc: 50,
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
        defaultMaxBuysPerLeg: 3,
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
        maxOpenValueUsdc: 500,
        maxActiveMarkets: 10,
        maxDustPositions: 5,
        tailQuarantineThresholdUsdc: 100,
        tailQuarantineThresholdRatio: 0.5,
        staleTailPruneEnabled: true,
        thresholdCleanupRequired: false,
        autoSettleResolvedMarkets: true,
      },
      session: {
        activeWindowsUtc: [{ start: "09:00", end: "17:00" }],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
        weekendMode: "reduced",
      },
    },
  };
}

describe("FamilyRulesProvider", () => {
  it("getRule returns bundle for known family", () => {
    const configs = [
      makeFamilyConfig({ familyId: "fam-1" }),
      makeFamilyConfig({ familyId: "fam-2" }),
    ];
    const provider = createFamilyRulesProvider(configs);

    const bundle = provider.getRule(createFamilyId("fam-1"));
    expect(bundle).not.toBeNull();
    expect(bundle!.identity.familyKey).toBe("key-fam-1");
    expect(bundle!.identity.familyId).toBe("fam-1");
  });

  it("getRule returns null for unknown family", () => {
    const provider = createFamilyRulesProvider([makeFamilyConfig({ familyId: "fam-1" })]);

    expect(provider.getRule(createFamilyId("unknown"))).toBeNull();
  });

  it("isEnabled returns true for enabled family", () => {
    const provider = createFamilyRulesProvider([
      makeFamilyConfig({ familyId: "fam-1", enabled: true, action: "trade" }),
    ]);

    expect(provider.isEnabled(createFamilyId("fam-1"))).toBe(true);
  });

  it("isEnabled returns false for disabled family", () => {
    const provider = createFamilyRulesProvider([
      makeFamilyConfig({ familyId: "fam-1", enabled: false }),
    ]);

    expect(provider.isEnabled(createFamilyId("fam-1"))).toBe(false);
  });

  it("isEnabled returns false for blocked family", () => {
    const provider = createFamilyRulesProvider([
      makeFamilyConfig({
        familyId: "fam-1",
        enabled: true,
        action: "blocked",
      }),
    ]);

    expect(provider.isEnabled(createFamilyId("fam-1"))).toBe(false);
  });

  it("isEnabled returns false for monitor family", () => {
    const provider = createFamilyRulesProvider([
      makeFamilyConfig({
        familyId: "fam-1",
        enabled: true,
        action: "monitor",
      }),
    ]);

    expect(provider.isEnabled(createFamilyId("fam-1"))).toBe(false);
  });

  it("isEnabled returns false for reduce-only family", () => {
    const provider = createFamilyRulesProvider([
      makeFamilyConfig({
        familyId: "fam-1",
        enabled: true,
        action: "reduce-only",
      }),
    ]);

    expect(provider.isEnabled(createFamilyId("fam-1"))).toBe(false);
  });

  it("isEnabled returns false for unknown family", () => {
    const provider = createFamilyRulesProvider([]);

    expect(provider.isEnabled(createFamilyId("unknown"))).toBe(false);
  });

  it("getAllFamilies returns all identities", () => {
    const configs = [
      makeFamilyConfig({ familyId: "fam-1" }),
      makeFamilyConfig({ familyId: "fam-2" }),
      makeFamilyConfig({ familyId: "fam-3" }),
    ];
    const provider = createFamilyRulesProvider(configs);

    const families = provider.getAllFamilies();
    expect(families).toHaveLength(3);

    const ids = families.map((f) => f.familyId).sort();
    expect(ids).toEqual(["fam-1", "fam-2", "fam-3"]);
  });

  it("getRulesForRegime filters correctly", () => {
    const configs = [
      makeFamilyConfig({ familyId: "fam-1", regime: "threshold" }),
      makeFamilyConfig({ familyId: "fam-2", regime: "price-range" }),
      makeFamilyConfig({ familyId: "fam-3", regime: "threshold" }),
    ];
    const provider = createFamilyRulesProvider(configs);

    const threshold = provider.getRulesForRegime("threshold");
    expect(threshold).toHaveLength(2);

    const ids = threshold.map((b) => b.identity.familyId).sort();
    expect(ids).toEqual(["fam-1", "fam-3"]);

    const priceRange = provider.getRulesForRegime("price-range");
    expect(priceRange).toHaveLength(1);
    expect(priceRange[0]!.identity.familyId).toBe("fam-2");
  });

  it("getRulesForRegime returns empty for unmatched regime", () => {
    const configs = [makeFamilyConfig({ familyId: "fam-1", regime: "threshold" })];
    const provider = createFamilyRulesProvider(configs);

    expect(provider.getRulesForRegime("geopolitics")).toEqual([]);
  });
});
