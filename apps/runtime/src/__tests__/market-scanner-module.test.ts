import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFamilyId, createTokenId } from "@plankton/domain";
import type {
  MarketDiscoveryGateway,
  ClobMarket,
  FamilyRulesProvider,
  FamilyIdentity,
  MarketRepository,
  Market,
  EventBus,
} from "@plankton/domain";
import { MarketScannerModule } from "../modules/market-scanner/market-scanner-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

/** Returns an endDate 1 day from now (within daily horizon filter). */
function nearEndDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0]!;
}

function makeClobMarket(overrides?: Partial<ClobMarket>): ClobMarket {
  return {
    conditionId: "cond-1",
    tokens: [
      { tokenId: "tok-yes", outcome: "Yes" },
      { tokenId: "tok-no", outcome: "No" },
    ],
    question: "Will BTC hit 100k?",
    slug: "bitcoin-above-100k",
    endDate: nearEndDate(),
    active: true,
    negRisk: false,
    tickSize: 0.01,
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

// ─── Tests ────────────────────────────────────────────────────────────────

describe("MarketScannerModule", () => {
  let discoveryGateway: ReturnType<typeof createMockDiscoveryGateway>;
  let familyRules: ReturnType<typeof createMockFamilyRules>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let bus: ReturnType<typeof createMockBus>;
  let mod: MarketScannerModule;

  beforeEach(() => {
    discoveryGateway = createMockDiscoveryGateway();
    familyRules = createMockFamilyRules();
    marketRepo = createMockMarketRepo();
    bus = createMockBus();
    mod = new MarketScannerModule({
      discoveryGateway,
      familyRules,
      marketRepo,
      bus,
      log: silentLog,
      scanIntervalMs: 300_000,
    });
  });

  it("scan() discovers markets and saves matched ones to repo", async () => {
    const btcMarket = makeClobMarket({
      slug: "bitcoin-above-100k",
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

  it("scan() does not crash on discovery failure", async () => {
    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gamma API unreachable"),
    );

    // Should not throw
    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
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
    expect((calls[0]![0] as Market).outcome).toBe("YES");
    expect((calls[1]![0] as Market).outcome).toBe("NO");
  });

  it("scan() skips families without slugPattern", async () => {
    const market = makeClobMarket({ slug: "some-market" });

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

  it("daily family does NOT match a market with endDate 9 months out", async () => {
    const longDatedMarket = makeClobMarket({
      slug: "bitcoin-above-190k",
      endDate: new Date(Date.now() + 270 * 24 * 60 * 60 * 1000).toISOString(),
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([
      longDatedMarket,
    ]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ horizon: "daily", slugPattern: "bitcoin-above-*" }),
    ]);

    await mod.scan();

    expect(marketRepo.save).not.toHaveBeenCalled();
  });

  it("daily family DOES match a market with endDate tomorrow", async () => {
    const nearMarket = makeClobMarket({
      slug: "bitcoin-above-100k",
      endDate: nearEndDate(),
    });

    (discoveryGateway.discoverMarkets as ReturnType<typeof vi.fn>).mockResolvedValue([nearMarket]);
    (familyRules.getAllFamilies as ReturnType<typeof vi.fn>).mockReturnValue([
      makeFamilyIdentity({ horizon: "daily", slugPattern: "bitcoin-above-*" }),
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
      (c: [Market]) => c[0].slug,
    );
    expect(slugs).toContain("bitcoin-above-100k");
    expect(slugs).toContain("bitcoin-above-110k");
  });
});
