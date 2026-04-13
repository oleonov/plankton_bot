import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createFamilyId,
  createFillId,
  createOrderId,
  createPositionId,
  createLotId,
  createCommandId,
} from "@plankton/domain";
import { LiveLiteGuard } from "../live-lite-guard.js";
import type {
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyRules,
  FamilyState,
  FamilyStateRepository,
  PositionRepository,
  InventoryLotRepository,
  OrderRepository,
  Position,
  InventoryLot,
  Order,
  Signal,
  FamilyId,
  Regime,
  ClientOrderId,
  NormalizedMarket,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { RiskInventoryModule } from "../modules/risk-inventory/risk-inventory-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

const FAM_ID = createFamilyId("fam-btc");
const TOK_ID = createTokenId("tok-yes");

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    signalId: "sig-1",
    familyId: FAM_ID,
    tokenId: TOK_ID,
    side: "buy",
    suggestedPrice: 0.5,
    suggestedSize: 10,
    suggestedSizeUsdc: 5,
    reason: "probe-entry",
    strategyTick: Date.now(),
    sequenceInTick: 0,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeNormalizedMarket(
  tokenId: ReturnType<typeof createTokenId>,
  minOrderSize: number,
): NormalizedMarket {
  return {
    tokenId,
    conditionId: `cond-${String(tokenId)}`,
    slug: `market-${String(tokenId)}`,
    eventSlug: null,
    question: "Test market?",
    outcome: "YES",
    outcomeIndex: 0,
    familyId: FAM_ID,
    familyKey: "btc-price",
    regime: "threshold" as Regime,
    horizon: "short",
    endDate: null,
    active: true,
    tickSize: 0.01,
    negRisk: false,
    bestBid: 0.19,
    bestAsk: 0.21,
    midPrice: 0.2,
    spread: 0.02,
    lastTradePrice: null,
    lastTradeAt: null,
    volume24h: null,
    liquidity: null,
    minOrderSize,
    bookSource: "clob",
    snapshotTs: Date.now(),
  };
}

function makeFamilyState(overrides?: Partial<FamilyState>): FamilyState {
  return {
    familyId: FAM_ID,
    runtimeMode: "active",
    openValueUsdc: 0,
    openPositionCount: 0,
    openDustCount: 0,
    activeMarketCount: 0,
    currentTailCostUsdc: 0,
    tailAdjustedPnlLive: 0,
    lastEntryTs: null,
    lastExitTs: null,
    quarantineReason: null,
    effectiveMode: null,
    derivedModeReason: null,
    firstNegativeTailAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTailRules(overrides?: Record<string, unknown>) {
  return {
    maxOpenValueUsdc: 100,
    maxActiveMarkets: 5,
    maxDustPositions: 3,
    tailQuarantineThresholdUsdc: 50,
    tailQuarantineThresholdRatio: 0.5,
    staleTailPruneEnabled: false,
    thresholdCleanupRequired: false,
    autoSettleResolvedMarkets: true,
    ...overrides,
  };
}

function makeRuleBundle(
  tailOverrides?: Record<string, unknown>,
  identityOverrides?: Partial<FamilyRuleBundle["identity"]>,
  evidenceOverrides?: Partial<FamilyRuleBundle["evidence"]>,
): FamilyRuleBundle {
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
      ...identityOverrides,
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
      recurrenceScore: null,
      recycleScore: null,
      liveViabilityScore: null,
      toxicityPenalty: null,
      lastValidatedAt: null,
      probeSubstate: null,
      repricingExitCount: 0,
      ...evidenceOverrides,
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
        minEntryPrice: 0.05,
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
        maxTailHoldHours: null,
      },
      twoSided: {
        allowTwoSided: false,
        twoSidedMode: "disabled",
        minActivityForTwoSided: null,
      },
      tailSuppression: makeTailRules(tailOverrides),
      session: {
        activeWindowsUtc: [],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
      },
    } as FamilyRules,
  };
}

function createMockRulesProvider(
  bundle: FamilyRuleBundle | null = makeRuleBundle(),
): FamilyRulesProvider {
  return {
    getRule: vi.fn().mockReturnValue(bundle),
    isEnabled: vi.fn().mockReturnValue(bundle !== null),
    getAllFamilies: vi.fn().mockReturnValue(bundle ? [bundle.identity] : []),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  };
}

function createMockFamilyStateRepo(state?: FamilyState): FamilyStateRepository {
  return {
    get: vi.fn().mockReturnValue(state ?? null),
    save: vi.fn(),
    findAll: vi.fn().mockReturnValue(state ? [state] : []),
    findByMode: vi.fn().mockReturnValue([]),
    findQuarantined: vi.fn().mockReturnValue([]),
  };
}

function createMockPositionRepo(position?: Position | Position[] | null): PositionRepository {
  const positions = Array.isArray(position) ? position : position ? [position] : [];
  return {
    save: vi.fn(),
    findByTokenId: vi
      .fn()
      .mockImplementation(
        (tokenId: ReturnType<typeof createTokenId>) =>
          positions.find((entry) => String(entry.tokenId) === String(tokenId)) ?? null,
      ),
    findByFamily: vi.fn().mockReturnValue(positions),
    findOpen: vi.fn().mockReturnValue(positions.filter((entry) => entry.status === "open")),
    findDust: vi.fn().mockReturnValue(positions.filter((entry) => entry.status === "dust")),
    findAll: vi.fn().mockReturnValue(positions),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
  };
}

function createMockLotRepo(): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

function createMockOrderRepo(order?: Order | null): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(order ?? null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
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

const mockDb = {
  prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
} as any;

// ─── Tests ───────────────────────────────────────────────────────────────

describe("RiskInventoryModule", () => {
  let bus: InProcessEventBus;
  let rulesProvider: ReturnType<typeof createMockRulesProvider>;
  let familyStateRepo: ReturnType<typeof createMockFamilyStateRepo>;
  let positionRepo: ReturnType<typeof createMockPositionRepo>;
  let lotRepo: ReturnType<typeof createMockLotRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: { markReconciled: ReturnType<typeof vi.fn> };
  let mod: RiskInventoryModule;

  function createModule(liveLiteGuard?: LiveLiteGuard) {
    return new RiskInventoryModule({
      bus,
      rulesProvider,
      familyStateRepo,
      positionRepo,
      inventoryLotRepo: lotRepo,
      orderRepo,
      fillRepo,
      log: silentLog,
      db: mockDb,
      liveLiteGuard,
    });
  }

  beforeEach(() => {
    bus = new InProcessEventBus();
    rulesProvider = createMockRulesProvider();
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState());
    positionRepo = createMockPositionRepo();
    lotRepo = createMockLotRepo();
    orderRepo = createMockOrderRepo();
    fillRepo = { markReconciled: vi.fn() };
    mod = createModule();
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────

  it("healthCheck returns not-ok before start", async () => {
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
  });

  it("healthCheck returns ok after start", async () => {
    await mod.start();
    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    await mod.stop();
  });

  // ─── Signal approval ───────────────────────────────────────────────

  it("approves valid entry signal for active family", async () => {
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(approved).toHaveLength(1);
    expect(approved[0].signal.signalId).toBe("sig-1");

    await mod.stop();
  });

  it("approves exit signal regardless of exposure limits", async () => {
    // Max out exposure
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ openValueUsdc: 999, openPositionCount: 99 }),
    );
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ side: "sell", reason: "repricing-exit" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Signal rejection: family not found ───────────────────────────

  it("rejects signal for unknown family", async () => {
    rulesProvider = createMockRulesProvider(null);
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("not found");

    await mod.stop();
  });

  // ─── Signal rejection: quarantine ─────────────────────────────────

  it("rejects strategy signal for quarantined family", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ runtimeMode: "quarantine" }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("quarantine");

    await mod.stop();
  });

  it("allows operator signal for quarantined family", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ runtimeMode: "quarantine" }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "operator", side: "sell" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Signal rejection: reduce-only ────────────────────────────────

  it("rejects entry signal for reduce-only family", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ runtimeMode: "reduce-only" }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ side: "buy", reason: "probe-entry" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("reduce-only");

    await mod.stop();
  });

  it("allows exit signal for reduce-only family", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ runtimeMode: "reduce-only" }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ side: "sell", reason: "repricing-exit" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Signal rejection: probe-only blocks scale-in ─────────────────

  it("rejects scale-in signal for probe-only family", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ runtimeMode: "probe-only" }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "scale-in" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("probe-only");

    await mod.stop();
  });

  it("approves spray-entry signal in probe-only family", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ runtimeMode: "probe-only" }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "spray-entry", suggestedSizeUsdc: 0.15 }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Signal rejection: exposure limits ────────────────────────────

  it("rejects entry when max open value exceeded", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ openValueUsdc: 98 }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    // signal suggestedSizeUsdc=5, existing=98, total=103 > max=100
    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("open value");

    await mod.stop();
  });

  it("rejects entry for new market when max active markets exceeded", async () => {
    const blockingToken = createTokenId("tok-blocking-open");
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ activeMarketCount: 1 }));
    rulesProvider = createMockRulesProvider(makeRuleBundle({ maxActiveMarkets: 1 }));
    positionRepo = createMockPositionRepo({
      positionId: createPositionId("pos-blocking-open"),
      tokenId: blockingToken,
      familyId: FAM_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.2,
      costBasisUsdc: 2,
      currentValueUsdc: 2,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    });
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("active markets");

    await mod.stop();
  });

  it("allows entry when only active family position is below the exchange minimum size", async () => {
    const legacyToken = createTokenId("tok-legacy-open");
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ activeMarketCount: 1 }));
    rulesProvider = createMockRulesProvider(makeRuleBundle({ maxActiveMarkets: 1 }));
    positionRepo = createMockPositionRepo({
      positionId: createPositionId("pos-legacy-open"),
      tokenId: legacyToken,
      familyId: FAM_ID,
      side: "buy",
      size: 1,
      avgEntryPrice: 0.2,
      costBasisUsdc: 0.2,
      currentValueUsdc: 0.2,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    });
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket(legacyToken, 5)],
      timestamp: Date.now(),
    });
    await bus.publish("SignalProduced", {
      signal: makeSignal({ tokenId: createTokenId("tok-new-open") }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("uses live minOrderSize when deciding whether an active market is still blocking", async () => {
    const legacyToken = createTokenId("tok-legacy-executable");
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ activeMarketCount: 1 }));
    rulesProvider = createMockRulesProvider(makeRuleBundle({ maxActiveMarkets: 1 }));
    positionRepo = createMockPositionRepo({
      positionId: createPositionId("pos-legacy-executable"),
      tokenId: legacyToken,
      familyId: FAM_ID,
      side: "buy",
      size: 3,
      avgEntryPrice: 0.2,
      costBasisUsdc: 0.6,
      currentValueUsdc: 0.6,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    });
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket(legacyToken, 2)],
      timestamp: Date.now(),
    });
    await bus.publish("SignalProduced", {
      signal: makeSignal({ tokenId: createTokenId("tok-new-blocked") }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("active markets 1 >= max 1");

    await mod.stop();
  });

  it("allows scale-in to existing market even when max active markets reached", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ activeMarketCount: 5 }));
    // Existing position for this token — scale-in, not a new market
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "scale-in" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("rejects entry when max dust positions exceeded", async () => {
    const blockingDustToken = createTokenId("tok-blocking-dust");
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ openDustCount: 1 }));
    rulesProvider = createMockRulesProvider(makeRuleBundle({ maxDustPositions: 1 }));
    positionRepo = createMockPositionRepo({
      positionId: createPositionId("pos-blocking-dust"),
      tokenId: blockingDustToken,
      familyId: FAM_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.2,
      costBasisUsdc: 2,
      currentValueUsdc: 2,
      realizedPnl: 0,
      status: "dust",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    });
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("dust");

    await mod.stop();
  });

  it("allows entry when only dust family position is below the exchange minimum size", async () => {
    const dustToken = createTokenId("tok-dust-legacy");
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ openDustCount: 1 }));
    rulesProvider = createMockRulesProvider(makeRuleBundle({ maxDustPositions: 1 }));
    positionRepo = createMockPositionRepo({
      positionId: createPositionId("pos-dust-legacy"),
      tokenId: dustToken,
      familyId: FAM_ID,
      side: "buy",
      size: 1,
      avgEntryPrice: 0.2,
      costBasisUsdc: 0.2,
      currentValueUsdc: 0.2,
      realizedPnl: 0,
      status: "dust",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    });
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeNormalizedMarket(dustToken, 5)],
      timestamp: Date.now(),
    });
    await bus.publish("SignalProduced", {
      signal: makeSignal({ tokenId: createTokenId("tok-new-after-dust") }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("rejects entry when tail quarantine threshold exceeded", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ currentTailCostUsdc: 48 }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    // tail=48 + signal=5 = 53 > threshold=50
    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("tail cost");

    await mod.stop();
  });

  it("rejects entry when tail quarantine ratio exceeded", async () => {
    // realizedPnl = tailAdjustedPnlLive + currentTailCostUsdc = 2 + 8 = 10
    // projectedTailCost = currentTailCostUsdc + signalSize = 8 + 5 = 13
    // ratio = 13 / 10 = 1.3 > threshold 0.5
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ tailAdjustedPnlLive: 2, currentTailCostUsdc: 8 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("reduce-only");

    await mod.stop();
  });

  it("skips tail ratio check when realizedPnl is non-positive", async () => {
    // realizedPnl = tailAdjustedPnlLive + currentTailCostUsdc = -20 + 5 = -15
    // ratio check skipped — no division by non-positive
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ tailAdjustedPnlLive: -20, currentTailCostUsdc: 5 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    const ratioRejection = rejected.find((r: any) => r.reason.includes("tail cost ratio"));
    expect(ratioRejection).toBeUndefined();

    await mod.stop();
  });

  // ─── Fill handling: buy ───────────────────────────────────────────

  it("creates new position on buy fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });
    const expChanges: any[] = [];
    bus.subscribe("FamilyExposureChanged", async (p) => {
      expChanges.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_abc" as ClientOrderId,
      tokenId: TOK_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      familyId: FAM_ID,
      signalReason: null,
      timestamp: Date.now(),
    });

    // Position was created
    expect(positionRepo.save).toHaveBeenCalledTimes(1);
    expect(posUpdates).toHaveLength(1);
    expect(posUpdates[0].position.size).toBe(10);
    expect(posUpdates[0].position.avgEntryPrice).toBe(0.5);
    expect(posUpdates[0].position.status).toBe("open");

    // Lot was created
    expect(lotRepo.save).toHaveBeenCalledTimes(1);

    // Family exposure was updated
    expect(expChanges).toHaveLength(1);
    expect(familyStateRepo.save).toHaveBeenCalled();

    await mod.stop();
  });

  it("sets entryStyle='spray' on new position from spray-entry fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-spray"),
      orderId: createOrderId("ord-spray"),
      clientOrderId: "plk_spray" as ClientOrderId,
      tokenId: TOK_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      familyId: FAM_ID,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });

    expect(posUpdates).toHaveLength(1);
    expect(posUpdates[0].position.entryStyle).toBe("spray");

    await mod.stop();
  });

  it("sets entryStyle='probe' on new position from probe-entry fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-probe"),
      orderId: createOrderId("ord-probe"),
      clientOrderId: "plk_probe" as ClientOrderId,
      tokenId: TOK_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      familyId: FAM_ID,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });

    expect(posUpdates).toHaveLength(1);
    expect(posUpdates[0].position.entryStyle).toBe("probe");

    await mod.stop();
  });

  it("scales into existing position on buy fill", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);
    mod = createModule();
    await mod.start();

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-2"),
      orderId: createOrderId("ord-2"),
      clientOrderId: "plk_def" as ClientOrderId,
      tokenId: TOK_ID,
      side: "buy" as const,
      price: 0.6,
      size: 10,
      sizeUsdc: 6,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      familyId: FAM_ID,
      signalReason: null,
      timestamp: Date.now(),
    });

    // Position updated with new avg price
    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.size).toBe(20); // 10 + 10
    expect(saved.costBasisUsdc).toBe(10); // 4 + 6
    expect(saved.avgEntryPrice).toBe(0.5); // 10/20

    await mod.stop();
  });

  // ─── Fill handling: sell with FIFO ────────────────────────────────

  it("applies sell fill with FIFO lot consumption", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);

    // FIFO consumption returns consumed lots
    const consumedLot: InventoryLot = {
      lotId: createLotId("lot-1"),
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 10,
      remainingSize: 5, // 5 remaining after consuming 5
      entryPrice: 0.4,
      costUsdc: 4,
      fillId: createFillId("fill-orig"),
      createdAt: new Date().toISOString(),
    };
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockReturnValue([
      { lot: consumedLot, consumed: 5 },
    ]);
    // After consumption, lots still open
    (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...consumedLot, remainingSize: 5 },
    ]);

    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-sell"),
      orderId: createOrderId("ord-sell"),
      clientOrderId: "plk_sell" as ClientOrderId,
      tokenId: TOK_ID,
      side: "sell" as const,
      price: 0.6,
      size: 5,
      sizeUsdc: 3,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      familyId: FAM_ID,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(lotRepo.consumeFifo).toHaveBeenCalledWith(createPositionId("pos-1"), 5);

    // Position updated
    expect(posUpdates).toHaveLength(1);
    const updatedPos = posUpdates[0].position as Position;
    expect(updatedPos.size).toBe(5); // 10 - 5
    expect(updatedPos.status).toBe("open");
    // Realized PnL: (5 * 0.6) - (5 * 0.4) - 0.01 fee = 3.0 - 2.0 - 0.01 = 0.99
    expect(updatedPos.realizedPnl).toBeCloseTo(0.99, 2);

    await mod.stop();
  });

  it("closes position when fully sold", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);

    const consumedLot: InventoryLot = {
      lotId: createLotId("lot-1"),
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 10,
      remainingSize: 0,
      entryPrice: 0.4,
      costUsdc: 4,
      fillId: createFillId("fill-orig"),
      createdAt: new Date().toISOString(),
    };
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockReturnValue([
      { lot: consumedLot, consumed: 10 },
    ]);
    (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([]);

    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-sell-all"),
      orderId: createOrderId("ord-sell-all"),
      clientOrderId: "plk_sellall" as ClientOrderId,
      tokenId: TOK_ID,
      side: "sell" as const,
      price: 0.6,
      size: 10,
      sizeUsdc: 6,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      familyId: FAM_ID,
      signalReason: null,
      timestamp: Date.now(),
    });

    const updatedPos = posUpdates[0].position as Position;
    expect(updatedPos.size).toBe(0);
    expect(updatedPos.status).toBe("closed");
    expect(updatedPos.closedAt).not.toBeNull();
    // Realized PnL: (10 * 0.6) - (10 * 0.4) = 6 - 4 = 2
    expect(updatedPos.realizedPnl).toBeCloseTo(2, 2);

    await mod.stop();
  });

  // ─── Family exposure update ───────────────────────────────────────

  it("publishes FamilyExposureChanged after fill", async () => {
    await mod.start();

    const changes: any[] = [];
    bus.subscribe("FamilyExposureChanged", async (p) => {
      changes.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_abc" as ClientOrderId,
      tokenId: TOK_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      familyId: FAM_ID,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].familyId).toBe(FAM_ID);
    expect(changes[0].familyState).toBeDefined();

    await mod.stop();
  });

  // ─── Fill reconciliation marking ─────────────────────────────────

  it("marks fill as reconciled after successful applyFill", async () => {
    await mod.start();

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_test" as ClientOrderId,
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(fillRepo.markReconciled).toHaveBeenCalledWith([createFillId("fill-1")]);

    await mod.stop();
  });

  it("does NOT call markReconciled when applyFill throws", async () => {
    await mod.start();

    // Sell fill for a token with no existing position — applyFill will throw
    await bus.publish("FillReceived", {
      fillId: createFillId("fill-err"),
      orderId: createOrderId("ord-err"),
      clientOrderId: "plk_err" as ClientOrderId,
      tokenId: createTokenId("tok-nonexistent"),
      familyId: FAM_ID,
      side: "sell" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(fillRepo.markReconciled).not.toHaveBeenCalled();

    await mod.stop();
  });

  // ─── Unsubscribe on stop ──────────────────────────────────────────

  it("does not process events after stop", async () => {
    await mod.start();
    await mod.stop();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(approved).toHaveLength(0);
  });

  // ─── Error resilience ─────────────────────────────────────────────

  it("rejects signal on internal error without crashing", async () => {
    // Make rulesProvider throw
    (rulesProvider.getRule as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("rules explosion");
    });
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("internal error");

    await mod.stop();
  });

  // ─── Live-lite allowlist check ────────────────────────────

  it("rejects signal for non-allowlisted family in live-lite mode", async () => {
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-other"],
      maxFamilies: 2,
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 50,
      maxActiveMarkets: 3,
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() }); // familyId = FAM_ID = "fam-btc"

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("live-lite-allowlist-rejected");

    await mod.stop();
  });

  it("rejects fee-enabled entry families in live-lite EOA mode", async () => {
    rulesProvider = createMockRulesProvider(
      makeRuleBundle(undefined, {
        primaryCategory: "crypto",
        feeTier: "fee-enabled",
        liveWalletRequirement: "relayer-required",
        requiresPostOnlyForLive: true,
      }),
    );
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-btc"],
      maxFamilies: 2,
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 50,
      maxActiveMarkets: 3,
      walletMode: "eoa",
      minOrderUsdc: 3,
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("live-post-only-required");
    expect(rejected[0].reason).toContain("live-eoa-fee-enabled-family-rejected");

    await mod.stop();
  });

  it("approves fee-enabled entry families in live-lite relayer mode when post-only is available", async () => {
    rulesProvider = createMockRulesProvider(
      makeRuleBundle(undefined, {
        primaryCategory: "crypto",
        feeTier: "fee-enabled",
        liveWalletRequirement: "relayer-required",
        requiresPostOnlyForLive: true,
      }),
    );
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-btc"],
      maxFamilies: 2,
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 50,
      maxActiveMarkets: 3,
      walletMode: "relayer",
      minOrderUsdc: 2,
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const approved: any[] = [];
    const rejected: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(0);
    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("rejects live-lite entry below the configured minimum order size", async () => {
    rulesProvider = createMockRulesProvider(
      makeRuleBundle(undefined, {
        primaryCategory: "geopolitics",
        feeTier: "fee-free",
        liveWalletRequirement: "eoa-ok",
        requiresPostOnlyForLive: false,
      }),
    );
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-btc"],
      maxFamilies: 2,
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 50,
      maxActiveMarkets: 3,
      walletMode: "eoa",
      minOrderUsdc: 3,
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ suggestedSizeUsdc: 2.5, suggestedSize: 5 }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("live-min-order-usdc-rejected");

    await mod.stop();
  });

  it("approves signal for allowlisted family in live-lite mode", async () => {
    rulesProvider = createMockRulesProvider(
      makeRuleBundle(undefined, {
        primaryCategory: "geopolitics",
        feeTier: "fee-free",
        liveWalletRequirement: "eoa-ok",
        requiresPostOnlyForLive: false,
      }),
    );
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-btc"],
      maxFamilies: 2,
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 50,
      maxActiveMarkets: 3,
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() }); // familyId = fam-btc

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("rejects entry signal when live-lite open value cap would be exceeded", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ openValueUsdc: 490 }));
    rulesProvider = createMockRulesProvider(
      makeRuleBundle(undefined, {
        primaryCategory: "geopolitics",
        feeTier: "fee-free",
        liveWalletRequirement: "eoa-ok",
        requiresPostOnlyForLive: false,
      }),
    );
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-btc"],
      maxFamilies: 2,
      maxOpenValueUsdc: 490, // current + signal (5) = 495 > 490
      maxOrderUsdc: 50,
      maxActiveMarkets: 3,
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("live-lite-open-value-cap-exceeded");

    await mod.stop();
  });

  it("rejects entry for new market when live-lite active markets cap would be exceeded", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ activeMarketCount: 3 }));
    positionRepo = createMockPositionRepo(null); // no existing position → new market
    rulesProvider = createMockRulesProvider(
      makeRuleBundle(undefined, {
        primaryCategory: "geopolitics",
        feeTier: "fee-free",
        liveWalletRequirement: "eoa-ok",
        requiresPostOnlyForLive: false,
      }),
    );
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-btc"],
      maxFamilies: 2,
      maxOpenValueUsdc: 10_000,
      maxOrderUsdc: 50,
      maxActiveMarkets: 3, // current 3 + 1 would exceed 3
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("live-lite-active-markets-cap-exceeded");

    await mod.stop();
  });

  it("allows exit signal through live-lite caps without rejection", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ openValueUsdc: 999, activeMarketCount: 99 }),
    );
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-btc"],
      maxFamilies: 2,
      maxOpenValueUsdc: 1, // would reject any entry
      maxOrderUsdc: 50,
      maxActiveMarkets: 1, // would reject new markets
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    // Exit signal — must never be blocked by live-lite caps
    await bus.publish("SignalProduced", {
      signal: makeSignal({ side: "sell", reason: "repricing-exit" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Error resilience ─────────────────────────────────────

  it("logs error on orphan sell fill without fabricating PnL", async () => {
    // No existing position for the token
    positionRepo = createMockPositionRepo(null);
    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-orphan"),
      orderId: createOrderId("ord-orphan"),
      clientOrderId: "plk_orphan" as ClientOrderId,
      tokenId: TOK_ID,
      side: "sell" as const,
      price: 0.6,
      size: 5,
      sizeUsdc: 3,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      familyId: FAM_ID,
      signalReason: null,
      timestamp: Date.now(),
    });

    // No position should be created — the error is caught by the module
    expect(posUpdates).toHaveLength(0);
    // No synthetic position saved
    expect(positionRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });

  // ─── Tail-adjusted PnL gating ─────────────────────────────────

  it("rejects scale-in when tailAdjustedPnlLive <= 0 and requirePositiveRecycleHistoryForScale", async () => {
    const bundle = makeRuleBundle();
    bundle.rules.scaleIn.requirePositiveRecycleHistoryForScale = true;
    rulesProvider = createMockRulesProvider(bundle);
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: 0 }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "scale-in" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("requirePositiveRecycleHistoryForScale");

    await mod.stop();
  });

  it("allows scale-in when tailAdjustedPnlLive <= 0 but requirePositiveRecycleHistoryForScale is false", async () => {
    // Default bundle has requirePositiveRecycleHistoryForScale: false
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: 0 }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "scale-in" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("rejects heavy-scale when tailAdjustedPnlLive <= 0", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: -5 }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "heavy-scale" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("tailAdjustedPnlLive");

    await mod.stop();
  });

  it("approves heavy-scale when family is healthy (tailAdjustedPnlLive > 0)", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: 10 }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "heavy-scale" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("approves probe-entry when tailAdjustedPnlLive is zero (cold start)", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: 0 }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "probe-entry" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("approves probe-entry when tailAdjustedPnlLive < 0 (probe-only mode)", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: -1 }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "probe-entry" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("rejects two-sided-entry when tailAdjustedPnlLive < 0", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: -1 }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "two-sided-entry" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("tailAdjustedPnlLive");

    await mod.stop();
  });

  it("approves two-sided-entry when tailAdjustedPnlLive is zero (cold start)", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: 0 }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "two-sided-entry" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("probe-entry rejected when projected tail cost exceeds absolute threshold (reduce-only)", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ currentTailCostUsdc: 48, tailAdjustedPnlLive: 5 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "probe-entry", suggestedSizeUsdc: 5 }),
    });

    // projected = 48 + 5 = 53 > 50 threshold → reduce-only
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("reduce-only");

    await mod.stop();
  });

  it("probe-entry rejected when tail ratio threshold breached (reduce-only)", async () => {
    // realizedPnl = tailPnl + tailCost = 10 + 5 = 15
    // ratio = 10 / 15 = 0.667 > 0.5 threshold → reduce-only
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ currentTailCostUsdc: 5, tailAdjustedPnlLive: 10 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "probe-entry", suggestedSizeUsdc: 5 }),
    });

    // projected = 5 + 5 = 10, realizedPnl = 10 + 5 = 15, ratio = 10/15 = 0.667 > 0.5
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("reduce-only");

    await mod.stop();
  });

  it("confirm-scale rejected when family in derived probe-only", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: -5 }));
    const customBundle = makeRuleBundle();
    customBundle.rules.scaleIn.requirePositiveRecycleHistoryForScale = true;
    rulesProvider = createMockRulesProvider(customBundle);
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "confirm-scale" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("probe-only");

    await mod.stop();
  });

  it("scale-in rejected when family in derived probe-only", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: -5 }));
    const customBundle = makeRuleBundle();
    customBundle.rules.scaleIn.requirePositiveRecycleHistoryForScale = true;
    rulesProvider = createMockRulesProvider(customBundle);
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "scale-in" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("probe-only");

    await mod.stop();
  });

  it("allows confirm-scale for proven non-threshold families with negative tail", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: -5 }));
    rulesProvider = createMockRulesProvider(
      makeRuleBundle(
        undefined,
        {
          familyKey: "elon-musk-of-tweets",
          primaryCategory: "other",
          regime: "social-activity",
          strategyProfile: "event-driven" as any,
        },
        {
          evidenceStatus: "partial",
          evidenceScore: 80,
          localTradeCount: 250,
        },
      ),
    );
    const bundle = rulesProvider.getRule(FAM_ID)!;
    bundle.rules.scaleIn.requirePositiveRecycleHistoryForScale = true;
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "confirm-scale" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("allows scale-in in derived probe-only when requirePositiveRecycleHistoryForScale is false", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: -5 }));
    // Default bundle has requirePositiveRecycleHistoryForScale: false
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "scale-in" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("exit signal approved under degraded tail state", async () => {
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState({ tailAdjustedPnlLive: -50 }));
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ side: "sell", reason: "repricing-exit" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("rejects confirm-scale in probe-only mode", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ runtimeMode: "probe-only", tailAdjustedPnlLive: 10 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "confirm-scale" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("probe-only");

    await mod.stop();
  });

  // ─── Wave 5: mark-to-market (P2-1) ─────────────────────────────────

  describe("mark-to-market (P2-1)", () => {
    it("revalues open positions on NormalizedMarketUpdated", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        familyId: FAM_ID,
        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: new Date().toISOString(),
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule();
      await mod.start();

      // Market moves from 0.05 to 0.08 → new value = 100 * 0.08 = 8.0
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,
            familyId: FAM_ID,
            familyKey: "btc",
            regime: "threshold" as Regime,
            horizon: "daily",
            endDate: null,
            active: true,
            tickSize: 0.01,
            negRisk: false,
            bestBid: 0.07,
            bestAsk: 0.09,
            midPrice: 0.08,
            spread: 0.02,
            snapshotTs: Date.now(),
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      // positionRepo.save should have been called with updated currentValueUsdc
      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(8.0, 2);
      expect(savedPos.status).toBe("open");

      await mod.stop();
    });

    it("reclassifies low-value open positions to dust on mark-to-market", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-dustify"),
        tokenId: TOK_ID,
        familyId: FAM_ID,
        side: "buy",
        size: 1,
        avgEntryPrice: 0.8,
        costBasisUsdc: 0.8,
        currentValueUsdc: 0.8,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: new Date().toISOString(),
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule();
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,
            familyId: FAM_ID,
            familyKey: "btc",
            regime: "threshold" as Regime,
            horizon: "daily",
            endDate: null,
            active: true,
            tickSize: 0.01,
            negRisk: false,
            bestBid: 0.19,
            bestAsk: 0.21,
            midPrice: 0.2,
            spread: 0.02,
            snapshotTs: Date.now(),
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(0.2, 2);
      expect(savedPos.status).toBe("dust");

      await mod.stop();
    });

    it("skips positions without live price data", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        familyId: FAM_ID,
        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: new Date().toISOString(),
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule();
      await mod.start();

      // Market update with null midPrice → no revaluation
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: createTokenId("tok-other"),
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,
            familyId: FAM_ID,
            familyKey: "btc",
            regime: "threshold" as Regime,
            horizon: "daily",
            endDate: null,
            active: true,
            tickSize: 0.01,
            negRisk: false,
            bestBid: null,
            bestAsk: null,
            midPrice: null,
            spread: null,
            snapshotTs: Date.now(),
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      // No save call for position (no price data matched)
      expect(positionRepo.save).not.toHaveBeenCalled();

      await mod.stop();
    });
  });

  // ─── Wave 5: operator diagnostics (P2-2) ───────────────────────────

  describe("operator diagnostics (P2-2)", () => {
    it("tracks approved and rejected signal counts per family", async () => {
      await mod.start();

      // Approve a probe-entry
      await bus.publish("SignalProduced", { signal: makeSignal() });
      await bus.drain();

      // Reject by disabling family
      rulesProvider.isEnabled = vi.fn().mockReturnValue(false);
      await bus.publish("SignalProduced", {
        signal: makeSignal({ signalId: "sig-2" }),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.signalsProcessed).toBe(2);
      expect(diag.signalsApproved).toBe(1);
      expect(diag.signalsRejected).toBe(1);
      expect(diag.families[String(FAM_ID)]).toBeDefined();
      expect(diag.families[String(FAM_ID)]!.signalsApproved).toBe(1);
      expect(diag.families[String(FAM_ID)]!.signalsRejected).toBe(1);
      expect(diag.families[String(FAM_ID)]!.lastRejectionReason).toContain("disabled");

      await mod.stop();
    });

    it("tracks last signal reason per family", async () => {
      await mod.start();

      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry" }),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.families[String(FAM_ID)]!.lastSignalReason).toBe("probe-entry");

      await mod.stop();
    });

    it("reports mark-to-market update count", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        familyId: FAM_ID,
        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: new Date().toISOString(),
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule();
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,
            familyId: FAM_ID,
            familyKey: "btc",
            regime: "threshold" as Regime,
            horizon: "daily",
            endDate: null,
            active: true,
            tickSize: 0.01,
            negRisk: false,
            bestBid: 0.07,
            bestAsk: 0.09,
            midPrice: 0.08,
            spread: 0.02,
            snapshotTs: Date.now(),
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.markToMarketUpdates).toBe(1);

      await mod.stop();
    });

    it("healthCheck includes approved/rejected/mtm counts", async () => {
      await mod.start();

      await bus.publish("SignalProduced", { signal: makeSignal() });
      await bus.drain();

      const h = await mod.healthCheck();
      expect(h.detail).toContain("approved=1");
      expect(h.detail).toContain("rejected=0");
      expect(h.detail).toContain("mtm=0");

      await mod.stop();
    });
  });

  // ─── Flat-family anti-deadlock (projected-ratio carve-out) ────────

  it("does NOT reject entry on flat family where only projected ratio would exceed threshold", async () => {
    // Family has $0 current tail (flat), $1.58 realized PnL
    // Signal suggests $5.00 entry
    // projected = 0 + 5 = 5, realized = 1.58 + 0 = 1.58, ratio = 5/1.58 = 3.16 > 0.5
    // But currentTailCostUsdc === 0, so ratio should NOT trigger reduce-only
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ tailAdjustedPnlLive: 1.58, currentTailCostUsdc: 0 }),
    );
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal({ suggestedSizeUsdc: 5 }) });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("still rejects entry when currentTailCostUsdc > 0 and ratio exceeded", async () => {
    // Family has $8 current tail, $2 tail-adjusted PnL
    // realizedPnl = 2 + 8 = 10, projected = 8 + 5 = 13, ratio = 13/10 = 1.3 > 0.5
    // currentTailCostUsdc > 0, so ratio check STILL applies
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ tailAdjustedPnlLive: 2, currentTailCostUsdc: 8 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("reduce-only");

    await mod.stop();
  });

  // ─── Rejection message distinguishes absolute cap vs ratio ────────

  it("rejection message distinguishes absolute cap breach from ratio breach", async () => {
    // Absolute cap breach: projectedTailCost > tailQuarantineThresholdUsdc
    // currentTail=40, signal=15, projected=55, threshold=50 → absolute cap breach
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ tailAdjustedPnlLive: 100, currentTailCostUsdc: 40 }),
    );
    rulesProvider = createMockRulesProvider(makeRuleBundle({ tailQuarantineThresholdUsdc: 50 }));
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ suggestedSizeUsdc: 15 }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("tail cost");
    expect(rejected[0].reason).toContain("> cap");
    expect(rejected[0].reason).toContain("50");
    expect(rejected[0].reason).not.toContain("ratio");

    await mod.stop();
  });

  it("rejection message for ratio breach includes ratio value and realized PnL", async () => {
    // Ratio breach: currentTail=8, signal=5, projected=13, realized=10, ratio=1.3 > 0.5
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ tailAdjustedPnlLive: 2, currentTailCostUsdc: 8 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("tail/pnl ratio");
    expect(rejected[0].reason).toContain("realized");
    expect(rejected[0].reason).toContain("1.30");

    await mod.stop();
  });

  // ─── Per-family in-flight limiter (B2.2) ──────────────────────────

  describe("per-family in-flight limiter", () => {
    function makePlaceOrderRequested(
      familyId: FamilyId = FAM_ID,
      signalReason: string | null = null,
    ) {
      return {
        command: {
          type: "PlaceOrderCommand" as const,
          commandId: createCommandId("cmd-1"),
          clientOrderId: "plk_test" as ClientOrderId,
          source: "strategy" as const,
          tokenId: TOK_ID,
          side: "buy" as const,
          size: 10,
          price: 0.5,
          orderType: "GTC" as const,
          tickSize: 0.01,
          negRisk: false,
          familyId,
          sequenceInTick: 0,
          signalReason,
        },
        timestamp: Date.now(),
      };
    }

    it("rejects entry signal when family has >= 2 in-flight orders", async () => {
      await mod.start();

      const rejected: any[] = [];
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("family-in-flight-limit");

      await mod.stop();
    });

    it("allows entry signal after in-flight order is rejected (counter decremented)", async () => {
      await mod.start();

      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      await bus.publish("OrderRejected", {
        commandId: createCommandId("cmd-1"),
        clientOrderId: "plk_test" as ClientOrderId,
        reason: "insufficient balance",
        errorCode: "INSUFFICIENT_BALANCE",
        familyId: FAM_ID,
        signalReason: null,
        timestamp: Date.now(),
      });
      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(approved).toHaveLength(1);

      await mod.stop();
    });

    it("decrements in-flight only once when a multi-fill order reaches filled", async () => {
      await mod.start();

      // 2 in-flight orders for the family
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());

      // Mock: order is "filled" (set before FillReceived, as importExchangeFills does)
      (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue({
        orderId: createOrderId("ord-1"),
        familyId: FAM_ID,
        status: "filled",
        size: 10,
      });

      // Two fills for the same order (e.g. partial fills in one import batch)
      const fillBase = {
        orderId: createOrderId("ord-1"),
        clientOrderId: "plk_test" as ClientOrderId,
        tokenId: TOK_ID,
        side: "buy" as const,
        sizeUsdc: 2.5,
        liquidityRole: "unknown" as const,
        fee: 0,
        feeRateBps: 0,
        familyId: FAM_ID,
        signalReason: null as string | null,
        timestamp: Date.now(),
      };
      await bus.publish("FillReceived", {
        ...fillBase,
        fillId: "fill-1" as any,
        price: 0.5,
        size: 5,
      });
      await bus.publish("FillReceived", {
        ...fillBase,
        fillId: "fill-2" as any,
        price: 0.5,
        size: 5,
      });

      // Counter should have decremented once (2 → 1), not twice (2 → 0)
      // So a new entry signal should still be rejected (1 in-flight remaining + the 1 just decremented = still at limit? No: 2 - 1 = 1, limit is 2, so it should pass)
      // Actually: started at 2, decremented once → 1. So next entry should be allowed.
      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });
      expect(approved).toHaveLength(1);

      // If it had double-decremented (2 → 0), we'd be at 0 in-flight.
      // Increment back to 2 to prove counter is at 1 not 0.
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      // Now at 2 in-flight — next entry should be rejected
      const rejected: any[] = [];
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });
      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry", signalId: "sig-check" as any }),
      });
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("family-in-flight-limit");

      await mod.stop();
    });

    it("does not apply in-flight limit to exit signals", async () => {
      await mod.start();

      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "repricing-exit", side: "sell" }),
      });

      expect(approved).toHaveLength(1);

      await mod.stop();
    });

    it("rejects a second probe-entry for the same token while a probe order is already in flight", async () => {
      await mod.start();

      const rejected: any[] = [];
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("probe-token-in-flight-limit");

      await mod.stop();
    });

    it("allows up to two same-token probe entries in flight for core families", async () => {
      rulesProvider = createMockRulesProvider(makeRuleBundle({}, { familyKey: "bitcoin-price" }));
      mod = createModule();
      await mod.start();

      const approved: any[] = [];
      const rejected: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(approved).toHaveLength(1);
      expect(rejected).toHaveLength(0);

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry", signalId: "sig-core-token-limit" as any }),
      });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("probe-token-in-flight-limit");

      await mod.stop();
    });

    it("uses configured throughput overrides instead of the family tier fallback", async () => {
      const bundle = makeRuleBundle({}, { familyKey: "custom-burst-family" });
      bundle.rules.throughput = {
        maxConcurrentOrdersPerFamily: 3,
        maxProbeInFlightPerToken: 3,
        maxEntrySignalsPerTickPerFamily: null,
      };
      rulesProvider = createMockRulesProvider(bundle);
      mod = createModule();
      await mod.start();

      const approved: any[] = [];
      const rejected: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(approved).toHaveLength(1);
      expect(rejected).toHaveLength(0);

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry", signalId: "sig-burst-limit" as any }),
      });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("family-in-flight-limit");

      await mod.stop();
    });

    it("allows a probe-entry on a different token while another probe is in flight for the family", async () => {
      await mod.start();

      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      await bus.publish("SignalProduced", {
        signal: makeSignal({
          tokenId: createTokenId("tok-no"),
          signalId: "sig-other-token",
          reason: "probe-entry",
        }),
      });

      expect(approved).toHaveLength(1);

      await mod.stop();
    });

    it("allows a new probe-entry on the same token after the prior probe order fully fills", async () => {
      await mod.start();

      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      const orderId = createOrderId("ord-probe");
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested(FAM_ID, "probe-entry"));
      (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue({
        orderId,
        familyId: FAM_ID,
        status: "filled",
        signalReason: "probe-entry",
      });

      await bus.publish("FillReceived", {
        fillId: createFillId("fill-probe"),
        orderId,
        clientOrderId: "plk_test" as ClientOrderId,
        tokenId: TOK_ID,
        side: "buy",
        price: 0.5,
        size: 10,
        sizeUsdc: 5,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        familyId: FAM_ID,
        signalReason: "probe-entry",
        timestamp: Date.now(),
      });

      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry", signalId: "sig-after-fill" }),
      });

      expect(approved).toHaveLength(1);

      await mod.stop();
    });

    it("rejects probe-entry when the token already has an open buy order", async () => {
      orderRepo = createMockOrderRepo();
      orderRepo.findByTokenId = vi.fn().mockReturnValue([
        {
          orderId: createOrderId("ord-open"),
          clientOrderId: "plk_open" as ClientOrderId,
          tokenId: TOK_ID,
          familyId: FAM_ID,
          side: "buy",
          orderType: "GTC",
          postOnly: true,
          price: 0.5,
          size: 10,
          sizeUsdc: 5,
          status: "open",
          exchangeOrderId: "ex-open" as any,
          signalId: null,
          signalReason: "probe-entry",
          botRunId: "run-1" as any,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies Order,
      ]);
      mod = createModule();
      await mod.start();

      const rejected: any[] = [];
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("probe token already has open buy order");

      await mod.stop();
    });
  });
});

// ─── Normalization tests ──────────────────────────────────────────────

import { normalizeReasonCode } from "../risk-event-codes.js";

describe("risk event code normalization for new rejection messages", () => {
  it("normalizes absolute cap rejection to derived_reduce_only", () => {
    const code = normalizeReasonCode(
      "entry blocked — family in derived reduce-only (tail cost 55.00 > cap 50)",
    );
    expect(code).toBe("derived_reduce_only");
  });

  it("normalizes ratio rejection to same derived_reduce_only code", () => {
    const code = normalizeReasonCode(
      "entry blocked — family in derived reduce-only (tail/pnl ratio 1.30 > 0.5, tail 13.00, realized 10.00)",
    );
    expect(code).toBe("derived_reduce_only");
  });
});
