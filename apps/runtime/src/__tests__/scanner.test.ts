import { describe, it, expect, vi } from "vitest";
import {
  createBotRunId,
  createFamilyId,
  createOrderId,
  createPositionId,
  createTokenId,
} from "@plankton/domain";
import type {
  ClientOrderId,
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyIdentity,
  FamilyEvidence,
  FamilyRules,
  FamilyState,
  FamilyStateRepository,
  Order,
  OrderRepository,
  Position,
  PositionRepository,
  NormalizedMarket,
  TokenId,
  FamilyId,
  Regime,
} from "@plankton/domain";
import type { GlobalConfig } from "@plankton/config";
import {
  scan,
  createBuyTracker,
  createSessionTracker,
  createSprayTracker,
  evaluateSprayEntry,
  resolveFamilyEntryPolicy,
  type EntryPolicy,
} from "../modules/strategy/scanner.js";

// ─── Constants ──────────────────────────────────��───────────────────────

const FAM_ID = createFamilyId("fam-btc");
const TOK_ID = createTokenId("tok-yes");
const TOK_ID_2 = createTokenId("tok-yes-2");
const TOK_ID_3 = createTokenId("tok-yes-3");

// ─── Helpers ───────────────────��────────────────────��───────────────────

function makeNormalizedMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: TOK_ID,
    conditionId: "cond-1",
    slug: "will-btc-reach-100k",
    eventSlug: null,
    question: "Will BTC hit 100k?",
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
    entryStyle: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_ord_1" as ClientOrderId,
    tokenId: TOK_ID,
    familyId: FAM_ID,
    side: "buy",
    orderType: "GTC",
    postOnly: true,
    price: 0.03,
    size: 100,
    sizeUsdc: 3,
    status: "open",
    exchangeOrderId: "ord-1",
    signalId: "sig-1",
    signalReason: "probe-entry",
    botRunId: createBotRunId("run-1"),
    createdAt: new Date().toISOString(),
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

function makeGlobalConfig(overrides?: Partial<GlobalConfig>): GlobalConfig {
  return {
    initialBalanceUsdc: 10_000,
    spraySizeUsdc: 0.15,
    sprayMaxMarketsPerTick: 10,
    sprayCooldownSeconds: 5,
    sprayBudgetUsdc: 50,
    sprayMaxTotalPositions: 30,
    ...overrides,
  };
}

function createMockRulesProvider(bundle: FamilyRuleBundle | null = makeBundle()) {
  return {
    getRule: vi.fn((_id: FamilyId) => bundle),
    isEnabled: vi.fn((_id: FamilyId) => true),
    getAllFamilies: vi.fn(() => (bundle ? [bundle.identity] : [])),
    getRulesForRegime: vi.fn(() => (bundle ? [bundle] : [])),
  } satisfies FamilyRulesProvider;
}

function createMockPositionRepo(initialPositions: Position[] = []) {
  const positions = new Map<string, Position>();
  for (const position of initialPositions) {
    positions.set(String(position.tokenId), position);
  }
  return {
    save: vi.fn(),
    findByTokenId: vi.fn((tokenId: TokenId) => positions.get(String(tokenId)) ?? null),
    findOpen: vi.fn(() => [...positions.values()].filter((p) => p.status === "open")),
    findDust: vi.fn(() => [...positions.values()].filter((p) => p.status === "dust")),
    findByFamily: vi.fn(() => [...positions.values()]),
    findAll: vi.fn(() => [...positions.values()]),
    findOpenByEntryStyle: vi.fn(() => []),
  } satisfies PositionRepository;
}

function createMockOrderRepo(initialOrders: Order[] = []) {
  return {
    save: vi.fn(),
    findById: vi.fn(() => null),
    findByClientOrderId: vi.fn(() => null),
    findByExchangeOrderId: vi.fn(() => null),
    findOpen: vi.fn(() => initialOrders.filter((order) => order.status === "open")),
    findByTokenId: vi.fn((tokenId) =>
      initialOrders.filter((order) => String(order.tokenId) === String(tokenId)),
    ),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn(() =>
      initialOrders
        .filter((order) => order.status === "open" && order.side === "buy")
        .reduce((sum, order) => sum + order.sizeUsdc, 0),
    ),
  } satisfies OrderRepository;
}

function createMockFamilyStateRepo() {
  const states = new Map<string, FamilyState>();
  return {
    get: vi.fn((_id: FamilyId) => states.get(String(_id)) ?? null),
    save: vi.fn(),
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

function nextSeqStub(_f: FamilyId, _t: TokenId, _s: string): number {
  return 0;
}

// ─── Tests: resolveFamilyEntryPolicy ─────────────��──────────────────────

describe("resolveFamilyEntryPolicy", () => {
  it("returns spray-first for unproven families", () => {
    const identity = makeIdentity({ strategyProfile: "scalp" });
    const evidence = makeEvidence({
      promotionState: "probe-only",
      evidenceScore: 10,
    });
    expect(resolveFamilyEntryPolicy(identity, evidence)).toBe("spray-first" as EntryPolicy);
  });

  it("returns probe-first for fee-enabled families", () => {
    const identity = makeIdentity({ feeTier: "fee-enabled" });
    const evidence = makeEvidence({
      promotionState: "probe-only",
      evidenceScore: 10,
    });
    expect(resolveFamilyEntryPolicy(identity, evidence)).toBe("probe-first" as EntryPolicy);
  });

  it("returns probe-first for scaled families", () => {
    const identity = makeIdentity();
    const evidence = makeEvidence({ promotionState: "scaled" });
    expect(resolveFamilyEntryPolicy(identity, evidence)).toBe("probe-first" as EntryPolicy);
  });

  it("returns probe-first when evidenceScore > 50", () => {
    const identity = makeIdentity();
    const evidence = makeEvidence({
      promotionState: "probe-only",
      evidenceScore: 51,
    });
    expect(resolveFamilyEntryPolicy(identity, evidence)).toBe("probe-first" as EntryPolicy);
  });

  it("returns disabled for restricted families", () => {
    const identity = makeIdentity({ strategyProfile: "restricted" });
    expect(resolveFamilyEntryPolicy(identity, undefined)).toBe("disabled" as EntryPolicy);
  });

  it("returns spray-first when no evidence provided", () => {
    const identity = makeIdentity({ strategyProfile: "scalp" });
    expect(resolveFamilyEntryPolicy(identity, undefined)).toBe("spray-first" as EntryPolicy);
  });
});

// ─── Tests: evaluateSprayEntry ───────────────��──────────────────────────

describe("evaluateSprayEntry", () => {
  it("generates spray signal with correct sizing", () => {
    const market = makeNormalizedMarket({ midPrice: 0.03 });
    const bundle = makeBundle();
    const spraySizeUsdc = 0.15;
    const sizeMult = 1.0;

    const signal = evaluateSprayEntry(
      market,
      bundle,
      0.03,
      Date.now(),
      nextSeqStub,
      spraySizeUsdc,
      sizeMult,
    );

    expect(signal).not.toBeNull();
    expect(signal!.reason).toBe("spray-entry");
    // Size = 0.15 * (0.03 ^ 1.5) = 0.00077... -> Floor (0.03 * 5) = 0.15
    expect(signal!.suggestedSizeUsdc).toBe(0.15);
    expect(signal!.suggestedSize).toBeCloseTo(0.15 / 0.03, 5);
    expect(signal!.side).toBe("buy");
    expect(signal!.familyId).toBe(FAM_ID);
    expect(signal!.tokenId).toBe(TOK_ID);
  });

  it("returns null when price is outside entry band (too low)", () => {
    const market = makeNormalizedMarket({ midPrice: 0.005 });
    const bundle = makeBundle();

    const signal = evaluateSprayEntry(market, bundle, 0.005, Date.now(), nextSeqStub, 0.15, 1.0);
    expect(signal).toBeNull();
  });

  it("returns null when price is outside entry band (too high)", () => {
    const market = makeNormalizedMarket({ midPrice: 0.06 });
    const bundle = makeBundle();

    const signal = evaluateSprayEntry(market, bundle, 0.06, Date.now(), nextSeqStub, 0.15, 1.0);
    expect(signal).toBeNull();
  });

  it("returns null when entry mode is disabled", () => {
    const market = makeNormalizedMarket({ midPrice: 0.03 });
    const bundle = makeBundle({
      rules: { entry: { ...makeRules().entry, entryMode: "disabled" } },
    });

    const signal = evaluateSprayEntry(market, bundle, 0.03, Date.now(), nextSeqStub, 0.15, 1.0);
    expect(signal).toBeNull();
  });

  it("applies sizeMult to spray size", () => {
    const market = makeNormalizedMarket({ midPrice: 0.03 });
    const bundle = makeBundle();

    const signal = evaluateSprayEntry(market, bundle, 0.03, Date.now(), nextSeqStub, 0.15, 0.6);

    expect(signal).not.toBeNull();
    // Base (0.15 * 0.6 = 0.09) * (0.03 ^ 1.5) = 0.00046... -> Floor (0.03 * 5) = 0.15
    expect(signal!.suggestedSizeUsdc).toBeCloseTo(0.15, 5);
  });

  it("allows spray when suggested shares meet market minOrderSize", () => {
    const market = makeNormalizedMarket({ midPrice: 0.03, minOrderSize: 0.01 });
    const bundle = makeBundle();

    const signal = evaluateSprayEntry(market, bundle, 0.03, Date.now(), nextSeqStub, 0.15, 1.0);
    expect(signal).not.toBeNull();
    // Floor is max(0.00077, 0.03 * 0.01, 0.05) = 0.05
    expect(signal!.suggestedSizeUsdc).toBeCloseTo(0.05, 5);
  });

  it("raises spray to the caller-provided live notional floor", () => {
    const market = makeNormalizedMarket({ midPrice: 0.03, minOrderSize: 0.01 });
    const bundle = makeBundle();

    const signal = evaluateSprayEntry(market, bundle, 0.03, Date.now(), nextSeqStub, 0.15, 1.0, 1);

    expect(signal).not.toBeNull();
    expect(signal!.suggestedSizeUsdc).toBe(1);
  });
});

describe("scan() outcome selection", () => {
  it("emits first-entry only for the best cheap outcome in a condition", () => {
    const bundle = makeBundle();
    const result = scan(
      [
        makeNormalizedMarket({
          tokenId: createTokenId("tok-yes"),
          outcome: "YES",
          bestBid: 0.49,
          bestAsk: 0.5,
          midPrice: 0.495,
          spread: 0.01,
          bookSource: "clob",
        }),
        makeNormalizedMarket({
          tokenId: createTokenId("tok-no"),
          outcome: "NO",
          outcomeIndex: 1,
          bestBid: 0.04,
          bestAsk: 0.05,
          midPrice: 0.045,
          spread: 0.01,
          bookSource: "clob",
        }),
      ],
      {
        rulesProvider: createMockRulesProvider(bundle),
        positionRepo: createMockPositionRepo(),
        familyStateRepo: createMockFamilyStateRepo(),
        log: createMockLogger(),
      },
      createBuyTracker(),
      Date.parse("2026-04-10T12:00:00Z"),
      createSessionTracker(),
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("probe-entry");
    expect(String(result.signals[0]!.tokenId)).toBe("tok-no");
  });

  it("does not emit a sibling first-entry while another outcome has an open entry order", () => {
    const result = scan(
      [
        makeNormalizedMarket({ tokenId: createTokenId("tok-yes"), outcome: "YES" }),
        makeNormalizedMarket({
          tokenId: createTokenId("tok-no"),
          outcome: "NO",
          outcomeIndex: 1,
        }),
      ],
      {
        rulesProvider: createMockRulesProvider(makeBundle()),
        positionRepo: createMockPositionRepo(),
        orderRepo: createMockOrderRepo([makeOrder({ tokenId: createTokenId("tok-yes") })]),
        familyStateRepo: createMockFamilyStateRepo(),
        log: createMockLogger(),
      },
      createBuyTracker(),
      Date.parse("2026-04-10T12:00:00Z"),
      createSessionTracker(),
    );

    expect(result.signals).toHaveLength(0);
  });

  it("emits a two-sided-entry only after a sibling position exists", () => {
    const bundle = makeBundle({
      evidence: { bothSidedEligible: true, localTradeCount: 50 },
      rules: {
        scaleIn: { ...makeRules().scaleIn, scaleMode: "disabled" },
        twoSided: {
          allowTwoSided: true,
          twoSidedMode: "selective",
          minActivityForTwoSided: 10,
        },
      },
    });
    const result = scan(
      [
        makeNormalizedMarket({
          tokenId: createTokenId("tok-yes"),
          outcome: "YES",
          bestBid: 0.03,
          bestAsk: 0.03,
          midPrice: 0.03,
          spread: 0,
        }),
        makeNormalizedMarket({
          tokenId: createTokenId("tok-no"),
          outcome: "NO",
          outcomeIndex: 1,
          bestBid: 0.04,
          bestAsk: 0.05,
          midPrice: 0.045,
          spread: 0.01,
        }),
      ],
      {
        rulesProvider: createMockRulesProvider(bundle),
        positionRepo: createMockPositionRepo([makePosition({ tokenId: createTokenId("tok-yes") })]),
        familyStateRepo: createMockFamilyStateRepo(),
        log: createMockLogger(),
      },
      createBuyTracker(),
      Date.parse("2026-04-10T12:00:00Z"),
      createSessionTracker(),
    );

    const entrySignals = result.signals.filter((signal) => signal.reason !== "repricing-exit");
    expect(entrySignals).toHaveLength(1);
    expect(entrySignals[0]!.reason).toBe("two-sided-entry");
    expect(String(entrySignals[0]!.tokenId)).toBe("tok-no");
  });

  it("allows additional side above the first-entry cap when maxAdditionalEntryPrice permits it", () => {
    const bundle = makeBundle({
      evidence: { bothSidedEligible: true, localTradeCount: 50 },
      rules: {
        twoSided: {
          allowTwoSided: true,
          twoSidedMode: "active",
          minActivityForTwoSided: null,
          maxAdditionalEntryPrice: 0.2,
        },
      },
    });
    const result = scan(
      [
        makeNormalizedMarket({
          tokenId: createTokenId("tok-yes"),
          outcome: "YES",
          bestBid: 0.04,
          bestAsk: 0.05,
          midPrice: 0.045,
          spread: 0.01,
        }),
        makeNormalizedMarket({
          tokenId: createTokenId("tok-no"),
          outcome: "NO",
          outcomeIndex: 1,
          bestBid: 0.14,
          bestAsk: 0.16,
          midPrice: 0.15,
          spread: 0.02,
        }),
      ],
      {
        rulesProvider: createMockRulesProvider(bundle),
        positionRepo: createMockPositionRepo([makePosition({ tokenId: createTokenId("tok-yes") })]),
        familyStateRepo: createMockFamilyStateRepo(),
        log: createMockLogger(),
      },
      createBuyTracker(),
      Date.parse("2026-04-10T12:00:00Z"),
      createSessionTracker(),
    );

    expect(result.signals.filter((signal) => signal.reason === "two-sided-entry")).toHaveLength(1);
  });

  it("blocks expensive sibling outcomes instead of buying 95c as two-sided hedge", () => {
    const bundle = makeBundle({
      evidence: { bothSidedEligible: true, localTradeCount: 50 },
      rules: {
        twoSided: {
          allowTwoSided: true,
          twoSidedMode: "active",
          minActivityForTwoSided: null,
          maxAdditionalEntryPrice: 0.2,
        },
      },
    });
    const result = scan(
      [
        makeNormalizedMarket({
          tokenId: createTokenId("tok-yes"),
          outcome: "YES",
          bestBid: 0.03,
          bestAsk: 0.03,
          midPrice: 0.03,
          spread: 0,
        }),
        makeNormalizedMarket({
          tokenId: createTokenId("tok-no"),
          outcome: "NO",
          outcomeIndex: 1,
          bestBid: 0.94,
          bestAsk: 0.96,
          midPrice: 0.95,
          spread: 0.02,
        }),
      ],
      {
        rulesProvider: createMockRulesProvider(bundle),
        positionRepo: createMockPositionRepo([makePosition({ tokenId: createTokenId("tok-yes") })]),
        familyStateRepo: createMockFamilyStateRepo(),
        log: createMockLogger(),
      },
      createBuyTracker(),
      Date.parse("2026-04-10T12:00:00Z"),
      createSessionTracker(),
    );

    expect(result.signals.filter((signal) => signal.reason === "two-sided-entry")).toHaveLength(0);
  });
});

// ─── Tests: scan() with spray integration ───────────��───────────────────

describe("scan() spray integration", () => {
  it("generates spray signals for eligible unproven families", () => {
    // Unproven family: probe-only, low evidence → spray-first
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // Use a weekday midday timestamp to avoid weekend/window blocks
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("spray-entry");
    // Price 0.035 -> Floor (0.035 * 5) = 0.175
    expect(result.signals[0]!.suggestedSizeUsdc).toBeCloseTo(0.175, 4);
  });

  it("uses minEntryNotionalUsdc for generated live entry signals", () => {
    const bundle = makeBundle();
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const markets = [makeNormalizedMarket({ midPrice: 0.03 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, minEntryNotionalUsdc: 1 },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("probe-entry");
    expect(result.signals[0]!.suggestedSizeUsdc).toBe(1);
  });

  it("does NOT generate spray for proven/scaled families", () => {
    // Proven family: scaled, high evidence → probe-first
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig },
      createBuyTracker(),
      tickTs,
    );

    // Should emit probe-entry, NOT spray-entry
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("probe-entry");
  });

  it("respects sprayMaxMarketsPerTick cap", () => {
    const FAM_A = createFamilyId("fam-a");
    const bundle = makeBundle({
      identity: { familyId: FAM_A },
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
      rules: { familyId: FAM_A },
    });

    const rulesProvider = {
      getRule: vi.fn((_id: FamilyId) => bundle),
      isEnabled: vi.fn((_id: FamilyId) => true),
      getAllFamilies: vi.fn(() => [bundle.identity]),
      getRulesForRegime: vi.fn(() => [bundle]),
    } satisfies FamilyRulesProvider;

    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig({ sprayMaxMarketsPerTick: 2 });

    // Create 5 markets in the same family, each with a different token
    const tokens = [TOK_ID, TOK_ID_2, TOK_ID_3, createTokenId("tok-4"), createTokenId("tok-5")];
    const markets = tokens.map((tokenId, index) =>
      makeNormalizedMarket({
        tokenId,
        conditionId: `cond-${index}`,
        familyId: FAM_A,
        midPrice: 0.035,
      }),
    );

    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig },
      createBuyTracker(),
      tickTs,
    );

    const spraySignals = result.signals.filter((s) => s.reason === "spray-entry");
    expect(spraySignals).toHaveLength(2);

    // Remaining spray-first markets are skipped entirely (no fallthrough to probe)
    expect(result.signals).toHaveLength(2);
  });

  it("does NOT generate spray when globalConfig is absent", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log },
      createBuyTracker(),
      tickTs,
    );

    // Without globalConfig, spray is disabled — spray-first family is skipped entirely
    expect(result.signals).toHaveLength(0);
  });
});

// ─── Spray → conviction escalation (evaluateScaleIn) ────────────────────

describe("spray → conviction escalation", () => {
  it("uses probeSizeUsdc for first scale-in on spray position (buyCount=1)", () => {
    const bundle = makeBundle();
    const rulesProvider = createMockRulesProvider(bundle);

    // Existing spray position for the token
    const sprayPos: import("@plankton/domain").Position = {
      positionId: createPositionId("pos-spray"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 5,
      avgEntryPrice: 0.035,
      costBasisUsdc: 0.175,
      currentValueUsdc: 0.175,
      realizedPnl: 0,
      status: "open",
      entryStyle: "spray",
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    const positionRepo = createMockPositionRepo();
    (positionRepo.findByTokenId as ReturnType<typeof vi.fn>).mockReturnValue(sprayPos);

    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    // buyCount=1 means this is the first scale-in (confirm-scale stage)
    const buyTracker = createBuyTracker();
    buyTracker.incrementBuyCount(String(sprayPos.positionId)); // buyCount = 1

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log },
      buyTracker,
      tickTs,
    );

    // Should produce a confirm-scale signal with probeSizeUsdc (5) instead of addSizeUsdc (4)
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("confirm-scale");
    // Base 5 * (0.035 ^ 1.5) = 0.032... -> Floor (0.035 * 5) = 0.175
    expect(result.signals[0]!.suggestedSizeUsdc).toBeCloseTo(0.175, 4); // probeSizeUsdc, not addSizeUsdc
  });

  it("uses addSizeUsdc for scale-in on probe position (regression)", () => {
    const bundle = makeBundle();
    const rulesProvider = createMockRulesProvider(bundle);

    // Existing probe position (normal entry)
    const probePos: import("@plankton/domain").Position = {
      positionId: createPositionId("pos-probe"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 100,
      avgEntryPrice: 0.035,
      costBasisUsdc: 3.5,
      currentValueUsdc: 3.5,
      realizedPnl: 0,
      status: "open",
      entryStyle: "probe",
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    const positionRepo = createMockPositionRepo();
    (positionRepo.findByTokenId as ReturnType<typeof vi.fn>).mockReturnValue(probePos);

    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const buyTracker = createBuyTracker();
    buyTracker.incrementBuyCount(String(probePos.positionId)); // buyCount = 1

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log },
      buyTracker,
      tickTs,
    );

    // Should produce a confirm-scale signal with addSizeUsdc (4), NOT probeSizeUsdc
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("confirm-scale");
    // Base 4 * (0.035 ^ 1.5) = 0.026... -> Floor (0.035 * 5) = 0.175
    expect(result.signals[0]!.suggestedSizeUsdc).toBeCloseTo(0.175, 4); // addSizeUsdc
  });

  it("uses addSizeUsdc for spray position after buyCount > 1", () => {
    const bundle = makeBundle();
    const rulesProvider = createMockRulesProvider(bundle);

    const sprayPos: import("@plankton/domain").Position = {
      positionId: createPositionId("pos-spray2"),
      tokenId: TOK_ID,
      familyId: FAM_ID,
      side: "buy",
      size: 100,
      avgEntryPrice: 0.035,
      costBasisUsdc: 3.5,
      currentValueUsdc: 3.5,
      realizedPnl: 0,
      status: "open",
      entryStyle: "spray",
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    const positionRepo = createMockPositionRepo();
    (positionRepo.findByTokenId as ReturnType<typeof vi.fn>).mockReturnValue(sprayPos);

    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    // buyCount=2 → past the escalation window
    const buyTracker = createBuyTracker();
    buyTracker.incrementBuyCount(String(sprayPos.positionId));
    buyTracker.incrementBuyCount(String(sprayPos.positionId)); // buyCount = 2

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log },
      buyTracker,
      tickTs,
    );

    // buyCount=2 → scale-in stage, should use addSizeUsdc (4)
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("scale-in");
    // Base 4 * (0.035 ^ 1.5) = 0.026... -> Floor (0.035 * 5) = 0.175
    expect(result.signals[0]!.suggestedSizeUsdc).toBeCloseTo(0.175, 4); // addSizeUsdc
  });
});

// ─── Tests: SprayTracker ────────────────────────────────────────────────

describe("SprayTracker", () => {
  it("tracks and removes positions", () => {
    const tracker = createSprayTracker();
    expect(tracker.getPositionCount()).toBe(0);
    expect(tracker.getExposureUsdc()).toBe(0);

    tracker.trackPosition("pos-1", 0.15);
    tracker.trackPosition("pos-2", 0.2);

    expect(tracker.getPositionCount()).toBe(2);
    expect(tracker.getExposureUsdc()).toBeCloseTo(0.35);
    expect(tracker.has("pos-1")).toBe(true);
    expect(tracker.has("pos-2")).toBe(true);
    expect(tracker.has("pos-3")).toBe(false);

    tracker.removePosition("pos-1");
    expect(tracker.getPositionCount()).toBe(1);
    expect(tracker.getExposureUsdc()).toBeCloseTo(0.2);
    expect(tracker.has("pos-1")).toBe(false);
  });

  it("deduplicates — tracking same positionId twice overwrites cost basis", () => {
    const tracker = createSprayTracker();
    tracker.trackPosition("pos-1", 0.15);
    tracker.trackPosition("pos-1", 0.3);

    expect(tracker.getPositionCount()).toBe(1);
    expect(tracker.getExposureUsdc()).toBeCloseTo(0.3);
  });

  it("removing non-existent position is a no-op", () => {
    const tracker = createSprayTracker();
    tracker.trackPosition("pos-1", 0.15);
    tracker.removePosition("pos-nonexistent");

    expect(tracker.getPositionCount()).toBe(1);
    expect(tracker.getExposureUsdc()).toBeCloseTo(0.15);
  });
});

// ─── Tests: scan() spray cap enforcement ────────────────────────────────

describe("scan() spray cap enforcement", () => {
  it("blocks spray when sprayMaxTotalPositions cap reached", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig({ sprayMaxTotalPositions: 5 });

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      {
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        globalConfig,
        spraySnapshot: { positionCount: 5, exposureUsdc: 0.5 },
      },
      createBuyTracker(),
      tickTs,
    );

    // Spray blocked by position cap — spray-first family is skipped entirely
    expect(result.signals).toHaveLength(0);
  });

  it("blocks spray when sprayBudgetUsdc cap reached", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig({ sprayBudgetUsdc: 1, spraySizeUsdc: 0.15 });

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      {
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        globalConfig,
        // Exposure already at budget limit (after sizeMult=0.6 → cost=0.09)
        spraySnapshot: { positionCount: 0, exposureUsdc: 0.95 },
      },
      createBuyTracker(),
      tickTs,
    );

    // Spray blocked by budget cap — spray-first family is skipped entirely
    expect(result.signals).toHaveLength(0);
  });

  it("allows spray when under both caps", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      {
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        globalConfig,
        spraySnapshot: { positionCount: 2, exposureUsdc: 0.3 },
      },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("spray-entry");
  });

  it("decrements intra-tick budget as spray signals are emitted", () => {
    const FAM_A = createFamilyId("fam-a");
    const bundle = makeBundle({
      identity: { familyId: FAM_A },
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
      rules: { familyId: FAM_A },
    });

    const rulesProvider = {
      getRule: vi.fn((_id: FamilyId) => bundle),
      isEnabled: vi.fn((_id: FamilyId) => true),
      getAllFamilies: vi.fn(() => [bundle.identity]),
      getRulesForRegime: vi.fn(() => [bundle]),
    } satisfies FamilyRulesProvider;

    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    // Budget allows only 2 sprays at 0.09 each (sizeMult 0.6 × 0.15 = 0.09)
    const globalConfig = makeGlobalConfig({
      sprayBudgetUsdc: 0.2,
      sprayMaxMarketsPerTick: 10,
      sprayMaxTotalPositions: 30,
    });

    const tokens = [TOK_ID, TOK_ID_2, TOK_ID_3];
    const markets = tokens.map((tokenId) =>
      makeNormalizedMarket({ tokenId, familyId: FAM_A, midPrice: 0.035 }),
    );

    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    const result = scan(
      markets,
      {
        rulesProvider,
        positionRepo,
        familyStateRepo,
        log,
        globalConfig,
        spraySnapshot: { positionCount: 0, exposureUsdc: 0 },
      },
      createBuyTracker(),
      tickTs,
    );

    const spraySignals = result.signals.filter((s) => s.reason === "spray-entry");
    // Budget 0.20 fits only 1 spray (0.175 each)
    expect(spraySignals).toHaveLength(1);
    expect(result.signals).toHaveLength(1);
  });
});

// ─── Tests: spray session counter isolation ───────────────────────────────

describe("spray session counter isolation", () => {
  it("spray signal does NOT increment sessionTracker probe count", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();
    const sessionTracker = createSessionTracker();

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig },
      createBuyTracker(),
      tickTs,
      sessionTracker,
    );

    // Spray signal emitted
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("spray-entry");

    // Session tracker NOT incremented — only StrategyModule does that on fill
    expect(sessionTracker.getProbeCount(String(TOK_ID))).toBe(0);
    expect(sessionTracker.getNewMarketCount(String(FAM_ID))).toBe(0);
  });
});

// ─── Tests: sprayedTokens cross-tick dedup ────────────────────────────────

describe("sprayedTokens cross-tick dedup", () => {
  it("blocks re-spray of tokens already in sprayedTokens set", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    // Token already sprayed
    const sprayedTokens = new Set([String(TOK_ID)]);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig, sprayedTokens },
      createBuyTracker(),
      tickTs,
    );

    // Spray blocked by sprayedTokens — spray-first family skipped entirely
    expect(result.signals).toHaveLength(0);
  });

  it("allows spray for tokens NOT in sprayedTokens set", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];
    const tickTs = new Date("2026-04-01T12:00:00Z").getTime();

    // Different token already sprayed, not TOK_ID
    const sprayedTokens = new Set(["other-token"]);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig, sprayedTokens },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("spray-entry");
  });
});

// ─── Tests: spray cooldown uses sprayCooldownSeconds ──────────────────────

describe("spray cooldown", () => {
  it("spray-first family uses sprayCooldownSeconds, not entryCooldownSeconds", () => {
    // Family with 30s entry cooldown, but spray cooldown is 5s
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig({ sprayCooldownSeconds: 5 });

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // Last entry was 10 seconds ago — past spray cooldown (5s) but within entry cooldown (30s)
    const tickTs = new Date("2026-04-01T12:00:10Z").getTime();
    (familyStateRepo.get as ReturnType<typeof vi.fn>).mockReturnValue({
      familyId: FAM_ID,
      runtimeMode: "active",
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
      activeMarketCount: 0,
      currentTailCostUsdc: 0,
      tailAdjustedPnlLive: 0,
      lastEntryTs: new Date("2026-04-01T12:00:00Z").toISOString(),
      lastExitTs: null,
      quarantineReason: null,
      effectiveMode: null,
      derivedModeReason: null,
      firstNegativeTailAt: null,
      updatedAt: new Date().toISOString(),
    } satisfies FamilyState);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig },
      createBuyTracker(),
      tickTs,
    );

    // Should spray — 10s > 5s spray cooldown
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("spray-entry");
  });

  it("spray-first family blocked when within sprayCooldownSeconds", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig({ sprayCooldownSeconds: 5 });

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // Last entry was 3 seconds ago — within spray cooldown (5s)
    const tickTs = new Date("2026-04-01T12:00:03Z").getTime();
    (familyStateRepo.get as ReturnType<typeof vi.fn>).mockReturnValue({
      familyId: FAM_ID,
      runtimeMode: "active",
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
      activeMarketCount: 0,
      currentTailCostUsdc: 0,
      tailAdjustedPnlLive: 0,
      lastEntryTs: new Date("2026-04-01T12:00:00Z").toISOString(),
      lastExitTs: null,
      quarantineReason: null,
      effectiveMode: null,
      derivedModeReason: null,
      firstNegativeTailAt: null,
      updatedAt: new Date().toISOString(),
    } satisfies FamilyState);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig },
      createBuyTracker(),
      tickTs,
    );

    // Should be blocked — 3s < 5s spray cooldown
    expect(result.signals).toHaveLength(0);
  });

  it("probe-first family still uses entryCooldownSeconds (not sprayCooldownSeconds)", () => {
    // Proven family (probe-first), with 30s entry cooldown
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig({ sprayCooldownSeconds: 5 });

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // Last entry was 10 seconds ago — past spray cooldown but within entry cooldown (30s)
    const tickTs = new Date("2026-04-01T12:00:10Z").getTime();
    (familyStateRepo.get as ReturnType<typeof vi.fn>).mockReturnValue({
      familyId: FAM_ID,
      runtimeMode: "active",
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
      activeMarketCount: 0,
      currentTailCostUsdc: 0,
      tailAdjustedPnlLive: 0,
      lastEntryTs: new Date("2026-04-01T12:00:00Z").toISOString(),
      lastExitTs: null,
      quarantineReason: null,
      effectiveMode: null,
      derivedModeReason: null,
      firstNegativeTailAt: null,
      updatedAt: new Date().toISOString(),
    } satisfies FamilyState);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig },
      createBuyTracker(),
      tickTs,
    );

    // Should be blocked — 10s < 30s entry cooldown for probe-first
    expect(result.signals).toHaveLength(0);
  });
});

// ─── Tests: per-family tick throughput ────────────────────────────────────

describe("per-family tick throughput", () => {
  it("keeps the legacy one-entry-per-family limit when no throughput override is configured", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const result = scan(
      [
        makeNormalizedMarket({ tokenId: TOK_ID, midPrice: 0.035 }),
        makeNormalizedMarket({ tokenId: TOK_ID_2, midPrice: 0.035 }),
      ],
      {
        rulesProvider: createMockRulesProvider(bundle),
        positionRepo: createMockPositionRepo(),
        familyStateRepo: createMockFamilyStateRepo(),
        log: createMockLogger(),
      },
      createBuyTracker(),
      new Date("2026-04-01T12:00:00Z").getTime(),
    );

    expect(result.signals).toHaveLength(1);
    expect(result.meta.blockedByPerFamilyTickLimit).toBe(1);
  });

  it("allows configured burst families to emit multiple conviction entries in one tick", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
      rules: {
        entry: { ...makeRules().entry, entryCooldownSeconds: 30 },
        throughput: {
          maxConcurrentOrdersPerFamily: null,
          maxProbeInFlightPerToken: null,
          maxEntrySignalsPerTickPerFamily: 2,
        },
      },
    });
    const result = scan(
      [
        makeNormalizedMarket({ tokenId: TOK_ID, conditionId: "cond-1", midPrice: 0.035 }),
        makeNormalizedMarket({ tokenId: TOK_ID_2, conditionId: "cond-2", midPrice: 0.035 }),
        makeNormalizedMarket({ tokenId: TOK_ID_3, conditionId: "cond-3", midPrice: 0.035 }),
      ],
      {
        rulesProvider: createMockRulesProvider(bundle),
        positionRepo: createMockPositionRepo(),
        familyStateRepo: createMockFamilyStateRepo(),
        log: createMockLogger(),
      },
      createBuyTracker(),
      new Date("2026-04-01T12:00:00Z").getTime(),
    );

    expect(result.signals).toHaveLength(2);
    expect(result.signals.map((s) => s.sequenceInTick)).toEqual([0, 0]);
    expect(result.meta.blockedByPerFamilyTickLimit).toBe(1);
  });
});

// ─── Tests: attempt-level cooldown tracker ────────────────────────────────

describe("attempt-level cooldown", () => {
  it("blocks entry when lastAttemptTs is within cooldown", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // Attempt was 10s ago, cooldown is 30s → blocked
    const tickTs = new Date("2026-04-01T12:00:10Z").getTime();
    const attemptTs = new Date("2026-04-01T12:00:00Z").getTime();
    const lastAttemptTs = new Map<string, number>([[`${FAM_ID}|${TOK_ID}`, attemptTs]]);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, lastAttemptTs },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(0);
  });

  it("allows entry when lastAttemptTs cooldown has elapsed", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // Attempt was 60s ago, cooldown is 30s → allowed
    const tickTs = new Date("2026-04-01T12:01:00Z").getTime();
    const attemptTs = new Date("2026-04-01T12:00:00Z").getTime();
    const lastAttemptTs = new Map<string, number>([[`${FAM_ID}|${TOK_ID}`, attemptTs]]);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, lastAttemptTs },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.reason).toBe("probe-entry");
  });

  it("attempt tracker takes precedence over persisted lastEntryTs", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // Persisted lastEntryTs: 10min ago (would allow entry)
    // But attempt tracker: 5s ago (should block)
    const tickTs = new Date("2026-04-01T12:10:05Z").getTime();
    const attemptTs = new Date("2026-04-01T12:10:00Z").getTime();
    const lastAttemptTs = new Map<string, number>([[`${FAM_ID}|${TOK_ID}`, attemptTs]]);

    (familyStateRepo.get as ReturnType<typeof vi.fn>).mockReturnValue({
      familyId: FAM_ID,
      runtimeMode: "active",
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
      activeMarketCount: 0,
      currentTailCostUsdc: 0,
      tailAdjustedPnlLive: 0,
      lastEntryTs: new Date("2026-04-01T12:00:00Z").toISOString(),
      lastExitTs: null,
      quarantineReason: null,
      effectiveMode: null,
      derivedModeReason: null,
      firstNegativeTailAt: null,
      updatedAt: new Date().toISOString(),
    } satisfies FamilyState);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, lastAttemptTs },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(0);
  });

  it("falls back to lastEntryTs when no attempt tracked for token", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // No attempt tracked, but lastEntryTs is 5s ago → blocked by fallback
    const tickTs = new Date("2026-04-01T12:00:05Z").getTime();
    const lastAttemptTs = new Map<string, number>(); // empty — no tracked attempts

    (familyStateRepo.get as ReturnType<typeof vi.fn>).mockReturnValue({
      familyId: FAM_ID,
      runtimeMode: "active",
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
      activeMarketCount: 0,
      currentTailCostUsdc: 0,
      tailAdjustedPnlLive: 0,
      lastEntryTs: new Date("2026-04-01T12:00:00Z").toISOString(),
      lastExitTs: null,
      quarantineReason: null,
      effectiveMode: null,
      derivedModeReason: null,
      firstNegativeTailAt: null,
      updatedAt: new Date().toISOString(),
    } satisfies FamilyState);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, lastAttemptTs },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(0);
  });

  it("spray-first uses sprayCooldownSeconds with attempt tracker", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "probe-only", evidenceScore: 10 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();
    const globalConfig = makeGlobalConfig({ sprayCooldownSeconds: 5 });

    const markets = [makeNormalizedMarket({ midPrice: 0.035 })];

    // Attempt was 3s ago, spray cooldown is 5s → blocked
    const tickTs = new Date("2026-04-01T12:00:03Z").getTime();
    const attemptTs = new Date("2026-04-01T12:00:00Z").getTime();
    const lastAttemptTs = new Map<string, number>([[`${FAM_ID}|${TOK_ID}`, attemptTs]]);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, globalConfig, lastAttemptTs },
      createBuyTracker(),
      tickTs,
    );

    expect(result.signals).toHaveLength(0);
  });

  it("attempt cooldown is per family+token — different token is allowed", () => {
    const bundle = makeBundle({
      evidence: { promotionState: "scaled", evidenceScore: 80 },
      rules: { entry: { ...makeRules().entry, entryCooldownSeconds: 30 } },
    });
    const rulesProvider = createMockRulesProvider(bundle);
    const positionRepo = createMockPositionRepo();
    const familyStateRepo = createMockFamilyStateRepo();
    const log = createMockLogger();

    // Two tokens: TOK_ID has a recent attempt, TOK_ID_2 does not
    const markets = [makeNormalizedMarket({ tokenId: TOK_ID_2, midPrice: 0.035 })];

    const tickTs = new Date("2026-04-01T12:00:05Z").getTime();
    const attemptTs = new Date("2026-04-01T12:00:00Z").getTime();
    const lastAttemptTs = new Map<string, number>([
      [`${FAM_ID}|${TOK_ID}`, attemptTs], // only TOK_ID is tracked
    ]);

    const result = scan(
      markets,
      { rulesProvider, positionRepo, familyStateRepo, log, lastAttemptTs },
      createBuyTracker(),
      tickTs,
    );

    // TOK_ID_2 has no attempt tracked, and no persisted lastEntryTs → allowed
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.tokenId).toBe(TOK_ID_2);
  });
});
