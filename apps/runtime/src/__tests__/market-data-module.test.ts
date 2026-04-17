import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId, createFamilyId } from "@plankton/domain";
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
    outcomeIndex: 0,
    familyId: createFamilyId("fam-btc"),
    familyKey: "btc-above",
    regime: "threshold",
    horizon: "daily",
    endDate: "2026-12-31",
    active: true,
    tradable: true,
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
          reason: "socket-closed" | "invalid-payload" | "connect-failed";
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

    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([yesMarket, noMarket]);

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

  it("lastSuccessfulDataMs is NOT updated when getMarketPricing throws", async () => {
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue([makeTrackedMarket()]);
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
    expect(h.detail).toContain("no successful market data");

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

  it("publishes stream updates between polls when WS stream is available", async () => {
    const tracked = [
      makeTrackedMarket({
        tokenId: createTokenId("tok-a"),
        conditionId: "cond-a",
      }),
    ];
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
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
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
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
        pricing: { bestBid: 0.44, bestAsk: 0.56, lastTradePrice: 0.5, bookSource: "clob" },
      },
    ]);
    await stream!.emitUpdates([
      {
        tokenId: "tok-a",
        pricing: { bestBid: 0.45, bestAsk: 0.55, lastTradePrice: 0.5, bookSource: "clob" },
      },
      {
        tokenId: "tok-b",
        pricing: { bestBid: 0.46, bestAsk: 0.58, lastTradePrice: 0.52, bookSource: "clob" },
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
      (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
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
          pricing: { bestBid: 0.44, bestAsk: 0.56, lastTradePrice: 0.5, bookSource: "clob" },
        },
        {
          tokenId: "tok-b",
          pricing: { bestBid: 0.45, bestAsk: 0.57, lastTradePrice: 0.51, bookSource: "clob" },
        },
      ]);

      await mod.poll();

      expect(gateway.getMarketPricing).not.toHaveBeenCalled();
      expect(mod.getMetricsSnapshot().fallbackPollCount).toBe(0);

      await mod.stop();
    } finally {
      vi.useRealTimers();
    }
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
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
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

    expect(gateway.getMarketPricing).toHaveBeenCalledWith(["tok-a", "tok-b"]);
    expect(mod.getMetricsSnapshot().wsEventGapDetected).toBe(1);

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
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
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
    (marketRepo.findActive as ReturnType<typeof vi.fn>).mockReturnValue(tracked);
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
        pricing: { bestBid: 0.44, bestAsk: 0.56, lastTradePrice: 0.5, bookSource: "clob" },
      },
      {
        tokenId: "tok-b",
        pricing: { bestBid: 0.45, bestAsk: 0.57, lastTradePrice: 0.51, bookSource: "clob" },
      },
    ]);
    await stream!.emitGapForTokenIds(["tok-a"]);
    await mod.poll();

    expect(gateway.getMarketPricing).toHaveBeenCalledWith(["tok-a"]);

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
