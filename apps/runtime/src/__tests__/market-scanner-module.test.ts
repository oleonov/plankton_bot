import { describe, it, expect, vi } from "vitest";
import { SelectionRuleEngine, createTokenId } from "@krabs/domain";
import type {
  SelectionRule,
  MarketDiscoveryGateway,
  ClobMarket,
  MarketRepository,
  Market,
  EventBus,
  PositionRepository,
  OrderRepository,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
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

/** Engine with no rules; v5.11 hard filters now own admission. */
const EMPTY_ENGINE = makeEngine([]);

function nearEndDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function makeClobMarket(overrides?: Partial<ClobMarket>): ClobMarket {
  const tokens = (
    overrides?.tokens ?? [
      { tokenId: "tok-yes", outcome: "Yes", outcomeIndex: 0 },
      { tokenId: "tok-no", outcome: "No", outcomeIndex: 1 },
    ]
  ).map((token) => ({
    bestBid: 0.31,
    bestAsk: 0.33,
    midPrice: 0.32,
    ...token,
  }));

  return {
    conditionId: "cond-1",
    question: "Will BTC hit 100k?",
    slug: "bitcoin-above-100k",
    eventSlug: "bitcoin-above-100k",
    endDate: nearEndDate(),
    active: true,
    negRisk: false,
    tickSize: 0.01,
    volume24h: null,
    liquidity: 250,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    ...overrides,
    tokens,
  };
}

/**
 * Derive the per-page event stats the scanner expects from a flattened list
 * of markets. Groups by `eventSlug` (falls back to `slug` for tests that
 * don't set it) and tallies single- vs multi-market events using each
 * group's `eventMarketCount`. Mirrors the gateway's per-page accounting.
 */
function eventStatsFromMarkets(markets: readonly ClobMarket[]): {
  events: number;
  singleMarket: number;
  multiMarket: number;
} {
  const groups = new Map<string, ClobMarket[]>();
  for (const m of markets) {
    const key = m.eventSlug ?? m.slug;
    const bucket = groups.get(key);
    if (bucket) bucket.push(m);
    else groups.set(key, [m]);
  }
  let singleMarket = 0;
  let multiMarket = 0;
  for (const bucket of groups.values()) {
    if (bucket[0]!.eventMarketCount === 1) singleMarket++;
    else multiMarket++;
  }
  return { events: groups.size, singleMarket, multiMarket };
}

type ForEachMarketPageCallback = (
  markets: ClobMarket[],
  eventStats: { events: number; singleMarket: number; multiMarket: number },
) => void;

function createMockDiscoveryGateway(): MarketDiscoveryGateway {
  const discoverMarkets = vi.fn<() => Promise<ClobMarket[]>>().mockResolvedValue([]);
  return {
    discoverMarkets,
    forEachMarketPage: vi.fn(async (cb: ForEachMarketPageCallback) => {
      const markets = await discoverMarkets();
      if (markets.length > 0) cb(markets, eventStatsFromMarkets(markets));
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
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
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
    updateScoresBatch: vi.fn(),
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

  it("persists market with matched_include when v5.11 hard filters pass", async () => {
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
    expect(saved.selectionWinningRuleId).toBeNull();
    expect(saved.tradable).toBe(true);
  });

  it("does not persist non-critical fallback_exclude rows when v5.11 hard filters fail", async () => {
    const { mod, discoveryGateway, marketRepo } = buildModule();
    const unrelated = makeClobMarket({
      slug: "will-it-rain-tomorrow",
      eventSlug: "will-it-rain-tomorrow",
      tokens: [{ tokenId: "tok-rain-yes", outcome: "Yes" }],
      liquidity: 50,
      eventMarketCount: 5,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([unrelated]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
    const [discovered] = (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((discovered as Set<string>).has("tok-rain-yes")).toBe(false);
  });

  it("persists fallback_exclude rows when the token has an open position", async () => {
    const positionRepo = createMockPositionRepo();
    (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { tokenId: createTokenId("tok-rain-yes"), status: "open" },
    ]);
    const { mod, discoveryGateway, marketRepo } = buildModule({ positionRepo });
    const unrelated = makeClobMarket({
      slug: "will-it-rain-tomorrow",
      eventSlug: "will-it-rain-tomorrow",
      tokens: [{ tokenId: "tok-rain-yes", outcome: "Yes" }],
      liquidity: 50,
      eventMarketCount: 5,
    });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([unrelated]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.selectionStatus).toBe("fallback_exclude");
    expect(saved.tradable).toBe(false);
    const [discovered, preserved] = (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect((discovered as Set<string>).has("tok-rain-yes")).toBe(true);
    expect((preserved as Set<string>).has("tok-rain-yes")).toBe(true);
  });

  it("persists single-market event with matched_include when hard filters pass", async () => {
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
    expect(saved.selectionStatus).toBe("matched_include");
    expect(saved.selectionWinningRuleId).toBeNull();
    expect(saved.tradable).toBe(true);
  });

  it("does not persist non-critical matched_exclude rows when exclude_slug rule matches", async () => {
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

    expect(marketRepo.save).not.toHaveBeenCalled();
    const [discovered] = (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((discovered as Set<string>).has("tok-spam")).toBe(false);
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

  it("scanOrThrow() propagates non-transient discovery failures for blocking startup use", async () => {
    const { mod, discoveryGateway } = buildModule();
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gamma API unreachable"),
    );

    await expect(mod.scanOrThrow()).rejects.toThrow("Gamma API unreachable");
  });

  it("scanOrThrow() starts from cached catalog on transient startup timeout", async () => {
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    const marketRepo = createMockMarketRepo();
    (marketRepo.iterateAllTokenIds as ReturnType<typeof vi.fn>).mockImplementation(() =>
      [createTokenId("tok-cached")][Symbol.iterator](),
    );
    const positionRepo = createMockPositionRepo();
    (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { tokenId: createTokenId("tok-cached"), status: "open" },
    ]);
    const { mod, discoveryGateway } = buildModule({ marketRepo, positionRepo });
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("TimeoutError: operation was aborted due to timeout"),
    );

    const result = await mod.scanOrThrow();
    const health = await mod.healthCheck();

    expect(result).toMatchObject({
      discoveredMarkets: 0,
      savedTokens: 0,
      preservedTokens: 1,
    });
    expect(health.ok).toBe(true);
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cachedTokens: 1 }),
      "startup scan degraded — using existing catalog until next scanner cycle",
    );
    expect(silentLog.error).not.toHaveBeenCalledWith(expect.anything(), "scan cycle failed");
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
      async (cb: ForEachMarketPageCallback) => {
        cb([page1Market], eventStatsFromMarkets([page1Market]));
        cb([page2Market], eventStatsFromMarkets([page2Market]));
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
      async (cb: ForEachMarketPageCallback) => {
        cb(page1, eventStatsFromMarkets(page1));
        cb(page2, eventStatsFromMarkets(page2));
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
      async (cb: ForEachMarketPageCallback) => {
        cb([], eventStatsFromMarkets([]));
        return { totalMarkets: 0 };
      },
    );

    await mod.scan();

    expect(marketRepo.saveBatch).not.toHaveBeenCalled();
    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  // Step 0 §P1.9: scanner must forward ClobMarket.gammaCreatedAt into every
  // token-level Market row written to the repo. Spec §1.7 R14 (`age_at_entry`)
  // depends on this field being captured at discovery time.
  it("scan() propagates gammaCreatedAt from ClobMarket to every token batch row", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const { mod, marketRepo } = buildModule({ discoveryGateway });

    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: ForEachMarketPageCallback) => {
        const page = [
          makeClobMarket({
            slug: "bitcoin-above-100k",
            conditionId: "cond-gamma",
            tokens: [
              { tokenId: "tok-gam-yes", outcome: "Yes" },
              { tokenId: "tok-gam-no", outcome: "No" },
            ],
            eventMarketCount: 1,
            gammaCreatedAt: "2026-04-15T08:30:00.000Z",
          }),
        ];
        cb(page, eventStatsFromMarkets(page));
        return { totalMarkets: 1 };
      },
    );

    await mod.scan();

    const batch = (marketRepo.saveBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as readonly Market[];
    expect(batch).toHaveLength(2);
    expect(batch.every((m) => m.gammaCreatedAt === "2026-04-15T08:30:00.000Z")).toBe(true);
  });

  it("scan() forwards gammaCreatedAt=null verbatim when the gateway has no value", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const { mod, marketRepo } = buildModule({ discoveryGateway });

    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: ForEachMarketPageCallback) => {
        const page = [
          makeClobMarket({
            slug: "bitcoin-above-200k",
            conditionId: "cond-no-gamma",
            tokens: [{ tokenId: "tok-no-gamma", outcome: "Yes" }],
            eventMarketCount: 1,
            gammaCreatedAt: null,
          }),
        ];
        cb(page, eventStatsFromMarkets(page));
        return { totalMarkets: 1 };
      },
    );

    await mod.scan();

    const batch = (marketRepo.saveBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as readonly Market[];
    expect(batch).toHaveLength(1);
    expect(batch[0]!.gammaCreatedAt).toBeNull();
  });

  // ── Discovery latency telemetry (Step 0 §P2) ─────────────────────────────

  it("scanOrThrow() reports discoveryLatencyMs ≈ 600_000 for a 10-minute-old first-sighted market", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const { mod } = buildModule({ discoveryGateway });

    const tenMinutesAgo = new Date(Date.now() - 600_000).toISOString();
    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: ForEachMarketPageCallback) => {
        const page = [
          makeClobMarket({
            slug: "bitcoin-above-100k",
            conditionId: "cond-fresh",
            tokens: [{ tokenId: "tok-fresh", outcome: "Yes" }],
            eventMarketCount: 1,
            gammaCreatedAt: tenMinutesAgo,
          }),
        ];
        cb(page, eventStatsFromMarkets(page));
        return { totalMarkets: 1 };
      },
    );

    const result = await mod.scanOrThrow();

    expect(result.firstSeenTokens).toBe(1);
    // Allow a small window for the actual scan duration to slip past 600s.
    expect(result.discoveryLatencyP50Ms).not.toBeNull();
    expect(result.discoveryLatencyP50Ms!).toBeGreaterThanOrEqual(600_000);
    expect(result.discoveryLatencyP50Ms!).toBeLessThan(605_000);
    expect(result.discoveryLatencyMaxMs).toBe(result.discoveryLatencyP50Ms);
  });

  it("scanOrThrow() reports null aggregates when no first-sighted token has gammaCreatedAt", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const { mod } = buildModule({ discoveryGateway });

    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: ForEachMarketPageCallback) => {
        const page = [
          makeClobMarket({
            slug: "bitcoin-above-100k",
            conditionId: "cond-null-gamma",
            tokens: [{ tokenId: "tok-null-gamma", outcome: "Yes" }],
            eventMarketCount: 1,
            gammaCreatedAt: null,
          }),
        ];
        cb(page, eventStatsFromMarkets(page));
        return { totalMarkets: 1 };
      },
    );

    const result = await mod.scanOrThrow();

    expect(result.firstSeenTokens).toBe(1);
    expect(result.discoveryLatencyP50Ms).toBeNull();
    expect(result.discoveryLatencyP90Ms).toBeNull();
    expect(result.discoveryLatencyMaxMs).toBeNull();
  });

  it("scanOrThrow() does NOT count re-discovery of an already-known token as first-seen", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const knownToken = createTokenId("tok-known");
    const marketRepo = createMockMarketRepo();
    (marketRepo.iterateAllTokenIds as ReturnType<typeof vi.fn>).mockReturnValue(
      [knownToken][Symbol.iterator](),
    );
    const { mod } = buildModule({ discoveryGateway, marketRepo });

    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: ForEachMarketPageCallback) => {
        const page = [
          makeClobMarket({
            slug: "bitcoin-above-100k",
            conditionId: "cond-known",
            tokens: [{ tokenId: "tok-known", outcome: "Yes" }],
            eventMarketCount: 1,
            gammaCreatedAt: new Date(Date.now() - 600_000).toISOString(),
          }),
        ];
        cb(page, eventStatsFromMarkets(page));
        return { totalMarkets: 1 };
      },
    );

    const result = await mod.scanOrThrow();

    expect(result.firstSeenTokens).toBe(0);
    expect(result.discoveryLatencyP50Ms).toBeNull();
  });

  it("scanOrThrow() computes p50/p90/max correctly for multiple first-sighted samples", async () => {
    const discoveryGateway = createMockDiscoveryGateway();
    const { mod } = buildModule({ discoveryGateway });

    const now = Date.now();
    const ages = [60_000, 120_000, 180_000, 240_000, 600_000];
    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: ForEachMarketPageCallback) => {
        const page = ages.map((ageMs, i) =>
          makeClobMarket({
            slug: `bitcoin-above-${i}`,
            conditionId: `cond-${i}`,
            tokens: [{ tokenId: `tok-${i}`, outcome: "Yes" }],
            eventMarketCount: 1,
            gammaCreatedAt: new Date(now - ageMs).toISOString(),
          }),
        );
        cb(page, eventStatsFromMarkets(page));
        return { totalMarkets: ages.length };
      },
    );

    const result = await mod.scanOrThrow();

    expect(result.firstSeenTokens).toBe(5);
    // p50 with nearest-rank on 5 sorted samples [60k,120k,180k,240k,600k]: idx ceil(0.5*5)-1 = 2 → 180k
    expect(result.discoveryLatencyP50Ms!).toBeGreaterThanOrEqual(180_000);
    expect(result.discoveryLatencyP50Ms!).toBeLessThan(185_000);
    // p90: idx ceil(0.9*5)-1 = 4 → 600k
    expect(result.discoveryLatencyP90Ms!).toBeGreaterThanOrEqual(600_000);
    expect(result.discoveryLatencyP90Ms!).toBeLessThan(605_000);
    expect(result.discoveryLatencyMaxMs).toBe(result.discoveryLatencyP90Ms);
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
      iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
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
      updateScoresBatch: vi.fn(),
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

  it("throttles repeated transient scan-degraded warnings", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-08T00:00:00.000Z") });
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    try {
      const { mod, discoveryGateway } = buildModule();
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce([])
        .mockRejectedValue(new Error("TimeoutError: operation was aborted due to timeout"));

      await mod.scan();
      await mod.scan();
      await mod.scan();

      expect(silentLog.warn).toHaveBeenCalledTimes(1);
      expect(silentLog.warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ suppressedCount: 0 }),
        "scan cycle degraded — keeping existing catalog",
      );

      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await mod.scan();

      expect(silentLog.warn).toHaveBeenCalledTimes(2);
      expect(silentLog.warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ suppressedCount: 1 }),
        "scan cycle degraded — keeping existing catalog",
      );
      expect(silentLog.error).not.toHaveBeenCalledWith(expect.anything(), "scan cycle failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips duplicate initial scan on start when a fresh startup scan already ran", async () => {
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
    (mod as unknown as { lastSuccessfulScanMs: number }).lastSuccessfulScanMs = Date.now();

    await mod.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(scanSpy).not.toHaveBeenCalled();

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

  it("suppresses hint-triggered full scans while a successful scan is still fresh", async () => {
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
      (mod as unknown as { lastSuccessfulScanMs: number }).lastSuccessfulScanMs = Date.now();

      await realBus.publish("NewMarketDiscoveredHint", {
        conditionId: "cond-3",
        marketId: "market-3",
        slug: "new-market-3",
        question: "Will Z happen?",
        active: true,
        tokenIds: [createTokenId("tok-3")],
        timestamp: Date.now(),
      });
      await realBus.drain();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(scanSpy).not.toHaveBeenCalled();

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Step 2 funnel breakdown (P2 acceptance) ──────────────────────────────
  // ADR-019 §D4: 8 cumulative counters surface the live STEP-1 / STEP-2 /
  // FINAL split alongside per-event single/multi totals so ADR-003 baseline
  // drift (eventsSingleMarketTotal / scannedEventsTotal ≈ 39.17 %) is
  // observable without re-grouping flattened markets.

  describe("Step 2 funnel breakdown", () => {
    it("counts a hard-filter INCLUDE", async () => {
      const { mod, discoveryGateway } = buildModule();
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-above-100k",
          eventSlug: "bitcoin-above-100k",
          tokens: [{ tokenId: "tok-1", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap.scannedMarketsTotal).toBe(1);
      expect(snap.marketsStep1MatchedInclude).toBe(1);
      expect(snap.marketsStep1MatchedExclude).toBe(0);
      expect(snap.marketsStep2FallbackInclude).toBe(0);
      expect(snap.marketsFinalExclude).toBe(0);
    });

    it("counts a STEP 1 EXCLUDE (slug-rule explicit exclude)", async () => {
      const excludeEngine = makeEngine([
        makeRule({ ruleId: "r-btc", ruleType: "include_prefix", pattern: "bitcoin-" }),
        makeRule({ ruleId: "r-spam", ruleType: "exclude_slug", pattern: "bitcoin-spam" }),
      ]);
      const { mod, discoveryGateway } = buildModule({ selectionRuleEngine: excludeEngine });
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-spam",
          eventSlug: "bitcoin-spam",
          tokens: [{ tokenId: "tok-spam", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap.marketsStep1MatchedInclude).toBe(0);
      expect(snap.marketsStep1MatchedExclude).toBe(1);
    });

    it("does not count STEP 2 fallback for single-market hard-filter INCLUDE", async () => {
      const { mod, discoveryGateway } = buildModule({ selectionRuleEngine: EMPTY_ENGINE });
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "us-election-winner",
          eventSlug: "us-election-winner",
          tokens: [{ tokenId: "tok-elect", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap.marketsStep1MatchedInclude).toBe(1);
      expect(snap.marketsStep2FallbackInclude).toBe(0);
      expect(snap.marketsFinalExclude).toBe(0);
    });

    it("counts a FINAL EXCLUDE when hard filters fail", async () => {
      const { mod, discoveryGateway } = buildModule({ selectionRuleEngine: EMPTY_ENGINE });
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "best-pic-2026-oppenheimer",
          eventSlug: "best-picture-2026",
          tokens: [{ tokenId: "tok-multi", outcome: "Yes" }],
          liquidity: 50,
          eventMarketCount: 8,
        }),
      ]);

      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap.marketsStep2FallbackInclude).toBe(0);
      expect(snap.marketsFinalExclude).toBe(1);
    });

    it("counts per-event single-market totals from gateway eventStats", async () => {
      // Two single-market events on one page — singleMarket=2, multiMarket=0.
      const discoveryGateway = createMockDiscoveryGateway();
      const { mod } = buildModule({ discoveryGateway });
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-above-100k",
          eventSlug: "bitcoin-above-100k",
          conditionId: "cond-evt-a",
          tokens: [{ tokenId: "tok-evt-a", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
        makeClobMarket({
          slug: "ethereum-above-5k",
          eventSlug: "ethereum-above-5k",
          conditionId: "cond-evt-b",
          tokens: [{ tokenId: "tok-evt-b", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap.scannedEventsTotal).toBe(2);
      expect(snap.eventsSingleMarketTotal).toBe(2);
      expect(snap.eventsMultiMarketTotal).toBe(0);
    });

    it("counts per-event multi-market totals from gateway eventStats", async () => {
      // One single-market event + one multi-market event of 5 markets.
      const discoveryGateway = createMockDiscoveryGateway();
      const { mod } = buildModule({ discoveryGateway });
      const multiMarkets = Array.from({ length: 5 }, (_, i) =>
        makeClobMarket({
          slug: `best-picture-${i}`,
          eventSlug: "best-picture-2026",
          conditionId: `cond-bp-${i}`,
          tokens: [{ tokenId: `tok-bp-${i}`, outcome: "Yes" }],
          eventMarketCount: 5,
        }),
      );
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-above-100k",
          eventSlug: "bitcoin-above-100k",
          conditionId: "cond-solo",
          tokens: [{ tokenId: "tok-solo", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
        ...multiMarkets,
      ]);

      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap.scannedEventsTotal).toBe(2);
      expect(snap.eventsSingleMarketTotal).toBe(1);
      expect(snap.eventsMultiMarketTotal).toBe(1);
      // Per-market invariant: 1 (solo) + 5 (multi) = 6 markets in the partition.
      expect(snap.scannedMarketsTotal).toBe(6);
      expect(
        snap.marketsStep1MatchedInclude +
          snap.marketsStep1MatchedExclude +
          snap.marketsStep2FallbackInclude +
          snap.marketsFinalExclude,
      ).toBe(6);
    });

    it("counters are cumulative across consecutive scans", async () => {
      const { mod, discoveryGateway } = buildModule();
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-above-100k",
          eventSlug: "bitcoin-above-100k",
          tokens: [{ tokenId: "tok-c", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      await mod.scan();
      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap.scannedMarketsTotal).toBe(2);
      expect(snap.scannedEventsTotal).toBe(2);
      expect(snap.eventsSingleMarketTotal).toBe(2);
      expect(snap.marketsStep1MatchedInclude).toBe(2);
    });

    it("getStep2BreakdownSnapshot() returns a defensive copy", async () => {
      const { mod } = buildModule();
      const a = mod.getStep2BreakdownSnapshot();
      a.scannedMarketsTotal = 999;
      const b = mod.getStep2BreakdownSnapshot();
      expect(b.scannedMarketsTotal).toBe(0);
    });

    it("does not leak partial counters when the scan fails mid-pagination", async () => {
      // ADR-019 §D4: counters represent successful scans only — Gamma
      // pagination is order-biased, so a half-finished scan would skew the
      // ADR-003 single-market ratio. A failure after page 1 must drop the
      // page-1 delta entirely.
      const discoveryGateway = createMockDiscoveryGateway();
      const { mod } = buildModule({ discoveryGateway });
      (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
        async (cb: ForEachMarketPageCallback) => {
          const page = [
            makeClobMarket({
              slug: "bitcoin-above-100k",
              eventSlug: "bitcoin-above-100k",
              tokens: [{ tokenId: "tok-leak-1", outcome: "Yes" }],
              eventMarketCount: 1,
            }),
          ];
          cb(page, eventStatsFromMarkets(page));
          throw new Error("page-2 fetch failed");
        },
      );

      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap).toEqual({
        scannedMarketsTotal: 0,
        marketsStep1MatchedInclude: 0,
        marketsStep1MatchedExclude: 0,
        marketsStep2FallbackInclude: 0,
        marketsFinalExclude: 0,
        scannedEventsTotal: 0,
        eventsSingleMarketTotal: 0,
        eventsMultiMarketTotal: 0,
      });
    });

    it("merges the pending delta only after a successful end-to-end scan", async () => {
      // Sequence: failed scan (drops page-1 delta) → successful scan (merges
      // its own delta). Cumulative counters must reflect only the successful
      // scan, not the failed one.
      const discoveryGateway = createMockDiscoveryGateway();
      const { mod } = buildModule({ discoveryGateway });

      const failingPage = [
        makeClobMarket({
          slug: "bitcoin-fail-page",
          eventSlug: "bitcoin-fail-page",
          tokens: [{ tokenId: "tok-fail", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ];
      const successPage = [
        makeClobMarket({
          slug: "bitcoin-success",
          eventSlug: "bitcoin-success",
          tokens: [{ tokenId: "tok-ok", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ];

      const fep = discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>;
      fep.mockImplementationOnce(async (cb: ForEachMarketPageCallback) => {
        cb(failingPage, eventStatsFromMarkets(failingPage));
        throw new Error("scan crashed");
      });
      fep.mockImplementationOnce(async (cb: ForEachMarketPageCallback) => {
        cb(successPage, eventStatsFromMarkets(successPage));
        return { totalMarkets: successPage.length };
      });

      await mod.scan();
      await mod.scan();

      const snap = mod.getStep2BreakdownSnapshot();
      expect(snap.scannedMarketsTotal).toBe(1);
      expect(snap.scannedEventsTotal).toBe(1);
      expect(snap.eventsSingleMarketTotal).toBe(1);
      expect(snap.marketsStep1MatchedInclude).toBe(1);
    });

    it("healthCheck() exposes step2Breakdown substring once a market has been scanned", async () => {
      const { mod, discoveryGateway } = buildModule();
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-above-100k",
          eventSlug: "bitcoin-above-100k",
          tokens: [{ tokenId: "tok-hc", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      await mod.scan();

      const h = await mod.healthCheck();
      expect(h.detail).toContain("step2Breakdown");
      expect(h.detail).toContain("step1Include=1");
      expect(h.detail).toContain("singleMarket=1");
    });

    it("healthCheck() omits step2Breakdown substring before any market has been scanned", async () => {
      const { mod, discoveryGateway } = buildModule();
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await mod.scan();

      const h = await mod.healthCheck();
      expect(h.detail).not.toContain("step2Breakdown");
    });
  });

  // ── ADR-021 §D-F watch-set telemetry ──────────────────────────────────────
  describe("watch-set telemetry (ADR-021 §D-F)", () => {
    it("scan() reports preservedDisappearedTokens=0 when every preserved token is rediscovered", async () => {
      const positionRepo = createMockPositionRepo();
      (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
        { tokenId: createTokenId("tok-leg"), status: "open" },
      ]);

      const { mod, discoveryGateway } = buildModule({ positionRepo });
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-above-100k",
          eventSlug: "bitcoin-above-100k",
          tokens: [{ tokenId: "tok-leg", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      const result = await mod.scanOrThrow();
      expect(result.preservedTokens).toBe(1);
      expect(result.preservedDisappearedTokens).toBe(0);
    });

    it("scan() reports preservedDisappearedTokens=N when preserved tokens are absent from Gamma", async () => {
      const positionRepo = createMockPositionRepo();
      (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
        { tokenId: createTokenId("tok-leg-a"), status: "open" },
        { tokenId: createTokenId("tok-leg-b"), status: "open" },
      ]);
      const orderRepo = createMockOrderRepo();
      (orderRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
        { tokenId: createTokenId("tok-leg-c"), status: "open" },
      ]);

      const { mod, discoveryGateway } = buildModule({ positionRepo, orderRepo });
      // Gamma scan returns nothing — all three preserved tokens are missing.
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await mod.scanOrThrow();
      expect(result.preservedTokens).toBe(3);
      expect(result.preservedDisappearedTokens).toBe(3);
    });

    it("scan() counts only the missing subset when some preserved tokens are rediscovered", async () => {
      const positionRepo = createMockPositionRepo();
      (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
        { tokenId: createTokenId("tok-found"), status: "open" },
        { tokenId: createTokenId("tok-missing"), status: "open" },
      ]);

      const { mod, discoveryGateway } = buildModule({ positionRepo });
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-above-100k",
          eventSlug: "bitcoin-above-100k",
          tokens: [{ tokenId: "tok-found", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      const result = await mod.scanOrThrow();
      expect(result.preservedTokens).toBe(2);
      expect(result.preservedDisappearedTokens).toBe(1);
    });

    it("healthCheck() includes a watchSet segment after a successful scan", async () => {
      const positionRepo = createMockPositionRepo();
      (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
        { tokenId: createTokenId("tok-leg"), status: "open" },
      ]);

      const { mod, discoveryGateway, marketRepo } = buildModule({ positionRepo });
      (marketRepo.deactivateMissing as ReturnType<typeof vi.fn>).mockReturnValue(2);
      (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeClobMarket({
          slug: "bitcoin-above-100k",
          eventSlug: "bitcoin-above-100k",
          tokens: [{ tokenId: "tok-fresh", outcome: "Yes" }],
          eventMarketCount: 1,
        }),
      ]);

      await mod.scan();

      const h = await mod.healthCheck();
      expect(h.detail).toContain("watchSet");
      expect(h.detail).toContain("preserved=1");
      expect(h.detail).toContain("deactivated=2");
      expect(h.detail).toContain("firstSeen=1");
      expect(h.detail).toContain("preservedDisappeared=1");
    });

    it("healthCheck() omits watchSet segment before any successful scan", async () => {
      const { mod } = buildModule();
      const h = await mod.healthCheck();
      expect(h.ok).toBe(false);
      expect(h.detail).not.toContain("watchSet");
    });
  });
});
