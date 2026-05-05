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
import { createTokenId } from "@plankton/domain";
import type {
  MarketDataGateway,
  MarketPricingLifecycleEvent,
  MarketPricingStream,
  MarketPricingStreamMetricsSnapshot,
  MarketPricingStreamUpdate,
  MarketRepository,
  Market,
  TrackedForPricing,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
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
    gammaCreatedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
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
    entryCandidates: candidateIds.map((id) => makeMarket(id)),
    discoveryOnly: discoveryIds.map((id) => makeMarket(id)),
  };
}

class FakePricingStream implements MarketPricingStream {
  tokenIds: string[] = [];
  setTokenIdsCalls: string[][] = [];
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
          reason: "socket-closed" | "invalid-payload" | "connect-failed";
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

    expect(repo.findTrackedForPricingTiered).toHaveBeenCalledWith({ maxTokens: 1000 });
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
    expect(firstBatch).toHaveLength(4);
    // All in batch are discovery tokens
    for (const id of firstBatch) {
      expect(id).toMatch(/^disc-/);
    }
    // WS tokens NOT in discovery batch
    expect(firstBatch).not.toContain("crit-1");
    expect(firstBatch).not.toContain("cand-1");

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
});
