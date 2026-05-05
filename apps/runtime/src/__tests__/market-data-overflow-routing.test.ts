/**
 * Regression tests for the queue_overflow → pendingGapTokenIds routing
 * (Finding #2) and the discovery poll cache seeding (Finding #3).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTokenId } from "@plankton/domain";
import type { Market, MarketPricingLifecycleEvent, MarketPricingSnapshot } from "@plankton/domain";
import { MarketDataModule } from "../modules/market-data/market-data-module.js";

function makeMarket(tokenId: string): Market {
  return {
    tokenId: createTokenId(tokenId),
    conditionId: `cond-${tokenId}`,
    slug: `slug-${tokenId}`,
    eventSlug: null,
    question: "Q?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: "threshold",
    horizon: "daily",
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function makePricing(mid: number): MarketPricingSnapshot {
  return {
    bestBid: mid - 0.01,
    bestAsk: mid + 0.01,
    lastTradePrice: null,
    lastTradeAt: null,
    volume24h: null,
    liquidity: null,
    minOrderSize: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bookSource: "gamma-fallback",
  };
}

describe("MarketDataModule — queue_overflow routing (Finding #2)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queue_overflow adds token IDs to pendingGapTokenIds so next poll refetches them", async () => {
    const lifecycleHandlerRef: {
      fn: ((events: readonly MarketPricingLifecycleEvent[]) => Promise<void>) | null;
    } = { fn: null };
    const getMarketPricing = vi.fn().mockResolvedValue(new Map());

    // Tracked tokens both in the WS tier AND the ones we'll "drop" via overflow.
    const trackedMarkets = [makeMarket("tok-A"), makeMarket("tok-B")];

    const fakeGateway = {
      createMarketPricingStream: (handlers: {
        onLifecycleEvents?: (events: readonly MarketPricingLifecycleEvent[]) => Promise<void>;
        onUpdates: () => void;
        onError: () => void;
        onGapDetected: () => void;
      }) => {
        lifecycleHandlerRef.fn = handlers.onLifecycleEvents ?? null;
        return { setTokenIds: () => {}, close: () => {} };
      },
      getMarketPricing,
    };
    const fakeBus = { publish: async () => {}, subscribe: () => () => {} };
    const fakeMarketRepo = {
      findTrackedForPricing: () => trackedMarkets,
      findTrackedForPricingTiered: () => ({
        executionCritical: trackedMarkets,
        entryCandidates: [],
        discoveryOnly: [],
      }),
    };
    const fakeLogger = {
      info: () => {},
      warn: vi.fn(),
      error: () => {},
      debug: () => {},
      child: function () {
        return this;
      },
    };

    const module = new MarketDataModule({
      gateway: fakeGateway as never,
      marketRepo: fakeMarketRepo as never,
      bus: fakeBus as never,
      log: fakeLogger as never,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 100,
    });

    await module.start();
    // Drain the initial poll
    await vi.advanceTimersByTimeAsync(1);
    getMarketPricing.mockClear();

    // Simulate queue_overflow that dropped two tokens' WS updates.
    await lifecycleHandlerRef.fn?.([
      {
        type: "queue_overflow",
        shardId: 0,
        droppedCount: 1,
        tokenIds: ["tok-A", "tok-B"],
        timestamp: Date.now(),
      },
    ]);
    expect(fakeLogger.warn).toHaveBeenCalled();

    // Next poll must include those tokens (pendingGapTokenIds makes the stale
    // predicate return true for them, even though their WS cache may be fresh).
    await module.poll();

    expect(getMarketPricing).toHaveBeenCalled();
    const polledIds = getMarketPricing.mock.calls[0]![0] as string[];
    expect(new Set(polledIds).has("tok-A")).toBe(true);
    expect(new Set(polledIds).has("tok-B")).toBe(true);

    await module.stop();
  });
});

describe("MarketDataModule — discovery poll publishes snapshots (Finding #3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("discovery poll publishes MarketSnapshotReceived and does NOT poison WS-tier caches", async () => {
    const discoveryMarkets = [makeMarket("disc-1"), makeMarket("disc-2")];
    const pricingMap = new Map<string, MarketPricingSnapshot>([
      ["disc-1", makePricing(0.42)],
      ["disc-2", makePricing(0.55)],
    ]);
    const getMarketPricing = vi.fn().mockImplementation(async (ids: string[]) => {
      const isDiscovery = ids.some((id) => id.startsWith("disc-"));
      return isDiscovery ? pricingMap : new Map<string, MarketPricingSnapshot>();
    });

    const fakeGateway = {
      createMarketPricingStream: () => ({ setTokenIds: () => {}, close: () => {} }),
      getMarketPricing,
    };
    const published: Array<{ topic: string; payload: unknown }> = [];
    const fakeBus = {
      publish: async (topic: string, payload: unknown) => {
        published.push({ topic, payload });
      },
      subscribe: () => () => {},
    };
    const fakeMarketRepo = {
      findTrackedForPricing: () => [],
      findTrackedForPricingTiered: () => ({
        executionCritical: [],
        entryCandidates: [],
        discoveryOnly: discoveryMarkets,
      }),
    };
    const fakeLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: function () {
        return this;
      },
    };

    const module = new MarketDataModule({
      gateway: fakeGateway as never,
      marketRepo: fakeMarketRepo as never,
      bus: fakeBus as never,
      log: fakeLogger as never,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 10,
    });

    await module.start();
    // Drain the initial main poll
    await vi.advanceTimersByTimeAsync(1);
    const baselinePublishCount = published.length;

    // Fire one discovery cycle.
    await vi.advanceTimersByTimeAsync(10_000);

    // Discovery must publish a MarketSnapshotReceived so downstream
    // (Normalization → AlgoDecision → SignalToOrder) sees the discovery tier.
    const discoverySnapshots = published
      .slice(baselinePublishCount)
      .filter((e) => e.topic === "MarketSnapshotReceived");
    expect(discoverySnapshots.length).toBeGreaterThanOrEqual(1);
    const snapshot = discoverySnapshots[0]!.payload as {
      markets: readonly { tokenId: unknown; midPrice: number | null }[];
    };
    const bySomeToken = new Map(snapshot.markets.map((m) => [String(m.tokenId), m.midPrice]));
    expect(bySomeToken.get("disc-1")).toBe(0.42);
    expect(bySomeToken.get("disc-2")).toBe(0.55);

    // Discovery must NOT seed the WS-tier caches — those stay bounded to
    // trackedMarketsByToken only, avoiding unbounded retention for the tail.
    const cache = (module as unknown as { marketCache: Map<string, unknown> }).marketCache;
    const lastUpdate = (module as unknown as { lastPricingUpdateAtByToken: Map<string, number> })
      .lastPricingUpdateAtByToken;
    expect(cache.has("disc-1")).toBe(false);
    expect(cache.has("disc-2")).toBe(false);
    expect(lastUpdate.has("disc-1")).toBe(false);
    expect(lastUpdate.has("disc-2")).toBe(false);

    await module.stop();
  });

  it("rolling discovery batches emit TrackedMarketsChanged.removedTokenIds so downstream caches stay bounded", async () => {
    // 4 discovery markets, batch size 2 → two rotations before wraparound.
    // Round 1 polls [A1, A2], round 2 polls [B1, B2]: previous batch must
    // be evicted via TrackedMarketsChanged so MarketSelectionCache and
    // SignalToOrderBridge drop A1/A2 instead of accumulating them.
    const discoveryMarkets = [
      makeMarket("A1"),
      makeMarket("A2"),
      makeMarket("B1"),
      makeMarket("B2"),
    ];
    const pricingMap = new Map<string, MarketPricingSnapshot>(
      discoveryMarkets.map((m) => [String(m.tokenId), makePricing(0.5)]),
    );
    const getMarketPricing = vi.fn().mockImplementation(async (ids: string[]) => {
      const out = new Map<string, MarketPricingSnapshot>();
      for (const id of ids) {
        const p = pricingMap.get(id);
        if (p) out.set(id, p);
      }
      return out;
    });

    const fakeGateway = {
      createMarketPricingStream: () => ({ setTokenIds: () => {}, close: () => {} }),
      getMarketPricing,
    };
    const published: Array<{ topic: string; payload: unknown }> = [];
    const fakeBus = {
      publish: async (topic: string, payload: unknown) => {
        published.push({ topic, payload });
      },
      subscribe: () => () => {},
    };
    const fakeMarketRepo = {
      findTrackedForPricing: () => [],
      findTrackedForPricingTiered: () => ({
        executionCritical: [],
        entryCandidates: [],
        discoveryOnly: discoveryMarkets,
      }),
    };
    const fakeLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: function () {
        return this;
      },
    };

    const module = new MarketDataModule({
      gateway: fakeGateway as never,
      marketRepo: fakeMarketRepo as never,
      bus: fakeBus as never,
      log: fakeLogger as never,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 2,
    });

    await module.start();
    await vi.advanceTimersByTimeAsync(1);

    // Round 1: batch [A1, A2]. No previous batch → no eviction emitted.
    await vi.advanceTimersByTimeAsync(10_000);
    const round1TrackedChanges = published.filter((e) => e.topic === "TrackedMarketsChanged");
    // The only TrackedMarketsChanged at this point should come from the main
    // poll (added=[]/removed=[] is skipped, so length 0 here — WS tier is empty).
    expect(round1TrackedChanges).toHaveLength(0);

    const publishedBeforeRound2 = published.length;

    // Round 2: batch [B1, B2]. Must evict [A1, A2] via TrackedMarketsChanged.
    await vi.advanceTimersByTimeAsync(10_000);
    const round2Events = published.slice(publishedBeforeRound2);
    const eviction = round2Events.find((e) => e.topic === "TrackedMarketsChanged") as
      | { topic: string; payload: { removedTokenIds: unknown[]; addedTokenIds: unknown[] } }
      | undefined;
    expect(eviction).toBeDefined();
    const removedIds = new Set(
      (eviction!.payload.removedTokenIds as string[]).map((t) => String(t)),
    );
    expect(removedIds.has("A1")).toBe(true);
    expect(removedIds.has("A2")).toBe(true);
    expect(removedIds.has("B1")).toBe(false);
    expect(removedIds.has("B2")).toBe(false);
    expect(eviction!.payload.addedTokenIds).toHaveLength(0);

    await module.stop();
  });

  it("flushes last discovery batch on module stop so downstream caches don't retain the tail", async () => {
    const discoveryMarkets = [makeMarket("S1"), makeMarket("S2")];
    const pricingMap = new Map<string, MarketPricingSnapshot>(
      discoveryMarkets.map((m) => [String(m.tokenId), makePricing(0.5)]),
    );
    const getMarketPricing = vi.fn().mockImplementation(async (ids: string[]) => {
      const out = new Map<string, MarketPricingSnapshot>();
      for (const id of ids) {
        const p = pricingMap.get(id);
        if (p) out.set(id, p);
      }
      return out;
    });
    const fakeGateway = {
      createMarketPricingStream: () => ({ setTokenIds: () => {}, close: () => {} }),
      getMarketPricing,
    };
    const published: Array<{ topic: string; payload: unknown }> = [];
    const fakeBus = {
      publish: async (topic: string, payload: unknown) => {
        published.push({ topic, payload });
      },
      subscribe: () => () => {},
    };
    const fakeMarketRepo = {
      findTrackedForPricing: () => [],
      findTrackedForPricingTiered: () => ({
        executionCritical: [],
        entryCandidates: [],
        discoveryOnly: discoveryMarkets,
      }),
    };
    const fakeLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: function () {
        return this;
      },
    };

    const module = new MarketDataModule({
      gateway: fakeGateway as never,
      marketRepo: fakeMarketRepo as never,
      bus: fakeBus as never,
      log: fakeLogger as never,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 10,
    });

    await module.start();
    await vi.advanceTimersByTimeAsync(1);
    // One discovery cycle → lastDiscoveryBatchTokenIds = {S1, S2}.
    await vi.advanceTimersByTimeAsync(10_000);

    const beforeStop = published.length;
    await module.stop();

    const afterStop = published.slice(beforeStop);
    const stopEviction = afterStop.find((e) => e.topic === "TrackedMarketsChanged") as
      | { topic: string; payload: { removedTokenIds: unknown[]; addedTokenIds: unknown[] } }
      | undefined;
    expect(stopEviction).toBeDefined();
    const removed = new Set(
      (stopEviction!.payload.removedTokenIds as string[]).map((t) => String(t)),
    );
    expect(removed.has("S1")).toBe(true);
    expect(removed.has("S2")).toBe(true);
  });

  it("flushes last discovery batch when discovery tier empties mid-run", async () => {
    const initialDiscovery = [makeMarket("E1"), makeMarket("E2")];
    const pricingMap = new Map<string, MarketPricingSnapshot>(
      initialDiscovery.map((m) => [String(m.tokenId), makePricing(0.5)]),
    );
    const getMarketPricing = vi.fn().mockImplementation(async (ids: string[]) => {
      const out = new Map<string, MarketPricingSnapshot>();
      for (const id of ids) {
        const p = pricingMap.get(id);
        if (p) out.set(id, p);
      }
      return out;
    });
    const fakeGateway = {
      createMarketPricingStream: () => ({ setTokenIds: () => {}, close: () => {} }),
      getMarketPricing,
    };
    const published: Array<{ topic: string; payload: unknown }> = [];
    const fakeBus = {
      publish: async (topic: string, payload: unknown) => {
        published.push({ topic, payload });
      },
      subscribe: () => () => {},
    };
    // Toggle: first refresh returns discovery, subsequent refreshes return empty.
    let discoveryVisible = true;
    const fakeMarketRepo = {
      findTrackedForPricing: () => [],
      findTrackedForPricingTiered: () => ({
        executionCritical: [],
        entryCandidates: [],
        discoveryOnly: discoveryVisible ? initialDiscovery : [],
      }),
    };
    const fakeLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: function () {
        return this;
      },
    };

    const module = new MarketDataModule({
      gateway: fakeGateway as never,
      marketRepo: fakeMarketRepo as never,
      bus: fakeBus as never,
      log: fakeLogger as never,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 10,
    });

    await module.start();
    await vi.advanceTimersByTimeAsync(1);
    // First discovery cycle populates lastDiscoveryBatchTokenIds.
    await vi.advanceTimersByTimeAsync(10_000);

    // Discovery tier goes empty (rule change, scanner withdrew).
    discoveryVisible = false;
    // Main poll must run so discoveryTier becomes empty on the module.
    await module.poll();

    const before = published.length;
    // Next discovery tick: tier empty, must still emit eviction.
    await vi.advanceTimersByTimeAsync(10_000);

    const emptyCycleEvents = published.slice(before);
    const eviction = emptyCycleEvents.find((e) => e.topic === "TrackedMarketsChanged") as
      | { topic: string; payload: { removedTokenIds: unknown[] } }
      | undefined;
    expect(eviction).toBeDefined();
    const removed = new Set((eviction!.payload.removedTokenIds as string[]).map((t) => String(t)));
    expect(removed.has("E1")).toBe(true);
    expect(removed.has("E2")).toBe(true);

    await module.stop();
  });
});
