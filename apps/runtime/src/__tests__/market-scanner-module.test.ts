import { describe, it, expect, vi } from "vitest";
import { SelectionRuleEngine, createTokenId } from "@plankton/domain";
import type {
  SelectionRule,
  MarketDiscoveryGateway,
  ClobMarket,
  MarketRepository,
  Market,
  EventBus,
  PositionRepository,
  OrderRepository,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { MarketScannerModule } from "../modules/market-scanner/market-scanner-module.js";
import type { RefreshableSelectionRuleEngine } from "../selection-rule-engine-factory.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeRule(
  partial: Partial<SelectionRule> & Pick<SelectionRule, "ruleId" | "ruleType" | "pattern">,
): SelectionRule {
  return {
    profileId: "simulation",
    enabled: true,
    note: null,
    createdAt: "2026-04-18T00:00:00Z",
    updatedAt: "2026-04-18T00:00:00Z",
    ...partial,
  };
}

/** Build a lightweight RefreshableSelectionRuleEngine stub around a real engine. */
function makeEngine(rules: SelectionRule[]): RefreshableSelectionRuleEngine {
  const engine = new SelectionRuleEngine(rules);
  return {
    refreshIfStale: vi.fn(),
    resolve: (...args: Parameters<SelectionRuleEngine["resolve"]>) => engine.resolve(...args),
    get current() {
      return engine;
    },
  } as unknown as RefreshableSelectionRuleEngine;
}

/** Engine matching the seeded 06-spec prefixes. */
const SEEDED_ENGINE = makeEngine([
  makeRule({ ruleId: "r-btc", ruleType: "include_prefix", pattern: "bitcoin-" }),
  makeRule({ ruleId: "r-elon", ruleType: "include_prefix", pattern: "elon-musk-" }),
  makeRule({ ruleId: "r-eth", ruleType: "include_prefix", pattern: "ethereum-" }),
]);

/** Engine with no rules — STEP 2: single-market events INCLUDE, multi-market EXCLUDE. */
const EMPTY_ENGINE = makeEngine([]);

function nearEndDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function makeClobMarket(overrides?: Partial<ClobMarket>): ClobMarket {
  return {
    conditionId: "cond-1",
    tokens: [
      { tokenId: "tok-yes", outcome: "Yes", outcomeIndex: 0 },
      { tokenId: "tok-no", outcome: "No", outcomeIndex: 1 },
    ],
    question: "Will BTC hit 100k?",
    slug: "bitcoin-above-100k",
    eventSlug: "bitcoin-above-100k",
    endDate: nearEndDate(),
    active: true,
    negRisk: false,
    tickSize: 0.01,
    volume24h: null,
    eventMarketCount: 1,
    ...overrides,
  };
}

function createMockDiscoveryGateway(): MarketDiscoveryGateway {
  const discoverMarkets = vi.fn<() => Promise<ClobMarket[]>>().mockResolvedValue([]);
  return {
    discoverMarkets,
    forEachMarketPage: vi.fn(async (cb: (markets: ClobMarket[]) => void) => {
      const markets = await discoverMarkets();
      if (markets.length > 0) cb(markets);
      return { totalMarkets: markets.length };
    }),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
  };
}

function createMockMarketRepo(): MarketRepository {
  const save = vi.fn();
  return {
    save,
    // Scanner now writes via saveBatch; trampoline to save() so existing
    // per-market assertions continue to work while still exercising the
    // batched code path in production.
    saveBatch: vi.fn((markets: readonly Market[]) => {
      for (const m of markets) save(m);
    }),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findTrackedForPricingTiered: vi.fn().mockReturnValue({
      executionCritical: [],
      entryCandidates: [],
      discoveryOnly: [],
    }),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
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

function createMockBus(): EventBus {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    drain: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockPositionRepo(): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
  };
}

function createMockOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

function buildModule(
  opts: {
    discoveryGateway?: MarketDiscoveryGateway;
    marketRepo?: MarketRepository;
    bus?: EventBus;
    positionRepo?: PositionRepository;
    orderRepo?: OrderRepository;
    selectionRuleEngine?: RefreshableSelectionRuleEngine;
  } = {},
): {
  mod: MarketScannerModule;
  discoveryGateway: ReturnType<typeof createMockDiscoveryGateway>;
  marketRepo: ReturnType<typeof createMockMarketRepo>;
  bus: ReturnType<typeof createMockBus>;
  positionRepo: ReturnType<typeof createMockPositionRepo>;
  orderRepo: ReturnType<typeof createMockOrderRepo>;
} {
  const discoveryGateway = opts.discoveryGateway ?? createMockDiscoveryGateway();
  const marketRepo = opts.marketRepo ?? createMockMarketRepo();
  const bus = opts.bus ?? createMockBus();
  const positionRepo = opts.positionRepo ?? createMockPositionRepo();
  const orderRepo = opts.orderRepo ?? createMockOrderRepo();
  const selectionRuleEngine = opts.selectionRuleEngine ?? SEEDED_ENGINE;

  const mod = new MarketScannerModule({
    discoveryGateway,
    marketRepo,
    bus,
    log: silentLog,
    scanIntervalMs: 300_000,
    selectionRuleEngine,
    positionRepo,
    orderRepo,
  });
  return { mod, discoveryGateway, marketRepo, bus, positionRepo, orderRepo };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("MarketScannerModule", () => {
  // ── Engine integration ────────────────────────────────────────────────────

  it("persists market with matched_include when prefix rule matches", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    const btcMarket = makeClobMarket({
      slug: "bitcoin-above-100k",
      eventSlug: "bitcoin-above-100k",
      tokens: [{ tokenId: "tok-btc-yes", outcome: "Yes" }],
      eventMarketCount: 1,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([btcMarket]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.tokenId).toBe("tok-btc-yes");
    expect(saved.selectionStatus).toBe("matched_include");
    expect(saved.selectionWinningRuleId).toBe("r-btc");
    expect(saved.tradable).toBe(true);
  });

  it("persists market with fallback_exclude when no rule matches and multi-market event", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    const unrelated = makeClobMarket({
      slug: "will-it-rain-tomorrow",
      eventSlug: "will-it-rain-tomorrow",
      tokens: [{ tokenId: "tok-rain-yes", outcome: "Yes" }],
      eventMarketCount: 5,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([unrelated]);

    await mod.scan();

    // Scanner now persists FULL universe — no skip
    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.selectionStatus).toBe("fallback_exclude");
    expect(saved.tradable).toBe(false);
  });

  it("persists market with step2_fallback_include for single-market event with no rule", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule({
      selectionRuleEngine: EMPTY_ENGINE,
    });
    const singleMarket = makeClobMarket({
      slug: "us-election-winner",
      eventSlug: "us-election-winner",
      tokens: [{ tokenId: "tok-election", outcome: "Yes" }],
      eventMarketCount: 1,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      singleMarket,
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.selectionStatus).toBe("step2_fallback_include");
    expect(saved.tradable).toBe(true);
  });

  it("persists market with matched_exclude when exclude_slug rule matches", async () => {
    const excludeEngine = makeEngine([
      makeRule({ ruleId: "r-btc", ruleType: "include_prefix", pattern: "bitcoin-" }),
      makeRule({ ruleId: "r-spam", ruleType: "exclude_slug", pattern: "bitcoin-spam" }),
    ]);
    const { mod, discoveryGateway, marketRepo } = buildModule({
      selectionRuleEngine: excludeEngine,
    });
    const spamMarket = makeClobMarket({
      slug: "bitcoin-spam",
      eventSlug: "bitcoin-spam",
      tokens: [{ tokenId: "tok-spam", outcome: "Yes" }],
      eventMarketCount: 1,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([spamMarket]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.selectionStatus).toBe("matched_exclude");
    expect(saved.tradable).toBe(false);
  });

  it("populates eventMarketCount on saved market", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    const btcMarket = makeClobMarket({
      slug: "bitcoin-above-100k",
      tokens: [{ tokenId: "tok-yes", outcome: "Yes" }],
      eventMarketCount: 7,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([btcMarket]);

    await mod.scan();

    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.eventMarketCount).toBe(7);
  });

  it("calls refreshIfStale on engine at start of each scan", async () => {
    const refreshSpy = vi.fn();
    const spyEngine = {
      ...SEEDED_ENGINE,
      refreshIfStale: refreshSpy,
      get current() {
        return SEEDED_ENGINE.current;
      },
    } as unknown as RefreshableSelectionRuleEngine;
    const { mod, discoveryGateway } = buildModule({ selectionRuleEngine: spyEngine });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await mod.scan();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("persists elon-musk- market with matched_include", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    const elonMarket = makeClobMarket({
      slug: "elon-musk-tweet-count",
      eventSlug: "elon-musk-tweet-count",
      tokens: [{ tokenId: "tok-elon", outcome: "Yes" }],
      eventMarketCount: 1,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([elonMarket]);

    await mod.scan();

    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.selectionStatus).toBe("matched_include");
    expect(saved.tradable).toBe(true);
  });

  it("scan() sets tradable=false on CLOB-inactive market even when rule includes", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    const inactiveMarket = makeClobMarket({
      slug: "bitcoin-above-100k",
      eventSlug: "bitcoin-above-100k",
      active: false,
      tokens: [{ tokenId: "tok-inactive", outcome: "Yes" }],
      eventMarketCount: 1,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      inactiveMarket,
    ]);

    await mod.scan();

    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    // CLOB inactive → tradable=false regardless of selection result
    expect(saved.tradable).toBe(false);
    // But selectionStatus still set
    expect(saved.selectionStatus).toBe("matched_include");
  });

  // ── Outcome mapping ───────────────────────────────────────────────────────

  it("scan() saves with correct outcome mapping", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    const market = makeClobMarket({
      slug: "bitcoin-above-100k",
      eventSlug: "bitcoin-above-100k",
      tokens: [
        { tokenId: "tok-yes", outcome: "Yes" },
        { tokenId: "tok-no", outcome: "No" },
      ],
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([market]);

    await mod.scan();

    const calls = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0]![0] as Market).outcome).toBe("Yes");
    expect((calls[1]![0] as Market).outcome).toBe("No");
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it("scan() does not crash on discovery failure", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gamma API unreachable"),
    );

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("scanOrThrow() propagates discovery failures for blocking startup use", async () => {
    const { mod, discoveryGateway } = buildModule();
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gamma API unreachable"),
    );

    await expect(mod.scanOrThrow()).rejects.toThrow("Gamma API unreachable");
  });

  // ── Health check ──────────────────────────────────────────────────────────

  it("healthCheck() returns not-ok before first scan", async () => {
    const { mod } = buildModule();
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("no successful scan");
  });

  it("healthCheck() returns ok after successful scan", async () => {
    const { mod, discoveryGateway } = buildModule();
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await mod.scan();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain("fresh");
  });

  // ── Re-entrancy ───────────────────────────────────────────────────────────

  it("concurrent scans are guarded by re-entrancy flag", async () => {
    let resolveDiscovery!: () => void;
    const blockingPromise = new Promise<ClobMarket[]>((resolve) => {
      resolveDiscovery = () => resolve([]);
    });

    const discoveryGateway = createMockDiscoveryGateway();
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(blockingPromise)
      .mockResolvedValueOnce([]);
    const { mod } = buildModule({ discoveryGateway });

    const scan1 = mod.scan();
    const scan2 = mod.scan(); // should be skipped due to guard

    resolveDiscovery();
    await Promise.all([scan1, scan2]);

    expect(discoveryGateway.discoverMarkets).toHaveBeenCalledTimes(1);
  });

  // ── Multi-page discovery ──────────────────────────────────────────────────

  it("scan() handles multi-page discovery correctly", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const { mod, marketRepo } = buildModule({ discoveryGateway });

    const page1Market = makeClobMarket({
      slug: "bitcoin-above-100k",
      conditionId: "cond-page1",
      tokens: [{ tokenId: "tok-p1", outcome: "Yes" }],
      eventMarketCount: 1,
    });
    const page2Market = makeClobMarket({
      slug: "bitcoin-above-110k",
      conditionId: "cond-page2",
      tokens: [{ tokenId: "tok-p2", outcome: "Yes" }],
      eventMarketCount: 1,
    });

    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (markets: ClobMarket[]) => void) => {
        cb([page1Market]);
        cb([page2Market]);
        return { totalMarkets: 2 };
      },
    );

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(2);
    const slugs = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as Market).slug,
    );
    expect(slugs).toContain("bitcoin-above-100k");
    expect(slugs).toContain("bitcoin-above-110k");
  });

  // ── Batched writes (saveBatch contract) ───────────────────────────────────
  // These tests pin the scanner's write pattern so regressions like
  // "reverted to per-token save()" or "flushes once per scan instead of once
  // per page" fail fast instead of silently slipping past the trampoline mock.

  it("scan() calls saveBatch exactly once per non-empty page with full batch", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const { mod, marketRepo } = buildModule({ discoveryGateway });

    const page1 = [
      makeClobMarket({
        slug: "bitcoin-above-100k",
        conditionId: "c-p1-a",
        tokens: [
          { tokenId: "tok-p1a-yes", outcome: "Yes" },
          { tokenId: "tok-p1a-no", outcome: "No" },
        ],
        eventMarketCount: 1,
      }),
      makeClobMarket({
        slug: "bitcoin-above-200k",
        conditionId: "c-p1-b",
        tokens: [{ tokenId: "tok-p1b", outcome: "Yes" }],
        eventMarketCount: 1,
      }),
    ];
    const page2 = [
      makeClobMarket({
        slug: "ethereum-above-5k",
        conditionId: "c-p2",
        tokens: [{ tokenId: "tok-p2", outcome: "Yes" }],
        eventMarketCount: 1,
      }),
    ];

    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (markets: ClobMarket[]) => void) => {
        cb(page1);
        cb(page2);
        return { totalMarkets: 3 };
      },
    );

    await mod.scan();

    const saveBatchMock = marketRepo.saveBatch as ReturnType<typeof vi.fn>;
    expect(saveBatchMock).toHaveBeenCalledTimes(2);

    const firstBatch = saveBatchMock.mock.calls[0]![0] as readonly Market[];
    const secondBatch = saveBatchMock.mock.calls[1]![0] as readonly Market[];

    // Page 1 produced 3 token rows (2 markets, one with YES+NO).
    expect(firstBatch.map((m) => m.tokenId).sort()).toEqual(
      ["tok-p1a-no", "tok-p1a-yes", "tok-p1b"].sort(),
    );
    // Page 2 produced 1 token row.
    expect(secondBatch.map((m) => m.tokenId)).toEqual(["tok-p2"]);
  });

  it("scan() skips saveBatch entirely for an empty page", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const { mod, marketRepo } = buildModule({ discoveryGateway });

    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (markets: ClobMarket[]) => void) => {
        cb([]);
        return { totalMarkets: 0 };
      },
    );

    await mod.scan();

    expect(marketRepo.saveBatch).not.toHaveBeenCalled();
    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("scan() uses saveBatch, not per-token save(), for the write path", async () => {
    // Bypass the trampoline mock used elsewhere so we can prove the module
    // never calls repo.save() directly — if a future refactor reverts the
    // batched write path, this test fails regardless of the mock shape.
    const discoveryGateway = createMockDiscoveryGateway();
    const marketRepo: MarketRepository = {
      save: vi.fn(),
      saveBatch: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByTokenIds: vi.fn().mockReturnValue([]),
      findByConditionId: vi.fn().mockReturnValue([]),
      findActive: vi.fn().mockReturnValue([]),
      iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
      findAll: vi.fn().mockReturnValue([]),
      deactivate: vi.fn(),
      deactivateMissing: vi.fn().mockReturnValue(0),
      findTrackedForPricing: vi.fn().mockReturnValue([]),
      findTrackedForPricingTiered: vi.fn().mockReturnValue({
        executionCritical: [],
        entryCandidates: [],
        discoveryOnly: [],
      }),
      findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    };
    const { mod } = buildModule({ discoveryGateway, marketRepo });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeClobMarket({
        slug: "bitcoin-above-100k",
        tokens: [{ tokenId: "tok-x", outcome: "Yes" }],
        eventMarketCount: 1,
      }),
    ]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
    expect(marketRepo.saveBatch).toHaveBeenCalledTimes(1);
    const batch = (marketRepo.saveBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as readonly Market[];
    expect(batch.map((m) => m.tokenId)).toEqual(["tok-x"]);
  });

  // ── Deactivation sweep ────────────────────────────────────────────────────

  it("scan() deactivates previously-active markets not in latest discovery", async () => {
    const freshMarket = makeClobMarket({
      conditionId: "cond-new",
      slug: "bitcoin-above-100k",
      tokens: [{ tokenId: "tok-new-yes", outcome: "Yes" }],
      eventMarketCount: 1,
    });

    const { mod, discoveryGateway, marketRepo } = buildModule();
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([freshMarket]);
    // New cursor-based path: scanner calls deactivateMissing directly; we just
    // assert it was invoked with the right (discovered, preserved) sets.
    (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mockReturnValue(1);

    await mod.scan();

    const saveCalls = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls;
    expect((saveCalls[0]![0] as Market).tokenId).toBe("tok-new-yes");
    expect((saveCalls[0]![0] as Market).active).toBe(true);

    expect(marketRepo.deactivateMissing).toHaveBeenCalledTimes(1);
    const [discovered, preserved] = (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect((discovered as Set<string>).has("tok-new-yes")).toBe(true);
    expect((preserved as Set<string>).size).toBe(0);
  });

  it("deactivation sweep preserves market with open position", async () => {
    const positionRepo = createMockPositionRepo();
    (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { tokenId: createTokenId("tok-old"), status: "open" },
    ]);

    const { mod, discoveryGateway, marketRepo } = buildModule({ positionRepo });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mockReturnValue(0);

    await mod.scan();

    const [, preserved] = (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((preserved as Set<string>).has("tok-old")).toBe(true);
  });

  it("deactivation sweep preserves market with open order", async () => {
    const orderRepo = createMockOrderRepo();
    (orderRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { tokenId: createTokenId("tok-pending"), status: "open" },
    ]);

    const { mod, discoveryGateway, marketRepo } = buildModule({ orderRepo });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mockReturnValue(0);

    await mod.scan();

    const [, preserved] = (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((preserved as Set<string>).has("tok-pending")).toBe(true);
  });

  it("deactivation sweep deactivates stale market with no open positions or orders", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mockReturnValue(1);

    await mod.scan();

    expect(marketRepo.deactivateMissing).toHaveBeenCalledTimes(1);
    const [discovered, preserved] = (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect((discovered as Set<string>).size).toBe(0);
    expect((preserved as Set<string>).size).toBe(0);
  });

  it("open-leg market returned as inactive by Gamma is saved as active", async () => {
    const positionRepo = createMockPositionRepo();
    (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { tokenId: createTokenId("tok-leg"), status: "open" },
    ]);

    const { mod, discoveryGateway, marketRepo } = buildModule({ positionRepo });
    const inactiveFromGamma = makeClobMarket({
      slug: "bitcoin-above-50k",
      eventSlug: "bitcoin-above-50k",
      active: false,
      tokens: [{ tokenId: "tok-leg", outcome: "Yes" }],
      eventMarketCount: 1,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      inactiveFromGamma,
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.tokenId).toBe("tok-leg");
    expect(saved.active).toBe(true);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  it("start/stop lifecycle manages timer", async () => {
    const { mod, discoveryGateway } = buildModule();
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await mod.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(discoveryGateway.discoverMarkets).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("consumes new-market WS hints with debounce and updates hint metrics", async () => {
    vi.useFakeTimers();
    try {
      const realBus = new InProcessEventBus();
      const discoveryGateway = createMockDiscoveryGateway();
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const mod = new MarketScannerModule({
        discoveryGateway,
        marketRepo: createMockMarketRepo(),
        bus: realBus,
        log: silentLog,
        scanIntervalMs: 300_000,
        selectionRuleEngine: SEEDED_ENGINE,
      });
      const scanSpy = vi.spyOn(mod, "scan").mockResolvedValue(undefined);

      await mod.start();
      scanSpy.mockClear();

      await realBus.publish("NewMarketDiscoveredHint", {
        conditionId: "cond-1",
        marketId: "market-1",
        slug: "new-market-1",
        question: "Will X happen?",
        active: true,
        tokenIds: [createTokenId("tok-1")],
        timestamp: Date.now(),
      });
      await realBus.publish("NewMarketDiscoveredHint", {
        conditionId: "cond-2",
        marketId: "market-2",
        slug: "new-market-2",
        question: "Will Y happen?",
        active: true,
        tokenIds: [createTokenId("tok-2")],
        timestamp: Date.now(),
      });
      await realBus.drain();

      await vi.advanceTimersByTimeAsync(249);
      expect(scanSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(scanSpy).toHaveBeenCalledTimes(1);
      expect(mod.getHintMetricsSnapshot()).toEqual({
        discoveryWsHintsConsumed: 2,
      });

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
