import { describe, it, expect } from "vitest";
import { createFamilyId } from "@plankton/domain";
import type { FamilyConfig } from "@plankton/config";
import { ReloadableFamilyRulesManager, type DbFamilyRulesReader } from "../family-rules-manager.js";

function makeFamilyConfig(
  familyId: string,
  overrides?: Partial<{ familyKey: string }>,
): FamilyConfig {
  return {
    identity: {
      familyId,
      familyKey: overrides?.familyKey ?? `key-${familyId}`,
      primaryCategory: "test",
      regime: "threshold",
      horizon: "daily",
      cadence: "daily",
      strategyProfile: "scalp",
      topicKey: null,
      slugPattern: null,
      notes: null,
    },
    evidence: {
      familyId,
      evidenceStatus: "confirmed",
      evidenceScore: 1,
      promotionState: "probe-only",
      localTradeCount: 0,
      localMarketCount: 0,
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
    },
    rules: {
      familyId,
      universe: {
        enabled: true,
        action: "trade",
        priorityRank: 1,
        allowWeekends: false,
        sessionMode: "active-window",
      },
      entry: {
        entryMode: "probe-first",
        minEntryPrice: 0.05,
        maxEntryPrice: 0.45,
        maxInitialNotionalUsdc: 5,
        allowHighPriceOneShot: false,
        highPriceThreshold: 0.85,
        requireProvenFamilyAbovePrice: 0.5,
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
        preferFastRecycle: false,
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
        maxOpenValueUsdc: 50,
        maxActiveMarkets: 5,
        maxDustPositions: 3,
        tailQuarantineThresholdUsdc: 30,
        tailQuarantineThresholdRatio: 0.5,
        staleTailPruneEnabled: false,
        thresholdCleanupRequired: false,
        autoSettleResolvedMarkets: true,
      },
      session: {
        activeWindowsUtc: [],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
        weekendMode: "normal",
      },
    },
  } as FamilyConfig;
}

function emptyReader(): DbFamilyRulesReader {
  return { loadAll: () => [] };
}

describe("ReloadableFamilyRulesManager", () => {
  it("returns YAML families when DB is empty", () => {
    const yamlFamilies = [makeFamilyConfig("fam-1"), makeFamilyConfig("fam-2")];
    const mgr = new ReloadableFamilyRulesManager(yamlFamilies, emptyReader());

    const families = mgr.getAllFamilies();
    expect(families).toHaveLength(2);
    expect(families.map((f) => String(f.familyId)).sort()).toEqual(["fam-1", "fam-2"]);
  });

  it("DB family overwrites YAML family with same key", () => {
    const yamlFamilies = [makeFamilyConfig("fam-1", { familyKey: "yaml-key" })];
    const dbOverride = makeFamilyConfig("fam-1", { familyKey: "db-key" });
    const reader: DbFamilyRulesReader = { loadAll: () => [dbOverride] };

    const mgr = new ReloadableFamilyRulesManager(yamlFamilies, reader);

    const bundle = mgr.getRule(createFamilyId("fam-1"));
    expect(bundle).not.toBeNull();
    expect(bundle!.identity.familyKey).toBe("db-key");
  });

  it("DB adds new families not present in YAML", () => {
    const yamlFamilies = [makeFamilyConfig("fam-1")];
    const dbNew = makeFamilyConfig("fam-db");
    const reader: DbFamilyRulesReader = { loadAll: () => [dbNew] };

    const mgr = new ReloadableFamilyRulesManager(yamlFamilies, reader);

    expect(mgr.getAllFamilies()).toHaveLength(2);
    expect(mgr.getRule(createFamilyId("fam-db"))).not.toBeNull();
  });

  it("reload() picks up new DB families", () => {
    const dbFamilies: FamilyConfig[] = [];
    const reader: DbFamilyRulesReader = { loadAll: () => dbFamilies };

    const mgr = new ReloadableFamilyRulesManager([], reader);
    expect(mgr.getAllFamilies()).toHaveLength(0);

    dbFamilies.push(makeFamilyConfig("fam-new"));
    mgr.reload();

    expect(mgr.getAllFamilies()).toHaveLength(1);
    expect(mgr.getRule(createFamilyId("fam-new"))).not.toBeNull();
  });

  it("isEnabled delegates correctly", () => {
    const yamlFamilies = [makeFamilyConfig("fam-1")];
    const mgr = new ReloadableFamilyRulesManager(yamlFamilies, emptyReader());

    expect(mgr.isEnabled(createFamilyId("fam-1"))).toBe(true);
    expect(mgr.isEnabled(createFamilyId("nonexistent"))).toBe(false);
  });

  it("getRulesForRegime delegates correctly", () => {
    const yamlFamilies = [makeFamilyConfig("fam-1")];
    const mgr = new ReloadableFamilyRulesManager(yamlFamilies, emptyReader());

    expect(mgr.getRulesForRegime("threshold")).toHaveLength(1);
    expect(mgr.getRulesForRegime("generic")).toHaveLength(0);
  });
});
