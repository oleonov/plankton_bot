import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createFamilyId,
  createFillId,
  createOrderId,
  createPositionId,
  createLotId,
} from "@plankton/domain";
import type {
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyIdentity,
  FamilyEvidence,
  FamilyRules,
  FamilyState,
  FamilyStateRepository,
  PositionRepository,
  InventoryLotRepository,
  Position,
  InventoryLot,
  Signal,
  NormalizedMarket,
  TokenId,
  FamilyId,
  PositionId,
  Regime,
  ClientOrderId,
  CommandId,
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
    ...overrides,
  };
}

function makeRuleBundle(tailOverrides?: Record<string, unknown>): FamilyRuleBundle {
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
      slugPattern: "btc.*",
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
        weekendMode: "normal",
      },
    } as FamilyRules,
  };
}

function createMockRulesProvider(bundle: FamilyRuleBundle | null = makeRuleBundle()): FamilyRulesProvider {
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

function createMockPositionRepo(position?: Position | null): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(position ?? null),
    findByFamily: vi.fn().mockReturnValue(position ? [position] : []),
    findOpen: vi.fn().mockReturnValue(position ? [position] : []),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue(position ? [position] : []),
  };
}

function createMockLotRepo(): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    consumeFifo: vi.fn().mockReturnValue([]),
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
  let mod: RiskInventoryModule;

  function createModule() {
    return new RiskInventoryModule({
      bus,
      rulesProvider,
      familyStateRepo,
      positionRepo,
      inventoryLotRepo: lotRepo,
      log: silentLog,
      db: mockDb,
    });
  }

  beforeEach(() => {
    bus = new InProcessEventBus();
    rulesProvider = createMockRulesProvider();
    familyStateRepo = createMockFamilyStateRepo(makeFamilyState());
    positionRepo = createMockPositionRepo();
    lotRepo = createMockLotRepo();
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
    bus.subscribe("SignalApproved", async (p) => { approved.push(p); });

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
    bus.subscribe("SignalApproved", async (p) => { approved.push(p); });

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
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("not found");

    await mod.stop();
  });

  // ─── Signal rejection: quarantine ─────────────────────────────────

  it("rejects strategy signal for quarantined family", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ runtimeMode: "quarantine" }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("quarantine");

    await mod.stop();
  });

  it("allows operator signal for quarantined family", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ runtimeMode: "quarantine" }),
    );
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => { approved.push(p); });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "operator", side: "sell" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Signal rejection: reduce-only ────────────────────────────────

  it("rejects entry signal for reduce-only family", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ runtimeMode: "reduce-only" }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ side: "buy", reason: "probe-entry" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("reduce-only");

    await mod.stop();
  });

  it("allows exit signal for reduce-only family", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ runtimeMode: "reduce-only" }),
    );
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => { approved.push(p); });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ side: "sell", reason: "repricing-exit" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Signal rejection: probe-only blocks scale-in ─────────────────

  it("rejects scale-in signal for probe-only family", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ runtimeMode: "probe-only" }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "scale-in" }),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("probe-only");

    await mod.stop();
  });

  // ─── Signal rejection: exposure limits ────────────────────────────

  it("rejects entry when max open value exceeded", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ openValueUsdc: 98 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    // signal suggestedSizeUsdc=5, existing=98, total=103 > max=100
    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("open value");

    await mod.stop();
  });

  it("rejects entry for new market when max active markets exceeded", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ activeMarketCount: 5 }),
    );
    // No existing position for this token — it's a new market
    positionRepo = createMockPositionRepo(null);
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("active markets");

    await mod.stop();
  });

  it("allows scale-in to existing market even when max active markets reached", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ activeMarketCount: 5 }),
    );
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
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);
    mod = createModule();
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => { approved.push(p); });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ reason: "scale-in" }),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("rejects entry when max dust positions exceeded", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ openDustCount: 3 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("dust");

    await mod.stop();
  });

  it("rejects entry when tail quarantine threshold exceeded", async () => {
    familyStateRepo = createMockFamilyStateRepo(
      makeFamilyState({ currentTailCostUsdc: 48 }),
    );
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    // tail=48 + signal=5 = 53 > threshold=50
    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("tail cost");

    await mod.stop();
  });

  // ─── Fill handling: buy ───────────────────────────────────────────

  it("creates new position on buy fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => { posUpdates.push(p); });
    const expChanges: any[] = [];
    bus.subscribe("FamilyExposureChanged", async (p) => { expChanges.push(p); });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_abc" as ClientOrderId,
      tokenId: TOK_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      fee: 0,
      familyId: FAM_ID,
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
      fee: 0,
      familyId: FAM_ID,
      timestamp: Date.now(),
    });

    // Position updated with new avg price
    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Position;
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
    bus.subscribe("PositionUpdated", async (p) => { posUpdates.push(p); });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-sell"),
      orderId: createOrderId("ord-sell"),
      clientOrderId: "plk_sell" as ClientOrderId,
      tokenId: TOK_ID,
      side: "sell" as const,
      price: 0.6,
      size: 5,
      sizeUsdc: 3,
      fee: 0.01,
      familyId: FAM_ID,
      timestamp: Date.now(),
    });

    expect(lotRepo.consumeFifo).toHaveBeenCalledWith(
      createPositionId("pos-1"),
      5,
    );

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
    bus.subscribe("PositionUpdated", async (p) => { posUpdates.push(p); });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-sell-all"),
      orderId: createOrderId("ord-sell-all"),
      clientOrderId: "plk_sellall" as ClientOrderId,
      tokenId: TOK_ID,
      side: "sell" as const,
      price: 0.6,
      size: 10,
      sizeUsdc: 6,
      fee: 0,
      familyId: FAM_ID,
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
    bus.subscribe("FamilyExposureChanged", async (p) => { changes.push(p); });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_abc" as ClientOrderId,
      tokenId: TOK_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      fee: 0,
      familyId: FAM_ID,
      timestamp: Date.now(),
    });

    expect(changes).toHaveLength(1);
    expect(changes[0].familyId).toBe(FAM_ID);
    expect(changes[0].familyState).toBeDefined();

    await mod.stop();
  });

  // ─── Unsubscribe on stop ──────────────────────────────────────────

  it("does not process events after stop", async () => {
    await mod.start();
    await mod.stop();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => { approved.push(p); });

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
    bus.subscribe("SignalRejected", async (p) => { rejected.push(p); });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("internal error");

    await mod.stop();
  });

  it("logs error on orphan sell fill without fabricating PnL", async () => {
    // No existing position for the token
    positionRepo = createMockPositionRepo(null);
    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => { posUpdates.push(p); });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-orphan"),
      orderId: createOrderId("ord-orphan"),
      clientOrderId: "plk_orphan" as ClientOrderId,
      tokenId: TOK_ID,
      side: "sell" as const,
      price: 0.6,
      size: 5,
      sizeUsdc: 3,
      fee: 0,
      familyId: FAM_ID,
      timestamp: Date.now(),
    });

    // No position should be created — the error is caught by the module
    expect(posUpdates).toHaveLength(0);
    // No synthetic position saved
    expect(positionRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });
});
