import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFamilyId, createTokenId } from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import type {
  MarketDiscoveryGateway,
  ClobMarket,
  FamilyRulesProvider,
  FamilyIdentity,
  MarketRepository,
  Market,
  EventBus,
  PositionRepository,
  OrderRepository,
} from "@plankton/domain";
import { MarketScannerModule } from "../modules/market-scanner/market-scanner-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

/** Returns an endDate 1 day from now (within daily horizon filter). */
function nearEndDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function farDeadlineEndDate(): string {
  return new Date(Date.now() + 18 * 24 * 60 * 60 * 1000).toISOString();
}

function nearDeadlineEndDate(): string {
  return new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
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
    ...overrides,
  };
}

function makeFamilyIdentity(overrides?: Partial<FamilyIdentity>): FamilyIdentity {
  return {
    familyId: createFamilyId("fam-btc"),
    familyKey: "btc-above",
    primaryCategory: "crypto",
    regime: "threshold",
    horizon: "daily",
    cadence: "recurring",
    strategyProfile: "scalp",
    topicKey: null,
    slugPattern: "bitcoin-above-*",
    notes: null,
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

function createMockFamilyRules(): FamilyRulesProvider {
  return {
    getRule: vi.fn().mockReturnValue(null),
    isEnabled: vi.fn().mockReturnValue(true),
    getAllFamilies: vi.fn<() => FamilyIdentity[]>().mockReturnValue([]),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  };
}

function createMockMarketRepo(): MarketRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findByFamily: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
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
    findByFamily: vi.fn().mockReturnValue([]),
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

// ─── Tests ────────────────────────────────────────────────────────────────

describe("MarketScannerModule", () => {
  let discoveryGateway: ReturnType<typeof createMockDiscoveryGateway>;
  let familyRules: ReturnType<typeof createMockFamilyRules>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let bus: ReturnType<typeof createMockBus>;
  let positionRepo: ReturnType<typeof createMockPositionRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let mod: MarketScannerModule;

  beforeEach(() => {
    discoveryGateway = createMockDiscoveryGateway();
    familyRules = createMockFamilyRules();
    marketRepo = createMockMarketRepo();
    bus = createMockBus();
    positionRepo = createMockPositionRepo();
    orderRepo = createMockOrderRepo();
    mod = new MarketScannerModule({
      discoveryGateway,
      familyRules,
      marketRepo,
      bus,
      log: silentLog,
      scanIntervalMs: 300_000,
      positionRepo,
      orderRepo,
    });
  });

  it("scan() discovers markets and saves matched ones to repo", async () => {
    const btcMarket = makeClobMarket({
      slug: "bitcoin-above-100k",
      eventSlug: "bitcoin-above-100k",
      tokens: [
        { tokenId: "tok-btc-yes", outcome: "Yes" },
        { tokenId: "tok-btc-no", outcome: "No" },
      ],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([btcMarket]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ slugPattern: "bitcoin-above-*" }),
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(2); // YES + NO tokens
    const savedMarket = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(savedMarket.tokenId).toBe("tok-btc-yes");
    expect(savedMarket.familyId).toBe("fam-btc");
    expect(savedMarket.slug).toBe("bitcoin-above-100k");
  });

  it("scan() skips markets not matching any family slug pattern", async () => {
    const unrelatedMarket = makeClobMarket({
      slug: "will-it-rain-tomorrow",
      eventSlug: "will-it-rain-tomorrow",
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      unrelatedMarket,
    ]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ slugPattern: "bitcoin-above-*" }),
    ]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("scan() skips long-dated threshold deadline markets", async () => {
    const market = makeClobMarket({
      slug: "will-tsla-reach-555-in-april",
      eventSlug: "will-tsla-reach-555-in-april",
      endDate: farDeadlineEndDate(),
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([market]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({
        familyId: createFamilyId("fam-tsla"),
        familyKey: "will-tsla-reach",
        horizon: "deadline",
        cadence: "deadline",
        slugPattern: "will-tsla-reach-*",
      }),
    ]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("scan() still accepts long-dated generic deadline markets", async () => {
    const market = makeClobMarket({
      slug: "will-crude-oil-cl-hit-by-end-of-march",
      eventSlug: "bitcoin-crude-oil-proxy",
      endDate: farDeadlineEndDate(),
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([market]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({
        familyId: createFamilyId("fam-crude"),
        familyKey: "will-crude-oil-cl-hit-by-end-of-march",
        regime: "generic",
        horizon: "deadline",
        cadence: "deadline",
        slugPattern: "will-crude-oil-cl-hit-*",
      }),
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(2);
  });

  it("scan() still accepts near-term threshold deadline markets", async () => {
    const market = makeClobMarket({
      slug: "will-tsla-reach-555-in-april",
      eventSlug: "bitcoin-tsla-proxy",
      endDate: nearDeadlineEndDate(),
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([market]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({
        familyId: createFamilyId("fam-tsla"),
        familyKey: "will-tsla-reach",
        horizon: "deadline",
        cadence: "deadline",
        slugPattern: "will-tsla-reach-*",
      }),
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(2);
  });

  it("scan() does not crash on discovery failure", async () => {
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gamma API unreachable"),
    );

    // Should not throw
    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("scanOrThrow() propagates discovery failures for blocking startup use", async () => {
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gamma API unreachable"),
    );

    await expect(mod.scanOrThrow()).rejects.toThrow("Gamma API unreachable");
  });

  it("healthCheck() returns not-ok before first scan", async () => {
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("no successful scan");
  });

  it("healthCheck() returns ok after successful scan", async () => {
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.scan();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain("fresh");
  });

  it("concurrent scans are guarded by re-entrancy flag", async () => {
    let resolveDiscovery!: () => void;
    const blockingPromise = new Promise<ClobMarket[]>((resolve) => {
      resolveDiscovery = () => resolve([]);
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(blockingPromise)
      .mockResolvedValueOnce([]);

    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const scan1 = mod.scan();
    const scan2 = mod.scan(); // should be skipped due to guard

    resolveDiscovery();
    await Promise.all([scan1, scan2]);

    expect(discoveryGateway.discoverMarkets).toHaveBeenCalledTimes(1);
  });

  it("scan() saves with correct outcome mapping", async () => {
    const market = makeClobMarket({
      slug: "bitcoin-above-100k",
      eventSlug: "bitcoin-above-100k",
      tokens: [
        { tokenId: "tok-yes", outcome: "Yes" },
        { tokenId: "tok-no", outcome: "No" },
      ],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([market]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity(),
    ]);

    await mod.scan();

    const calls = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls;
    expect((calls[0]![0] as Market).outcome).toBe("Yes");
    expect((calls[1]![0] as Market).outcome).toBe("No");
  });

  it("scan() skips families without slugPattern", async () => {
    const market = makeClobMarket({ slug: "some-market", eventSlug: "some-market" });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([market]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ slugPattern: null }),
    ]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("healthCheck() returns not-ok after failed scan (no prior success)", async () => {
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("fail"),
    );

    await mod.scan();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
  });

  it("scan() deactivates previously-active markets not in latest discovery", async () => {
    const staleMarket: Market = {
      tokenId: createTokenId("tok-old"),
      conditionId: "cond-old",
      slug: "bitcoin-above-50k-on-jan-1",
      eventSlug: null,
      question: "Will BTC be above 50k on Jan 1?",
      outcome: "YES",
      familyId: createFamilyId("fam-btc"),
      familyKey: "btc-above",
      regime: "threshold",
      horizon: "daily",
      endDate: "2026-01-01",
      active: true,
      tickSize: 0.01,
      negRisk: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    // Discovery returns only the NEW market (the old one is gone/closed)
    const freshMarket = makeClobMarket({
      conditionId: "cond-new",
      slug: "bitcoin-above-100k",
      tokens: [{ tokenId: "tok-new-yes", outcome: "Yes" }],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([freshMarket]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ slugPattern: "bitcoin-above-*" }),
    ]);
    // The repo currently has the stale market as active
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([staleMarket]);

    await mod.scan();

    const saveCalls = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls;
    // First call: save the newly discovered market
    expect((saveCalls[0]![0] as Market).tokenId).toBe("tok-new-yes");
    expect((saveCalls[0]![0] as Market).active).toBe(true);
    // Second call: deactivate the stale market
    const deactivated = saveCalls[1]![0] as Market;
    expect(deactivated.tokenId).toBe("tok-old");
    expect(deactivated.active).toBe(false);
  });

  it("market with matching slug but wrong family horizon gets null familyId", async () => {
    const longDatedMarket = makeClobMarket({
      slug: "bitcoin-above-190k",
      eventSlug: "bitcoin-above-190k",
      endDate: new Date(Date.now() + 270 * 24 * 60 * 60 * 1000).toISOString(),
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      longDatedMarket,
    ]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ horizon: "daily", slugPattern: "bitcoin-above-*" }),
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(2);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.familyId).toBeNull();
  });

  it("daily family DOES match a market with endDate tomorrow", async () => {
    const nearMarket = makeClobMarket({
      slug: "bitcoin-above-100k",
      eventSlug: "bitcoin-above-100k",
      endDate: nearEndDate(),
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([nearMarket]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ horizon: "daily", slugPattern: "bitcoin-above-*" }),
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(2); // YES + NO tokens
  });

  it("intraday-4h family does NOT match long-dated will-bitcoin-reach market", async () => {
    const longDatedMarket = makeClobMarket({
      slug: "will-bitcoin-reach-140000-by-december-31-2026-131-829-299",
      eventSlug: "will-bitcoin-reach-140000-by-december-31-2026-131-829-299",
      endDate: "2027-01-01T05:00:00Z",
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      longDatedMarket,
    ]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({
        familyId: createFamilyId("fam-btc-reach"),
        familyKey: "will-bitcoin-reach",
        horizon: "intraday-4h",
        cadence: "intraday-4h",
        slugPattern: "will-bitcoin-reach-*",
      }),
    ]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("intraday-4h family DOES match near-term will-bitcoin-reach market", async () => {
    const nearMarket = makeClobMarket({
      slug: "will-bitcoin-reach-140000",
      eventSlug: "bitcoin-price-milestones",
      endDate: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([nearMarket]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({
        familyId: createFamilyId("fam-btc-reach"),
        familyKey: "will-bitcoin-reach",
        horizon: "intraday-4h",
        cadence: "intraday-4h",
        slugPattern: "will-bitcoin-reach-*",
      }),
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(2); // YES + NO tokens
  });

  it("start/stop lifecycle manages timer", async () => {
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.start();
    // Give fire-and-forget scan a tick to settle
    await new Promise((r) => setTimeout(r, 0));
    expect(discoveryGateway.discoverMarkets).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("scan() handles multi-page discovery correctly", async () => {
    const page1Market = makeClobMarket({
      slug: "bitcoin-above-100k",
      conditionId: "cond-page1",
      tokens: [{ tokenId: "tok-p1", outcome: "Yes" }],
    });
    const page2Market = makeClobMarket({
      slug: "bitcoin-above-110k",
      conditionId: "cond-page2",
      tokens: [{ tokenId: "tok-p2", outcome: "Yes" }],
    });

    // Override forEachMarketPage to deliver 2 separate pages
    (discoveryGateway.forEachMarketPage as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (markets: ClobMarket[]) => void) => {
        cb([page1Market]);
        cb([page2Market]);
        return { totalMarkets: 2 };
      },
    );
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ slugPattern: "bitcoin-above-*" }),
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(2);
    const slugs = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (c[0] as Market).slug,
    );
    expect(slugs).toContain("bitcoin-above-100k");
    expect(slugs).toContain("bitcoin-above-110k");
  });

  it("scan() saves market passing pre-entry filter even without family match", async () => {
    const btcMarket = makeClobMarket({
      slug: "bitcoin-above-200k",
      eventSlug: "bitcoin-above-200k",
      tokens: [{ tokenId: "tok-200k-yes", outcome: "Yes" }],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([btcMarket]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.tokenId).toBe("tok-200k-yes");
    expect(saved.familyId).toBeNull();
  });

  it("scan() saves single-outcome market (distinct_outcomes=1) via pre-entry STEP 2", async () => {
    const negRiskLeg = makeClobMarket({
      slug: "who-will-win-election-trump",
      eventSlug: "who-will-win-election",
      tokens: [{ tokenId: "tok-trump-yes", outcome: "Yes" }],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([negRiskLeg]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.familyId).toBeNull();
  });

  it("scan() saves market with elon-musk- prefix even without family match", async () => {
    const elonMarket = makeClobMarket({
      slug: "elon-musk-foo-2025-yes",
      eventSlug: "elon-musk-foo-2025",
      tokens: [{ tokenId: "tok-elon-yes", outcome: "Yes" }],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([elonMarket]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.tokenId).toBe("tok-elon-yes");
    expect(saved.familyId).toBeNull();
  });

  it("scan() saves market with ethereum- prefix even without family match", async () => {
    const ethMarket = makeClobMarket({
      slug: "ethereum-price-2025-yes",
      eventSlug: "ethereum-price-2025",
      tokens: [{ tokenId: "tok-eth-yes", outcome: "Yes" }],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([ethMarket]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.tokenId).toBe("tok-eth-yes");
    expect(saved.familyId).toBeNull();
  });

  it("scan() skips multi-outcome market with solana- prefix (not in allowed list)", async () => {
    const solanaMarket = makeClobMarket({
      slug: "solana-something",
      eventSlug: "solana-something",
      tokens: [
        { tokenId: "tok-sol-a", outcome: "Above" },
        { tokenId: "tok-sol-b", outcome: "Below" },
      ],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      solanaMarket,
    ]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("scan() skips multi-outcome market without matching slug prefix", async () => {
    const multiOutcome = makeClobMarket({
      slug: "who-will-win-nba-finals",
      eventSlug: "who-will-win-nba-finals",
      tokens: [
        { tokenId: "tok-team-a", outcome: "Lakers" },
        { tokenId: "tok-team-b", outcome: "Celtics" },
        { tokenId: "tok-team-c", outcome: "Warriors" },
      ],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      multiOutcome,
    ]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("deactivation sweep preserves market with open position", async () => {
    const staleMarket: Market = {
      tokenId: createTokenId("tok-old"),
      conditionId: "cond-old",
      slug: "some-obscure-market",
      eventSlug: null,
      question: "Old market?",
      outcome: "Yes",
      outcomeIndex: null,
      familyId: null,
      familyKey: null,
      regime: null,
      horizon: null,
      endDate: "2026-01-01",
      active: true,
      tickSize: 0.01,
      negRisk: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([staleMarket]);
    (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { tokenId: createTokenId("tok-old"), status: "open" },
    ]);

    await mod.scan();

    const saveCalls = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls;
    const deactivations = saveCalls.filter((c: unknown[]) => (c[0] as Market).active === false);
    expect(deactivations).toHaveLength(0);
  });

  it("deactivation sweep preserves market with open order", async () => {
    const staleMarket: Market = {
      tokenId: createTokenId("tok-pending"),
      conditionId: "cond-pending",
      slug: "another-market",
      eventSlug: null,
      question: "Pending order market?",
      outcome: "Yes",
      outcomeIndex: null,
      familyId: null,
      familyKey: null,
      regime: null,
      horizon: null,
      endDate: "2026-06-01",
      active: true,
      tickSize: 0.01,
      negRisk: false,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([staleMarket]);
    (orderRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { tokenId: createTokenId("tok-pending"), status: "open" },
    ]);

    await mod.scan();

    const saveCalls = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls;
    const deactivations = saveCalls.filter((c: unknown[]) => (c[0] as Market).active === false);
    expect(deactivations).toHaveLength(0);
  });

  it("deactivation sweep deactivates stale market with no open positions or orders", async () => {
    const staleMarket: Market = {
      tokenId: createTokenId("tok-stale"),
      conditionId: "cond-stale",
      slug: "expired-market",
      eventSlug: null,
      question: "Expired?",
      outcome: "Yes",
      outcomeIndex: null,
      familyId: null,
      familyKey: null,
      regime: null,
      horizon: null,
      endDate: "2025-01-01",
      active: true,
      tickSize: 0.01,
      negRisk: false,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([staleMarket]);

    await mod.scan();

    const saveCalls = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls;
    expect(saveCalls).toHaveLength(1);
    expect((saveCalls[0]![0] as Market).tokenId).toBe("tok-stale");
    expect((saveCalls[0]![0] as Market).active).toBe(false);
  });

  it("open-leg market returned as inactive by Gamma is saved as active", async () => {
    const inactiveFromGamma = makeClobMarket({
      slug: "bitcoin-above-50k",
      eventSlug: "bitcoin-above-50k",
      active: false,
      tokens: [{ tokenId: "tok-leg", outcome: "Yes" }],
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      inactiveFromGamma,
    ]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([]);
    (positionRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { tokenId: createTokenId("tok-leg"), status: "open" },
    ]);

    await mod.scan();

    expect(marketRepo.save).toHaveBeenCalledTimes(1);
    const saved = (marketRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Market;
    expect(saved.tokenId).toBe("tok-leg");
    expect(saved.active).toBe(true);
  });

  it("consumes new-market WS hints with debounce and updates hint metrics", async () => {
    vi.useFakeTimers();
    try {
      const realBus = new InProcessEventBus();
      mod = new MarketScannerModule({
        discoveryGateway,
        familyRules,
        marketRepo,
        bus: realBus,
        log: silentLog,
        scanIntervalMs: 300_000,
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
