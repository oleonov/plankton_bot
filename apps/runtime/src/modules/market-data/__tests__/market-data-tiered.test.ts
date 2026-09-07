/**
 * Task 1 — Tiered pricing universe tests for MarketDataModule.
 *
 * Verifies:
 * 1. stream.setTokenIds receives only WS-tier (executionCritical + entryCandidates).
 * 2. Discovery poll loop polls only discoveryOnly tokens in rolling batches.
 * 3. The discovery cursor advances across calls and wraps correctly.
 * 4. Module stop() clears the discovery timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConditionId, createPositionId, createTokenId, PositionStatus } from "@krabs/domain";
import type {
  MarketDataGateway,
  MarketPricingLifecycleEvent,
  MarketPricingSnapshot,
  MarketPricingStream,
  MarketPricingStreamMetricsSnapshot,
  MarketPricingStreamUpdate,
  MarketRepository,
  Market,
  NormalizedMarket,
  Position,
  TrackedForPricing,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { MarketDataModule } from "../market-data-module.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeMarket(tokenId: string, overrides: Partial<Market> = {}): Market {
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
    ...overrides,
  };
}

function makePricing(overrides: Partial<MarketPricingSnapshot> = {}): MarketPricingSnapshot {
  return {
    bestBid: 0.4,
    bestAsk: 0.5,
    acceptingOrders: true,
    enableOrderBook: true,
    lastTradePrice: 0.45,
    volume24h: null,
    volume24hr: null,
    publicTradeCount24h: null,
    liquidity: null,
    minOrderSize: null,
    bookSource: "gamma-fallback",
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("pos-full-lifetime"),
    tokenId: createTokenId("crit-1"),
    conditionId: createConditionId("cond-crit-1"),
    side: "buy",
    size: 10,
    avgEntryPrice: 0.1,
    costBasisUsdc: 1,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: PositionStatus.Open,
    entryStyle: null,
    openedAt: "2026-06-11T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeTiered(
  criticalIds: string[],
  candidateIds: string[],
  discoveryIds: string[],
): TrackedForPricing {
  return {
    executionCritical: criticalIds.map((id) => makeMarket(id)),
    planktonSignature: [],
    entryCandidates: candidateIds.map((id) => makeMarket(id)),
    discoveryOnly: discoveryIds.map((id) => makeMarket(id)),
    signatureOverflow: 0,
  };
}

class FakePricingStream implements MarketPricingStream {
  tokenIds: string[] = [];
  setTokenIdsCalls: string[][] = [];
  fullBookTokenIds: string[] = [];
  setFullBookTokenIdsCalls: string[][] = [];
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
        gap: Readonly<{
          reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout";
          timestamp: number;
          tokenIds?: readonly string[];
        }>,
      ) => Promise<void> | void;
    }>,
  ) {}

  setTokenIds(tokenIds: readonly string[]): void {
    this.tokenIds = [...tokenIds];
    this.setTokenIdsCalls.push([...tokenIds]);
    this.metrics = { ...this.metrics, trackedTokenCount: this.tokenIds.length };
  }

  setFullBookTokenIds(_reason: string, tokenIds: readonly string[]): void {
    this.fullBookTokenIds = [...tokenIds];
    this.setFullBookTokenIdsCalls.push([...tokenIds]);
    this.metrics = { ...this.metrics, fullBookTokenCount: this.fullBookTokenIds.length };
  }

  close(): void {
    this.tokenIds = [];
  }

  getMetricsSnapshot(): MarketPricingStreamMetricsSnapshot {
    return this.metrics;
  }
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

function createMockRepo(tiered: TrackedForPricing): MarketRepository {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi
      .fn()
      .mockReturnValue([...tiered.executionCritical, ...tiered.entryCandidates]),
    findTrackedForPricingTiered: vi.fn().mockReturnValue(tiered),
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

// ─── Tests ────────────────────────────────────────────────────────────────

describe("MarketDataModule — tiered pricing (Task 1)", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let bus: InProcessEventBus;
  let stream: FakePricingStream | null;

  beforeEach(() => {
    gateway = createMockGateway();
    bus = new InProcessEventBus();
    stream = null;
    silentLog.info.mockClear();
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    silentLog.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stream.setTokenIds receives only executionCritical + entryCandidates (not discoveryOnly)", async () => {
    const tiered = makeTiered(["crit-1", "crit-2"], ["cand-1", "cand-2"], ["disc-1", "disc-2"]);
    const repo = createMockRepo(tiered);

    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 60_000,
      discoveryBatchSize: 200,
    });

    // start() creates the stream via createMarketPricingStream; then the initial
    // poll fires and calls setTokenIds. Wait for the initial poll to complete.
    await mod.start();
    await vi.waitFor(() => {
      expect(stream).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(stream!.setTokenIdsCalls.length).toBeGreaterThanOrEqual(1);
    });

    // setTokenIds should have been called with only the WS tier
    const calls = stream!.setTokenIdsCalls;
    const lastCall = calls[calls.length - 1]!;
    const wsTokenSet = new Set(lastCall);

    // WS tier contains critical + candidates
    expect(wsTokenSet.has("crit-1")).toBe(true);
    expect(wsTokenSet.has("crit-2")).toBe(true);
    expect(wsTokenSet.has("cand-1")).toBe(true);
    expect(wsTokenSet.has("cand-2")).toBe(true);
    // Discovery tokens NOT in WS tier
    expect(wsTokenSet.has("disc-1")).toBe(false);
    expect(wsTokenSet.has("disc-2")).toBe(false);

    await mod.stop();
  });

  it("findTrackedForPricingTiered is called (not the flat findTrackedForPricing) when maxTrackedTokens is set", async () => {
    const tiered = makeTiered(["c1"], ["e1"], ["d1"]);
    const repo = createMockRepo(tiered);

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
    });

    await mod.poll();

    // signatureTierMode defaults to "shadow" -> reserveSignature: false.
    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledWith({
      maxTokens: 1000,
      reserveSignature: false,
    });
  });

  it("caches tiered pricing universe between poll cycles", async () => {
    const tiered = makeTiered(["c1"], ["e1"], ["d1"]);
    const repo = createMockRepo(tiered);

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      tieredPricingCacheTtlMs: 60_000,
    });

    await mod.poll();
    await mod.poll();

    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledTimes(1);
  });

  it("captures target routing only on a natural tier-cache refresh", async () => {
    const capturedAtMs = Date.parse("2026-08-01T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(capturedAtMs);
    const fact = {
      tokenId: "e1",
      conditionId: "cond-e1",
      outcome: "YES",
      outcomeIndex: 0,
      capturedAtMs,
      basis: "post_detection_route_evaluation" as const,
      route: "entry_candidate" as const,
      v4Category: "crypto-btc" as const,
      v4Reason: "admit" as const,
      admissionRank: 1,
      capacitySlots: 999,
      signatureMatched: false,
    };
    const tiered = { ...makeTiered([], ["e1"], []), targetRoutes: [fact] };
    const repo = createMockRepo(tiered);
    vi.mocked(repo.findTrackedForPricingTiered).mockImplementation((opts) =>
      opts.targetTokenIds ? tiered : makeTiered([], ["e1"], []),
    );
    const routeTargetTokenIds = vi.fn(() => new Set(["e1"]));
    const observeRouting = vi.fn(() => {
      throw new Error("shadow unavailable");
    });
    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      tieredPricingCacheTtlMs: 60_000,
      entryShadowObserver: {
        routeTargetTokenIds,
        observeRouting,
        isTarget: () => false,
        observeDiscovery: vi.fn(),
      },
    });

    await expect(mod.poll()).resolves.toBeUndefined();
    vi.setSystemTime(capturedAtMs + 10_000);
    await expect(mod.poll()).resolves.toBeUndefined();

    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledTimes(1);
    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledWith(
      expect.objectContaining({ targetTokenIds: new Set(["e1"]) }),
    );
    expect(routeTargetTokenIds).toHaveBeenCalledTimes(1);
    expect(observeRouting).toHaveBeenCalledTimes(1);
    expect(observeRouting).toHaveBeenCalledWith(fact);

    routeTargetTokenIds.mockImplementation(() => {
      throw new Error("target snapshot unavailable");
    });
    vi.setSystemTime(capturedAtMs + 70_000);
    await expect(mod.poll()).resolves.toBeUndefined();
    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledTimes(2);
    expect(repo.findTrackedForPricingTiered).toHaveBeenLastCalledWith({
      maxTokens: 1000,
      reserveSignature: false,
    });
    expect(observeRouting).toHaveBeenCalledTimes(1);
  });

  it("observes discovery request outcomes without changing failures", async () => {
    const tiered = makeTiered([], [], ["d0"]);
    const repo = createMockRepo(tiered);
    const observeDiscovery = vi.fn();
    const entryShadowObserver = {
      routeTargetTokenIds: () => new Set<string>(),
      observeRouting: vi.fn(),
      isTarget: vi.fn((tokenId: string) => tokenId === "d0"),
      observeDiscovery,
    };
    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      entryShadowObserver,
    });
    await mod.poll();

    gateway.getMarketPricing = vi.fn().mockResolvedValueOnce(new Map([["d0", makePricing()]]));
    await (mod as any).pollDiscoveryBatch();
    expect(observeDiscovery.mock.calls.map((call) => call[1])).toEqual(["requested", "returned"]);

    observeDiscovery.mockClear();
    gateway.getMarketPricing = vi.fn().mockResolvedValueOnce(new Map());
    await (mod as any).pollDiscoveryBatch();
    expect(observeDiscovery.mock.calls.map((call) => call[1])).toEqual(["requested", "missing"]);

    observeDiscovery.mockClear();
    gateway.getMarketPricing = vi.fn().mockRejectedValueOnce(new Error("offline"));
    await expect((mod as any).pollDiscoveryBatch()).resolves.toBeUndefined();
    expect(observeDiscovery.mock.calls.map((call) => call[1])).toEqual([
      "requested",
      "request_failed",
    ]);
  });

  it("publishes MarketSnapshotHeartbeat for quiet full-lifetime active tokens", async () => {
    const tiered = makeTiered(["crit-1"], [], []);
    const repo = createMockRepo(tiered);
    const pricing = new Map<string, MarketPricingSnapshot>([["crit-1", makePricing()]]);
    gateway.getMarketPricing = vi.fn().mockResolvedValue(pricing);
    const heartbeats: Array<{ markets: readonly unknown[]; reason: string; source: string }> = [];
    const realSnapshots: Array<{ markets: readonly unknown[] }> = [];
    bus.subscribe("MarketSnapshotHeartbeat", async (payload) => {
      heartbeats.push(payload);
    });
    bus.subscribe("MarketSnapshotReceived", async (payload) => {
      realSnapshots.push(payload);
    });

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      fullLifetimeSnapshots: {
        enabled: true,
        heartbeatMs: 5 * 60 * 1000,
        postCloseGraceMs: 0,
        activePositionTokenIds: () => [createTokenId("crit-1")],
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(realSnapshots.length).toBeGreaterThanOrEqual(1);
    });
    realSnapshots.length = 0;

    await mod.poll();

    expect(realSnapshots).toHaveLength(0);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    expect(heartbeats[0]!.markets).toHaveLength(1);
    expect(heartbeats[0]!.markets[0]).toMatchObject({
      tokenId: createTokenId("crit-1"),
      bestBid: 0.4,
      bestAsk: 0.5,
    });

    await mod.stop();
  });

  it("hydrates active full-lifetime metadata without emitting a null-BBO heartbeat", async () => {
    const tiered = makeTiered([], [], []);
    const repo = createMockRepo(tiered);
    repo.findByTokenId = vi.fn().mockReturnValue(makeMarket("orphan-active"));
    const heartbeats: Array<{ markets: readonly NormalizedMarket[]; reason: string }> = [];
    const missingReasons: string[] = [];
    const hydratedReasons: string[] = [];
    const skippedReasons: string[] = [];
    bus.subscribe("MarketSnapshotHeartbeat", async (payload) => {
      heartbeats.push(payload);
    });

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      fullLifetimeSnapshots: {
        enabled: true,
        heartbeatMs: 5 * 60 * 1000,
        postCloseGraceMs: 0,
        activePositionTokenIds: () => [createTokenId("orphan-active")],
        recordMissingMarket: (reason) => missingReasons.push(reason),
        recordMarketCacheHydrated: (reason) => hydratedReasons.push(reason),
        recordSkippedSnapshot: (reason) => skippedReasons.push(reason),
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(skippedReasons).toEqual(["metadata_only_no_book"]);
    });

    expect(repo.findByTokenId).toHaveBeenCalledWith(createTokenId("orphan-active"));
    expect(heartbeats).toHaveLength(0);
    expect(missingReasons).toEqual([]);
    expect(hydratedReasons).toEqual(["cache_miss_hydrated"]);
    expect(skippedReasons).toEqual(["metadata_only_no_book"]);
    expect(silentLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("full-lifetime snapshot"),
    );

    await mod.stop();
  });

  it("continues full-lifetime heartbeat when one market lookup throws", async () => {
    const tiered = makeTiered(["cache-ok"], [], []);
    const repo = createMockRepo(tiered);
    const pricing = new Map<string, MarketPricingSnapshot>([["cache-ok", makePricing()]]);
    gateway.getMarketPricing = vi.fn().mockResolvedValue(pricing);
    repo.findByTokenId = vi.fn((tokenId) => {
      if (String(tokenId) === "lookup-throws") {
        throw new Error("sqlite interrupted");
      }
      return makeMarket(String(tokenId));
    });
    const heartbeats: Array<{ markets: readonly NormalizedMarket[]; reason: string }> = [];
    const missingReasons: string[] = [];
    bus.subscribe("MarketSnapshotHeartbeat", async (payload) => {
      heartbeats.push(payload);
    });

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      fullLifetimeSnapshots: {
        enabled: true,
        heartbeatMs: 5 * 60 * 1000,
        postCloseGraceMs: 0,
        activePositionTokenIds: () => [createTokenId("lookup-throws"), createTokenId("cache-ok")],
        recordMissingMarket: (reason) => missingReasons.push(reason),
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(missingReasons).toEqual(["market_lookup_error"]);
    });
    await mod.poll();
    await vi.waitFor(() => {
      expect(heartbeats).toHaveLength(1);
    });

    expect(heartbeats[0]!.markets).toHaveLength(1);
    expect(heartbeats[0]!.markets[0]!.tokenId).toBe(createTokenId("cache-ok"));
    expect(missingReasons).toEqual(["market_lookup_error"]);
    expect(silentLog.warn).toHaveBeenCalledTimes(1);
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "market_lookup_error",
      }),
      "full-lifetime snapshot active position token missing market cache",
    );

    await mod.stop();
  });

  it("does not warn-storm inactive full-lifetime tokens missing from the cache", async () => {
    const tiered = makeTiered([], [], []);
    const repo = createMockRepo(tiered);
    repo.findByTokenId = vi
      .fn()
      .mockReturnValue(makeMarket("inactive-token", { active: false, tradable: false }));
    const heartbeats: Array<{ markets: readonly NormalizedMarket[] }> = [];
    const missingReasons: string[] = [];
    const skippedReasons: string[] = [];
    bus.subscribe("MarketSnapshotHeartbeat", async (payload) => {
      heartbeats.push(payload);
    });

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      fullLifetimeSnapshots: {
        enabled: true,
        heartbeatMs: 5 * 60 * 1000,
        postCloseGraceMs: 0,
        activePositionTokenIds: () => [createTokenId("inactive-token")],
        recordMissingMarket: (reason) => missingReasons.push(reason),
        recordSkippedSnapshot: (reason) => skippedReasons.push(reason),
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(skippedReasons).toEqual(["inactive_or_untradable"]);
    });
    await mod.poll();

    expect(heartbeats).toHaveLength(0);
    expect(missingReasons).toEqual([]);
    expect(skippedReasons).toEqual(["inactive_or_untradable"]);
    expect(silentLog.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("full-lifetime snapshot"),
    );

    await mod.stop();
  });

  it("keeps missing market rows bounded and warning-rate-limited", async () => {
    const tiered = makeTiered([], [], []);
    const repo = createMockRepo(tiered);
    repo.findByTokenId = vi.fn().mockReturnValue(null);
    const missingReasons: string[] = [];

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      fullLifetimeSnapshots: {
        enabled: true,
        heartbeatMs: 5 * 60 * 1000,
        postCloseGraceMs: 0,
        activePositionTokenIds: () => [createTokenId("missing-market-row")],
        recordMissingMarket: (reason) => missingReasons.push(reason),
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(missingReasons).toEqual(["market_row_missing"]);
    });
    await mod.poll();

    expect(missingReasons).toEqual(["market_row_missing"]);
    expect(silentLog.warn).toHaveBeenCalledTimes(1);
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: "missing-market-row",
        reason: "market_row_missing",
      }),
      "full-lifetime snapshot active position token missing market cache",
    );

    await mod.stop();
  });

  it("invalidates tiered pricing cache only on full-lifetime active-state transitions", async () => {
    const tiered = makeTiered(["crit-1"], [], []);
    const repo = createMockRepo(tiered);
    gateway.getMarketPricing = vi.fn().mockResolvedValue(new Map());
    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      tieredPricingCacheTtlMs: 60_000,
      fullLifetimeSnapshots: {
        enabled: true,
        heartbeatMs: 5 * 60 * 1000,
        postCloseGraceMs: 0,
        activePositionTokenIds: () => [],
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(repo.findTrackedForPricingTiered).toHaveBeenCalledTimes(1);
    });
    await mod.poll();
    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledTimes(1);

    await bus.publish("PositionUpdated", { position: makePosition() });
    await vi.waitFor(() => {
      expect(repo.findTrackedForPricingTiered).toHaveBeenCalledTimes(2);
    });

    await bus.publish("PositionUpdated", {
      position: makePosition({ size: 12, updatedAt: "2026-06-11T00:01:00.000Z" }),
    });
    await mod.poll();
    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledTimes(2);

    await bus.publish("PositionUpdated", {
      position: makePosition({
        status: PositionStatus.Closed,
        size: 0,
        closedAt: "2026-06-11T00:02:00.000Z",
      }),
    });
    await vi.waitFor(() => {
      expect(repo.findTrackedForPricingTiered).toHaveBeenCalledTimes(3);
    });

    await mod.stop();
  });

  it("legacy flat path used when maxTrackedTokens is undefined", async () => {
    const tiered = makeTiered([], ["e1", "e2"], []);
    const repo = createMockRepo(tiered);

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      // no maxTrackedTokens
    });

    await mod.poll();

    expect(repo.findTrackedForPricing).toHaveBeenCalledTimes(1);
    expect(repo.findTrackedForPricingTiered).not.toHaveBeenCalled();
  });

  it("discovery poll loop calls getMarketPricing only for discovery tokens, in batches", async () => {
    vi.useFakeTimers();

    const discoveryIds = Array.from({ length: 10 }, (_, i) => `disc-${i}`);
    const tiered = makeTiered(["crit-1"], ["cand-1"], discoveryIds);
    const repo = createMockRepo(tiered);

    const getMarketPricing = vi.fn().mockResolvedValue(new Map());
    gateway.getMarketPricing = getMarketPricing;

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 4,
    });

    await mod.start();
    // Let the initial poll complete (it fires immediately in start()).
    await vi.advanceTimersByTimeAsync(1);
    getMarketPricing.mockClear();

    // Advance time to trigger one discovery poll cycle.
    await vi.advanceTimersByTimeAsync(10_000);

    // Discovery batch of 4 should have been polled.
    const discoveryCalls = getMarketPricing.mock.calls.filter((call) => {
      const ids: string[] = call[0] as string[];
      return ids.some((id) => id.startsWith("disc-"));
    });
    expect(discoveryCalls.length).toBeGreaterThanOrEqual(1);
    const firstBatch: string[] = discoveryCalls[0]![0] as string[];
    const [, opts] = discoveryCalls[0] as [string[], { timeoutMs?: number }];
    expect(firstBatch).toHaveLength(4);
    expect(opts?.timeoutMs).toBe(10_100);
    // All in batch are discovery tokens
    for (const id of firstBatch) {
      expect(id).toMatch(/^disc-/);
    }
    // WS tokens NOT in discovery batch
    expect(firstBatch).not.toContain("crit-1");
    expect(firstBatch).not.toContain("cand-1");

    await mod.stop();
  });

  it("caps Track G full-book subscriptions and reports skipped depth subscriptions", async () => {
    const tiered = makeTiered(["crit-1"], ["cand-1"], []);
    const repo = createMockRepo(tiered);
    const openPositionTokenIds = ["open-1", "open-2", "open-3", "open-4", "open-5"].map((id) =>
      createTokenId(id),
    );
    const setOpenPositionTokenIds = vi.fn();

    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 3,
      bookSignals: {
        openPositionTokenIds: () => openPositionTokenIds,
        setOpenPositionTokenIds,
        ingestTopOfBook: vi.fn(),
        ingestLastTradePrice: vi.fn(),
        ingestBook: vi.fn(),
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(stream).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(stream!.setFullBookTokenIdsCalls.length).toBeGreaterThanOrEqual(1);
    });

    expect(stream!.fullBookTokenIds).toEqual(["open-1", "open-2", "open-3"]);
    expect(setOpenPositionTokenIds).toHaveBeenCalledWith(openPositionTokenIds);
    expect(mod.getMetricsSnapshot()).toMatchObject({
      bookSignalFullBookDemandCount: 5,
      bookSignalFullBookSubscribedCount: 3,
      bookSignalFullBookSkippedCount: 2,
    });
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        demandCount: 5,
        subscribedCount: 3,
        skippedCount: 2,
        cap: 3,
      }),
      "Track G full-book subscription demand exceeds cap; depthTop3 degrades for skipped tokens",
    );

    await mod.stop();
  });

  it("tracks the extended trackedTokenIds for trade-stats but keeps full-book depth position-only", async () => {
    const tiered = makeTiered(["crit-1"], ["cand-1"], []);
    const repo = createMockRepo(tiered);
    const openPositionTokenIds = ["open-1", "open-2"].map((id) => createTokenId(id));
    // positions ∪ GATE-whitelist entry candidates (wl-*)
    const trackedTokenIds = ["open-1", "open-2", "wl-1", "wl-2"].map((id) => createTokenId(id));
    const setOpenPositionTokenIds = vi.fn();

    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 10,
      bookSignals: {
        openPositionTokenIds: () => openPositionTokenIds,
        trackedTokenIds: () => trackedTokenIds,
        setOpenPositionTokenIds,
        ingestTopOfBook: vi.fn(),
        ingestLastTradePrice: vi.fn(),
        ingestBook: vi.fn(),
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(stream).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(stream!.setFullBookTokenIdsCalls.length).toBeGreaterThanOrEqual(1);
    });

    // Trade-stats track-set = extended set (positions ∪ whitelist), so tradeCount3h accrues for entries.
    expect(setOpenPositionTokenIds).toHaveBeenCalledWith(trackedTokenIds);
    // Full-book depth subscription stays position-only — decoupled from the extended track-set.
    expect(stream!.fullBookTokenIds).toEqual(["open-1", "open-2"]);

    await mod.stop();
  });

  it("throttles repeated discovery poll failures while preserving batch context", async () => {
    vi.useFakeTimers();

    const tiered = makeTiered([], [], ["d0", "d1"]);
    const repo = createMockRepo(tiered);
    gateway.getMarketPricing = vi
      .fn()
      .mockRejectedValue(new Error("TimeoutError: operation was aborted due to timeout"));

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 2,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    silentLog.warn.mockClear();

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(silentLog.warn).toHaveBeenCalledTimes(1);
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        batchSize: 2,
        cursor: 0,
        discoveryTotal: 2,
        suppressedCount: 0,
      }),
      "discovery poll batch failed",
    );

    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(silentLog.warn).toHaveBeenCalledTimes(2);
    expect(silentLog.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        batchSize: 2,
        suppressedCount: expect.any(Number),
      }),
      "discovery poll batch failed",
    );
    const [lastContext] = silentLog.warn.mock.calls.at(-1)!;
    expect(lastContext.suppressedCount).toBeGreaterThan(0);

    await mod.stop();
  });

  it("backs off discovery pricing polls after Gamma 429 responses", async () => {
    vi.useFakeTimers();

    const tiered = makeTiered([], [], ["d0", "d1", "d2", "d3"]);
    const repo = createMockRepo(tiered);
    const getMarketPricing = vi
      .fn()
      .mockRejectedValue(new Error("Gamma pricing request failed: 429 Too Many Requests"));
    gateway.getMarketPricing = getMarketPricing;

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 2,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getMarketPricing).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(getMarketPricing).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(getMarketPricing).toHaveBeenCalledTimes(2);

    await mod.stop();
  });

  it("degrades main polling to cached stream state on Gamma 429 responses", async () => {
    vi.useFakeTimers();

    const tiered = makeTiered(["crit-1"], [], []);
    const repo = createMockRepo(tiered);
    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };
    gateway.getMarketPricing = vi
      .fn()
      .mockRejectedValue(new Error("Gamma pricing request failed: 429 Too Many Requests"));

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 2,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(silentLog.error).not.toHaveBeenCalledWith(expect.anything(), "poll cycle failed");
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        trackedCount: 1,
        fallbackPollCount: 1,
      }),
      "poll cycle degraded — keeping cached websocket state",
    );

    await mod.stop();
  });

  it("discovery cursor advances across poll cycles, wrapping at end of discovery list", async () => {
    vi.useFakeTimers();

    const discoveryIds = ["d0", "d1", "d2", "d3", "d4"];
    const tiered = makeTiered([], [], discoveryIds);
    const repo = createMockRepo(tiered);

    const polledBatches: string[][] = [];
    gateway.getMarketPricing = vi.fn().mockImplementation(async (ids: string[]) => {
      if (ids.some((id) => id.startsWith("d"))) {
        polledBatches.push([...ids]);
      }
      return new Map();
    });

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 2,
    });

    await mod.start();
    // Let the initial poll complete
    await vi.advanceTimersByTimeAsync(1);
    polledBatches.length = 0;

    // Run 3 discovery cycles: 2+2+1 = 5 tokens (all), then wrap
    await vi.advanceTimersByTimeAsync(10_000); // cycle 1: d0,d1
    await vi.advanceTimersByTimeAsync(10_000); // cycle 2: d2,d3
    await vi.advanceTimersByTimeAsync(10_000); // cycle 3: d4 (wraps)
    await vi.advanceTimersByTimeAsync(10_000); // cycle 4: d0,d1 again

    expect(polledBatches.length).toBeGreaterThanOrEqual(3);
    // Each batch has at most 2 tokens
    for (const batch of polledBatches) {
      expect(batch.length).toBeLessThanOrEqual(2);
    }
    // Across the first 3 batches, all 5 discovery tokens should be covered
    const allPolled = new Set(polledBatches.flat());
    for (const id of discoveryIds) {
      expect(allPolled.has(id)).toBe(true);
    }

    await mod.stop();
  });

  it("stop() clears the discovery timer — no more discovery polls after stop", async () => {
    vi.useFakeTimers();

    const discoveryIds = ["d0", "d1", "d2"];
    const tiered = makeTiered([], [], discoveryIds);
    const repo = createMockRepo(tiered);

    const getMarketPricing = vi.fn().mockResolvedValue(new Map());
    gateway.getMarketPricing = getMarketPricing;

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 10,
    });

    await mod.start();
    // Let the initial poll complete
    await vi.advanceTimersByTimeAsync(1);
    getMarketPricing.mockClear();

    // Stop the module
    await mod.stop();

    // Advance time significantly — no discovery polls should fire
    const callCountBefore = getMarketPricing.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100_000);
    const callCountAfter = getMarketPricing.mock.calls.length;

    expect(callCountAfter - callCountBefore).toBe(0);
  });

  it("discovery tokens absent from getMetricsSnapshot().trackedTokenCount", async () => {
    const tiered = makeTiered(["c1"], ["e1", "e2"], ["d1", "d2", "d3"]);
    const repo = createMockRepo(tiered);

    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
    });

    await mod.poll();

    const snapshot = mod.getMetricsSnapshot();
    // trackedTokenCount comes from the WS stream (3 tokens: c1+e1+e2)
    expect(snapshot.trackedTokenCount).toBe(3);

    await mod.stop();
  });

  it("shadow mode (default) never re-homes planktonSignature markets — not WS-tracked, not added to discoveryTier beyond baseline — but still records coverage", async () => {
    vi.useFakeTimers();

    const tiered: TrackedForPricing = {
      executionCritical: [makeMarket("crit-1")],
      // In shadow mode these are a measurement projection only (spec
      // 2026-07-02): the repo call used reserveSignature: false, so sig-1/
      // sig-2 were never pulled out of entryCandidates/discoveryOnly — they
      // simply didn't win a V4 slot on their own merit in this fixture.
      planktonSignature: [makeMarket("sig-1"), makeMarket("sig-2")],
      entryCandidates: [makeMarket("cand-1")],
      discoveryOnly: [makeMarket("disc-1")],
      signatureOverflow: 5,
    };
    const repo = createMockRepo(tiered);
    const coverageCalls: Array<[string, number, string]> = [];

    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };
    const getMarketPricing = vi.fn().mockResolvedValue(new Map());
    gateway.getMarketPricing = getMarketPricing;

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 10_000,
      discoveryBatchSize: 10,
      // signatureTierMode intentionally omitted — must default to "shadow".
      recordSignatureCoverage: (inLiveTier, count, mode) => {
        coverageCalls.push([inLiveTier, count, mode]);
      },
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);

    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledWith({
      maxTokens: 1000,
      reserveSignature: false,
    });

    // WS tier is exactly executionCritical + entryCandidates — the baseline
    // shape, with no reserved signature slots.
    const lastCall = stream!.setTokenIdsCalls.at(-1)!;
    const wsTokenSet = new Set(lastCall);
    expect(wsTokenSet.has("crit-1")).toBe(true);
    expect(wsTokenSet.has("cand-1")).toBe(true);
    expect(wsTokenSet.has("sig-1")).toBe(false);
    expect(wsTokenSet.has("sig-2")).toBe(false);

    // Not role-tagged planktonSignature either.
    const snapshot = mod.getMetricsSnapshot();
    expect(snapshot.trackedRoleCounts.planktonSignature).toBe(0);
    expect(snapshot.trackedRoleCounts.executionCritical).toBe(1);
    expect(snapshot.trackedRoleCounts.entryCandidate).toBe(1);

    // Coverage metric is still emitted, labeled with the shadow mode.
    expect(coverageCalls).toContainEqual(["yes", 2, "shadow"]);
    expect(coverageCalls).toContainEqual(["no", 5, "shadow"]);

    // The critical invariant: discoveryTier must be `discoveryOnly` verbatim,
    // NOT `[...planktonSignature, ...discoveryOnly]`. Advance to the next
    // discovery poll batch and confirm sig-1/sig-2 are never polled — only
    // disc-1 (the baseline discoveryOnly set) is.
    getMarketPricing.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);

    const polledIds = getMarketPricing.mock.calls.flatMap((call) => call[0] as string[]);
    expect(polledIds).toContain("disc-1");
    expect(polledIds).not.toContain("sig-1");
    expect(polledIds).not.toContain("sig-2");

    await mod.stop();
  });

  it("live mode feeds planktonSignature into the WS tier and tags the role", async () => {
    const tiered: TrackedForPricing = {
      executionCritical: [makeMarket("crit-1")],
      planktonSignature: [makeMarket("sig-1"), makeMarket("sig-2")],
      entryCandidates: [makeMarket("cand-1")],
      discoveryOnly: [makeMarket("disc-1")],
      signatureOverflow: 5,
    };
    const repo = createMockRepo(tiered);
    const coverageCalls: Array<[string, number, string]> = [];

    gateway.createMarketPricingStream = (handlers) => {
      stream = new FakePricingStream(handlers);
      return stream;
    };

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      signatureTierMode: "live",
      recordSignatureCoverage: (inLiveTier, count, mode) => {
        coverageCalls.push([inLiveTier, count, mode]);
      },
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(stream).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(stream!.setTokenIdsCalls.length).toBeGreaterThanOrEqual(1);
    });

    const lastCall = stream!.setTokenIdsCalls.at(-1)!;
    const wsTokenSet = new Set(lastCall);
    expect(wsTokenSet.has("sig-1")).toBe(true);
    expect(wsTokenSet.has("sig-2")).toBe(true);

    const snapshot = mod.getMetricsSnapshot();
    expect(snapshot.trackedRoleCounts.planktonSignature).toBe(2);

    expect(coverageCalls).toContainEqual(["yes", 2, "live"]);
    expect(coverageCalls).toContainEqual(["no", 5, "live"]);

    await mod.stop();
  });
});
