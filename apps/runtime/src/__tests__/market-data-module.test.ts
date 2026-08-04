import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId, type ConditionId } from "@krabs/domain";
import type {
  MarketDataGateway,
  MarketPricingLifecycleEvent,
  MarketPricingStream,
  MarketPricingStreamMetricsSnapshot,
  MarketPricingStreamUpdate,
  NormalizedMarket,
  RuntimeEventMap,
  MarketRepository,
  Market,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
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
    outcomeIndex: 0,
    regime: "threshold",
    horizon: "daily",
    endDate: "2026-12-31",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
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

class FakePricingStream implements MarketPricingStream {
  tokenIds: string[] = [];
  metrics: MarketPricingStreamMetricsSnapshot = {
    windowStartMs: Date.now(),
    wsEventsReceived: 0,
    wsEventsReceivedPerSec: 0,
    wsUpdatesApplied: 0,
    trackedTokenCount: 0,
    shardCount: 1,
    reconnectCount: 0,
    wsEventGapDetected: 0,
    wsLatencyMs: null,
  };

  constructor(
    private readonly handlers: Readonly<{
      onUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
      onLifecycleEvents?: (events: readonly MarketPricingLifecycleEvent[]) => Promise<void> | void;
      onError?: (error: unknown) => Promise<void> | void;
      onGapDetected?: (
        info: Readonly<{
          reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout";
          timestamp: number;
          tokenIds?: readonly string[];
        }>,
      ) => Promise<void> | void;
    }>,
  ) {}

  setTokenIds(tokenIds: readonly string[]): void {
    this.tokenIds = [...tokenIds];
    this.metrics = {
      ...this.metrics,
      trackedTokenCount: this.tokenIds.length,
    };
  }

  close(): void {
    this.tokenIds = [];
    this.metrics = {
      ...this.metrics,
      trackedTokenCount: 0,
    };
  }

  getMetricsSnapshot(): MarketPricingStreamMetricsSnapshot {
    return this.metrics;
  }

  async emitUpdates(updates: readonly MarketPricingStreamUpdate[]): Promise<void> {
    this.metrics = {
      ...this.metrics,
      wsEventsReceived: this.metrics.wsEventsReceived + updates.length,
      wsUpdatesApplied: this.metrics.wsUpdatesApplied + updates.length,
      wsEventsReceivedPerSec: updates.length,
    };
    await this.handlers.onUpdates(updates);
  }

  async emitGap(): Promise<void> {
    this.metrics = {
      ...this.metrics,
      reconnectCount: this.metrics.reconnectCount + 1,
      wsEventGapDetected: this.metrics.wsEventGapDetected + 1,
    };
    await this.handlers.onGapDetected?.({
      reason: "socket-closed",
      timestamp: Date.now(),
    });
  }

  async emitGapForTokenIds(tokenIds: readonly string[]): Promise<void> {
    this.metrics = {
      ...this.metrics,
      reconnectCount: this.metrics.reconnectCount + 1,
      wsEventGapDetected: this.metrics.wsEventGapDetected + 1,
    };
    await this.handlers.onGapDetected?.({
      reason: "socket-closed",
      timestamp: Date.now(),
      tokenIds,
    });
  }

  async emitLifecycleEvents(events: readonly MarketPricingLifecycleEvent[]): Promise<void> {
    this.metrics = {
      ...this.metrics,
      wsEventsReceived: this.metrics.wsEventsReceived + events.length,
      marketResolvedEvents:
        (this.metrics.marketResolvedEvents ?? 0) +
        events.filter((event) => event.type === "market_resolved").length,
      newMarketEvents:
        (this.metrics.newMarketEvents ?? 0) +
        events.filter((event) => event.type === "new_market").length,
    };
    await this.handlers.onLifecycleEvents?.(events);
  }
}

function createMockMarketRepo(): MarketRepository {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn<() => Market[]>().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    // Phase 4: market-data module calls findTrackedForPricing instead of findActive.
    // Tests set up their tracked markets via findTrackedForPricing mock.
    findTrackedForPricing: vi.fn<() => Market[]>().mockReturnValue([]),
    findTrackedForPricingTiered: vi.fn().mockReturnValue({
      executionCritical: [],
      planktonSignature: [],
      entryCandidates: [],
      discoveryOnly: [],
      signatureOverflow: 0,
    }),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
    updateTickSize: vi.fn(),
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
  let stream: FakePricingStream | null;

  beforeEach(() => {
    gateway = createMockGateway();
    marketRepo = createMockMarketRepo();
    bus = new InProcessEventBus();
    stream = null;
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("healthCheck returns not-ok before first poll", async () => {
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("no successful market data");
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

    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      yesMarket,
      noMarket,
    ]);

    const pricingMap = new Map<
      string,
      {
        bestBid: number | null;
        bestAsk: number | null;
        lastTradePrice: number | null;
        lastTradeAt?: string | null;
        minOrderSize?: number | null;
      }
    >();
    pricingMap.set("tok-yes", {
      bestBid: 0.45,
      bestAsk: 0.55,
      lastTradePrice: 0.5,
      lastTradeAt: "2026-01-01T00:01:00.000Z",
      minOrderSize: 5,
    });
    pricingMap.set("tok-no", {
      bestBid: 0.4,
      bestAsk: 0.6,
      lastTradePrice: 0.5,
      lastTradeAt: "2026-01-01T00:02:00.000Z",
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
    expect(received[0]![0]!.lastTradeAt).toBe("2026-01-01T00:01:00.000Z");
    expect(received[0]![0]!.lastTradePrice).toBe(0.5);
    expect(received[0]![0]!.minOrderSize).toBe(5);
    expect(received[0]![0]!.outcome).toBe("YES");
    expect(received[0]![1]!.minOrderSize).toBe(1);
    expect(received[0]![1]!.outcome).toBe("NO");
  });

  it("enriches REST pricing with public trade count once per condition", async () => {
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
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      yesMarket,
      noMarket,
    ]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([
        [
          "tok-yes",
          {
            bestBid: 0.45,
            bestAsk: 0.55,
            lastTradePrice: null,
            acceptingOrders: true,
            enableOrderBook: true,
          },
        ],
        [
          "tok-no",
          {
            bestBid: 0.4,
            bestAsk: 0.6,
            lastTradePrice: null,
            acceptingOrders: true,
            enableOrderBook: true,
          },
        ],
      ]),
    );
    const tradeCountProvider = {
      countTrades: vi.fn(),
      fetchPublicTradeCount24h: vi.fn(async (_conditionId: ConditionId, _nowMs: number) => ({
        count: 42,
        capReached: false,
        fetchedAt: Date.now(),
      })),
    };
    mod = new MarketDataModule({
      gateway,
      marketRepo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      tradeCountProvider,
    });
    const received: NormalizedMarket[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (p) => {
      received.push([...p.markets]);
    });

    await mod.poll();

    expect(tradeCountProvider.fetchPublicTradeCount24h).toHaveBeenCalledTimes(1);
    expect(tradeCountProvider.fetchPublicTradeCount24h.mock.calls[0]![0]).toBe("cond-1");
    expect(received[0]![0]!.publicTradeCount24h).toBe(42);
    expect(received[0]![1]!.publicTradeCount24h).toBe(42);
  });

  it("public trade count enrichment respects the optional token filter", async () => {
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
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      yesMarket,
      noMarket,
    ]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([
        [
          "tok-yes",
          {
            bestBid: 0.45,
            bestAsk: 0.55,
            lastTradePrice: null,
            acceptingOrders: true,
            enableOrderBook: true,
          },
        ],
        [
          "tok-no",
          {
            bestBid: 0.4,
            bestAsk: 0.6,
            lastTradePrice: null,
            acceptingOrders: true,
            enableOrderBook: true,
          },
        ],
      ]),
    );
    const tradeCountProvider = {
      countTrades: vi.fn(),
      fetchPublicTradeCount24h: vi.fn(async (_conditionId: ConditionId, _nowMs: number) => ({
        count: 7,
        capReached: false,
        fetchedAt: Date.now(),
      })),
    };
    mod = new MarketDataModule({
      gateway,
      marketRepo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      tradeCountProvider,
      publicTradeCountEnrichmentFilter: (tokenId) => tokenId === "tok-yes",
    });
    const received: NormalizedMarket[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (p) => {
      received.push([...p.markets]);
    });

    await mod.poll();

    expect(tradeCountProvider.fetchPublicTradeCount24h).toHaveBeenCalledTimes(1);
    expect(received[0]![0]!.publicTradeCount24h).toBe(7);
    expect(received[0]![1]!.publicTradeCount24h).toBeNull();
    expect(mod.getMetricsSnapshot().publicTradeCountEnrichmentEligibleCount).toBe(1);
    expect(mod.getMetricsSnapshot().publicTradeCountEnrichmentSkippedCount).toBe(1);
  });

  it("poll uses tracked markets from repo (not gateway.getMarkets)", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-a",
      }),
    ];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());

    await mod.poll();

    expect(marketRepo.findTrackedForPricing).toHaveBeenCalledTimes(1);
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
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
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
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      makeTrackedMarket(),
    ]);

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

    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      makeTrackedMarket(),
    ]);
    await mod.poll();

    await new Promise((r) => setTimeout(r, staleMs + 10));

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("stale");
  });

  it("poll does not crash on gateway failure", async () => {
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      makeTrackedMarket(),
    ]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("network down"),
    );

    await mod.poll();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
  });

  it("lastSuccessfulDataMs is NOT updated when getMarketPricing throws", async () => {
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      makeTrackedMarket(),
    ]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("request timed out after 15000ms"),
    );

    await mod.poll();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("no successful market data");
  });

  it("concurrent polls are guarded by re-entrancy flag", async () => {
    let resolveFirst!: (v: Market[]) => void;
    const blockingPromise = new Promise<Market[]>((resolve) => {
      resolveFirst = resolve;
    });

    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(blockingPromise)
      .mockReturnValue([]);

    const poll1 = mod.poll();
    const poll2 = mod.poll(); // should be skipped due to guard

    resolveFirst([]);
    await Promise.all([poll1, poll2]);

    expect(marketRepo.findTrackedForPricing).toHaveBeenCalledTimes(1);
  });

  it("start resolves immediately even when gateway is slow (non-blocking)", async () => {
    let resolvePricing!: (v: Map<string, any>) => void;
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      makeTrackedMarket(),
    ]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<Map<string, any>>((r) => {
        resolvePricing = r;
      }),
    );

    await mod.start();

    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
    expect(h.detail).toContain("no successful market data");

    resolvePricing(new Map());
    await new Promise((r) => setTimeout(r, 0));

    const h2 = await mod.healthCheck();
    expect(h2.ok).toBe(true);

    await mod.stop();
  });

  it("start/stop lifecycle manages timer", async () => {
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await mod.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(marketRepo.findTrackedForPricing).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("publishes stream updates between polls when WS stream is available", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-a",
      }),
    ];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([
        [
          "tok-a",
          {
            bestBid: 0.4,
            bestAsk: 0.6,
            lastTradePrice: 0.5,
            minOrderSize: 1,
          },
        ],
      ]),
    );
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    const received: NormalizedMarket[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (payload) => {
      received.push([...payload.markets]);
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(received.length).toBeGreaterThan(0);
    });
    received.length = 0;

    await stream!.emitUpdates([
      {
        tokenId: "tok-a",
        pricing: {
          bestBid: 0.45,
          bestAsk: 0.55,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: 0.5,
          bookSource: "clob",
        },
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 125));

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    expect(received[0]![0]!.bestBid).toBe(0.45);
    expect(received[0]![0]!.bestAsk).toBe(0.55);
    expect(mod.getMetricsSnapshot().wsUpdatesApplied).toBe(1);

    await mod.stop();
  });

  it("coalesces rapid stream updates into a single published batch with last-write-wins per token", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-a",
      }),
      makeTrackedMarket({
        tokenId: createTokenId("tok-b"),
        conditionId: "cond-b",
      }),
    ];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([
        ["tok-a", { bestBid: 0.4, bestAsk: 0.6, lastTradePrice: 0.5, minOrderSize: 1 }],
        ["tok-b", { bestBid: 0.41, bestAsk: 0.61, lastTradePrice: 0.51, minOrderSize: 1 }],
      ]),
    );
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    const received: NormalizedMarket[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (payload) => {
      received.push([...payload.markets]);
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(received.length).toBeGreaterThan(0);
    });
    received.length = 0;

    await stream!.emitUpdates([
      {
        tokenId: "tok-a",
        pricing: {
          bestBid: 0.44,
          bestAsk: 0.56,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: 0.5,
          bookSource: "clob",
        },
      },
    ]);
    await stream!.emitUpdates([
      {
        tokenId: "tok-a",
        pricing: {
          bestBid: 0.45,
          bestAsk: 0.55,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: 0.5,
          bookSource: "clob",
        },
      },
      {
        tokenId: "tok-b",
        pricing: {
          bestBid: 0.46,
          bestAsk: 0.58,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: 0.52,
          bookSource: "clob",
        },
      },
    ]);

    expect(received).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 125));

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(2);
    const byToken = new Map(received[0]!.map((market) => [String(market.tokenId), market]));
    expect(byToken.get("tok-a")!.bestBid).toBe(0.45);
    expect(byToken.get("tok-b")!.bestBid).toBe(0.46);

    await mod.stop();
  });

  it("poll skips REST pricing fetch when stream data is fresh for all tracked tokens", async () => {
    vi.useFakeTimers();
    try {
      const tracked = [
        makeTrackedMarket({
          tokenId: createTokenId("tok-a"),
          conditionId: "cond-a",
        }),
        makeTrackedMarket({
          tokenId: createTokenId("tok-b"),
          conditionId: "cond-b",
        }),
      ];
      (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map([
          ["tok-a", { bestBid: 0.4, bestAsk: 0.6, lastTradePrice: 0.5, minOrderSize: 1 }],
          ["tok-b", { bestBid: 0.41, bestAsk: 0.61, lastTradePrice: 0.51, minOrderSize: 1 }],
        ]),
      );
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      console.error("INIT", JSON.stringify((gateway.getMarketPricing as any).mock.calls), [
        ...(mod as any).marketCache.keys(),
      ]);
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

      await stream!.emitUpdates([
        {
          tokenId: "tok-a",
          pricing: {
            bestBid: 0.44,
            bestAsk: 0.56,
            acceptingOrders: true,
            enableOrderBook: true,
            lastTradePrice: 0.5,
            bookSource: "clob",
          },
        },
        {
          tokenId: "tok-b",
          pricing: {
            bestBid: 0.45,
            bestAsk: 0.57,
            acceptingOrders: true,
            enableOrderBook: true,
            lastTradePrice: 0.51,
            bookSource: "clob",
          },
        },
      ]);

      await mod.poll();

      expect(gateway.getMarketPricing).not.toHaveBeenCalled();
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(0);
      expect(mod.getMetricsSnapshot().silentTrackedTokenCount).toBe(0);

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps quiet clob-tracked tokens silent while the stream stays healthy", async () => {
    vi.useFakeTimers();
    try {
      const tracked = [
        makeTrackedMarket({ tokenId: createTokenId("tok-a"), conditionId: "cond-a" }),
      ];
      (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
      // Step 3: seed volume24hr + liquidity so featuresCapturedTs gets set on
      // the first REST poll. Without this, the soft-ranking feature-freshness
      // safeguard would force a re-poll on every cycle to prime null features
      // for healthy WS-tier known-source tokens.
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map([
          [
            "tok-a",
            {
              bestBid: 0.4,
              bestAsk: 0.6,
              lastTradePrice: 0.5,
              minOrderSize: 1,
              volume24hr: 1000,
              liquidity: 5000,
            },
          ],
        ]),
      );
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

      await stream!.emitUpdates([
        {
          tokenId: "tok-a",
          pricing: {
            bestBid: 0.44,
            bestAsk: 0.56,
            acceptingOrders: true,
            enableOrderBook: true,
            lastTradePrice: 0.5,
            bookSource: "clob",
          },
        },
      ]);

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await mod.poll();

      expect(gateway.getMarketPricing).not.toHaveBeenCalled();
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(0);
      expect(mod.getMetricsSnapshot().silentTrackedTokenCount).toBe(1);

      await vi.advanceTimersByTimeAsync(12 * 60_000);
      await mod.poll();

      expect(gateway.getMarketPricing).not.toHaveBeenCalled();
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(0);
      expect(mod.getMetricsSnapshot().silentTrackedTokenCount).toBe(1);

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps quiet gamma-sourced tracked tokens silent while the stream stays healthy", async () => {
    vi.useFakeTimers();
    try {
      const tracked = [
        makeTrackedMarket({ tokenId: createTokenId("tok-a"), conditionId: "cond-a" }),
      ];
      (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
      // Step 3: seed volume24hr + liquidity so featuresCapturedTs gets set on
      // the initial REST poll. Without it, the new soft-ranking
      // feature-freshness safeguard would force a re-poll on every cycle.
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map([
          [
            "tok-a",
            {
              bestBid: 0.4,
              bestAsk: 0.6,
              acceptingOrders: true,
              enableOrderBook: true,
              lastTradePrice: 0.5,
              minOrderSize: 1,
              bookSource: "gamma",
              volume24hr: 1000,
              liquidity: 5000,
            },
          ],
        ]),
      );
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

      await stream!.emitLifecycleEvents([
        {
          type: "new_market",
          conditionId: "cond-new",
          marketId: "market-new",
          slug: "market-new",
          question: "Will new market happen?",
          active: true,
          tokenIds: [createTokenId("tok-z")],
          timestamp: Date.now(),
        },
      ]);

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await mod.poll();

      expect(gateway.getMarketPricing).not.toHaveBeenCalled();
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(0);
      expect(mod.getMetricsSnapshot().silentTrackedTokenCount).toBe(1);

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-polls quiet gamma-sourced tracked tokens after a stream gap", async () => {
    vi.useFakeTimers();
    try {
      const tracked = [
        makeTrackedMarket({ tokenId: createTokenId("tok-a"), conditionId: "cond-a" }),
      ];
      (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map([
          [
            "tok-a",
            {
              bestBid: 0.4,
              bestAsk: 0.6,
              acceptingOrders: true,
              enableOrderBook: true,
              lastTradePrice: 0.5,
              minOrderSize: 1,
              bookSource: "gamma",
            },
          ],
        ]),
      );
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

      await stream!.emitLifecycleEvents([
        {
          type: "new_market",
          conditionId: "cond-new",
          marketId: "market-new",
          slug: "market-new",
          question: "Will new market happen?",
          active: true,
          tokenIds: [createTokenId("tok-z")],
          timestamp: Date.now(),
        },
      ]);

      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await stream!.emitGap();
      await vi.advanceTimersByTimeAsync(300);
      await mod.poll();

      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(1);

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-poll quiet unknown entry-candidate tokens every cycle on a healthy stream", async () => {
    vi.useFakeTimers();
    try {
      const executionCritical = [
        makeTrackedMarket({ tokenId: createTokenId("tok-exec"), conditionId: "cond-exec" }),
      ];
      const entryCandidates = [
        makeTrackedMarket({ tokenId: createTokenId("tok-entry"), conditionId: "cond-entry" }),
      ];
      (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
        executionCritical,
        planktonSignature: [],
        entryCandidates,
        discoveryOnly: [],
        signatureOverflow: 0,
      });
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };
      mod = new MarketDataModule({
        gateway,
        marketRepo,
        bus,
        log: silentLog,
        pollIntervalMs: 5_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-123",
        maxTrackedTokens: 2,
      });

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

      await stream!.emitLifecycleEvents([
        {
          type: "new_market",
          conditionId: "cond-new",
          marketId: "market-new",
          slug: "market-new",
          question: "Will new market happen?",
          active: true,
          tokenIds: [createTokenId("tok-z")],
          timestamp: Date.now(),
        },
      ]);

      await vi.advanceTimersByTimeAsync(20_000);
      await mod.poll();

      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      expect(gateway.getMarketPricing).toHaveBeenLastCalledWith(["tok-exec"], {
        timeoutMs: 10_025,
      });
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(1);
      expect(mod.getMetricsSnapshot().fallbackReasonCounts).toEqual({
        pendingGap: 0,
        missingCache: 0,
        unknownSourceRefresh: 1,
        knownSourceRefresh: 0,
        forceFullPoll: 0,
        streamUnavailable: 0,
        featureFreshness: 0,
        minOrderSizeHydration: 0,
      });
      expect(mod.getMetricsSnapshot().fallbackRoleCounts).toEqual({
        executionCritical: 1,
        planktonSignature: 0,
        entryCandidate: 0,
        legacy: 0,
        unassigned: 0,
      });

      await vi.advanceTimersByTimeAsync(120_000);
      await mod.poll();

      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(2);
      expect(gateway.getMarketPricing).toHaveBeenLastCalledWith(["tok-exec", "tok-entry"], {
        timeoutMs: 10_050,
      });
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(2);

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-polls a quiet token whose parked minOrderSize is blocked only by stale pricing", async () => {
    vi.useFakeTimers();
    try {
      const executionCritical = [
        makeTrackedMarket({ tokenId: createTokenId("tok-exec"), conditionId: "cond-exec" }),
      ];
      const entryCandidates = [
        makeTrackedMarket({ tokenId: createTokenId("tok-entry"), conditionId: "cond-entry" }),
      ];
      (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
        executionCritical,
        planktonSignature: [],
        entryCandidates,
        discoveryOnly: [],
        signatureOverflow: 0,
      });
      // A known `bookSource` plus primed features is the production shape of the
      // bug: neither the book budget nor the feature-freshness safeguard would
      // ever pick this token back up. `minOrderSize` stays absent because Gamma
      // never carries it — only the /books REST call does.
      const pricing = {
        bestBid: 0.4,
        bestAsk: 0.6,
        acceptingOrders: true,
        enableOrderBook: true,
        lastTradePrice: 0.5,
        bookSource: "gamma",
        volume24hr: 1000,
        liquidity: 5000,
      };
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map([
          ["tok-exec", pricing],
          ["tok-entry", pricing],
        ]),
      );
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };
      mod = new MarketDataModule({
        gateway,
        marketRepo,
        bus,
        log: silentLog,
        pollIntervalMs: 5_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-123",
        maxTrackedTokens: 2,
      });

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

      // Inside the 30s gamma book budget: a quiet cycle that polls nobody.
      await vi.advanceTimersByTimeAsync(20_000);
      await mod.poll();
      expect(gateway.getMarketPricing).not.toHaveBeenCalled();
      expect(mod.getMetricsSnapshot().fallbackReasonCounts.minOrderSizeHydration).toBe(0);

      // A minimum observed while placing the entry: pricing is already past the
      // publish-freshness budget, so the flush parks it instead of delivering.
      // The repoll returns a batch that OMITS the token — the partial-response
      // case that leaves the value parked and used to re-request every cycle.
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      mod.noteMinOrderSizeObserved(createTokenId("tok-entry"), 5);
      await mod.poll();

      expect(gateway.getMarketPricing).toHaveBeenLastCalledWith(["tok-entry"], expect.anything());
      expect(mod.getMetricsSnapshot().fallbackReasonCounts.minOrderSizeHydration).toBe(1);

      // Still parked, so the branch still matches — but the unknown-source
      // entry-candidate budget (120s) must throttle it instead of hammering.
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();
      await vi.advanceTimersByTimeAsync(9_000);
      await mod.poll();
      expect(gateway.getMarketPricing).not.toHaveBeenCalled();

      // Past the budget it retries — throttled, not abandoned.
      await vi.advanceTimersByTimeAsync(120_000);
      await mod.poll();
      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      expect((gateway.getMarketPricing as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
        "tok-entry",
      );

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates parked minOrderSize repolls the rate cap deferred instead of starving them", async () => {
    vi.useFakeTimers();
    try {
      const executionCritical = [
        makeTrackedMarket({ tokenId: createTokenId("tok-exec"), conditionId: "cond-exec" }),
      ];
      const entryCandidates = [
        makeTrackedMarket({ tokenId: createTokenId("tok-entry"), conditionId: "cond-entry" }),
      ];
      (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
        executionCritical,
        planktonSignature: [],
        entryCandidates,
        discoveryOnly: [],
        signatureOverflow: 0,
      });
      const pricing = {
        bestBid: 0.4,
        bestAsk: 0.6,
        acceptingOrders: true,
        enableOrderBook: true,
        lastTradePrice: 0.5,
        bookSource: "gamma",
        volume24hr: 1000,
        liquidity: 5000,
      };
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map([
          ["tok-exec", pricing],
          ["tok-entry", pricing],
        ]),
      );
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };
      mod = new MarketDataModule({
        gateway,
        marketRepo,
        bus,
        log: silentLog,
        pollIntervalMs: 5_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-123",
        maxTrackedTokens: 2,
      });

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();
      // Squeezed to a per-cycle fallback budget of exactly 1 token (0.2 tok/s x
      // 5s) only AFTER the priming poll: the same cap also trims the first full
      // poll, which would leave the second token uncached and route it down the
      // `missingCache` branch instead of the parked-hydration one under test.
      (
        mod as unknown as { deps: { fallbackPollRatePerSec?: number } }
      ).deps.fallbackPollRatePerSec = 0.2;

      await vi.advanceTimersByTimeAsync(20_000);
      // The repoll batch omits both, so both stay parked and keep matching the
      // hydration branch — the partial-response case the throttle exists for.
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      mod.noteMinOrderSizeObserved(createTokenId("tok-exec"), 5);
      mod.noteMinOrderSizeObserved(createTokenId("tok-entry"), 5);

      await mod.poll();
      expect(gateway.getMarketPricing).toHaveBeenLastCalledWith(["tok-exec"], expect.anything());
      expect(mod.getMetricsSnapshot().fallbackReasonCounts.minOrderSizeHydration).toBe(1);

      // The deferred token was never polled, so it must NOT have started a
      // backoff: the very next cycle is its turn while tok-exec sits out its own.
      // Asserted on the REASON, not just the polled token — other fallback
      // branches can reach the same token and would mask a starved hydration.
      await mod.poll();
      expect(gateway.getMarketPricing).toHaveBeenLastCalledWith(["tok-entry"], expect.anything());
      expect(mod.getMetricsSnapshot().fallbackReasonCounts.minOrderSizeHydration).toBe(1);

      // Both are now inside their budgets — the rotation stops rather than
      // alternating forever.
      await mod.poll();
      expect(mod.getMetricsSnapshot().fallbackReasonCounts.minOrderSizeHydration).toBe(0);

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("walks the whole over-limit hydration set instead of starving the tail", async () => {
    vi.useFakeTimers();
    try {
      const tokenIds = ["tok-0", "tok-1", "tok-2", "tok-3", "tok-4"];
      const executionCritical = tokenIds.map((tokenId) =>
        makeTrackedMarket({ tokenId: createTokenId(tokenId), conditionId: `cond-${tokenId}` }),
      );
      (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
        executionCritical,
        planktonSignature: [],
        entryCandidates: [],
        discoveryOnly: [],
        signatureOverflow: 0,
      });
      const pricing = {
        bestBid: 0.4,
        bestAsk: 0.6,
        acceptingOrders: true,
        enableOrderBook: true,
        lastTradePrice: 0.5,
        // `clob` keeps the book-refresh budget at 60s, so the whole walk below
        // stays inside it and every poll is charged to the hydration reason —
        // a shorter budget would let `knownSourceRefresh` reach the same tokens
        // and mask a starved hydration.
        bookSource: "clob",
        volume24hr: 1000,
        liquidity: 5000,
      };
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map(tokenIds.map((tokenId) => [tokenId, pricing])),
      );
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };
      mod = new MarketDataModule({
        gateway,
        marketRepo,
        bus,
        log: silentLog,
        pollIntervalMs: 5_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-123",
        maxTrackedTokens: tokenIds.length,
      });

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();
      // One token per cycle (0.2 tok/s x 5s), applied only after the priming
      // poll cached all five.
      (
        mod as unknown as { deps: { fallbackPollRatePerSec?: number } }
      ).deps.fallbackPollRatePerSec = 0.2;

      await vi.advanceTimersByTimeAsync(20_000);
      // The repoll batch never carries the minimum back, so all five stay parked
      // and keep matching the hydration branch for the whole walk.
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      for (const tokenId of tokenIds) {
        mod.noteMinOrderSizeObserved(createTokenId(tokenId), 5);
      }

      const polled: string[] = [];
      // The 15s execution-critical budget is three 5s cycles, so from the fourth
      // poll on the earliest tokens are eligible again. Priority is equal and the
      // sort is stable, so without rotation that same prefix wins the single slot
      // forever and `tok-4` — one past 15s/5s tokens — is never polled.
      for (let round = 0; round < 8; round += 1) {
        await mod.poll();
        if (mod.getMetricsSnapshot().fallbackReasonCounts.minOrderSizeHydration === 1) {
          const calls = (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mock.calls;
          polled.push(...(calls[calls.length - 1]![0] as string[]));
        }
        await vi.advanceTimersByTimeAsync(5_000);
      }

      expect([...new Set(polled)].sort()).toEqual([...tokenIds].sort());

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not charge a hydration backoff to tokens skipped by the Gamma rate-limit backoff", async () => {
    vi.useFakeTimers();
    try {
      const executionCritical = [
        makeTrackedMarket({ tokenId: createTokenId("tok-exec"), conditionId: "cond-exec" }),
      ];
      (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
        executionCritical,
        planktonSignature: [],
        entryCandidates: [],
        discoveryOnly: [],
        signatureOverflow: 0,
      });
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map([
          [
            "tok-exec",
            {
              bestBid: 0.4,
              bestAsk: 0.6,
              acceptingOrders: true,
              enableOrderBook: true,
              lastTradePrice: 0.5,
              bookSource: "clob",
              volume24hr: 1000,
              liquidity: 5000,
            },
          ],
        ]),
      );
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };
      mod = new MarketDataModule({
        gateway,
        marketRepo,
        bus,
        log: silentLog,
        pollIntervalMs: 5_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-123",
        maxTrackedTokens: 1,
      });

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

      await vi.advanceTimersByTimeAsync(20_000);
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      mod.noteMinOrderSizeObserved(createTokenId("tok-exec"), 5);

      const backoff = mod as unknown as { pricingPollBackoffUntilMs: number };
      backoff.pricingPollBackoffUntilMs = Date.now() + 60_000;
      await mod.poll();
      expect(gateway.getMarketPricing).not.toHaveBeenCalled();

      // Gamma was never asked, so the token cannot have earned a hydration
      // backoff: the very next poll — one second later, far inside the 15s
      // budget — must still select it.
      backoff.pricingPollBackoffUntilMs = 0;
      await vi.advanceTimersByTimeAsync(1_000);
      await mod.poll();

      expect(gateway.getMarketPricing).toHaveBeenLastCalledWith(["tok-exec"], expect.anything());
      expect(mod.getMetricsSnapshot().fallbackReasonCounts.minOrderSizeHydration).toBe(1);

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });
  it("drops parked minOrderSize hydrations on stop so a restart cannot republish them", async () => {
    (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
      executionCritical: [
        makeTrackedMarket({ tokenId: createTokenId("tok-exec"), conditionId: "cond-exec" }),
      ],
      planktonSignature: [],
      entryCandidates: [],
      discoveryOnly: [],
      signatureOverflow: 0,
    });
    // No pricing at all: the token never reaches `marketCache`, so the observed
    // minimum can only survive as a parked entry.
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };
    mod = new MarketDataModule({
      gateway,
      marketRepo,
      bus,
      log: silentLog,
      pollIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      botRunId: "run-test-123",
      maxTrackedTokens: 1,
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
    });
    mod.noteMinOrderSizeObserved(createTokenId("tok-exec"), 5);

    const parked = (mod as unknown as { pendingMinOrderSizeByToken: Map<string, unknown> })
      .pendingMinOrderSizeByToken;
    expect(parked.size).toBe(1);

    await mod.stop();

    // A minimum observed an arbitrary time ago must not survive the largest gap
    // there is — the restart releases the `/books` dedupe and re-observes it.
    expect(parked.size).toBe(0);
  });

  it("still re-polls quiet unknown execution-critical tokens on the short safety budget", async () => {
    vi.useFakeTimers();
    try {
      const executionCritical = [
        makeTrackedMarket({ tokenId: createTokenId("tok-exec"), conditionId: "cond-exec" }),
      ];
      (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
        executionCritical,
        planktonSignature: [],
        entryCandidates: [],
        discoveryOnly: [],
        signatureOverflow: 0,
      });
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      gateway.createMarketPricingStream = (handlers) => {
        stream = new FakePricingStream(handlers);
        return stream;
      };
      mod = new MarketDataModule({
        gateway,
        marketRepo,
        bus,
        log: silentLog,
        pollIntervalMs: 5_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-123",
        maxTrackedTokens: 1,
      });

      await mod.start();
      await vi.waitFor(() => {
        expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      });
      clearInterval((mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer!);
      (mod as unknown as { timer: ReturnType<typeof setInterval> | null }).timer = null;
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

      await stream!.emitLifecycleEvents([
        {
          type: "new_market",
          conditionId: "cond-new",
          marketId: "market-new",
          slug: "market-new",
          question: "Will new market happen?",
          active: true,
          tokenIds: [createTokenId("tok-z")],
          timestamp: Date.now(),
        },
      ]);

      await vi.advanceTimersByTimeAsync(20_000);
      await mod.poll();

      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
      expect(gateway.getMarketPricing).toHaveBeenLastCalledWith(["tok-exec"], {
        timeoutMs: 10_025,
      });
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(1);
      expect(mod.getMetricsSnapshot().fallbackReasonCounts).toEqual({
        pendingGap: 0,
        missingCache: 0,
        unknownSourceRefresh: 1,
        knownSourceRefresh: 0,
        forceFullPoll: 0,
        streamUnavailable: 0,
        featureFreshness: 0,
        minOrderSizeHydration: 0,
      });
      expect(mod.getMetricsSnapshot().fallbackRoleCounts).toEqual({
        executionCritical: 1,
        planktonSignature: 0,
        entryCandidate: 0,
        legacy: 0,
        unassigned: 0,
      });

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears pendingGapTokenIds after a successful poll so stale entries don't accumulate", async () => {
    const tracked = [makeTrackedMarket({ tokenId: createTokenId("tok-a"), conditionId: "cond-a" })];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([["tok-a", { bestBid: 0.4, bestAsk: 0.6, lastTradePrice: 0.5, minOrderSize: 1 }]]),
    );
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    await mod.start();
    await vi.waitFor(() => {
      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
    });

    // Seed the gap set with tracked tok-a plus a ghost token that isn't tracked.
    // Without the clear(), the ghost entry would linger in pendingGapTokenIds forever.
    await stream!.emitGapForTokenIds(["tok-a", "tok-ghost-1", "tok-ghost-2"]);
    expect((mod as unknown as { pendingGapTokenIds: Set<string> }).pendingGapTokenIds.size).toBe(3);

    await mod.poll();

    expect((mod as unknown as { pendingGapTokenIds: Set<string> }).pendingGapTokenIds.size).toBe(0);

    await mod.stop();
  });

  it("poll forces a full REST refresh after a stream gap", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-a",
      }),
      makeTrackedMarket({
        tokenId: createTokenId("tok-b"),
        conditionId: "cond-b",
      }),
    ];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    await mod.start();
    await vi.waitFor(() => {
      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
    });
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

    await stream!.emitGap();
    await mod.poll();

    expect(gateway.getMarketPricing).toHaveBeenCalledWith(
      ["tok-a", "tok-b"],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(mod.getMetricsSnapshot().wsEventGapDetected).toBe(1);
    expect(mod.getMetricsSnapshot().fallbackReasonCounts).toEqual({
      pendingGap: 0,
      missingCache: 0,
      unknownSourceRefresh: 0,
      knownSourceRefresh: 0,
      forceFullPoll: 2,
      streamUnavailable: 0,
      featureFreshness: 0,
      minOrderSizeHydration: 0,
    });
    expect(mod.getMetricsSnapshot().fallbackRoleCounts).toEqual({
      executionCritical: 0,
      planktonSignature: 0,
      entryCandidate: 0,
      legacy: 2,
      unassigned: 0,
    });

    await mod.stop();
  });

  it("poll degrades to cached websocket state on transient fallback fetch failures", async () => {
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-a",
      }),
    ];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Map([["tok-a", { bestBid: 0.4, bestAsk: 0.6, lastTradePrice: 0.5, minOrderSize: 1 }]]),
      )
      .mockRejectedValueOnce(
        new Error("fetch failed: getaddrinfo ENOTFOUND gamma-api.polymarket.com"),
      );
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    await mod.start();
    await vi.waitFor(() => {
      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
    });
    await stream!.emitGapForTokenIds(["tok-a"]);
    await mod.poll();
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackPollCount: 1,
        trackedCount: 1,
      }),
      "poll cycle degraded — keeping cached websocket state",
    );
    expect(silentLog.error).not.toHaveBeenCalledWith(expect.anything(), "poll cycle failed");
    await expect(mod.healthCheck()).resolves.toEqual(
      expect.objectContaining({
        ok: true,
      }),
    );

    await mod.stop();
  });

  it("poll narrows reconnect catch-up to the affected token ids when a shard reports them", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-a",
      }),
      makeTrackedMarket({
        tokenId: createTokenId("tok-b"),
        conditionId: "cond-b",
      }),
    ];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Map([
        ["tok-a", { bestBid: 0.4, bestAsk: 0.6, lastTradePrice: 0.5, minOrderSize: 1 }],
        ["tok-b", { bestBid: 0.41, bestAsk: 0.61, lastTradePrice: 0.51, minOrderSize: 1 }],
      ]),
    );
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    await mod.start();
    await vi.waitFor(() => {
      expect(gateway.getMarketPricing).toHaveBeenCalledTimes(1);
    });
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockClear();

    await stream!.emitUpdates([
      {
        tokenId: "tok-a",
        pricing: {
          bestBid: 0.44,
          bestAsk: 0.56,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: 0.5,
          bookSource: "clob",
        },
      },
      {
        tokenId: "tok-b",
        pricing: {
          bestBid: 0.45,
          bestAsk: 0.57,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: 0.51,
          bookSource: "clob",
        },
      },
    ]);
    await stream!.emitGapForTokenIds(["tok-a"]);
    await mod.poll();

    expect(gateway.getMarketPricing).toHaveBeenCalledWith(
      ["tok-a"],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );

    await mod.stop();
  });

  it("publishes additive lifecycle hints from market WS events and exposes their metrics", async () => {
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    const resolvedHints: RuntimeEventMap["MarketResolvedHint"][] = [];
    const discoveryHints: RuntimeEventMap["NewMarketDiscoveredHint"][] = [];
    bus.subscribe("MarketResolvedHint", async (payload) => {
      resolvedHints.push(payload);
    });
    bus.subscribe("NewMarketDiscoveredHint", async (payload) => {
      discoveryHints.push(payload);
    });

    await mod.start();
    await stream!.emitLifecycleEvents([
      {
        type: "market_resolved",
        conditionId: "cond-1",
        marketId: "market-1",
        slug: "market-one",
        tokenIds: [createTokenId("tok-a")],
        winningTokenId: createTokenId("tok-a"),
        timestamp: Date.now(),
      },
      {
        type: "new_market",
        conditionId: "cond-2",
        marketId: "market-2",
        slug: "market-two",
        question: "Will two happen?",
        active: true,
        tokenIds: [createTokenId("tok-b")],
        timestamp: Date.now(),
      },
    ]);
    await bus.drain();

    expect(resolvedHints).toHaveLength(1);
    expect(discoveryHints).toHaveLength(1);
    expect(mod.getMetricsSnapshot().marketResolvedEvents).toBe(1);
    expect(mod.getMetricsSnapshot().newMarketEvents).toBe(1);

    await mod.stop();
  });

  it("publishes empty snapshot when no tracked markets exist", async () => {
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([]);

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
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
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

    expect(received).toHaveLength(0);
    await expect(mod.healthCheck()).resolves.toMatchObject({ ok: true });
  });

  // ─── Poll progress tests ─────────────────────────────────────────────

  it("poll publishes MarketDataPollProgress active:true at start of poll", async () => {
    const progressEvents: RuntimeEventMap["MarketDataPollProgress"][] = [];
    bus.subscribe("MarketDataPollProgress", async (p) => {
      progressEvents.push(p);
    });

    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([]);

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

    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([]);

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

    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([
      makeTrackedMarket(),
    ]);
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

  it("propagates acceptingOrders + enableOrderBook through syncTrackedMarket", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-t1"),
        conditionId: "cond-t1",
      }),
    ];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);

    // Snapshot with both liveness booleans false — market not live yet.
    const pricingMap = new Map<string, import("@krabs/domain").MarketPricingSnapshot>([
      [
        "tok-t1",
        {
          bestBid: 0.3,
          bestAsk: 0.7,
          acceptingOrders: false,
          enableOrderBook: false,
          lastTradePrice: null,
        },
      ],
    ]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(pricingMap);

    const received: NormalizedMarket[] = [];
    bus.subscribe("MarketSnapshotReceived", async (p) => {
      received.push(...p.markets);
    });

    await mod.poll();

    expect(received).toHaveLength(1);
    expect(received[0]!.acceptingOrders).toBe(false);
    expect(received[0]!.enableOrderBook).toBe(false);
  });

  it("propagates sigLiquidity and sigVol24hr from tracked Market row onto NormalizedMarket", async () => {
    // Confirms the fix for isMakerUniverse zero-shadow bug: sig fields from the
    // DB row must survive into NormalizedMarket so the gate uses them when the
    // live liquidity/volume24hr are null (CLOB stream path omits Gamma features).
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-sig"),
        conditionId: "cond-sig",
        sigLiquidity: 7_500,
        sigVol24h: 3_000,
      }),
    ];
    (marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(tracked);

    const pricingMap = new Map<string, import("@krabs/domain").MarketPricingSnapshot>([
      [
        "tok-sig",
        {
          bestBid: 0.4,
          bestAsk: 0.6,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: null,
          // intentionally no liquidity / volume24hr to simulate CLOB-only update
        },
      ],
    ]);
    (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(pricingMap);

    const received: NormalizedMarket[] = [];
    bus.subscribe("MarketSnapshotReceived", async (p) => {
      received.push(...p.markets);
    });

    await mod.poll();

    expect(received).toHaveLength(1);
    expect(received[0]!.sigLiquidity).toBe(7_500);
    expect(received[0]!.sigVol24hr).toBe(3_000);
  });

  // ── ADR-021 §D-F #1 wsCapUtilizationPct ────────────────────────────────
  describe("watch-set capacity telemetry (ADR-021 §D-F)", () => {
    it("getMetricsSnapshot reports wsCapUtilizationPct=null when maxTrackedTokens is unset", async () => {
      const snap = mod.getMetricsSnapshot();
      expect(snap.wsCapUtilizationPct).toBeNull();
    });

    it("getMetricsSnapshot reports rounded utilization when maxTrackedTokens is set", async () => {
      const tracked = [
        makeTrackedMarket({ tokenId: createTokenId("tok-a"), conditionId: "cond-a" }),
        makeTrackedMarket({ tokenId: createTokenId("tok-b"), conditionId: "cond-b" }),
        makeTrackedMarket({ tokenId: createTokenId("tok-c"), conditionId: "cond-c" }),
      ];
      (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
        executionCritical: tracked,
        planktonSignature: [],
        entryCandidates: [],
        discoveryOnly: [],
        signatureOverflow: 0,
      });
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      mod = new MarketDataModule({
        gateway,
        marketRepo,
        bus,
        log: silentLog,
        pollIntervalMs: 60_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-123",
        maxTrackedTokens: 4,
      });

      await mod.poll();

      // 3 tracked / 4 cap = 75%
      expect(mod.getMetricsSnapshot().wsCapUtilizationPct).toBe(75);
    });

    it("getMetricsSnapshot wsCapUtilizationPct rounds to nearest integer", async () => {
      const tracked = [
        makeTrackedMarket({ tokenId: createTokenId("tok-a"), conditionId: "cond-a" }),
      ];
      (marketRepo.findTrackedForPricingTiered as ReturnType<typeof vi.fn>).mockReturnValue({
        executionCritical: tracked,
        planktonSignature: [],
        entryCandidates: [],
        discoveryOnly: [],
        signatureOverflow: 0,
      });
      (gateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
      mod = new MarketDataModule({
        gateway,
        marketRepo,
        bus,
        log: silentLog,
        pollIntervalMs: 60_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-123",
        maxTrackedTokens: 3,
      });

      await mod.poll();

      // 1 / 3 = 33.33% → 33
      expect(mod.getMetricsSnapshot().wsCapUtilizationPct).toBe(33);
    });
  });

  describe("pause gating", () => {
    it("skips poll cycles while the runtime is paused", async () => {
      const isPaused = vi.fn(() => true);
      const localGateway = createMockGateway();
      const localRepo = createMockMarketRepo();
      const localBus = new InProcessEventBus();
      const tracked = makeTrackedMarket();
      (localRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([tracked]);
      const localMod = new MarketDataModule({
        gateway: localGateway,
        marketRepo: localRepo,
        bus: localBus,
        log: silentLog,
        pollIntervalMs: 60_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-paused",
        runtimeControl: { isPaused },
      });

      const received: NormalizedMarket[][] = [];
      localBus.subscribe("MarketSnapshotReceived", async (p) => {
        received.push([...p.markets]);
      });

      await localMod.poll();

      expect(isPaused).toHaveBeenCalled();
      expect(localGateway.getMarketPricing).not.toHaveBeenCalled();
      expect(localRepo.findTrackedForPricing).not.toHaveBeenCalled();
      expect(received).toEqual([]);
    });

    it("suppresses WS-driven snapshot publication while the runtime is paused", async () => {
      let paused = false;
      const isPaused = vi.fn(() => paused);
      let localStream: FakePricingStream | null = null;
      const localGateway = createMockGateway();
      const localRepo = createMockMarketRepo();
      const localBus = new InProcessEventBus();
      const tracked = makeTrackedMarket({
        tokenId: createTokenId("tok-ws"),
        conditionId: "cond-ws",
      });
      (localRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([tracked]);
      (localGateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(
        new Map([
          [
            "tok-ws",
            {
              bestBid: 0.4,
              bestAsk: 0.6,
              lastTradePrice: 0.5,
              minOrderSize: 1,
            },
          ],
        ]),
      );
      localGateway.createMarketPricingStream = (handlers) => {
        localStream = new FakePricingStream(handlers);
        return localStream;
      };

      const localMod = new MarketDataModule({
        gateway: localGateway,
        marketRepo: localRepo,
        bus: localBus,
        log: silentLog,
        pollIntervalMs: 60_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-ws-paused",
        runtimeControl: { isPaused },
      });

      const received: NormalizedMarket[][] = [];
      localBus.subscribe("MarketSnapshotReceived", async (payload) => {
        received.push([...payload.markets]);
      });

      await localMod.start();
      await vi.waitFor(() => {
        expect(received.length).toBeGreaterThan(0);
      });
      received.length = 0;

      paused = true;
      await localStream!.emitUpdates([
        {
          tokenId: "tok-ws",
          pricing: {
            bestBid: 0.41,
            bestAsk: 0.59,
            acceptingOrders: true,
            enableOrderBook: true,
            lastTradePrice: 0.5,
            bookSource: "clob",
          },
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 125));

      expect(received).toEqual([]);
      expect(localMod.getMetricsSnapshot().wsUpdatesApplied).toBe(1);

      paused = false;
      await localStream!.emitUpdates([
        {
          tokenId: "tok-ws",
          pricing: {
            bestBid: 0.42,
            bestAsk: 0.58,
            acceptingOrders: true,
            enableOrderBook: true,
            lastTradePrice: 0.5,
            bookSource: "clob",
          },
        },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 125));

      expect(received).toHaveLength(1);
      expect(received[0]![0]!.bestBid).toBe(0.42);

      await localMod.stop();
    });

    it("resumes polling once the pause flag clears", async () => {
      let paused = true;
      const isPaused = vi.fn(() => paused);
      const localGateway = createMockGateway();
      const localRepo = createMockMarketRepo();
      const localBus = new InProcessEventBus();
      const tracked = makeTrackedMarket();
      (localRepo.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue([tracked]);
      const pricingMap = new Map([
        ["tok-yes", { bestBid: 0.45, bestAsk: 0.55, lastTradePrice: 0.5 }],
      ]);
      (localGateway.getMarketPricing as ReturnType<typeof vi.fn>).mockResolvedValue(pricingMap);

      const localMod = new MarketDataModule({
        gateway: localGateway,
        marketRepo: localRepo,
        bus: localBus,
        log: silentLog,
        pollIntervalMs: 60_000,
        staleThresholdMs: 120_000,
        botRunId: "run-test-resume",
        runtimeControl: { isPaused },
      });

      await localMod.poll();
      expect(localGateway.getMarketPricing).not.toHaveBeenCalled();

      paused = false;
      await localMod.poll();
      expect(localGateway.getMarketPricing).toHaveBeenCalledTimes(1);
    });
  });
});
