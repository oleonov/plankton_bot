import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFamilyId, createTokenId, createPositionId } from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import type {
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyRules,
  Position,
  PositionRepository,
  MarketRepository,
  Regime,
} from "@plankton/domain";
import { StalePruningModule } from "../modules/pruning/stale-pruning-module.js";

const FAM_ID = createFamilyId("fam-btc");
const TOK_ID = createTokenId("tok-yes");

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: TOK_ID,
    familyId: FAM_ID,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.02, // cheap — below minEntryPrice
    costBasisUsdc: 2,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    openedAt: hoursAgo(100), // old enough to prune
    closedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeBundle(overrides?: {
  staleTailPruneEnabled?: boolean;
  maxTailHoldHours?: number | null;
  minEntryPrice?: number;
}): FamilyRuleBundle {
  const {
    staleTailPruneEnabled = true,
    maxTailHoldHours = 69,
    minEntryPrice = 0.03,
  } = overrides ?? {};

  return {
    identity: {
      familyId: FAM_ID,
      familyKey: "btc-price",
      primaryCategory: "crypto",
      regime: "threshold" as Regime,
      horizon: "short",
      cadence: "daily",
      strategyProfile: "scalp" as any,
      topicKey: "btc",
      slugPattern: "btc*",
      notes: null,
    },
    evidence: {
      familyId: FAM_ID,
      evidenceStatus: "confirmed",
      evidenceScore: 0.8,
      promotionState: "scaled",
      localTradeCount: 10,
      localMarketCount: 3,
      localRealizedPnlFifo: 5,
      openTailCostUsdc: 0,
      tailAdjustedPnl: 5,
      remoteClosedRealizedPnl: null,
      openPositionCount: null,
      openDustCount: null,
      bothSidedEligible: false,
      heavyCampaignEligible: false,
      activeWindowEdgeScore: null,
      lastValidatedAt: null,
    },
    rules: {
      familyId: FAM_ID,
      universe: {
        enabled: true,
        action: "trade",
        priorityRank: 1,
        allowWeekends: false,
        sessionMode: "active-window",
      },
      entry: {
        entryMode: "probe-first",
        minEntryPrice,
        maxEntryPrice: 0.95,
        maxInitialNotionalUsdc: 10,
        allowHighPriceOneShot: false,
        highPriceThreshold: 0.85,
        requireProvenFamilyAbovePrice: 0.7,
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
        targetRoiBandLow: null,
        targetRoiBandHigh: null,
        maxUnmovedHoldHours: null,
        maxTailHoldHours,
      },
      twoSided: { allowTwoSided: false, twoSidedMode: "disabled", minActivityForTwoSided: null },
      tailSuppression: {
        maxOpenValueUsdc: 100,
        maxActiveMarkets: 5,
        maxDustPositions: 3,
        tailQuarantineThresholdUsdc: 50,
        tailQuarantineThresholdRatio: 0.5,
        staleTailPruneEnabled,
        thresholdCleanupRequired: false,
        autoSettleResolvedMarkets: true,
      },
      session: {
        activeWindowsUtc: [],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
        weekendMode: "normal",
      },
    } as FamilyRules,
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function createMockRulesProvider(bundle: FamilyRuleBundle): FamilyRulesProvider {
  return {
    getRule: vi.fn().mockReturnValue(bundle),
    isEnabled: vi.fn().mockReturnValue(true),
    getAllFamilies: vi.fn().mockReturnValue([bundle.identity]),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  };
}

function createMockPositionRepo(positions: Position[]): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByFamily: vi.fn().mockReturnValue(positions),
    findOpen: vi.fn().mockReturnValue(positions),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue(positions),
  };
}

function createMockMarketRepo(active = true): MarketRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue({ active }),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findByFamily: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
  };
}

describe("StalePruningModule", () => {
  let bus: InProcessEventBus;

  beforeEach(() => {
    bus = new InProcessEventBus();
  });

  it("emits stale-prune signal for old cheap position", async () => {
    const bundle = makeBundle();
    const pos = makePosition(); // 100 hours old, avgEntryPrice 0.02 < minEntryPrice 0.03
    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      rulesProvider: createMockRulesProvider(bundle),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const signals: any[] = [];
    bus.subscribe("SignalProduced", async (p) => {
      signals.push(p);
    });

    const pruned = await mod.runCheck();

    expect(pruned).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].signal.reason).toBe("stale-prune");
    expect(signals[0].signal.side).toBe("sell");
    expect(signals[0].signal.tokenId).toBe(TOK_ID);

    await mod.stop();
  });

  it("skips position not old enough", async () => {
    const bundle = makeBundle({ maxTailHoldHours: 69 });
    const pos = makePosition({ openedAt: hoursAgo(1) }); // only 1 hour old

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      rulesProvider: createMockRulesProvider(bundle),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("skips position with entry price above minEntryPrice", async () => {
    const bundle = makeBundle({ minEntryPrice: 0.03 });
    const pos = makePosition({ avgEntryPrice: 0.1 }); // not a cheap tail position

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      rulesProvider: createMockRulesProvider(bundle),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("skips family with staleTailPruneEnabled=false", async () => {
    const bundle = makeBundle({ staleTailPruneEnabled: false });
    const pos = makePosition();

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      rulesProvider: createMockRulesProvider(bundle),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("skips family with maxTailHoldHours=null", async () => {
    const bundle = makeBundle({ maxTailHoldHours: null });
    const pos = makePosition();

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      rulesProvider: createMockRulesProvider(bundle),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("prunes dust positions too", async () => {
    const bundle = makeBundle();
    const pos = makePosition({ status: "dust" });

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      rulesProvider: createMockRulesProvider(bundle),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(1);

    await mod.stop();
  });

  it("does not prune closed positions", async () => {
    const bundle = makeBundle();
    const pos = makePosition({ status: "closed" });

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(),
      rulesProvider: createMockRulesProvider(bundle),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });

  it("skips positions on inactive/resolved markets", async () => {
    const bundle = makeBundle();
    const pos = makePosition(); // would normally be pruned

    const mod = new StalePruningModule({
      positionRepo: createMockPositionRepo([pos]),
      marketRepo: createMockMarketRepo(false), // inactive market
      rulesProvider: createMockRulesProvider(bundle),
      bus,
      log: silentLog,
      checkIntervalMs: 60_000,
    });

    const pruned = await mod.runCheck();
    expect(pruned).toBe(0);

    await mod.stop();
  });
});
