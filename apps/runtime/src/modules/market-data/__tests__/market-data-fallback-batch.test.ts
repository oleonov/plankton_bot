/**
 * Task 5 — Fallback-batch cap and dynamic timeout tests for MarketDataModule.
 *
 * Verifies:
 * 1. Under forceFullPoll=true, only priority tokens (executionCritical + entryCandidates)
 *    are polled — discovery tokens are excluded.
 * 2. The timeoutMs passed to getMarketPricing scales as
 *    min(30_000, 5_000 + batchLength * 10).
 * 3. When priority tier exceeds fallbackBatchSize, the batch is trimmed to the
 *    cap and a warn log fires.
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
    eventMarketCount: 1,
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
  private readonly metrics: MarketPricingStreamMetricsSnapshot = {
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

  // Capture gap handler for tests that need to trigger forceFullPoll.
  private _onGapDetected:
    | ((
        gap: Readonly<{
          reason: "socket-closed" | "invalid-payload" | "connect-failed";
          timestamp: number;
          tokenIds?: readonly string[];
        }>,
      ) => Promise<void> | void)
    | undefined = undefined;

  constructor(
    handlers: Readonly<{
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
  ) {
    this._onGapDetected = handlers.onGapDetected;
  }

  async triggerGap(reason: "socket-closed" | "invalid-payload" | "connect-failed"): Promise<void> {
    await this._onGapDetected?.({ reason, timestamp: Date.now() });
  }

  setTokenIds(tokenIds: readonly string[]): void {
    this.tokenIds = [...tokenIds];
  }

  close(): void {
    this.tokenIds = [];
  }

  getMetricsSnapshot(): MarketPricingStreamMetricsSnapshot {
    return { ...this.metrics, trackedTokenCount: this.tokenIds.length };
  }
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
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ─── Tests ────────────────────────────────────────────────────────────────

describe("MarketDataModule — fallback batch cap (Task 5)", () => {
  let bus: InProcessEventBus;
  let streamRef: FakePricingStream | null;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new InProcessEventBus();
    streamRef = null;
    silentLog.info.mockClear();
    silentLog.warn.mockClear();
    silentLog.error.mockClear();
    silentLog.debug.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Test 1: Priority-only under forceFullPoll ───────────────────────────

  it("forceFullPoll=true: polls only priority tier; discovery tokens excluded", async () => {
    const priorityIds = Array.from({ length: 50 }, (_, i) => `prio-${i}`);
    const discoveryIds = Array.from({ length: 9_000 }, (_, i) => `disc-${i}`);
    const tiered = makeTiered(priorityIds.slice(0, 25), priorityIds.slice(25), discoveryIds);
    const repo = createMockRepo(tiered);

    const getMarketPricing = vi.fn().mockResolvedValue(new Map());

    const gateway: MarketDataGateway = {
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
      getMarketPricing,
      createMarketPricingStream: (handlers) => {
        const s = new FakePricingStream(handlers);
        streamRef = s;
        return s;
      },
    };

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 3_600_000, // prevent discovery timer from firing
      discoveryBatchSize: 200,
      fallbackBatchSize: 500,
    });

    await mod.start();
    // Let the initial poll complete.
    await vi.advanceTimersByTimeAsync(1);
    expect(streamRef).not.toBeNull();
    getMarketPricing.mockClear();

    // Trigger forceFullPoll by simulating a gap with no specific token IDs.
    await streamRef!.triggerGap("socket-closed");

    // Advance past the gap log debounce.
    await vi.advanceTimersByTimeAsync(300);

    // Trigger the main poll cycle.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(getMarketPricing).toHaveBeenCalledTimes(1);
    const [calledIds] = getMarketPricing.mock.calls[0] as [string[], unknown];

    // Must contain ALL priority tokens.
    for (const id of priorityIds) {
      expect(calledIds).toContain(id);
    }
    // Must NOT contain any discovery token.
    for (const id of calledIds) {
      expect(id).not.toMatch(/^disc-/);
    }
    expect(calledIds).toHaveLength(50);

    await mod.stop();
  });

  // ── Test 2: Dynamic timeout scaling ────────────────────────────────────

  it("timeoutMs scales proportionally: 5_000 + length*10, capped at 30_000", async () => {
    // We use the legacy flat path (no maxTrackedTokens) so we can precisely
    // control the size of the poll batch by returning exactly the right tokens.

    // ── Case A: batch length 100 → expected timeout = 6_000 ──────────────
    const ids100 = Array.from({ length: 100 }, (_, i) => `tok-${i}`);

    const getMarketPricingA = vi.fn().mockResolvedValue(new Map());
    const repoA: MarketRepository = createMockRepo(makeTiered([], [], []));
    // Override flat path to return exactly 100 tokens.
    (repoA.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(
      ids100.map((id) => makeMarket(id)),
    );

    const gatewayA: MarketDataGateway = {
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
      getMarketPricing: getMarketPricingA,
      // No createMarketPricingStream → no stream → forceFullPoll path is taken every cycle.
    };

    const modA = new MarketDataModule({
      gateway: gatewayA,
      marketRepo: repoA,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      // no maxTrackedTokens → legacy flat path
      fallbackBatchSize: 500,
    });

    await modA.poll();

    expect(getMarketPricingA).toHaveBeenCalledTimes(1);
    const [, optsA] = getMarketPricingA.mock.calls[0] as [string[], { timeoutMs?: number }];
    expect(optsA?.timeoutMs).toBe(6_000); // 5_000 + 100 * 10

    await modA.stop();

    // ── Case B: batch length 2500 → timeout would be 30_000 (capped) ─────
    const ids2500 = Array.from({ length: 2_500 }, (_, i) => `big-${i}`);

    const getMarketPricingB = vi.fn().mockResolvedValue(new Map());
    const repoB: MarketRepository = createMockRepo(makeTiered([], [], []));
    (repoB.findTrackedForPricing as ReturnType<typeof vi.fn>).mockReturnValue(
      ids2500.map((id) => makeMarket(id)),
    );

    const gatewayB: MarketDataGateway = {
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
      getMarketPricing: getMarketPricingB,
    };

    const busB = new InProcessEventBus();
    const modB = new MarketDataModule({
      gateway: gatewayB,
      marketRepo: repoB,
      bus: busB,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      fallbackBatchSize: 3_000, // allow large batch through for timeout test
    });

    await modB.poll();

    expect(getMarketPricingB).toHaveBeenCalledTimes(1);
    const [, optsB] = getMarketPricingB.mock.calls[0] as [string[], { timeoutMs?: number }];
    // 5_000 + 2_500 * 10 = 30_000 — exactly at the cap.
    expect(optsB?.timeoutMs).toBe(30_000);

    await modB.stop();
  });

  // ── Test 3: Defensive cap trims batch and fires warn ───────────────────

  it("defensive cap: priority tier exceeding fallbackBatchSize is trimmed + warn logged", async () => {
    // 600 priority tokens, fallbackBatchSize = 500 → expect trim to 500 + warn.
    const priorityIds = Array.from({ length: 600 }, (_, i) => `prio-${i}`);
    const tiered = makeTiered(priorityIds.slice(0, 300), priorityIds.slice(300), []);
    const repo = createMockRepo(tiered);

    const capturedIds: string[][] = [];
    const getMarketPricing = vi.fn().mockImplementation(async (ids: string[]) => {
      capturedIds.push([...ids]);
      return new Map();
    });

    const gateway: MarketDataGateway = {
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
      getMarketPricing,
      createMarketPricingStream: (handlers) => {
        const s = new FakePricingStream(handlers);
        streamRef = s;
        return s;
      },
    };

    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 60_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(streamRef).not.toBeNull();
    getMarketPricing.mockClear();
    capturedIds.length = 0;
    silentLog.warn.mockClear();

    // Trigger forceFullPoll.
    await streamRef!.triggerGap("socket-closed");
    await vi.advanceTimersByTimeAsync(300); // debounce
    await vi.advanceTimersByTimeAsync(60_000); // poll interval

    expect(getMarketPricing).toHaveBeenCalledTimes(1);
    const [polledIds] = capturedIds[0]!;

    // Batch must be trimmed to cap.
    expect(capturedIds[0]).toHaveLength(500);

    // Warn log must fire with tokenCount and cap fields.
    const warnCalls = silentLog.warn.mock.calls as Array<[unknown, string]>;
    const capWarn = warnCalls.find(
      ([, msg]) => typeof msg === "string" && msg.includes("fallbackBatchSize cap"),
    );
    expect(capWarn).toBeDefined();
    const [warnMeta] = capWarn!;
    expect((warnMeta as Record<string, unknown>).tokenCount).toBe(600);
    expect((warnMeta as Record<string, unknown>).cap).toBe(500);

    // Suppress unused variable lint.
    void polledIds;

    await mod.stop();
  });
});
