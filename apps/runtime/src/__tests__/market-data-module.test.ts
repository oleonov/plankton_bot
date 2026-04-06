import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createFamilyId } from "@plankton/domain";
import type {
  MarketDataGateway,
  NormalizedMarket,
  RuntimeEventMap,
  MarketRepository,
  Market,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { MarketDataModule } from "../modules/market-data/market-data-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

function makeTrackedMarket(overrides?: Partial<Market>): Market {
  return {
    tokenId: createTokenId("tok-yes"),
    conditionId: "cond-1",
    slug: "bitcoin-above-100k",
    eventSlug: null,
    question: "Will BTC hit 100k?",
    outcome: "YES",
    familyId: createFamilyId("fam-btc"),
    familyKey: "btc-above",
    regime: "threshold",
    horizon: "daily",
    endDate: "2026-12-31",
    active: true,
    tickSize: 0.01,
    negRisk: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function createMockGateway(): MarketDataGateway {
  return {
    getMarkets: vi.fn().mockResolvedValue([]),
    getMarket: vi.fn().mockResolvedValue(null),
    getOrderBook: vi.fn().mockResolvedValue({
      tokenId: createTokenId(""),
      bids: [],
      asks: [],
      bestBid: null,
      bestAsk: null,
      midPrice: null,
      spread: null,
      timestamp: Date.now(),
    }),
    getTickSize: vi.fn().mockResolvedValue(0.01),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    getMarketPricing: vi.fn().mockResolvedValue(new Map()),
  };
}

function createMockMarketRepo(): MarketRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn<() => Market[]>().mockReturnValue([]),
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

// ─── Tests ───────────────────────────────────────────────────────────────

describe("MarketDataModule", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let bus: InProcessEventBus;
  let mod: MarketDataModule;

  beforeEach(() => {
    gateway = createMockGateway();
    marketRepo = createMockMarketRepo();
    bus = new InProcessEventBus();
    mod = new MarketDataModule({
      gateway,
      marketRepo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      botRunId: "run-test-123",
    });
  });

  it("healthCheck returns not-ok before first poll", async () => {
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("no successful poll");
  });

  it("poll publishes MarketSnapshotReceived with correct data", async () => {
    const yesMarket = makeTrackedMarket({
      tokenId: createTokenId("tok-yes"),
      conditionId: "cond-1",
      outcome: "YES",
    });
    const noMarket = makeTrackedMarket({
      tokenId: createTokenId("tok-no"),
      conditionId: "cond-1",
      outcome: "NO",
    });

    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([yesMarket, noMarket]);

    const pricingMap = new Map<
      string,
      {
        bestBid: number | null;
        bestAsk: number | null;
        lastTradePrice: number | null;
        minOrderSize?: number | null;
      }
    >();
    pricingMap.set("tok-yes", {
      bestBid: 0.45,
      bestAsk: 0.55,
      lastTradePrice: 0.5,
      minOrderSize: 5,
    });
    pricingMap.set("tok-no", {
      bestBid: 0.4,
      bestAsk: 0.6,
      lastTradePrice: 0.5,
      minOrderSize: 1,
    });
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(pricingMap);

    const received: NormalizedMarket[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (p) => {
      received.push([...p.markets]);
    });

    await mod.poll();

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    expect(received[0]![0]!.tokenId).toBe("tok-yes");
    expect(received[0]![0]!.bestBid).toBe(0.45);
    expect(received[0]![0]!.bestAsk).toBe(0.55);
    expect(received[0]![0]!.midPrice).toBe(0.5);
    expect(received[0]![0]!.minOrderSize).toBe(5);
    expect(received[0]![0]!.outcome).toBe("YES");
    expect(received[0]![0]!.familyId).toBe("fam-btc");
    expect(received[0]![1]!.minOrderSize).toBe(1);
    expect(received[0]![1]!.outcome).toBe("NO");
  });

  it("poll uses tracked markets from repo (not gateway.getMarkets)", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-a",
      }),
    ];
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());

    await mod.poll();

    expect(marketRepo.findActive).toHaveBeenCalledTimes(1);
    expect(gateway.getMarkets).not.toHaveBeenCalled();
    expect(gateway.getOrderBook).not.toHaveBeenCalled();
  });

  it("poll calls getMarketPricing with correct tokenIds", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-1",
      }),
      makeTrackedMarket({
        tokenId: createTokenId("tok-b"),
        conditionId: "cond-1",
      }),
      makeTrackedMarket({
        tokenId: createTokenId("tok-c"),
        conditionId: "cond-2",
      }),
    ];
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());

    await mod.poll();

    expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
    const calledIds = (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string[];
    expect(calledIds).toHaveLength(3);
    expect(calledIds).toContain("tok-a");
    expect(calledIds).toContain("tok-b");
    expect(calledIds).toContain("tok-c");
  });

  it("healthCheck returns ok after successful poll", async () => {
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([makeTrackedMarket()]);

    await mod.poll();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    expect(h.detail).toContain("fresh");
  });

  it("healthCheck returns stale when threshold exceeded", async () => {
    const staleMs = 50;
    mod = new MarketDataModule({
      gateway,
      marketRepo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: staleMs,
      botRunId: "run-test-123",
    });

    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([makeTrackedMarket()]);
    await mod.poll();

    await new Promise((r) => setTimeout(r, staleMs + 10));

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("stale");
  });

  it("poll does not crash on gateway failure", async () => {
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([makeTrackedMarket()]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );

    await mod.poll();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
  });

  it("lastSuccessfulPollMs is NOT updated when getMarketPricing throws", async () => {
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([makeTrackedMarket()]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("request timed out after 15000ms"),
    );

    await mod.poll();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("no successful poll");
  });

  it("concurrent polls are guarded by re-entrancy flag", async () => {
    let resolveFirst!: (v: Market[]) => void;
    const blockingPromise = new Promise<Market[]>((resolve) => {
      resolveFirst = resolve;
    });

    (marketRepo.findActive as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(blockingPromise)
      .mockReturnValue([]);

    const poll1 = mod.poll();
    const poll2 = mod.poll(); // should be skipped due to guard

    resolveFirst([]);
    await Promise.all([poll1, poll2]);

    expect(marketRepo.findActive).toHaveBeenCalledTimes(1);
  });

  it("start resolves immediately even when gateway is slow (non-blocking)", async () => {
    let resolvePricing!: (v: Map<string, any>) => void;
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([makeTrackedMarket()]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<Map<string, any>>((r) => {
        resolvePricing = r;
      }),
    );

    await mod.start();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("no successful poll");

    resolvePricing(new Map());
    await new Promise((r) => setTimeout(r, 0));

    const h2 = await mod.healthCheck();
    expect(h2.ok).toBe(true);

    await mod.stop();
  });

  it("start/stop lifecycle manages timer", async () => {
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(marketRepo.findActive).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("publishes empty snapshot when no tracked markets exist", async () => {
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const received: NormalizedMarket[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (p) => {
      received.push([...p.markets]);
    });

    await mod.poll();

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(0);
    expect(gateway.getMarketPricing).not.toHaveBeenCalled();
  });

  it("poll handles missing pricing for a token gracefully", async () => {
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([
      makeTrackedMarket({
        tokenId: createTokenId("tok-orphan"),
        conditionId: "cond-1",
      }),
    ]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());

    const received: NormalizedMarket[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (p) => {
      received.push([...p.markets]);
    });

    await mod.poll();

    expect(received).toHaveLength(1);
    expect(received[0]![0]!.bestBid).toBeNull();
    expect(received[0]![0]!.bestAsk).toBeNull();
    expect(received[0]![0]!.midPrice).toBeNull();
    expect(received[0]![0]!.spread).toBeNull();
  });

  // ─── Poll progress tests ─────────────────────────────────────────────

  it("poll publishes MarketDataPollProgress active:true at start of poll", async () => {
    const progressEvents: RuntimeEventMap["MarketDataPollProgress"][] = [];
    bus.subscribe("MarketDataPollProgress", async (p) => {
      progressEvents.push(p);
    });

    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.poll();

    const activeEvents = progressEvents.filter((e) => e.active);
    expect(activeEvents).toHaveLength(1);
    expect(activeEvents[0]!.botRunId).toBe("run-test-123");
  });

  it("poll publishes MarketDataPollProgress active:false after successful poll", async () => {
    const progressEvents: RuntimeEventMap["MarketDataPollProgress"][] = [];
    bus.subscribe("MarketDataPollProgress", async (p) => {
      progressEvents.push(p);
    });

    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.poll();

    const finalEvent = progressEvents[progressEvents.length - 1];
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.active).toBe(false);
    expect(finalEvent!.page).toBe(0);
    expect(finalEvent!.botRunId).toBe("run-test-123");
  });

  it("poll publishes MarketDataPollProgress active:false after failed poll", async () => {
    const progressEvents: RuntimeEventMap["MarketDataPollProgress"][] = [];
    bus.subscribe("MarketDataPollProgress", async (p) => {
      progressEvents.push(p);
    });

    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([makeTrackedMarket()]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );

    await mod.poll();

    const finalEvent = progressEvents[progressEvents.length - 1];
    expect(finalEvent).toBeDefined();
    expect(finalEvent!.active).toBe(false);
    expect(finalEvent!.page).toBe(0);
    expect(finalEvent!.botRunId).toBe("run-test-123");
  });
});
