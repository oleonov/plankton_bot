/**
 * Task 5 — Fallback-batch cap and dynamic timeout tests for MarketDataModule.
 *
 * Verifies:
 * 1. Under forceFullPoll=true, only priority tokens (executionCritical + entryCandidates)
 *    are polled — discovery tokens are excluded.
 * 2. The timeoutMs passed to getMarketPricing scales as
 *    min(30_000, 10_000 + batchLength * 25).
 * 3. When priority tier exceeds bounded fallback caps, the batch is trimmed and
 *    a warn log fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId } from "@krabs/domain";
import type {
  MarketDataGateway,
  MarketPricingLifecycleEvent,
  MarketPricingStream,
  MarketPricingStreamMetricsSnapshot,
  MarketPricingStreamUpdate,
  MarketRepository,
  Market,
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
          reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout";
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
          reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout";
          timestamp: number;
          tokenIds?: readonly string[];
        }>,
      ) => Promise<void> | void;
    }>,
  ) {
    this._onGapDetected = handlers.onGapDetected;
  }

  async triggerGap(
    reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout",
  ): Promise<void> {
    await this._onGapDetected?.({ reason, timestamp: Date.now() });
  }

  async triggerGapForTokenIds(tokenIds: readonly string[]): Promise<void> {
    await this._onGapDetected?.({ reason: "socket-closed", timestamp: Date.now(), tokenIds });
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
    updateTickSize: vi.fn(),
  };
}

/**
 * A gateway that deliberately OMITS `createMarketPricingStream`, so `this.stream` stays null and
 * every poll takes the `streamUnavailable` branch — the branch that offers every tracked token as
 * a candidate on every cycle, with no refresh budget and no per-token backoff. That is the only
 * surface on which a selection order can starve a token permanently rather than merely delay it.
 */
function createStreamlessGateway(onPricingPoll: (batch: string[]) => void): MarketDataGateway {
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
    getMarketPricing: vi.fn().mockImplementation(async (batch: string[]) => {
      onPricingPoll(batch);
      return new Map();
    }),
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

  it("poll publishes only changed polled markets, not the full tracked cache", async () => {
    const tiered = makeTiered(["crit-a"], ["entry-a"], []);
    const repo = createMockRepo(tiered);
    const published: string[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (payload) => {
      published.push(payload.markets.map((market) => String(market.tokenId)));
    });

    const getMarketPricing = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(
        new Map([
          [
            "crit-a",
            {
              tokenId: createTokenId("crit-a"),
              bestBid: 0.1,
              bestAsk: 0.12,
              midPrice: 0.11,
              spread: 0.02,
              acceptingOrders: true,
              enableOrderBook: true,
              timestamp: Date.now(),
            },
          ],
        ]),
      );
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
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      fallbackPollMaxConcurrency: 1,
      fallbackPollRatePerSec: 5,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    published.length = 0;

    await streamRef!.triggerGapForTokenIds(["crit-a", "entry-a"]);
    await mod.poll();

    expect(published).toEqual([["crit-a"]]);
    await mod.stop();
  });

  it("does not overwrite cached pricing when REST fallback returns null pricing", async () => {
    const tiered = makeTiered(["crit-a"], [], []);
    const repo = createMockRepo(tiered);
    const published: string[][] = [];
    bus.subscribe("MarketSnapshotReceived", async (payload) => {
      published.push(payload.markets.map((market) => String(market.tokenId)));
    });

    const getMarketPricing = vi
      .fn()
      .mockResolvedValueOnce(new Map())
      .mockResolvedValueOnce(
        new Map([
          [
            "crit-a",
            {
              tokenId: createTokenId("crit-a"),
              bestBid: 0.1,
              bestAsk: 0.12,
              midPrice: 0.11,
              spread: 0.02,
              acceptingOrders: true,
              enableOrderBook: true,
              timestamp: Date.now(),
            },
          ],
        ]),
      )
      .mockResolvedValueOnce(new Map());
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
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      fallbackPollMaxConcurrency: 1,
      fallbackPollRatePerSec: 5,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    published.length = 0;

    await streamRef!.triggerGapForTokenIds(["crit-a"]);
    await mod.poll();
    expect(published).toEqual([["crit-a"]]);

    published.length = 0;
    await streamRef!.triggerGapForTokenIds(["crit-a"]);
    await mod.poll();

    expect(published).toEqual([]);
    expect(silentLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ nullPricingGateCount: 1, changedMarketCount: 0 }),
      "poll cycle complete",
    );
    await mod.stop();
  });

  // ── Test 2: Dynamic timeout scaling ────────────────────────────────────

  it("timeoutMs scales proportionally: 10_000 + length*25, capped at 30_000", async () => {
    // We use the legacy flat path (no maxTrackedTokens) so we can precisely
    // control the size of the poll batch by returning exactly the right tokens.

    // ── Case A: batch length 100 → expected timeout = 12_500 ─────────────
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
      fallbackPollMaxConcurrency: 500,
      fallbackPollRatePerSec: 100,
    });

    await modA.poll();

    expect(getMarketPricingA).toHaveBeenCalledTimes(1);
    const [, optsA] = getMarketPricingA.mock.calls[0] as [string[], { timeoutMs?: number }];
    expect(optsA?.timeoutMs).toBe(12_500);

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
      fallbackPollMaxConcurrency: 3_000,
      fallbackPollRatePerSec: 1_000,
    });

    await modB.poll();

    expect(getMarketPricingB).toHaveBeenCalledTimes(1);
    const [, optsB] = getMarketPricingB.mock.calls[0] as [string[], { timeoutMs?: number }];
    expect(optsB?.timeoutMs).toBe(30_000);

    await modB.stop();
  });

  it.each([
    ["network timeout", "TimeoutError: operation was aborted due to timeout"],
    ["Gamma pricing 5xx", "Gamma pricing request failed: 500 Internal Server Error"],
  ])("degrades %s to cached/base stream state without error logs", async (_caseName, message) => {
    const tiered = makeTiered(["prio-a"], ["prio-b"], []);
    const repo = createMockRepo(tiered);

    const getMarketPricing = vi.fn().mockRejectedValue(new Error(message));

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

    expect(silentLog.error).not.toHaveBeenCalledWith(expect.anything(), "poll cycle failed");
    expect(silentLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ trackedCount: 2, fallbackPollCount: 2 }),
      "poll cycle degraded — keeping cached websocket state",
    );

    await mod.stop();
  });

  it("throttles repeated cached-state degradation warnings", async () => {
    const tiered = makeTiered(["prio-a"], ["prio-b"], []);
    const repo = createMockRepo(tiered);
    const getMarketPricing = vi
      .fn()
      .mockRejectedValue(new Error("TimeoutError: operation was aborted due to timeout"));

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
      pollIntervalMs: 3_600_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 1000,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
    });

    await mod.start();
    await vi.waitFor(() => {
      expect(silentLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          trackedCount: 2,
          fallbackPollCount: 2,
          suppressedCount: 0,
        }),
        "poll cycle degraded — keeping cached websocket state",
      );
    });

    await mod.poll();

    expect(silentLog.warn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await mod.poll();

    expect(silentLog.warn).toHaveBeenCalledTimes(2);
    const [lastContext] = silentLog.warn.mock.calls.at(-1)!;
    expect(lastContext.suppressedCount).toBeGreaterThan(0);
    expect(silentLog.error).not.toHaveBeenCalledWith(expect.anything(), "poll cycle failed");

    await mod.stop();
  });

  // ── Test 3: Defensive cap trims batch and fires warn ───────────────────

  it("defensive cap: priority tier exceeding bounded fallback limit is trimmed + warn logged", async () => {
    // 600 priority tokens, fallbackBatchSize = 500 and concurrency = 50 → expect trim to 50.
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
      fallbackPollMaxConcurrency: 50,
      fallbackPollRatePerSec: 5,
      tieredPricingCacheTtlMs: 0,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(streamRef).not.toBeNull();
    getMarketPricing.mockClear();
    capturedIds.length = 0;

    // Trigger forceFullPoll.
    await streamRef!.triggerGap("socket-closed");
    await vi.advanceTimersByTimeAsync(300); // debounce
    await vi.advanceTimersByTimeAsync(60_000); // poll interval

    expect(getMarketPricing).toHaveBeenCalledTimes(1);
    const [polledIds] = capturedIds[0]!;

    // Batch must be trimmed to the bounded cap.
    expect(capturedIds[0]).toHaveLength(50);

    // Cap warn logs once and then throttles repeated poll-cycle exceedances.
    const warnCalls = silentLog.warn.mock.calls as Array<[unknown, string]>;
    const capWarn = warnCalls.find(
      ([, msg]) => typeof msg === "string" && msg.includes("bounded rate cap"),
    );
    expect(capWarn).toBeDefined();
    const [warnMeta] = capWarn!;
    expect((warnMeta as Record<string, unknown>).candidateCount).toBe(600);
    expect((warnMeta as Record<string, unknown>).limit).toBe(50);
    expect((warnMeta as Record<string, unknown>).suppressedCount).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);

    const capWarnsAfterNextPoll = (silentLog.warn.mock.calls as Array<[unknown, string]>).filter(
      ([, msg]) => typeof msg === "string" && msg.includes("bounded rate cap"),
    );
    expect(capWarnsAfterNextPoll).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15 * 60_000);

    const throttledCapWarns = (silentLog.warn.mock.calls as Array<[unknown, string]>).filter(
      ([, msg]) => typeof msg === "string" && msg.includes("bounded rate cap"),
    );
    expect(throttledCapWarns.length).toBeGreaterThanOrEqual(2);
    const [throttledWarnMeta] = throttledCapWarns.at(-1)!;
    expect((throttledWarnMeta as Record<string, unknown>).suppressedCount).toBeGreaterThan(0);

    // Suppress unused variable lint.
    void polledIds;

    await mod.stop();
  });

  it("resets fallback cap warning throttle when backlog returns under cap", async () => {
    const overCapIds = Array.from({ length: 600 }, (_, i) => `over-${i}`);
    const underCapIds = Array.from({ length: 10 }, (_, i) => `under-${i}`);
    const overCapTiered = makeTiered(overCapIds.slice(0, 300), overCapIds.slice(300), []);
    const underCapTiered = makeTiered(underCapIds, [], []);
    const repo = createMockRepo(underCapTiered);
    const findTrackedForPricingTiered = vi.mocked(repo.findTrackedForPricingTiered);
    const findTrackedForPricing = vi.mocked(repo.findTrackedForPricing);

    const capturedIds: string[][] = [];
    const getMarketPricing = vi.fn().mockImplementation(async (polled: string[]) => {
      capturedIds.push([...polled]);
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
      fallbackPollMaxConcurrency: 50,
      fallbackPollRatePerSec: 5,
      tieredPricingCacheTtlMs: 0,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    silentLog.warn.mockClear();
    getMarketPricing.mockClear();
    capturedIds.length = 0;

    findTrackedForPricingTiered.mockReturnValue(overCapTiered);
    findTrackedForPricing.mockReturnValue([
      ...overCapTiered.executionCritical,
      ...overCapTiered.entryCandidates,
    ]);
    await vi.advanceTimersByTimeAsync(1);
    await streamRef!.triggerGap("socket-closed");
    await mod.poll();

    expect(capturedIds.at(-1)).toHaveLength(50);
    let capWarns = (silentLog.warn.mock.calls as Array<[unknown, string]>).filter(
      ([, msg]) => typeof msg === "string" && msg.includes("bounded rate cap"),
    );
    expect(capWarns).toHaveLength(1);
    expect((capWarns[0]![0] as Record<string, unknown>).suppressedCount).toBe(0);

    findTrackedForPricingTiered.mockReturnValue(underCapTiered);
    findTrackedForPricing.mockReturnValue([
      ...underCapTiered.executionCritical,
      ...underCapTiered.entryCandidates,
    ]);
    await vi.advanceTimersByTimeAsync(1);
    await mod.poll();

    expect(capturedIds.at(-1)).toHaveLength(10);
    capWarns = (silentLog.warn.mock.calls as Array<[unknown, string]>).filter(
      ([, msg]) => typeof msg === "string" && msg.includes("bounded rate cap"),
    );
    expect(capWarns).toHaveLength(1);

    findTrackedForPricingTiered.mockReturnValue(overCapTiered);
    findTrackedForPricing.mockReturnValue([
      ...overCapTiered.executionCritical,
      ...overCapTiered.entryCandidates,
    ]);
    await vi.advanceTimersByTimeAsync(1);
    await mod.poll();

    expect(capturedIds.at(-1)).toHaveLength(50);
    capWarns = (silentLog.warn.mock.calls as Array<[unknown, string]>).filter(
      ([, msg]) => typeof msg === "string" && msg.includes("bounded rate cap"),
    );
    expect(capWarns).toHaveLength(2);
    expect((capWarns[1]![0] as Record<string, unknown>).suppressedCount).toBe(0);

    await mod.stop();
  });

  it("prioritizes execution-critical fallback work before entry candidates", async () => {
    const criticalIds = ["crit-a", "crit-b", "crit-c"];
    const entryIds = ["entry-a", "entry-b", "entry-c"];
    const tiered = makeTiered(criticalIds, entryIds, []);
    const repo = createMockRepo(tiered);
    const capturedIds: string[][] = [];
    const getMarketPricing = vi.fn().mockImplementation(async (polled: string[]) => {
      capturedIds.push([...polled]);
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
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      fallbackPollMaxConcurrency: 4,
      fallbackPollRatePerSec: 5,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    getMarketPricing.mockClear();
    capturedIds.length = 0;

    await streamRef!.triggerGap("socket-closed");
    await mod.poll();

    // The whole critical tier survives the cap, and the leftover slot goes to
    // `entry-b`, not `entry-a`: the start() poll already spent its fourth slot
    // on `entry-a`, so the least-recently-polled tie-break hands this one to a
    // peer that has never been polled. That is the anti-starvation walk, and it
    // is deterministic — not a rotation whose landing spot depends on which
    // candidates happen to be eligible this cycle.
    expect(capturedIds[0]).toEqual([...criticalIds, "entry-b"]);

    await mod.stop();
  });

  it("prioritizes plankton-signature fallback work ahead of entry candidates", async () => {
    const criticalIds = ["crit-a"];
    const signatureIds = ["sig-a", "sig-b"];
    const entryIds = ["entry-a", "entry-b"];
    const tiered: TrackedForPricing = {
      executionCritical: criticalIds.map((id) => makeMarket(id)),
      planktonSignature: signatureIds.map((id) => makeMarket(id)),
      entryCandidates: entryIds.map((id) => makeMarket(id)),
      discoveryOnly: [],
      signatureOverflow: 0,
    };
    const repo = createMockRepo(tiered);
    const capturedIds: string[][] = [];
    const getMarketPricing = vi.fn().mockImplementation(async (polled: string[]) => {
      capturedIds.push([...polled]);
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
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      // Cap below the full candidate count (5) so priority ordering decides who survives.
      fallbackPollMaxConcurrency: 4,
      fallbackPollRatePerSec: 5,
      // This test exercises live-tier fallback prioritization for
      // planktonSignature tokens — shadow mode (the new default) would
      // route them to discovery instead, so opt into "live" explicitly.
      signatureTierMode: "live",
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    getMarketPricing.mockClear();
    capturedIds.length = 0;

    await streamRef!.triggerGap("socket-closed");
    await mod.poll();

    // Same tie-break as above: `entry-a` took the start() poll's last slot, so
    // the never-polled `entry-b` wins this one.
    expect(capturedIds[0]).toEqual([...criticalIds, ...signatureIds, "entry-b"]);

    await mod.stop();
  });

  it("over-limit same-role candidates are all eventually polled (no permanent starvation)", async () => {
    // The gateway advertises no pricing stream, so `this.stream` stays null and
    // every poll takes the `streamUnavailable` branch. That branch is the one
    // real permanent-starvation surface: it pushes EVERY tracked token as a
    // candidate unconditionally — no refresh budget, no per-token backoff — so
    // the same 101 candidates are eligible at every single poll forever.
    //
    // Under a stable sort by role alone, the first 25 therefore win all 25
    // slots on every cycle and tok-25..tok-100 are never polled at all — their
    // pricing goes permanently stale while the module reports healthy polling.
    // (The budget-gated branches do not starve: a polled token's backoff hands
    // the next slot to its peers, which is why the bug hides until the stream
    // is gone.)
    //
    // Assert the property that actually matters — every candidate gets served —
    // rather than one exact sequence, so the test stays honest about the goal
    // instead of pinning today's tie-break.
    const ids = Array.from({ length: 101 }, (_, i) => `tok-${i}`);
    const tiered = makeTiered(ids, [], []);
    const repo = createMockRepo(tiered);
    const polled: string[] = [];
    const getMarketPricing = vi.fn().mockImplementation(async (batch: string[]) => {
      polled.push(...batch);
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
      // Deliberately absent: `createMarketPricingStream` is optional on the
      // gateway, and its absence is what pins every poll to the branch under
      // test.
    };
    const mod = new MarketDataModule({
      gateway,
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 200,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      fallbackPollMaxConcurrency: 25,
      fallbackPollRatePerSec: 5,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);

    // 30 cycles is far more than the five a fair walk needs to cover 101 tokens
    // at 25 a cycle — a token missing after that is starved, not waiting.
    for (let cycle = 0; cycle < 30; cycle += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      await mod.poll();
    }

    expect([...new Set(polled)].sort()).toEqual([...ids].sort());

    await mod.stop();
  });

  it("a lower-role candidate is not starved by a continuously eligible higher-role one", async () => {
    // Least-recently-polled ordering only settles ties WITHIN a role — the priority term dominates
    // it. With a single fallback slot and one always-eligible `executionCritical`, the
    // `entryCandidate` loses every cycle forever no matter how long it has waited, and a token
    // that is never polled is a token whose pending hydration never lands (the unknown-minimum
    // exit block is exactly that). Coverage, not order, is the property under test.
    const repo = createMockRepo(makeTiered(["crit-0"], ["entry-0"], []));
    const polled: string[] = [];
    const mod = new MarketDataModule({
      gateway: createStreamlessGateway((batch) => polled.push(...batch)),
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 200,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      // One slot: the whole point is that the two candidates must SHARE it.
      fallbackPollMaxConcurrency: 1,
      fallbackPollRatePerSec: 5,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    for (let cycle = 0; cycle < 30; cycle += 1) {
      await vi.advanceTimersByTimeAsync(5_000);
      await mod.poll();
    }

    expect(polled).toContain("crit-0");
    expect(polled).toContain("entry-0");

    await mod.stop();
  });

  it("a resident candidate is not starved by a stream of newly admitted peers", async () => {
    // The rotation key must mean "waiting since", not "never polled". Defaulted to 0, a newcomer
    // sorts ahead of every peer that has ever been polled — so one fresh token per cycle (the
    // tracked set churns constantly) hands the single slot to a different newcomer forever while
    // the resident, whose stamp is positive, never wins again.
    let cycle = 0;
    const repo = createMockRepo(makeTiered([], [], []));
    const tieredForCycle = () => makeTiered([], ["resident", `new-${cycle}`], []);
    repo.findTrackedForPricingTiered = vi.fn().mockImplementation(tieredForCycle);
    repo.findTrackedForPricing = vi.fn().mockImplementation(() => {
      const tiered = tieredForCycle();
      return [...tiered.executionCritical, ...tiered.entryCandidates];
    });

    const polledByCycle: string[][] = [];
    const mod = new MarketDataModule({
      gateway: createStreamlessGateway((batch) => polledByCycle.at(-1)!.push(...batch)),
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 200,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      fallbackPollMaxConcurrency: 1,
      fallbackPollRatePerSec: 5,
      // Churn is the point: without this the tiered set is served from cache and the "newcomer"
      // never changes, so the poll order under test is never actually exercised.
      tieredPricingCacheTtlMs: 0,
    });

    polledByCycle.push([]);
    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    // Exactly ONE poll per cycle — the interval tick, with no manual `poll()` chaser. Two polls at
    // the same timestamp hide the bug: the first hands the slot to the newcomer and stamps it, so
    // the second finds the resident least-recently-polled and serves it anyway, every cycle.
    for (cycle = 1; cycle <= 30; cycle += 1) {
      polledByCycle.push([]);
      await vi.advanceTimersByTimeAsync(5_000);
    }

    // The LATE half, not "polled at all". The resident is first in the candidate list, so it wins
    // the opening cycle either way — and then, with newcomers measured from zero, it never wins
    // again. Being served once and starved for the remaining 29 cycles is the bug, not the fix.
    expect(polledByCycle.slice(16).flat()).toContain("resident");

    await mod.stop();
  });

  it("a candidate is not starved by a peer that keeps leaving and rejoining", async () => {
    // Admission time only measures a genuine wait if it SURVIVES a round trip out of the tracked
    // set. Stamped fresh on every rejoin, a token that drops out and returns is permanently
    // younger than the resident it is queued behind, so it loses every cycle it is even present
    // for — and it never waits long enough in one stretch to trip the starvation tier either.
    // Dropping in and out is ordinary churn here (the scanner's tiered view moves markets
    // constantly), not an adversarial pattern.
    let cycle = 0;
    const repo = createMockRepo(makeTiered([], [], []));
    const tieredForCycle = () =>
      makeTiered([], cycle % 2 === 1 ? ["resident", "rejoiner"] : ["resident"], []);
    repo.findTrackedForPricingTiered = vi.fn().mockImplementation(tieredForCycle);
    repo.findTrackedForPricing = vi.fn().mockImplementation(() => {
      const tiered = tieredForCycle();
      return [...tiered.executionCritical, ...tiered.entryCandidates];
    });

    const polledByCycle: string[][] = [];
    const mod = new MarketDataModule({
      gateway: createStreamlessGateway((batch) => polledByCycle.at(-1)!.push(...batch)),
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 200,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      fallbackPollMaxConcurrency: 1,
      fallbackPollRatePerSec: 5,
      // Without this the tiered set is served from cache and the membership never actually churns.
      tieredPricingCacheTtlMs: 0,
    });

    polledByCycle.push([]);
    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    for (cycle = 1; cycle <= 30; cycle += 1) {
      polledByCycle.push([]);
      await vi.advanceTimersByTimeAsync(5_000);
    }

    // Both, in the LATE half: the resident must keep its share too, or "fairness" would just be
    // the same starvation pointed the other way.
    expect(polledByCycle.slice(16).flat()).toContain("rejoiner");
    expect(polledByCycle.slice(16).flat()).toContain("resident");

    await mod.stop();
  });

  it("a long-absent token does not outrank an execution-critical peer on rejoin", async () => {
    // The carried-over wait must be a DURATION, not the stamp it was measured from. Held as a
    // stamp, a token that spent 40 cycles OUTSIDE the tracked set re-enters looking as if it had
    // waited all of them, trips the starvation tier on its very first cycle back, and takes the
    // slot from an execution-critical resident that really has been waiting its turn — for time
    // the absentee could not have been polled in anyway.
    let cycle = 0;
    const repo = createMockRepo(makeTiered([], [], []));
    // Present only in cycle 1, then gone for 39 cycles, then back from cycle 41.
    const tieredForCycle = () =>
      makeTiered(["critical"], cycle === 1 || cycle >= 41 ? ["absentee"] : [], []);
    repo.findTrackedForPricingTiered = vi.fn().mockImplementation(tieredForCycle);
    repo.findTrackedForPricing = vi.fn().mockImplementation(() => {
      const tiered = tieredForCycle();
      return [...tiered.executionCritical, ...tiered.entryCandidates];
    });

    const polledByCycle: string[][] = [];
    const mod = new MarketDataModule({
      gateway: createStreamlessGateway((batch) => polledByCycle.at(-1)!.push(...batch)),
      marketRepo: repo,
      bus,
      log: silentLog,
      pollIntervalMs: 5_000,
      staleThresholdMs: 120_000,
      maxTrackedTokens: 200,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      fallbackPollMaxConcurrency: 1,
      fallbackPollRatePerSec: 5,
      tieredPricingCacheTtlMs: 0,
    });

    polledByCycle.push([]);
    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    for (cycle = 1; cycle <= 41; cycle += 1) {
      polledByCycle.push([]);
      await vi.advanceTimersByTimeAsync(5_000);
    }

    // The rejoin cycle itself is the discriminator: the absentee accrued one cycle of wait before
    // it left, so it comes back queued behind the critical peer, not ahead of it.
    expect(polledByCycle[41]).toContain("critical");
    expect(polledByCycle[41]).not.toContain("absentee");

    await mod.stop();
  });

  it("pending gaps are rate-capped and stale gap tokens age out", async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `tok-${i}`);
    const tiered = makeTiered([], ids, []);
    const repo = createMockRepo(tiered);
    const capturedIds: string[][] = [];
    const getMarketPricing = vi.fn().mockImplementation(async (polled: string[]) => {
      capturedIds.push([...polled]);
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
      maxTrackedTokens: 100,
      discoveryPollIntervalMs: 3_600_000,
      fallbackBatchSize: 500,
      fallbackPollMaxConcurrency: 50,
      fallbackPollRatePerSec: 5,
      fallbackStaleTokenAgeMs: 30_000,
    });

    await mod.start();
    await vi.advanceTimersByTimeAsync(1);
    getMarketPricing.mockClear();
    capturedIds.length = 0;

    await streamRef!.triggerGapForTokenIds(ids);
    await mod.poll();

    expect(capturedIds[0]).toHaveLength(50);
    expect(mod.getMetricsSnapshot().fallbackCandidateCount).toBe(80);
    expect(mod.getMetricsSnapshot().fallbackDeferredCount).toBe(30);
    expect(mod.getMetricsSnapshot().pendingGapTokenCount).toBe(30);

    await vi.advanceTimersByTimeAsync(31_000);
    await mod.poll();

    expect(mod.getMetricsSnapshot().fallbackDroppedStaleCount).toBe(30);
    expect(mod.getMetricsSnapshot().pendingGapTokenCount).toBe(0);

    await mod.stop();
  });
});
