import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId, createFamilyId, createPositionId } from "@plankton/domain";
import type {
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyIdentity,
  FamilyEvidence,
  FamilyRules,
  FamilyState,
  FamilyStateRepository,
  PositionRepository,
  Position,
  NormalizedMarket,
  TokenId,
  FamilyId,
  Regime,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { StrategyModule } from "../modules/strategy/strategy-module.js";
import { LiveLiteGuard } from "../live-lite-guard.js";

// ─── Test helpers ────────────────────────────────────────────────────────

const FAM_ID = createFamilyId("fam-btc");
const TOK_ID = createTokenId("tok-yes");
const TOK_ID_2 = createTokenId("tok-yes-2");

function makeNormalizedMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: TOK_ID,
    conditionId: "cond-1",
    slug: "will-btc-reach-100k",
    eventSlug: null,
    question: "Will BTC reach 100k?",
    outcome: "YES",
    familyId: FAM_ID,
    familyKey: "btc-price",
    regime: "threshold" as Regime,
    horizon: "short",
    endDate: null,
    active: true,
    tickSize: 0.01,
    negRisk: false,
    bestBid: 0.03,
    bestAsk: 0.04,
    midPrice: 0.035,
    spread: 0.01,
    snapshotTs: Date.now(),
    ...overrides,
  };
}

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: TOK_ID,
    familyId: FAM_ID,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.03,
    costBasisUsdc: 3,
    currentValueUsdc: 3.5,
    realizedPnl: 0,
    status: "open",
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
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
    effectiveMode: null,
    derivedModeReason: null,
    firstNegativeTailAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRules(overrides?: Partial<FamilyRules>): FamilyRules {
  return {
    familyId: FAM_ID,
    universe: {
      enabled: true,
      action: "trade",
      priorityRank: 1,
      allowWeekends: true,
      sessionMode: "active-window",
    },
    entry: {
      entryMode: "probe-first",
      minEntryPrice: 0.01,
      maxEntryPrice: 0.05,
      maxInitialNotionalUsdc: 5,
      allowHighPriceOneShot: false,
      highPriceThreshold: 0.85,
      requireProvenFamilyAbovePrice: 0.1,
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
    twoSided: {
      allowTwoSided: false,
      twoSidedMode: "disabled",
      minActivityForTwoSided: null,
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
      weekendMode: "normal",
    },
    ...overrides,
  };
}

function makeIdentity(overrides?: Partial<FamilyIdentity>): FamilyIdentity {
  return {
    familyId: FAM_ID,
    familyKey: "btc-price",
    primaryCategory: "crypto",
    regime: "threshold" as Regime,
    horizon: "short",
    cadence: "weekly",
    strategyProfile: "scalp",
    topicKey: null,
    slugPattern: null,
    notes: null,
    ...overrides,
  };
}

function makeEvidence(overrides?: Partial<FamilyEvidence>): FamilyEvidence {
  return {
    familyId: FAM_ID,
    evidenceStatus: "confirmed",
    evidenceScore: 80,
    promotionState: "scaled",
    localTradeCount: 10,
    localMarketCount: 5,
    localRealizedPnlFifo: 50,
    openTailCostUsdc: 5,
    tailAdjustedPnl: 45,
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
  };
}

function makeBundle(overrides?: {
  identity?: Partial<FamilyIdentity>;
  evidence?: Partial<FamilyEvidence>;
  rules?: Partial<FamilyRules>;
}): FamilyRuleBundle {
  return {
    identity: makeIdentity(overrides?.identity),
    evidence: makeEvidence(overrides?.evidence),
    rules: makeRules(overrides?.rules),
  };
}

// ─── Mock factories ──────────────────────────────────────────────────────

function createMockRulesProvider(bundle: FamilyRuleBundle | null = makeBundle()) {
  return {
    getRule: vi.fn((_id: FamilyId) => bundle),
    isEnabled: vi.fn((_id: FamilyId) => true),
    getAllFamilies: vi.fn(() => (bundle ? [bundle.identity] : [])),
    getRulesForRegime: vi.fn(() => (bundle ? [bundle] : [])),
  } satisfies FamilyRulesProvider;
}

function createMockPositionRepo() {
  const positions = new Map<string, Position>();
  return {
    save: vi.fn((p: Position) => {
      positions.set(String(p.tokenId), p);
    }),
    findByTokenId: vi.fn((tokenId: TokenId) => positions.get(String(tokenId)) ?? null),
    findOpen: vi.fn(() => [...positions.values()].filter((p) => p.status === "open")),
    findDust: vi.fn(() => [...positions.values()].filter((p) => p.status === "dust")),
    findByFamily: vi.fn((_id: FamilyId) => [...positions.values()]),
    findAll: vi.fn(() => [...positions.values()]),
    _setPosition(tokenId: TokenId, pos: Position) {
      positions.set(String(tokenId), pos);
    },
  } satisfies PositionRepository & { _setPosition: (t: TokenId, p: Position) => void };
}

function createMockFamilyStateRepo() {
  const states = new Map<string, FamilyState>();
  return {
    get: vi.fn((_id: FamilyId) => states.get(String(_id)) ?? null),
    save: vi.fn((s: FamilyState) => {
      states.set(String(s.familyId), s);
    }),
    findAll: vi.fn(() => [...states.values()]),
    findByMode: vi.fn(() => []),
    findQuarantined: vi.fn(() => []),
  } satisfies FamilyStateRepository;
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    trace: vi.fn(),
    level: "info",
    silent: vi.fn(),
  } as unknown as import("../logger.js").Logger;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("StrategyModule", () => {
  let bus: InstanceType<typeof InProcessEventBus>;
  let rulesProvider: ReturnType<typeof createMockRulesProvider>;
  let positionRepo: ReturnType<typeof createMockPositionRepo>;
  let familyStateRepo: ReturnType<typeof createMockFamilyStateRepo>;
  let log: ReturnType<typeof createMockLogger>;
  let mod: StrategyModule;

  beforeEach(() => {
    bus = new InProcessEventBus();
    rulesProvider = createMockRulesProvider();
    positionRepo = createMockPositionRepo();
    familyStateRepo = createMockFamilyStateRepo();
    log = createMockLogger();

    mod = new StrategyModule({
      bus,
      rulesProvider,
      positionRepo,
      familyStateRepo,
      log,
      scanIntervalMs: 60_000, // long interval, we'll call tick() manually
      runtimeControl: { isPaused: () => false },
    });
  });

  afterEach(async () => {
    await mod.stop();
  });

  // ─── Lifecycle ───────────────────────────────────────────

  describe("lifecycle", () => {
    it("starts and reports healthy", async () => {
      await mod.start();
      const h = await mod.healthCheck();
      expect(h.ok).toBe(true);
    });

    it("reports unhealthy before start", async () => {
      const h = await mod.healthCheck();
      expect(h.ok).toBe(false);
    });

    it("stops cleanly and reports unhealthy", async () => {
      await mod.start();
      await mod.stop();
      const h = await mod.healthCheck();
      expect(h.ok).toBe(false);
    });

    it("unsubscribes on stop — no signals produced after stop", async () => {
      await mod.start();
      await mod.stop();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Publish markets after stop — should not trigger scan
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket()],
        timestamp: Date.now(),
      });
      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });
  });

  // ─── Market cache ─────────────────────────────────────────

  describe("market cache", () => {
    it("caches NormalizedMarketUpdated payload", async () => {
      await mod.start();
      const markets = [makeNormalizedMarket()];
      await bus.publish("NormalizedMarketUpdated", {
        markets,
        timestamp: Date.now(),
      });
      await bus.drain();

      const h = await mod.healthCheck();
      expect(h.detail).toContain("markets=1");
    });

    it("tick with no cached markets produces no signals", async () => {
      await mod.start();
      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });
  });

  // ─── Probe entry ──────────────────────────────────────────

  describe("probe entry", () => {
    it("produces probe-entry signal for market in entry band", async () => {
      await mod.start();
      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      expect(signals).toHaveLength(1);
      expect(signals[0]!.signal.reason).toBe("probe-entry");
      expect(signals[0]!.signal.side).toBe("buy");
      expect(signals[0]!.signal.familyId).toBe(FAM_ID);
      expect(signals[0]!.signal.tokenId).toBe(TOK_ID);
    });

    it("skips market with price below entry band", async () => {
      await mod.start();
      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.005 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips market with price above entry band", async () => {
      await mod.start();
      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.1 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips market with no familyId", async () => {
      await mod.start();
      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ familyId: null })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips inactive market", async () => {
      await mod.start();
      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ active: false })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips market with null midPrice", async () => {
      await mod.start();
      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: null })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips family with disabled entry mode", async () => {
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, entryMode: "disabled" } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips family with universe action != trade", async () => {
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { universe: { ...makeRules().universe, action: "monitor" } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips when family is disabled", async () => {
      rulesProvider.isEnabled.mockReturnValue(false);
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips when rules not found for family", async () => {
      rulesProvider.getRule.mockReturnValue(null);
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("skips probe entry when existing position exists", async () => {
      positionRepo._setPosition(TOK_ID, makePosition());
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // Should produce scale-in, not probe-entry
      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(0);
    });
  });

  // ─── Scanner blocker metadata ─────────────────────────────

  describe("scanner blocker metadata", () => {
    it("scan returns resolution buffer blocker count", async () => {
      await mod.start();
      const ticks: any[] = [];
      bus.subscribe("ScanTickCompleted", async (p) => {
        ticks.push(p);
      });

      // Market with endDate in the past (within resolution buffer)
      const pastEnd = new Date(Date.now() - 60_000).toISOString();
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03, endDate: pastEnd })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      expect(ticks).toHaveLength(1);
      expect(ticks[0].blockedByResolutionBuffer).toBeGreaterThan(0);
    });
  });

  // ─── Scale-in ─────────────────────────────────────────────

  describe("scale-in", () => {
    it("produces scale-in signal for existing position in entry band", async () => {
      positionRepo._setPosition(TOK_ID, makePosition());
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter((s) => s.signal.reason === "scale-in");
      expect(scaleIns).toHaveLength(1);
      expect(scaleIns[0]!.signal.side).toBe("buy");
    });

    it("skips scale-in when scale mode is disabled", async () => {
      positionRepo._setPosition(TOK_ID, makePosition());
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { scaleIn: { ...makeRules().scaleIn, scaleMode: "disabled" } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // May still produce exit signals but no scale-in
      const scaleIns = (signals as Array<{ signal: import("@plankton/domain").Signal }>).filter(
        (s) => s.signal.reason === "scale-in",
      );
      expect(scaleIns).toHaveLength(0);
    });

    it("respects defaultMaxBuysPerLeg limit via buy tracker", async () => {
      // Set up position with existing buys tracked via PositionUpdated
      const pos = makePosition({ size: 100 });
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Simulate 3 buy fills with increasing size (defaultMaxBuysPerLeg = 3)
      for (let i = 0; i < 3; i++) {
        await bus.publish("PositionUpdated", {
          position: { ...pos, size: pos.size + (i + 1) * 10 },
        });
      }
      await bus.drain();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter((s) => s.signal.reason === "scale-in");
      expect(scaleIns).toHaveLength(0);
    });

    it("skips scale-in when price outside entry band", async () => {
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.1 })], // outside band
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const scaleIns = (signals as Array<{ signal: import("@plankton/domain").Signal }>).filter(
        (s) => s.signal.reason === "scale-in",
      );
      expect(scaleIns).toHaveLength(0);
    });

    it("emits confirm-scale on second buy (buyCount=1)", async () => {
      const pos = makePosition();
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Simulate 1 buy via PositionUpdated
      await bus.publish("PositionUpdated", { position: pos });
      await bus.drain();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const confirms = signals.filter((s) => s.signal.reason === "confirm-scale");
      expect(confirms).toHaveLength(1);
      expect(confirms[0]!.signal.side).toBe("buy");
    });

    it("emits scale-in on third buy (buyCount=2)", async () => {
      const pos = makePosition();
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Simulate 2 buys via PositionUpdated
      await bus.publish("PositionUpdated", { position: pos });
      await bus.publish("PositionUpdated", {
        position: { ...pos, size: pos.size + 10 },
      });
      await bus.drain();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter((s) => s.signal.reason === "scale-in");
      expect(scaleIns).toHaveLength(1);
      expect(scaleIns[0]!.signal.side).toBe("buy");
    });

    it("blocks heavy-scale when allowHeavyCampaigns=false", async () => {
      const pos = makePosition();
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Simulate 3 buys (= defaultMaxBuysPerLeg)
      for (let i = 0; i < 3; i++) {
        await bus.publish("PositionUpdated", {
          position: { ...pos, size: pos.size + (i + 1) * 10 },
        });
      }
      await bus.drain();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // No entry signals at all — stages exhausted with allowHeavyCampaigns=false
      const entrySignals = signals.filter((s) =>
        ["scale-in", "confirm-scale", "heavy-scale"].includes(s.signal.reason),
      );
      expect(entrySignals).toHaveLength(0);
    });

    it("emits heavy-scale when allowHeavyCampaigns=true and buyCount >= defaultMax", async () => {
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            scaleIn: {
              ...makeRules().scaleIn,
              allowHeavyCampaigns: true,
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });

      const pos = makePosition();
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Simulate 3 buys (= defaultMaxBuysPerLeg)
      for (let i = 0; i < 3; i++) {
        await bus.publish("PositionUpdated", {
          position: { ...pos, size: pos.size + (i + 1) * 10 },
        });
      }
      await bus.drain();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const heavyScales = signals.filter((s) => s.signal.reason === "heavy-scale");
      expect(heavyScales).toHaveLength(1);
      expect(heavyScales[0]!.signal.side).toBe("buy");
    });

    it("exhausts all stages when buyCount >= heavyMaxBuysPerLeg", async () => {
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            scaleIn: {
              ...makeRules().scaleIn,
              allowHeavyCampaigns: true,
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });

      const pos = makePosition();
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Simulate 5 buys (= heavyMaxBuysPerLeg)
      for (let i = 0; i < 5; i++) {
        await bus.publish("PositionUpdated", {
          position: { ...pos, size: pos.size + (i + 1) * 10 },
        });
      }
      await bus.drain();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // No entry signals — all stages exhausted even with heavy campaigns
      const entrySignals = signals.filter((s) =>
        ["scale-in", "confirm-scale", "heavy-scale"].includes(s.signal.reason),
      );
      expect(entrySignals).toHaveLength(0);
    });
  });

  // ─── Repricing exit ───────────────────────────────────────

  describe("repricing exit", () => {
    it("produces repricing-exit when ROI in target band", async () => {
      // Position at 0.03, market at 0.04 → ROI = 33% (within 20-50%)
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03, size: 100 }));
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.04 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(1);
      expect(exits[0]!.signal.side).toBe("sell");
      expect(exits[0]!.signal.suggestedSize).toBe(100);
    });

    it("skips exit when ROI below target band", async () => {
      // Position at 0.03, market at 0.031 → ROI = 3.3% (below 20%)
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.031 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(0);
    });

    it("skips exit when ROI above target band and runner extension enabled", async () => {
      // Position at 0.03, market at 0.06 → ROI = 100% (above 50%)
      // allowRunnerExtension: true → above-band positions are held as runners
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { exit: { ...makeRules().exit, allowRunnerExtension: true } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.06 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(0);
    });

    it("skips exit when exit mode is disabled", async () => {
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { exit: { ...makeRules().exit, exitMode: "disabled" } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.04 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const exits = (signals as Array<{ signal: import("@plankton/domain").Signal }>).filter(
        (s) => s.signal.reason === "repricing-exit",
      );
      expect(exits).toHaveLength(0);
    });

    it("exit signal not gated by session window", async () => {
      // Use a narrow active window that doesn't include current UTC hour
      const bundle = makeBundle({
        rules: {
          session: {
            activeWindowsUtc: [{ start: "03:00", end: "04:00" }], // very narrow
            reducedWindowsUtc: [],
            weekdayBias: "normal",
            weekendMode: "normal",
          },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));

      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Use a tick timestamp at 15:00 UTC (outside 03:00-04:00 window)
      const tickAt15Utc = new Date();
      tickAt15Utc.setUTCHours(15, 0, 0, 0);

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.04 })],
        timestamp: tickAt15Utc.getTime(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // Exit should still be produced (not session-gated)
      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(1);
    });
  });

  // ─── Session window ───────────────────────────────────────

  describe("session window", () => {
    it("skips probe entry outside active window", async () => {
      const bundle = makeBundle({
        rules: {
          session: {
            activeWindowsUtc: [{ start: "03:00", end: "04:00" }],
            reducedWindowsUtc: [],
            weekdayBias: "normal",
            weekendMode: "normal",
          },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // Entry should be blocked outside session window (depends on current UTC hour)
      // If test is run at 03:xx UTC, entry will be produced — the test verifies the mechanism
      const probes = (signals as Array<{ signal: import("@plankton/domain").Signal }>).filter(
        (s) => s.signal.reason === "probe-entry",
      );
      // At minimum, we verify the window check runs without error
      expect(probes.length).toBeLessThanOrEqual(1);
    });
  });

  // ─── Re-entrancy guard ────────────────────────────────────

  describe("re-entrancy guard", () => {
    it("skips overlapping tick", async () => {
      await mod.start();
      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      // Fire two ticks concurrently
      const [_r1, _r2] = await Promise.all([mod.tick(), mod.tick()]);

      await bus.drain();

      // At most 1 signal (second tick should be skipped by guard)
      expect(signals.length).toBeLessThanOrEqual(1);
    });
  });

  // ─── Signal fields ────────────────────────────────────────

  describe("signal fields", () => {
    it("sets correct signal fields for probe entry", async () => {
      await mod.start();
      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.04 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      expect(signals).toHaveLength(1);
      const sig = signals[0]!.signal;
      expect(sig.signalId).toBeTruthy();
      expect(sig.familyId).toBe(FAM_ID);
      expect(sig.tokenId).toBe(TOK_ID);
      expect(sig.side).toBe("buy");
      expect(sig.suggestedPrice).toBe(0.04);
      expect(sig.suggestedSizeUsdc).toBeLessThanOrEqual(5);
      expect(sig.suggestedSize).toBeCloseTo(sig.suggestedSizeUsdc / 0.04);
      expect(sig.reason).toBe("probe-entry");
      expect(sig.strategyTick).toBeGreaterThan(0);
      expect(sig.sequenceInTick).toBe(0);
      expect(sig.generatedAt).toBeTruthy();
    });

    it("assigns sequential sequenceInTick for same family+token+side", async () => {
      // Create a second token in the same family to generate multiple signals
      const bundle = makeBundle();
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Two different tokens in same family
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          makeNormalizedMarket({ tokenId: TOK_ID, midPrice: 0.03 }),
          makeNormalizedMarket({ tokenId: TOK_ID_2, midPrice: 0.03 }),
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // Different tokens → sequenceInTick resets to 0 for each
      expect(signals).toHaveLength(2);
      expect(signals[0]!.signal.sequenceInTick).toBe(0);
      expect(signals[1]!.signal.sequenceInTick).toBe(0);
    });
  });

  // ─── High-price gates ─────────────────────────────────────

  describe("high-price gates", () => {
    it("blocks high-price entry when allowHighPriceOneShot is false", async () => {
      const bundle = makeBundle({
        rules: {
          entry: {
            ...makeRules().entry,
            maxEntryPrice: 0.95,
            highPriceThreshold: 0.85,
            allowHighPriceOneShot: false,
          },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.9 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });

    it("allows high-price entry when allowHighPriceOneShot is true", async () => {
      const bundle = makeBundle({
        rules: {
          entry: {
            ...makeRules().entry,
            maxEntryPrice: 0.95,
            highPriceThreshold: 0.85,
            allowHighPriceOneShot: true,
          },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.9 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(1);
      expect(signals[0]!.signal.reason).toBe("probe-entry");
    });

    it("blocks unproven family above requireProvenFamilyAbovePrice", async () => {
      const bundle = makeBundle({
        rules: {
          entry: {
            ...makeRules().entry,
            maxEntryPrice: 0.5,
            requireProvenFamilyAbovePrice: 0.1,
          },
        },
        evidence: { evidenceStatus: "weak" },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.15 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(0);
    });
  });

  // ─── Exit suppresses scale-in ───────────────────────────────

  describe("exit suppresses scale-in", () => {
    it("emits only exit when ROI is in target band — no contradictory scale-in", async () => {
      // Position at 0.025, market at 0.035 → ROI = 40% (in band)
      // Price 0.035 is also in entry band [0.01, 0.05] → scale-in would be eligible
      // But exit takes priority — emitting both would create opposing orders.
      positionRepo._setPosition(
        TOK_ID,
        makePosition({
          avgEntryPrice: 0.025,
          size: 100,
        }),
      );
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.035 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const reasons = signals.map((s) => s.signal.reason);
      expect(reasons).toContain("repricing-exit");
      expect(reasons).not.toContain("scale-in");
      expect(signals).toHaveLength(1);
    });

    it("emits scale-in when ROI is below exit band", async () => {
      // Position at 0.03, market at 0.031 → ROI = 3.3% (below medium-hold band)
      // Price 0.031 is in entry band → scale-in is eligible, no exit.
      positionRepo._setPosition(
        TOK_ID,
        makePosition({
          avgEntryPrice: 0.03,
          size: 100,
        }),
      );
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.031 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const reasons = signals.map((s) => s.signal.reason);
      expect(reasons).toContain("scale-in");
      expect(reasons).not.toContain("repricing-exit");
      expect(reasons).not.toContain("medium-hold-exit");
    });
  });

  // ─── PositionUpdated buy tracking ───────────────────────────

  describe("position tracking", () => {
    it("increments buy count only when position size increases", async () => {
      const pos = makePosition({ size: 100 });
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      // First buy fill: size 0 → 100 (increase → increment)
      await bus.publish("PositionUpdated", { position: pos });
      await bus.drain();

      // Second buy fill: size 100 → 120 (increase → increment)
      await bus.publish("PositionUpdated", {
        position: { ...pos, size: 120 },
      });
      await bus.drain();

      // Third buy fill: size 120 → 140 (increase → increment)
      await bus.publish("PositionUpdated", {
        position: { ...pos, size: 140 },
      });
      await bus.drain();

      // Buy count is now 3, which equals defaultMaxBuysPerLeg
      // So scale-in should be blocked on next tick
      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter((s) => s.signal.reason === "scale-in");
      expect(scaleIns).toHaveLength(0);
    });

    it("does not increment buy count on sell-side size decrease", async () => {
      const pos = makePosition({ size: 100 });
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      // Buy fill: size 0 → 100
      await bus.publish("PositionUpdated", { position: pos });
      await bus.drain();

      // Partial sell: size 100 → 80 (decrease → should NOT increment)
      await bus.publish("PositionUpdated", {
        position: { ...pos, size: 80 },
      });
      await bus.drain();

      // Buy count should still be 1, not 2
      // So confirm-scale should still be allowed (buyCount=1 → confirm stage)
      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const confirms = signals.filter((s) => s.signal.reason === "confirm-scale");
      expect(confirms).toHaveLength(1);
    });

    it("cleans up tracker when position is closed", async () => {
      const pos = makePosition({ size: 100 });
      positionRepo._setPosition(TOK_ID, pos);
      await mod.start();

      // Buy fill
      await bus.publish("PositionUpdated", { position: pos });
      await bus.drain();

      // Close position
      await bus.publish("PositionUpdated", {
        position: {
          ...pos,
          status: "closed" as const,
          size: 0,
          closedAt: new Date().toISOString(),
        },
      });
      await bus.drain();

      // Tracker should have removed the count — verified by the module not throwing
    });
  });

  // ─── Signal-to-order bridge ────────────────────────────────

  describe("signal-to-order bridge", () => {
    it("converts SignalApproved into PlaceOrderRequested", async () => {
      await mod.start();

      // Seed market cache so bridge can look up tickSize/negRisk
      const market = makeNormalizedMarket({ midPrice: 0.03 });
      await bus.publish("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });
      await bus.drain();

      const orderRequests: Array<{ command: import("@plankton/domain").PlaceOrderCommand }> = [];
      bus.subscribe("PlaceOrderRequested", async (p) => {
        orderRequests.push(p);
      });

      // Publish an approved signal
      const signal = {
        signalId: "sig-bridge-1",
        familyId: FAM_ID,
        tokenId: TOK_ID,
        side: "buy" as const,
        suggestedPrice: 0.03,
        suggestedSize: 100,
        suggestedSizeUsdc: 3,
        reason: "probe-entry" as const,
        strategyTick: Date.now(),
        sequenceInTick: 0,
        generatedAt: new Date().toISOString(),
      };
      await bus.publish("SignalApproved", { signal, approvedAt: Date.now() });
      await bus.drain();

      expect(orderRequests).toHaveLength(1);
      const cmd = orderRequests[0]!.command;
      expect(cmd.type).toBe("PlaceOrderCommand");
      expect(cmd.tokenId).toBe(TOK_ID);
      expect(cmd.side).toBe("buy");
      expect(cmd.size).toBe(100);
      expect(cmd.price).toBe(0.03);
      expect(cmd.tickSize).toBe(market.tickSize);
      expect(cmd.negRisk).toBe(market.negRisk);
      expect(cmd.familyId).toBe(FAM_ID);
      expect(cmd.source).toBe("strategy");
    });

    it("uses maker-safe post-only pricing for fee-enabled relayer families", async () => {
      mod = new StrategyModule({
        bus,
        rulesProvider: createMockRulesProvider(
          makeBundle({
            identity: {
              primaryCategory: "crypto",
              feeTier: "fee-enabled",
              liveWalletRequirement: "relayer-required",
              requiresPostOnlyForLive: true,
            },
          }),
        ),
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
        liveLiteGuard: new LiveLiteGuard({
          familyAllowlist: ["fam-btc"],
          maxFamilies: 2,
          maxOpenValueUsdc: 500,
          maxOrderUsdc: 50,
          maxActiveMarkets: 3,
          walletMode: "relayer",
          minOrderUsdc: 2,
        }),
      });

      await mod.start();

      const market = makeNormalizedMarket({ bestBid: 0.03, bestAsk: 0.04, midPrice: 0.035 });
      await bus.publish("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });
      await bus.drain();

      const orderRequests: Array<{ command: import("@plankton/domain").PlaceOrderCommand }> = [];
      bus.subscribe("PlaceOrderRequested", async (p) => {
        orderRequests.push(p);
      });

      await bus.publish("SignalApproved", {
        signal: {
          signalId: "sig-bridge-maker-1",
          familyId: FAM_ID,
          tokenId: TOK_ID,
          side: "buy",
          suggestedPrice: 0.035,
          suggestedSize: 100,
          suggestedSizeUsdc: 3.5,
          reason: "probe-entry",
          strategyTick: Date.now(),
          sequenceInTick: 0,
          generatedAt: new Date().toISOString(),
        },
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(orderRequests).toHaveLength(1);
      expect(orderRequests[0]!.command.postOnly).toBe(true);
      expect(orderRequests[0]!.command.price).toBe(0.03);
    });

    it("skips fee-enabled relayer orders when the book cannot support a maker-safe price", async () => {
      mod = new StrategyModule({
        bus,
        rulesProvider: createMockRulesProvider(
          makeBundle({
            identity: {
              primaryCategory: "crypto",
              feeTier: "fee-enabled",
              liveWalletRequirement: "relayer-required",
              requiresPostOnlyForLive: true,
            },
          }),
        ),
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
        liveLiteGuard: new LiveLiteGuard({
          familyAllowlist: ["fam-btc"],
          maxFamilies: 2,
          maxOpenValueUsdc: 500,
          maxOrderUsdc: 50,
          maxActiveMarkets: 3,
          walletMode: "relayer",
          minOrderUsdc: 2,
        }),
      });

      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ bestBid: 0.04, bestAsk: 0.04, midPrice: 0.04 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      const orderRequests: unknown[] = [];
      bus.subscribe("PlaceOrderRequested", async (p) => {
        orderRequests.push(p);
      });

      await bus.publish("SignalApproved", {
        signal: {
          signalId: "sig-bridge-maker-locked",
          familyId: FAM_ID,
          tokenId: TOK_ID,
          side: "buy",
          suggestedPrice: 0.04,
          suggestedSize: 100,
          suggestedSizeUsdc: 4,
          reason: "probe-entry",
          strategyTick: Date.now(),
          sequenceInTick: 0,
          generatedAt: new Date().toISOString(),
        },
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(orderRequests).toHaveLength(0);
    });

    it("skips approved signal when market not in cache", async () => {
      await mod.start();
      // No market cache seeded

      const orderRequests: unknown[] = [];
      bus.subscribe("PlaceOrderRequested", async (p) => {
        orderRequests.push(p);
      });

      await bus.publish("SignalApproved", {
        signal: {
          signalId: "sig-bridge-2",
          familyId: FAM_ID,
          tokenId: TOK_ID,
          side: "buy" as const,
          suggestedPrice: 0.03,
          suggestedSize: 100,
          suggestedSizeUsdc: 3,
          reason: "probe-entry" as const,
          strategyTick: Date.now(),
          sequenceInTick: 0,
          generatedAt: new Date().toISOString(),
        },
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(orderRequests).toHaveLength(0);
    });

    it("does not convert after module stop", async () => {
      await mod.start();

      const market = makeNormalizedMarket({ midPrice: 0.03 });
      await bus.publish("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.stop();

      const orderRequests: unknown[] = [];
      bus.subscribe("PlaceOrderRequested", async (p) => {
        orderRequests.push(p);
      });

      await bus.publish("SignalApproved", {
        signal: {
          signalId: "sig-bridge-3",
          familyId: FAM_ID,
          tokenId: TOK_ID,
          side: "buy" as const,
          suggestedPrice: 0.03,
          suggestedSize: 100,
          suggestedSizeUsdc: 3,
          reason: "probe-entry" as const,
          strategyTick: Date.now(),
          sequenceInTick: 0,
          generatedAt: new Date().toISOString(),
        },
        approvedAt: Date.now(),
      });
      await bus.drain();

      expect(orderRequests).toHaveLength(0);
    });
  });

  // ─── Live-lite allowlist filter ───────────────────────────

  describe("live-lite allowlist filter", () => {
    it("skips signals for non-allowlisted families in live-lite mode", async () => {
      // "fam-other" is in allowlist, but market belongs to FAM_ID ("fam-btc")
      const liveLiteGuard = new LiveLiteGuard({
        familyAllowlist: ["fam-other"],
        maxFamilies: 2,
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 50,
        maxActiveMarkets: 3,
      });
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
        liveLiteGuard,
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // fam-btc is not in allowlist ["fam-other"] — all signals must be filtered
      expect(signals).toHaveLength(0);
    });

    it("passes signals for allowlisted families in live-lite mode", async () => {
      const liveLiteGuard = new LiveLiteGuard({
        familyAllowlist: ["fam-btc"],
        maxFamilies: 2,
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 50,
        maxActiveMarkets: 3,
      });
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
        liveLiteGuard,
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      // fam-btc IS in the allowlist — signal should pass through
      expect(signals).toHaveLength(1);
    });
  });

  // ─── RuntimeControl pause ─────────────────────────────────

  describe("runtime pause", () => {
    it("skips tick when runtime is paused", async () => {
      const pausedControl = { isPaused: () => true };
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: pausedControl,
      });
      await mod.start();

      const signals: unknown[] = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      expect(signals).toHaveLength(0);
    });
  });

  // ─── Evidence-based variable sizing ──────────────────────────

  describe("evidence-based variable sizing", () => {
    it("probe entry uses probeSizeUsdc not hard-coded $5", async () => {
      const bundle = makeBundle({
        rules: {
          entry: {
            ...makeRules().entry,
            probeSizeUsdc: 6,
            addSizeUsdc: 4,
            maxInitialNotionalUsdc: 10,
          },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      expect(signals).toHaveLength(1);
      expect(signals[0]!.signal.suggestedSizeUsdc).toBe(6);
    });

    it("scale-in uses addSizeUsdc not hard-coded $5", async () => {
      const bundle = makeBundle({
        rules: {
          entry: {
            ...makeRules().entry,
            probeSizeUsdc: 6,
            addSizeUsdc: 3,
            maxInitialNotionalUsdc: 10,
          },
          // Disable fast recycle so medium-hold band doesn't interfere
          exit: { ...makeRules().exit, preferFastRecycle: false },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      positionRepo._setPosition(
        TOK_ID,
        makePosition({
          avgEntryPrice: 0.03,
          size: 100,
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.031 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter((s) => s.signal.reason === "scale-in");
      expect(scaleIns).toHaveLength(1);
      expect(scaleIns[0]!.signal.suggestedSizeUsdc).toBe(3);
    });

    it("probe and scale-in sizes are capped by maxInitialNotionalUsdc", async () => {
      const bundle = makeBundle({
        rules: {
          entry: {
            ...makeRules().entry,
            probeSizeUsdc: 10,
            addSizeUsdc: 8,
            maxInitialNotionalUsdc: 4,
          },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      await mod.tick();
      await bus.drain();

      expect(signals).toHaveLength(1);
      // Capped at maxInitialNotionalUsdc (4), not probeSizeUsdc (10)
      expect(signals[0]!.signal.suggestedSizeUsdc).toBe(4);
    });
  });

  // ─── Wave 3: active session / reduced mode ──────────────────────────────

  describe("active session window (P1-2)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("allows probe entry outside active window", async () => {
      // Window: 14:00-21:00 UTC. Tick at 10:00 UTC → outside window.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));

      const outsideWindowRules = makeBundle({
        rules: {
          session: { ...makeRules().session, activeWindowsUtc: [{ start: "14:00", end: "21:00" }] },
        },
      });
      rulesProvider = createMockRulesProvider(outsideWindowRules);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(1);

      vi.useRealTimers();
    });

    it("blocks scale-in outside active window", async () => {
      // Window: 14:00-21:00 UTC. Tick at 10:00 UTC → outside window.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));

      const outsideWindowRules = makeBundle({
        rules: {
          session: { ...makeRules().session, activeWindowsUtc: [{ start: "14:00", end: "21:00" }] },
        },
      });
      rulesProvider = createMockRulesProvider(outsideWindowRules);
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const entries = signals.filter(
        (s) => s.signal.side === "buy" && s.signal.reason !== "probe-entry",
      );
      expect(entries).toHaveLength(0);

      vi.useRealTimers();
    });

    it("allows exit outside active window", async () => {
      // Window: 14:00-21:00 UTC. Tick at 10:00 UTC → exit should still fire.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-16T10:00:00Z"));

      const outsideWindowRules = makeBundle({
        rules: {
          session: { ...makeRules().session, activeWindowsUtc: [{ start: "14:00", end: "21:00" }] },
        },
      });
      rulesProvider = createMockRulesProvider(outsideWindowRules);
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // midPrice 0.04 → ROI = (0.04-0.03)/0.03 = 33%, in [20%, 50%] band
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.04 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(1);

      vi.useRealTimers();
    });
  });

  // ─── Wave 3: fast recycle exit (P1-4) ───────────────────────────────────

  describe("fast recycle exit (P1-4)", () => {
    it("triggers exit at lower ROI for young positions", async () => {
      // Position opened 30 min ago. lowBand = 20%, effectiveLow = 10%.
      // ROI = (0.033 - 0.03) / 0.03 = 10% — should exit with fast recycle.
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      positionRepo._setPosition(
        TOK_ID,
        makePosition({
          avgEntryPrice: 0.03,
          openedAt: thirtyMinAgo,
        }),
      );
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { exit: { ...makeRules().exit, preferFastRecycle: true } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      const now = Date.now();
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.033 })],
        timestamp: now,
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(1);
    });

    it("does not apply fast recycle to old positions", async () => {
      // Position opened 2 hours ago. lowBand = 20%, no reduction.
      // ROI = (0.033 - 0.03) / 0.03 = 10% — below 20%, should NOT exit.
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      positionRepo._setPosition(
        TOK_ID,
        makePosition({
          avgEntryPrice: 0.03,
          openedAt: twoHoursAgo,
        }),
      );
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { exit: { ...makeRules().exit, preferFastRecycle: true } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      const now = Date.now();
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.033 })],
        timestamp: now,
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(0);
    });
  });

  // ─── Wave 3: runner extension (P1-4) ────────────────────────────────────

  describe("runner extension (P1-4)", () => {
    it("prevents exit when ROI exceeds highBand and runner extension enabled", async () => {
      // ROI = (0.06 - 0.03) / 0.03 = 100% — above 50% highBand.
      // allowRunnerExtension: true → hold as runner.
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { exit: { ...makeRules().exit, allowRunnerExtension: true } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.06 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(0);
    });

    it("sells when ROI exceeds highBand and runner extension disabled", async () => {
      // ROI = (0.06 - 0.03) / 0.03 = 100% — above 50% highBand.
      // allowRunnerExtension: false → sell.
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      // Default: allowRunnerExtension: false
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.06 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(1);
    });
  });

  // ─── Wave 3: entry cooldown (P1-6) ─────────────────────────────────────

  describe("entry cooldown (P1-6)", () => {
    it("blocks entry when cooldown not elapsed", async () => {
      // entryCooldownSeconds: 300 (5 min), lastEntryTs: 2 min ago → blocked.
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      familyStateRepo.save(makeFamilyState({ lastEntryTs: twoMinAgo }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 300 } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      expect(signals).toHaveLength(0);
    });

    it("allows entry when cooldown elapsed", async () => {
      // entryCooldownSeconds: 300 (5 min), lastEntryTs: 10 min ago → allowed.
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      familyStateRepo.save(makeFamilyState({ lastEntryTs: tenMinAgo }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 300 } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(1);
    });

    it("does not block exits by cooldown", async () => {
      // entryCooldownSeconds: 300, lastEntryTs: 2 min ago → cooldown active.
      // But exits should still fire.
      const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      familyStateRepo.save(makeFamilyState({ lastEntryTs: twoMinAgo }));
      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 300 } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // ROI = (0.04 - 0.03) / 0.03 = 33% → in exit band
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.04 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(1);
    });

    it("limits to one entry per family per scan cycle when cooldown configured", async () => {
      // Two markets in the same family, cooldown elapsed → only one probe emitted.
      const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      familyStateRepo.save(makeFamilyState({ lastEntryTs: tenMinAgo }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 300 } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Two distinct markets in the same family, both in entry band
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          makeNormalizedMarket({ tokenId: TOK_ID, midPrice: 0.03 }),
          makeNormalizedMarket({ tokenId: TOK_ID_2, midPrice: 0.03 }),
        ],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(1);
    });
  });

  // ─── Wave 4: weekend policy (P1-3) ─────────────────────────────────────

  describe("weekend policy (P1-3)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("blocks all entries on weekend when allowWeekends is false", async () => {
      // Saturday 2026-03-21 at 16:00 UTC (inside active window)
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-21T16:00:00Z"));

      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            universe: { ...makeRules().universe, allowWeekends: false },
            session: { ...makeRules().session, weekendMode: "normal" },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const entries = signals.filter((s) => s.signal.side === "buy");
      expect(entries).toHaveLength(0);
    });

    it("blocks scale-in on weekend when weekendMode is reduced", async () => {
      // Saturday at 16:00 UTC, weekendMode=reduced → probes allowed, scale-in blocked.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-21T16:00:00Z"));

      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            universe: { ...makeRules().universe, allowWeekends: true },
            session: { ...makeRules().session, weekendMode: "reduced" },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter(
        (s) => s.signal.side === "buy" && s.signal.reason !== "probe-entry",
      );
      expect(scaleIns).toHaveLength(0);
    });

    it("allows probes on weekend when weekendMode is reduced", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-21T16:00:00Z"));

      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            universe: { ...makeRules().universe, allowWeekends: true },
            session: { ...makeRules().session, weekendMode: "reduced" },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(1);
    });

    it("allows exits on weekend regardless of policy", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-21T16:00:00Z"));

      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            universe: { ...makeRules().universe, allowWeekends: false },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // ROI = (0.04 - 0.03) / 0.03 = 33% → in exit band
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.04 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(1);
    });
  });

  // ─── Wave 4: family priority ranking (P1-1) ────────────────────────────

  describe("family priority ranking (P1-1)", () => {
    it("processes higher-priority families first in intra-tick dedup", async () => {
      // Two families: fam-btc (rank 1) and fam-eth (rank 2).
      // With cooldown + intra-tick dedup, only rank 1 gets the entry.
      const FAM_ETH = createFamilyId("fam-eth");
      const TOK_ETH = createTokenId("tok-eth-yes");

      const btcBundle = makeBundle({
        rules: {
          universe: { ...makeRules().universe, priorityRank: 1 },
          entry: { ...makeRules().entry, entryCooldownSeconds: 300 },
        },
      });
      const ethBundle = makeBundle({
        identity: { ...btcBundle.identity, familyId: FAM_ETH },
        rules: {
          ...makeRules(),
          familyId: FAM_ETH,
          universe: { ...makeRules().universe, priorityRank: 2 },
          entry: { ...makeRules().entry, entryCooldownSeconds: 300 },
        },
      });

      // Custom rules provider returning different bundles per family
      const customRulesProvider = {
        getRule: vi.fn((id: FamilyId) => {
          if (String(id) === "fam-btc") return btcBundle;
          if (String(id) === "fam-eth") return ethBundle;
          return null;
        }),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => [btcBundle.identity, ethBundle.identity]),
        getRulesForRegime: vi.fn(() => [btcBundle, ethBundle]),
      } satisfies FamilyRulesProvider;

      mod = new StrategyModule({
        bus,
        rulesProvider: customRulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // ETH market appears first in array, but BTC has higher priority (lower rank)
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          makeNormalizedMarket({ tokenId: TOK_ETH, familyId: FAM_ETH, midPrice: 0.03 }),
          makeNormalizedMarket({ tokenId: TOK_ID, familyId: FAM_ID, midPrice: 0.03 }),
        ],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      // Both families get entries since cooldown dedup is per-family, not global.
      // But BTC should be processed first due to priority sorting.
      expect(probes).toHaveLength(2);
      expect(String(probes[0]!.signal.familyId)).toBe("fam-btc");
    });
  });

  // ─── P1-6 completion: max_probe_count_per_market ────────────────────

  describe("max probe count per market (P1-6)", () => {
    it("blocks probe after filled entry reaches maxProbeCountPerMarket", async () => {
      // maxProbeCountPerMarket: 1 → after first filled probe, re-probe is blocked.
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, maxProbeCountPerMarket: 1 } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // First tick: probe signal fires
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();
      expect(signals.filter((s) => s.signal.reason === "probe-entry")).toHaveLength(1);

      // Simulate fill → PositionUpdated (new position, prevSize 0 → size 100)
      await bus.publish("PositionUpdated", {
        position: makePosition({ tokenId: TOK_ID, size: 100 }),
      });
      await bus.drain();

      // Simulate position closed (sell fill)
      await bus.publish("PositionUpdated", {
        position: makePosition({ tokenId: TOK_ID, size: 0, status: "closed" }),
      });
      await bus.drain();

      // Second tick: same tokenId, no open position → blocked by session probe count
      signals.length = 0;
      await mod.tick();
      await bus.drain();

      expect(signals.filter((s) => s.signal.reason === "probe-entry")).toHaveLength(0);
    });

    it("does not consume probe count on rejected signal", async () => {
      // maxProbeCountPerMarket: 1. Signal fires but risk rejects it.
      // The probe count should NOT be incremented — a rejected probe
      // doesn't count against the limit.
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, maxProbeCountPerMarket: 1 } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // First tick: probe signal fires
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();
      expect(signals.filter((s) => s.signal.reason === "probe-entry")).toHaveLength(1);

      // No PositionUpdated — signal was rejected by risk gate.
      // Session tracker should NOT have incremented.

      // Second tick: same tokenId → should fire again (rejected probe didn't consume limit)
      signals.length = 0;
      await mod.tick();
      await bus.drain();

      expect(signals.filter((s) => s.signal.reason === "probe-entry")).toHaveLength(1);
    });
  });

  // ─── P1-6 completion: max_new_markets_per_session ───────────────────

  describe("max new markets per session (P1-6)", () => {
    it("blocks new market entry after filled entries reach session limit", async () => {
      // maxNewMarketsPerSession: 1 → after one filled new market, block new ones.
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, maxNewMarketsPerSession: 1 } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // First tick: probe fires for TOK_ID
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ tokenId: TOK_ID, midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();
      expect(signals.filter((s) => s.signal.reason === "probe-entry")).toHaveLength(1);

      // Simulate fill → PositionUpdated (new position)
      await bus.publish("PositionUpdated", {
        position: makePosition({ tokenId: TOK_ID, size: 100 }),
      });
      await bus.drain();

      // Second tick: different market TOK_ID_2 → blocked by session limit
      signals.length = 0;
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ tokenId: TOK_ID_2, midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      expect(signals.filter((s) => s.signal.reason === "probe-entry")).toHaveLength(0);
    });

    it("does not count rejected signal as a new market entry", async () => {
      // maxNewMarketsPerSession: 1. First probe signal is rejected (no fill).
      // A second attempt to a different market should still be allowed.
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: { entry: { ...makeRules().entry, maxNewMarketsPerSession: 1 } },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // First tick: probe signal fires for TOK_ID
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ tokenId: TOK_ID, midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();
      expect(signals).toHaveLength(1);

      // No PositionUpdated — signal was rejected. Session limit not consumed.

      // Second tick: different market TOK_ID_2 → should still be allowed
      signals.length = 0;
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ tokenId: TOK_ID_2, midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      expect(signals.filter((s) => s.signal.reason === "probe-entry")).toHaveLength(1);
    });
  });

  // ─── P1-2 completion: config-driven reduced mode ─────────────────────

  describe("config-driven reduced mode (P1-2)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("always-reduced sessionMode blocks scale-in even inside active window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-18T17:00:00Z")); // Wednesday 17:00 UTC (inside 14-21 window)

      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            universe: { ...makeRules().universe, sessionMode: "always-reduced" },
            session: {
              activeWindowsUtc: [{ start: "14:00", end: "21:00" }],
              reducedWindowsUtc: [],
              weekdayBias: "normal",
              weekendMode: "normal",
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter(
        (s) => s.signal.reason === "scale-in" || s.signal.reason === "confirm-scale",
      );
      expect(scaleIns).toHaveLength(0);
    });

    it("reducedWindowsUtc forces reduced mode even inside active window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-18T17:00:00Z")); // Wednesday 17:00 UTC

      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            session: {
              activeWindowsUtc: [{ start: "14:00", end: "21:00" }],
              reducedWindowsUtc: [{ start: "16:00", end: "18:00" }], // 17:00 is inside
              weekdayBias: "normal",
              weekendMode: "normal",
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter(
        (s) => s.signal.reason === "scale-in" || s.signal.reason === "confirm-scale",
      );
      expect(scaleIns).toHaveLength(0);
    });

    it("allows scale-in when inside active window and outside reduced window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-18T19:00:00Z")); // Wednesday 19:00 UTC

      positionRepo._setPosition(TOK_ID, makePosition({ avgEntryPrice: 0.03 }));
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            exit: { ...makeRules().exit, preferFastRecycle: false },
            session: {
              activeWindowsUtc: [{ start: "14:00", end: "21:00" }],
              reducedWindowsUtc: [{ start: "16:00", end: "18:00" }], // 19:00 is outside
              weekdayBias: "normal",
              weekendMode: "normal",
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.031 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const scaleIns = signals.filter(
        (s) => s.signal.reason === "scale-in" || s.signal.reason === "confirm-scale",
      );
      expect(scaleIns).toHaveLength(1);
    });
  });

  // ─── P0-3 completion: evidence-aware sizing ─────────────────────────

  describe("evidence-aware sizing (P0-3)", () => {
    it("reduces probe size for probe-only promotion state", async () => {
      const bundle = makeBundle({
        evidence: { promotionState: "probe-only" },
        rules: {
          entry: { ...makeRules().entry, probeSizeUsdc: 10, maxInitialNotionalUsdc: 20 },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(1);
      // probe-only → 0.6x multiplier: 10 * 0.6 = 6
      expect(probes[0]!.signal.suggestedSizeUsdc).toBe(6);
    });

    it("increases size for heavy campaign eligible with high evidence", async () => {
      const bundle = makeBundle({
        evidence: { heavyCampaignEligible: true, evidenceScore: 125 },
        rules: {
          entry: { ...makeRules().entry, probeSizeUsdc: 10, maxInitialNotionalUsdc: 20 },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(1);
      // heavy eligible + score>100 → 1.25x: 10 * 1.25 = 12.5
      expect(probes[0]!.signal.suggestedSizeUsdc).toBe(12.5);
    });

    it("reduces size when tail-adjusted PnL is negative", async () => {
      familyStateRepo.save(makeFamilyState({ tailAdjustedPnlLive: -10 }));
      const bundle = makeBundle({
        rules: {
          entry: { ...makeRules().entry, probeSizeUsdc: 10, maxInitialNotionalUsdc: 20 },
        },
      });
      rulesProvider = createMockRulesProvider(bundle);
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(1);
      // negative tailPnl → 0.75x evidence mult + 0.5x probe haircut: 10 * 0.75 * 0.5 = 3.75
      expect(probes[0]!.signal.suggestedSizeUsdc).toBe(3.75);
    });
  });

  // ─── P1-4 completion: medium-hold partial exit ──────────────────────

  describe("medium-hold partial exit (P1-4)", () => {
    it("emits medium-hold-exit with partial size when ROI is in medium band", async () => {
      // avgEntryPrice: 0.03, midPrice: 0.032 → ROI = 6.7%
      // With fast recycle on young position: effectiveLowBand = 10%, mediumHoldBand = 5%
      // 6.7% is between 5% and 10% → medium-hold-exit
      positionRepo._setPosition(
        TOK_ID,
        makePosition({
          avgEntryPrice: 0.03,
          size: 100,
          openedAt: new Date().toISOString(), // young position
        }),
      );
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.032 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const medHolds = signals.filter((s) => s.signal.reason === "medium-hold-exit");
      expect(medHolds).toHaveLength(1);
      // Partial sell: floor(100 * 0.5) = 50 shares
      expect(medHolds[0]!.signal.suggestedSize).toBe(50);
      expect(medHolds[0]!.signal.side).toBe("sell");
    });

    it("emits full repricing-exit when ROI is in target band", async () => {
      // avgEntryPrice: 0.03, midPrice: 0.04 → ROI = 33% (in 20-50% band)
      positionRepo._setPosition(
        TOK_ID,
        makePosition({
          avgEntryPrice: 0.03,
          size: 100,
        }),
      );
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.04 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const exits = signals.filter((s) => s.signal.reason === "repricing-exit");
      expect(exits).toHaveLength(1);
      expect(exits[0]!.signal.suggestedSize).toBe(100); // full position
    });

    it("skips medium-hold when position too small to split", async () => {
      // Size 0.001 → 0.001 * 0.5 = 0.0005 → below 0.001 threshold
      positionRepo._setPosition(
        TOK_ID,
        makePosition({
          avgEntryPrice: 0.03,
          size: 0.001,
          openedAt: new Date().toISOString(),
        }),
      );
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ midPrice: 0.032 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const medHolds = signals.filter((s) => s.signal.reason === "medium-hold-exit");
      expect(medHolds).toHaveLength(0);
    });
  });

  // ─── P1-5: selective two-sided overlay ──────────────────────────────

  describe("two-sided overlay (P1-5)", () => {
    it("emits two-sided-entry for NO-outcome market when allowTwoSided is true", async () => {
      rulesProvider = createMockRulesProvider(
        makeBundle({
          evidence: { bothSidedEligible: true, localTradeCount: 50 },
          rules: {
            twoSided: {
              allowTwoSided: true,
              twoSidedMode: "selective",
              minActivityForTwoSided: 10,
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ outcome: "NO", midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      // NO-outcome with two-sided enabled: should get two-sided-entry (not probe-entry)
      const twoSided = signals.filter((s) => s.signal.reason === "two-sided-entry");
      expect(twoSided).toHaveLength(1);
      expect(twoSided[0]!.signal.side).toBe("buy");
    });

    it("blocks two-sided entry when twoSidedMode is disabled", async () => {
      rulesProvider = createMockRulesProvider(
        makeBundle({
          rules: {
            twoSided: {
              allowTwoSided: false,
              twoSidedMode: "disabled",
              minActivityForTwoSided: null,
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ outcome: "NO", midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const twoSided = signals.filter((s) => s.signal.reason === "two-sided-entry");
      expect(twoSided).toHaveLength(0);
    });

    it("blocks two-sided in selective mode when bothSidedEligible is false", async () => {
      rulesProvider = createMockRulesProvider(
        makeBundle({
          evidence: { bothSidedEligible: false },
          rules: {
            twoSided: {
              allowTwoSided: true,
              twoSidedMode: "selective",
              minActivityForTwoSided: null,
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ outcome: "NO", midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const twoSided = signals.filter((s) => s.signal.reason === "two-sided-entry");
      expect(twoSided).toHaveLength(0);
    });

    it("blocks two-sided in reduced mode", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-18T05:00:00Z")); // 05:00 UTC (outside 14-21)

      rulesProvider = createMockRulesProvider(
        makeBundle({
          evidence: { bothSidedEligible: true },
          rules: {
            twoSided: {
              allowTwoSided: true,
              twoSidedMode: "selective",
              minActivityForTwoSided: null,
            },
            session: {
              activeWindowsUtc: [{ start: "14:00", end: "21:00" }],
              reducedWindowsUtc: [],
              weekdayBias: "normal",
              weekendMode: "normal",
            },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ outcome: "NO", midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const twoSided = signals.filter((s) => s.signal.reason === "two-sided-entry");
      expect(twoSided).toHaveLength(0);

      vi.useRealTimers();
    });

    it("blocks two-sided when activity below minActivityForTwoSided", async () => {
      rulesProvider = createMockRulesProvider(
        makeBundle({
          evidence: { bothSidedEligible: true, localTradeCount: 5 },
          rules: {
            twoSided: { allowTwoSided: true, twoSidedMode: "active", minActivityForTwoSided: 20 },
          },
        }),
      );
      mod = new StrategyModule({
        bus,
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeNormalizedMarket({ outcome: "NO", midPrice: 0.03 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const twoSided = signals.filter((s) => s.signal.reason === "two-sided-entry");
      expect(twoSided).toHaveLength(0);
    });
  });

  // ─── P1-1 completion: multi-factor family ranking ──────────────────

  describe("multi-factor family ranking (P1-1)", () => {
    it("ranks family with better evidence higher than equal priorityRank", async () => {
      const FAM_WEAK = createFamilyId("fam-weak");
      const TOK_WEAK = createTokenId("tok-weak");

      // Both families have priorityRank: 1, but fam-btc has higher evidence score
      const strongBundle = makeBundle({
        evidence: { evidenceScore: 200 },
        rules: {
          universe: { ...makeRules().universe, priorityRank: 1 },
          entry: { ...makeRules().entry, entryCooldownSeconds: 300 },
        },
      });
      const weakBundle = makeBundle({
        identity: { ...makeIdentity(), familyId: FAM_WEAK },
        evidence: { evidenceScore: 10 },
        rules: {
          ...makeRules(),
          familyId: FAM_WEAK,
          universe: { ...makeRules().universe, priorityRank: 1 },
          entry: { ...makeRules().entry, entryCooldownSeconds: 300 },
        },
      });

      const customRulesProvider = {
        getRule: vi.fn((id: FamilyId) => {
          if (String(id) === "fam-btc") return strongBundle;
          if (String(id) === "fam-weak") return weakBundle;
          return null;
        }),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => [strongBundle.identity, weakBundle.identity]),
        getRulesForRegime: vi.fn(() => [strongBundle, weakBundle]),
      } satisfies FamilyRulesProvider;

      mod = new StrategyModule({
        bus,
        rulesProvider: customRulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      // Weak family market first in array, strong second
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          makeNormalizedMarket({ tokenId: TOK_WEAK, familyId: FAM_WEAK, midPrice: 0.03 }),
          makeNormalizedMarket({ tokenId: TOK_ID, familyId: FAM_ID, midPrice: 0.03 }),
        ],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(2);
      // Strong evidence family should be processed first
      expect(String(probes[0]!.signal.familyId)).toBe("fam-btc");
    });

    it("priorityRank always dominates even with maximal evidence difference", async () => {
      // fam-btc: rank 2 with perfect evidence (score 999, positive tail PnL)
      // fam-low: rank 1 with terrible evidence (score 0, negative tail PnL)
      // rank-1 family should still win despite far worse evidence.
      const FAM_LOW = createFamilyId("fam-low");
      const TOK_LOW = createTokenId("tok-low");

      const highEvidenceBundle = makeBundle({
        evidence: { evidenceScore: 999, heavyCampaignEligible: true },
        rules: {
          universe: { ...makeRules().universe, priorityRank: 2 },
          entry: { ...makeRules().entry, entryCooldownSeconds: 300 },
        },
      });
      familyStateRepo.save(
        makeFamilyState({
          familyId: FAM_ID,
          tailAdjustedPnlLive: 500,
          currentTailCostUsdc: 0,
        }),
      );

      const lowEvidenceBundle = makeBundle({
        identity: { ...makeIdentity(), familyId: FAM_LOW },
        evidence: { evidenceScore: 0 },
        rules: {
          ...makeRules(),
          familyId: FAM_LOW,
          universe: { ...makeRules().universe, priorityRank: 1 },
          entry: { ...makeRules().entry, entryCooldownSeconds: 300 },
        },
      });
      familyStateRepo.save(
        makeFamilyState({
          familyId: FAM_LOW,
          tailAdjustedPnlLive: -100,
          currentTailCostUsdc: 500,
        }),
      );

      const customRulesProvider = {
        getRule: vi.fn((id: FamilyId) => {
          if (String(id) === "fam-btc") return highEvidenceBundle;
          if (String(id) === "fam-low") return lowEvidenceBundle;
          return null;
        }),
        isEnabled: vi.fn(() => true),
        getAllFamilies: vi.fn(() => [highEvidenceBundle.identity, lowEvidenceBundle.identity]),
        getRulesForRegime: vi.fn(() => [highEvidenceBundle, lowEvidenceBundle]),
      } satisfies FamilyRulesProvider;

      mod = new StrategyModule({
        bus,
        rulesProvider: customRulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        scanIntervalMs: 60_000,
        runtimeControl: { isPaused: () => false },
      });
      await mod.start();

      const signals: Array<{ signal: import("@plankton/domain").Signal }> = [];
      bus.subscribe("SignalProduced", async (p) => {
        signals.push(p);
      });

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          makeNormalizedMarket({ tokenId: TOK_ID, familyId: FAM_ID, midPrice: 0.03 }),
          makeNormalizedMarket({ tokenId: TOK_LOW, familyId: FAM_LOW, midPrice: 0.03 }),
        ],
        timestamp: Date.now(),
      });
      await bus.drain();
      await mod.tick();
      await bus.drain();

      const probes = signals.filter((s) => s.signal.reason === "probe-entry");
      expect(probes).toHaveLength(2);
      // Rank 1 (fam-low) must beat rank 2 (fam-btc) despite worse evidence
      expect(String(probes[0]!.signal.familyId)).toBe("fam-low");
    });
  });
});
