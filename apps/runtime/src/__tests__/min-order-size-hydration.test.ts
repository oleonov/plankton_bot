/**
 * Regression tests for the `entry_unknown_min` entry loop
 * (docs/plans/2026-07-30-min-order-size-hydration-entry-loop.md).
 *
 * The REST `/books` payload is the only source of `min_order_size`: Gamma
 * pricing and the WSS `book` event both omit it, yet the WSS path still stamps
 * `bookSource: "clob"`. A WSS-tracked market therefore kept `minOrderSize: null`
 * forever, sellable sizing could never compute its share floor, and every book
 * tick skipped the entry — 1 937 657 rows over 151 tokens in 3 days.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createTokenId,
  DEFAULT_EXECUTION_POLICY,
  type AlgoDecisionRule,
  type AlgoRulesRepository,
  type AlgoSizeRule,
  type ConditionId,
  type EventBus,
  type LegStateRepository,
  type Market,
  type MarketDataGateway,
  type MarketPricingStreamUpdate,
  type MarketRepository,
  type NormalizedMarket,
  type OrderBookSnapshot,
  type RuntimeEventMap,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  AlgoDecisionModule,
  conversionSkipReEvalDelayMs,
  type SelectedMarketCache,
} from "../modules/algo-decision/algo-decision-module.js";
import {
  ENTRY_MIN_ORDER_SIZE_UNKNOWN_REASON,
  evaluateDecisionPlan,
  type DecisionPlanningInput,
} from "../modules/algo-decision/decision-planner.js";
import type { DecisionWorkerPool } from "../modules/algo-decision/decision-worker-pool.js";
import { MarketDataModule } from "../modules/market-data/market-data-module.js";
import { NormalizationModule } from "../modules/normalization/normalization-module.js";
import {
  CandidateBookCache,
  type CandidateBookGateway,
} from "../modules/strategy/candidate-book-cache.js";
import { SignalToOrderBridge } from "../modules/strategy/signal-to-order.js";
import type { CandidateBookCacheEntry } from "../modules/strategy/candidate-book-cache.js";
import type { Logger } from "../logger.js";

const TOKEN = "tok-min-hydration";

function makeLogger(): Logger {
  const log: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: "info",
    silent: vi.fn(),
  };
  log["child"] = vi.fn(() => log);
  return log as unknown as Logger;
}

function makeBook(tokenId: string, minOrderSize?: number | null): OrderBookSnapshot {
  return {
    tokenId: createTokenId(tokenId),
    bids: [{ price: 0.04, size: 100 }],
    asks: [{ price: 0.05, size: 100 }],
    bestBid: 0.04,
    bestAsk: 0.05,
    midPrice: 0.045,
    spread: 0.01,
    timestamp: Date.now(),
    ...(minOrderSize === undefined ? {} : { minOrderSize }),
  };
}

// ─── F1a — the book cache reports every observed minimum ─────────────────────

describe("CandidateBookCache → onMinOrderSizeObserved", () => {
  it("reports the minimum carried by a REST /books payload", async () => {
    const observed: Array<[string, number]> = [];
    const gateway: CandidateBookGateway = {
      getOrderBooks: vi.fn(
        async (tokenIds: string[]) =>
          new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId, 5)])),
      ),
    };
    const cache = new CandidateBookCache({
      gateway,
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) => observed.push([tokenId, minOrderSize]),
    });

    await cache.prime([TOKEN]);

    expect(observed).toEqual([[TOKEN, 5]]);
  });

  it("stays silent for a book without a usable minimum (the WSS book never carries one)", async () => {
    const observed: Array<[string, number]> = [];
    const gateway: CandidateBookGateway = {
      getOrderBooks: vi.fn(
        async (tokenIds: string[]) =>
          new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId, null)])),
      ),
    };
    const cache = new CandidateBookCache({
      gateway,
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) => observed.push([tokenId, minOrderSize]),
    });

    await cache.prime([TOKEN]);
    cache.upsertBooks(new Map([[TOKEN, makeBook(TOKEN, 0)]]));

    expect(observed).toEqual([]);
  });

  it("reports the minimum from the upsert write path too", () => {
    const observed: Array<[string, number]> = [];
    const cache = new CandidateBookCache({
      gateway: { getOrderBooks: vi.fn(async () => new Map()) },
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) => observed.push([tokenId, minOrderSize]),
    });

    cache.upsertBooks(new Map([[TOKEN, makeBook(TOKEN, 5)]]), Date.now(), "rest");

    expect(observed).toEqual([[TOKEN, 5]]);
  });
});

// ─── F1b — the market cache keeps the observed minimum (sticky) ──────────────

function makeTrackedMarket(): Market {
  return {
    tokenId: createTokenId(TOKEN),
    conditionId: "cond-min-hydration",
    slug: "min-hydration",
    eventSlug: null,
    question: "Hydration?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: "threshold",
    horizon: "daily",
    endDate: "2099-12-31",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  } as unknown as Market;
}

function makeMarketDataModule(
  bus: InProcessEventBus,
  pricingOverrides?: Record<string, unknown>,
  runtimeControl?: { isPaused: () => boolean },
  extraDeps?: Record<string, unknown>,
): MarketDataModule & {
  pricingCalls: ReturnType<typeof vi.fn>;
  trackedCalls: ReturnType<typeof vi.fn>;
  tieredCalls: ReturnType<typeof vi.fn>;
} {
  // Gamma pricing without a minimum — exactly the production shape that left
  // `minOrderSize` null forever on a WSS-tracked market.
  const getMarketPricing = vi.fn(
    async () =>
      new Map([
        [
          TOKEN,
          { bestBid: 0.04, bestAsk: 0.05, lastTradePrice: null, ...(pricingOverrides ?? {}) },
        ],
      ]),
  );
  const gateway = {
    getMarkets: vi.fn().mockResolvedValue([]),
    getMarket: vi.fn().mockResolvedValue(null),
    getOrderBook: vi.fn(),
    getTickSize: vi.fn().mockResolvedValue(0.01),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    getMarketPricing,
  } as unknown as MarketDataGateway;

  const findTrackedForPricingTiered = vi.fn(() => ({
    executionCritical: [makeTrackedMarket()],
    planktonSignature: [],
    entryCandidates: [],
    discoveryOnly: [] as Market[],
    signatureOverflow: 0,
  }));

  const marketRepo = {
    findTrackedForPricing: vi.fn(() => [makeTrackedMarket()]),
    findTrackedForPricingTiered,
    findByTokenId: vi.fn(() => null),
    upsertMany: vi.fn(),
    updateScoresBatch: vi.fn(),
    updateTickSize: vi.fn(),
    findEventMarketCountBySlug: vi.fn(() => null),
  } as unknown as MarketRepository;

  const mod = new MarketDataModule({
    gateway,
    marketRepo,
    bus,
    log: makeLogger(),
    pollIntervalMs: 60_000,
    staleThresholdMs: 120_000,
    botRunId: "run-min-hydration",
    ...(runtimeControl ? { runtimeControl } : {}),
    ...(extraDeps ?? {}),
  } as never) as MarketDataModule & {
    pricingCalls: ReturnType<typeof vi.fn>;
    trackedCalls: ReturnType<typeof vi.fn>;
    tieredCalls: ReturnType<typeof vi.fn>;
  };
  // Exposed so a composed test can prove the self-heal needed no second poll.
  mod.pricingCalls = getMarketPricing;
  // Exposed so a test can deselect the market the way the scanner does.
  mod.trackedCalls = marketRepo.findTrackedForPricing as ReturnType<typeof vi.fn>;
  // Exposed so a test can move the market between the discovery and WS tiers.
  mod.tieredCalls = findTrackedForPricingTiered;
  return mod;
}

describe("MarketDataModule.noteMinOrderSizeObserved", () => {
  async function pollOnce(
    mod: MarketDataModule,
    bus: InProcessEventBus,
  ): Promise<NormalizedMarket> {
    const seen: NormalizedMarket[] = [];
    const unsubscribe = bus.subscribe("MarketSnapshotReceived", async (payload) => {
      seen.push(...payload.markets);
    });
    await mod.poll();
    unsubscribe();
    const market = seen.find((entry) => String(entry.tokenId) === TOKEN);
    expect(market).toBeDefined();
    return market!;
  }

  function captureSnapshots(bus: InProcessEventBus): {
    seen: NormalizedMarket[];
    unsubscribe: () => void;
  } {
    const seen: NormalizedMarket[] = [];
    const unsubscribe = bus.subscribe("MarketSnapshotReceived", async (payload) => {
      seen.push(...payload.markets.filter((entry) => String(entry.tokenId) === TOKEN));
    });
    return { seen, unsubscribe };
  }

  it("publishes the hydrated snapshot immediately instead of waiting for the next poll", async () => {
    const bus = new InProcessEventBus();
    const mod = makeMarketDataModule(bus);

    expect((await pollOnce(mod, bus)).minOrderSize ?? null).toBeNull();

    const { seen, unsubscribe } = captureSnapshots(bus);
    mod.noteMinOrderSizeObserved(TOKEN, 5);
    // Downstream modules cache markets off MarketSnapshotReceived only, so a
    // silent cache seed would stay invisible until the next poll — hours on a
    // quiet market, with the skip re-emitting the whole time.
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    unsubscribe();

    expect(seen[0]!.minOrderSize).toBe(5);
  });

  it("ignores a non-positive observation instead of poisoning the cache", async () => {
    const bus = new InProcessEventBus();
    const mod = makeMarketDataModule(bus);

    // The market must be cached first — in production a snapshot is always
    // published before anything can fetch a book for that token.
    await pollOnce(mod, bus);
    const { seen, unsubscribe } = captureSnapshots(bus);

    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    mod.noteMinOrderSizeObserved(TOKEN, 0);
    mod.noteMinOrderSizeObserved(TOKEN, Number.NaN);
    mod.noteMinOrderSizeObserved(TOKEN, 5);
    unsubscribe();

    // A rejected value publishes nothing, and re-observing the same minimum is
    // not a change either — otherwise every REST book would republish.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.minOrderSize).toBe(5);
  });

  it("stays silent while the runtime is paused", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    const { seen, unsubscribe } = captureSnapshots(bus);
    paused.isPaused.mockReturnValue(true);

    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await Promise.resolve();
    unsubscribe();

    // Publishing while paused is suppressed everywhere else in this module by
    // design. The observation is parked rather than dropped — see the next test
    // for the delivery half.
    expect(seen).toHaveLength(0);
  });

  it("delivers a hydration that landed while paused on the first unpaused poll", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    const { seen, unsubscribe } = captureSnapshots(bus);
    paused.isPaused.mockReturnValue(true);

    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await Promise.resolve();
    expect(seen).toHaveLength(0);

    // Resume changes nothing else: same pricing payload, no WSS tick, and the
    // dirty-token set was already drained by the pre-pause evaluation. Without
    // the parked retry the value would sit in no cache at all — the book cache
    // dedupes the refresh, so nothing re-observes this minimum and the entry
    // stays suppressed for the market's whole life.
    paused.isPaused.mockReturnValue(false);
    await mod.poll();

    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(1);
    });
    unsubscribe();

    expect(seen.every((market) => market.minOrderSize === 5)).toBe(true);
  });

  it("drops a parked value for a token deselected while paused instead of republishing it", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    const { seen, unsubscribe } = captureSnapshots(bus);
    paused.isPaused.mockReturnValue(true);

    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await Promise.resolve();
    expect(seen).toHaveLength(0);

    // The scanner deselects the market while we are paused. Flushing the parked
    // value before the tracked set is reconciled republishes a market we no
    // longer track — and since the hydration publish is fire-and-forget, that
    // snapshot can reach an Algo evaluation that places a real BUY on it.
    mod.trackedCalls.mockReturnValue([]);
    paused.isPaused.mockReturnValue(false);
    await mod.poll();
    await Promise.resolve();
    unsubscribe();

    expect(seen).toHaveLength(0);
  });

  it("discards the parked value for a deselected token instead of holding it for a rejoin", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    paused.isPaused.mockReturnValue(true);
    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await Promise.resolve();

    mod.trackedCalls.mockReturnValue([]);
    paused.isPaused.mockReturnValue(false);
    await mod.poll();
    await Promise.resolve();

    // Suppressing the republish is not enough on its own: the entry has no
    // delivery route left, so keeping it only defers the publish to whenever the
    // token rejoins — by which time the value is arbitrarily old. The rejoin
    // releases the hydration dedupe, so a fresh /books supplies the current one.
    const internals = mod as unknown as {
      pendingMinOrderSizeByToken: Map<string, { minOrderSize: number }>;
    };
    expect(internals.pendingMinOrderSizeByToken.size).toBe(0);

    mod.trackedCalls.mockReturnValue([makeTrackedMarket()]);
    const { seen, unsubscribe } = captureSnapshots(bus);
    await mod.poll();
    await Promise.resolve();
    unsubscribe();

    expect(seen.some((market) => market.minOrderSize === 5)).toBe(false);
  });

  it("does not let a parked older minimum overwrite a newer delivered one", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    paused.isPaused.mockReturnValue(true);
    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await Promise.resolve();

    paused.isPaused.mockReturnValue(false);
    const { seen, unsubscribe } = captureSnapshots(bus);
    mod.noteMinOrderSizeObserved(TOKEN, 10);
    await vi.waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    expect(seen[0]!.minOrderSize).toBe(10);

    // The direct delivery above already superseded the parked value. If the
    // flush still republishes 5, downstream sizes the next entry against a floor
    // the exchange has since raised and the order is rejected outright.
    await mod.poll();
    await Promise.resolve();
    unsubscribe();

    expect(seen.every((market) => market.minOrderSize === 10)).toBe(true);
  });

  it("does not advertise hydration for a tracked token with no publishable cache entry", async () => {
    const bus = new InProcessEventBus();
    const mod = makeMarketDataModule(bus);

    // A token promoted into the WS tier that Gamma then omits from the batch:
    // the tracked set has it, but nothing ever builds a market-cache entry, and
    // delivery publishes off the cache only.
    mod.pricingCalls.mockResolvedValue(new Map());
    await mod.poll();

    const internals = mod as unknown as {
      marketCache: Map<string, NormalizedMarket>;
      trackedMarketsByToken: Map<string, unknown>;
    };
    expect(internals.trackedMarketsByToken.has(TOKEN)).toBe(true);
    expect(internals.marketCache.has(TOKEN)).toBe(false);

    const { seen, unsubscribe } = captureSnapshots(bus);
    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await Promise.resolve();
    unsubscribe();
    expect(seen).toHaveLength(0);

    // Delivery is impossible here, so the advertiser must say so: the entry
    // pre-filter trusts it and would otherwise suppress the signal while waiting
    // on a publish that never comes.
    expect(mod.canHydrateMinOrderSize(TOKEN)).toBe(false);
  });

  it("keeps a tracked token's parked value when the cap evicts", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    const { seen, unsubscribe } = captureSnapshots(bus);
    paused.isPaused.mockReturnValue(true);

    // The tracked token parks FIRST, so a plain oldest-first eviction drops
    // exactly the one entry that still has a delivery route. Untracked tokens
    // — a market dropped from the WS tier between the refresh and its callback
    // — are the ones that can pile up without bound, and the runtime tracks
    // thousands of them, so overflowing 512 is a normal day, not a corner case.
    mod.noteMinOrderSizeObserved(TOKEN, 5);
    for (let i = 0; i < 512; i++) {
      mod.noteMinOrderSizeObserved(`untracked-${i}`, 7);
    }
    await Promise.resolve();
    expect(seen).toHaveLength(0);

    paused.isPaused.mockReturnValue(false);
    await mod.poll();

    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(1);
    });
    unsubscribe();

    expect(seen.every((market) => market.minOrderSize === 5)).toBe(true);
  });

  it("bounds the parked map even when every token still has a delivery route", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    paused.isPaused.mockReturnValue(true);

    const internals = mod as unknown as {
      marketCache: Map<string, NormalizedMarket>;
      pendingMinOrderSizeByToken: Map<string, { minOrderSize: number }>;
    };
    const cached = internals.marketCache.get(TOKEN)!;
    for (let i = 0; i < 600; i++) {
      internals.marketCache.set(`routable-${i}`, cached);
      mod.noteMinOrderSizeObserved(`routable-${i}`, 7);
    }

    // Preferring routable entries must not turn the cap into no cap: a paused
    // runtime tracking thousands of tokens would otherwise grow this map to the
    // tracked limit while every single insert rescans the whole thing.
    expect(internals.pendingMinOrderSizeByToken.size).toBeLessThanOrEqual(512);
  });

  it("scales the parked cap with the tracked tier instead of the 512 floor", () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => true) };
    const mod = makeMarketDataModule(bus, undefined, paused, { maxTrackedTokens: 2_000 });

    // Every one of these is routable — a market-cache entry exists and delivery
    // is refused only because the runtime is paused. A flat 512 sat below the
    // 2 000–5 000 tracked tier the runtime advertises, so one pre-pause /books
    // batch evicted values that all still had a delivery route, and each eviction
    // costs a hydration-retry window with the entry suppressed throughout.
    const internals = mod as unknown as {
      marketCache: Map<string, NormalizedMarket>;
      pendingMinOrderSizeByToken: Map<string, { minOrderSize: number }>;
    };
    internals.marketCache.set(TOKEN, makePricingMarket({ minOrderSize: null }));
    mod.noteMinOrderSizeObserved(TOKEN, 5);
    for (let i = 0; i < 600; i++) {
      internals.marketCache.set(`routable-${i}`, makePricingMarket({ minOrderSize: null }));
      mod.noteMinOrderSizeObserved(`routable-${i}`, 7);
    }

    expect(internals.pendingMinOrderSizeByToken.size).toBe(601);
    // Map size alone would pass while the cap silently rotated values out:
    // oldest-first eviction takes the FIRST token parked, so assert that one and
    // the last one both survived carrying their own minimum.
    expect(internals.pendingMinOrderSizeByToken.get(TOKEN)?.minOrderSize).toBe(5);
    expect(internals.pendingMinOrderSizeByToken.get("routable-599")?.minOrderSize).toBe(7);
  });

  it("does not republish stale pre-pause prices to deliver a parked minimum", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    const { seen, unsubscribe } = captureSnapshots(bus);
    paused.isPaused.mockReturnValue(true);

    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await Promise.resolve();
    expect(seen).toHaveLength(0);

    const internals = mod as unknown as {
      marketCache: Map<string, NormalizedMarket>;
      pendingMinOrderSizeByToken: Map<string, { minOrderSize: number }>;
      lastPricingUpdateAtByToken: Map<string, number>;
      flushPendingMinOrderSizeHydration: () => void;
    };
    // Seeding the local cache is the half that must happen regardless — the
    // poll's own pricing publish carries the minimum forward from here.
    expect(internals.marketCache.get(TOKEN)?.minOrderSize).toBe(5);

    // A pause that outlasted the pricing cadence: the cached bid is now pre-pause
    // data, and a republished market carrying a known minimum with
    // `bookSource: "clob"` is priced by signal-to-order WITHOUT a fresh book.
    internals.lastPricingUpdateAtByToken.set(TOKEN, Date.now() - 10 * 60_000);
    paused.isPaused.mockReturnValue(false);
    internals.flushPendingMinOrderSizeHydration();
    await Promise.resolve();

    expect(seen).toHaveLength(0);
    // Refusing must only defer: dropping the value here would strand it exactly
    // like the pre-park behaviour this suite exists to pin.
    expect(internals.pendingMinOrderSizeByToken.get(TOKEN)?.minOrderSize).toBe(5);

    mod.pricingCalls.mockResolvedValue(
      new Map([[TOKEN, { bestBid: 0.09, bestAsk: 0.1, lastTradePrice: null }]]),
    );
    await mod.poll();

    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(1);
    });
    unsubscribe();

    // The minimum still reaches downstream — riding the CURRENT price, never the
    // pre-pause one.
    const hydrated = seen.filter((market) => market.minOrderSize === 5);
    expect(hydrated.length).toBeGreaterThanOrEqual(1);
    expect(hydrated.every((market) => market.bestBid === 0.09)).toBe(true);
  });

  it("publishes a parked value the paused stream already wrote into the cache", async () => {
    const bus = new InProcessEventBus();
    const paused = { isPaused: vi.fn(() => false) };
    const mod = makeMarketDataModule(bus, undefined, paused);

    await pollOnce(mod, bus);
    const { seen, unsubscribe } = captureSnapshots(bus);
    paused.isPaused.mockReturnValue(true);

    // `flushPendingStreamUpdates` writes `marketCache` BEFORE its pause guard,
    // so a paused book event seeds the minimum locally and publishes nothing.
    // Treating that cached value as proof of delivery drops the parked entry
    // while downstream still sees `minOrderSize: null`.
    const internals = mod as unknown as {
      handleStreamUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void>;
      marketCache: Map<string, NormalizedMarket>;
    };
    await internals.handleStreamUpdates([
      {
        tokenId: TOKEN,
        pricing: { bestBid: 0.04, bestAsk: 0.05, lastTradePrice: null },
        book: makeBook(TOKEN, 5),
      } as unknown as MarketPricingStreamUpdate,
    ]);
    mod.noteMinOrderSizeObserved(TOKEN, 5);
    await vi.waitFor(() => {
      expect(internals.marketCache.get(TOKEN)?.minOrderSize).toBe(5);
    });
    expect(seen).toHaveLength(0);

    // Resume with no fresh WSS tick and no pricing for this token — Gamma
    // routinely drops a quiet market from the batch, and the poll skips it
    // (`pricing == null`) instead of rebuilding it. The rebuild would otherwise
    // republish the cached minimum and mask the defect; here the parked retry
    // is the only route left to downstream.
    paused.isPaused.mockReturnValue(false);
    mod.pricingCalls.mockResolvedValue(new Map());
    await mod.poll();

    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(1);
    });
    unsubscribe();

    expect(seen.every((market) => market.minOrderSize === 5)).toBe(true);
  });

  // A discovery-tier entry observes the minimum from `/books`, but discovery
  // markets are held out of BOTH caches, so the value can only be parked. The
  // flush used to read that as "the token left the tracked set" and discard it,
  // leaving the promoted snapshot with a null minimum — which live-lite rejects
  // on the EXIT, not the entry.
  it("keeps a discovery-tier minimum alive until the fill promotes the token", async () => {
    vi.useFakeTimers();
    try {
      const bus = new InProcessEventBus();
      const mod = makeMarketDataModule(bus, undefined, undefined, {
        maxTrackedTokens: 10,
        // The tier cache is what decides discovery-vs-tracked; a zero TTL still
        // hits on a same-millisecond poll, so every poll below advances first.
        tieredPricingCacheTtlMs: 0,
      });
      mod.tieredCalls.mockReturnValue({
        executionCritical: [] as Market[],
        planktonSignature: [],
        entryCandidates: [],
        discoveryOnly: [makeTrackedMarket()],
        signatureOverflow: 0,
      });
      await mod.poll();

      mod.noteMinOrderSizeObserved(TOKEN, 5);
      // Still discovery-only: this is the poll that used to drop the value.
      await vi.advanceTimersByTimeAsync(1_000);
      await mod.poll();

      mod.tieredCalls.mockReturnValue({
        executionCritical: [makeTrackedMarket()],
        planktonSignature: [],
        entryCandidates: [],
        discoveryOnly: [] as Market[],
        signatureOverflow: 0,
      });
      // The first tracked poll builds the cache entry; the flush that runs
      // before it still has nowhere to deliver, so the value rides one cycle.
      await vi.advanceTimersByTimeAsync(1_000);
      await mod.poll();
      const { seen, unsubscribe } = captureSnapshots(bus);
      await vi.advanceTimersByTimeAsync(1_000);
      await mod.poll();
      unsubscribe();

      expect(seen.at(-1)?.minOrderSize).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  // The publish that carries a parked minimum needs fresh pricing, but the book
  // budget can be far longer than the freshness budget (Infinity on a healthy
  // WS tier). Nothing else would poll the token, so the parked value waits —
  // and the token's exit stays unpriceable for that whole window.
});

// ─── F2 — a probe-entry BUY with an unknown minimum reaches the REST book ────

function makePricingMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: createTokenId(TOKEN),
    conditionId: "cond-min-hydration" as ConditionId,
    slug: "min-hydration",
    eventSlug: null,
    question: "Hydration?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: "price-range",
    horizon: "daily",
    endDate: "2099-12-31T23:59:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.04,
    bestAsk: 0.04,
    midPrice: 0.04,
    spread: 0,
    lastTradePrice: null,
    lastTradeAt: null,
    volume24h: 100_000,
    liquidity: 10_000,
    // The WSS book stamps "clob" while carrying no minimum — the exact shape
    // that used to short-circuit pricing onto a market that can never learn it.
    bookSource: "clob",
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...overrides,
  } as unknown as NormalizedMarket;
}

function sellableFlowPolicy() {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    bounceExit: { ...DEFAULT_EXECUTION_POLICY.bounceExit, ladderFractions: [0.1, 0.2, 0.3, 0.4] },
    sellableFlow: {
      enabled: true,
      buffer: 1.2,
      maxEntryUsdc: 10,
      appliesFromMs: 1,
    },
  };
}

function makeCachedEntry(
  minOrderSize: number | null,
  sourceKind: "ws" | "rest" = "rest",
): CandidateBookCacheEntry {
  return {
    tokenId: TOKEN,
    snapshotTs: Date.now(),
    cachedAtMs: Date.now(),
    sourcePolledAtMs: Date.now(),
    bookSource: "clob",
    sourceKind,
    book: makeBook(TOKEN, minOrderSize),
  } as unknown as CandidateBookCacheEntry;
}

function makeSignal(overrides?: Record<string, unknown>) {
  return {
    signalId: "sig-min-hydration",
    tokenId: createTokenId(TOKEN),
    conditionId: "cond-min-hydration" as ConditionId,
    side: "buy" as const,
    reason: "probe-entry",
    suggestedSize: 25,
    suggestedSizeUsdc: 1,
    price: 0.04,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runBridge(
  market: NormalizedMarket,
  options?: {
    readonly signal?: Record<string, unknown>;
    /** What the synchronous cache lookup returns before any waiting happens. */
    readonly freshEntry?: CandidateBookCacheEntry | null;
    /** What the WSS wait resolves to — a WSS book never carries the minimum. */
    readonly waiterEntry?: CandidateBookCacheEntry | null;
    /** What the REST continuation resolves to. */
    readonly restEntry?: CandidateBookCacheEntry | null;
    /** `LiveLiteGuard.isActive` — the bridge's live-lite discriminator. */
    readonly liveLite?: boolean;
  },
): Promise<{
  placed: unknown[];
  skipped: Array<{ reasons: readonly string[] }>;
  cache: {
    waitForFreshEntry: ReturnType<typeof vi.fn>;
    getFreshOrRefresh: ReturnType<typeof vi.fn>;
  };
}> {
  const bus = new InProcessEventBus();
  const freshEntry = options?.freshEntry ?? null;
  const waiterEntry = options?.waiterEntry ?? makeCachedEntry(5);
  const restEntry = options?.restEntry ?? null;
  const candidateBookCache = {
    getFreshEntry: vi.fn(() => freshEntry),
    waitForFreshEntry: vi.fn(async () => waiterEntry),
    getFreshOrRefresh: vi.fn(async () => ({ status: "refreshed" as const, entry: restEntry })),
  };
  const bridge = new SignalToOrderBridge({
    bus,
    log: makeLogger(),
    liveLiteGuard: {
      getWalletMode: () => "relayer",
      isActive: options?.liveLite === true,
    } as never,
    policy: () => sellableFlowPolicy(),
    candidateBookCache: candidateBookCache as never,
  } as never);
  bridge.subscribe();

  const placed: unknown[] = [];
  const skipped: Array<{ reasons: readonly string[] }> = [];
  bus.subscribe("PlaceOrderRequested", async (payload) => {
    placed.push(payload);
  });
  bus.subscribe("SignalConversionSkipped", async (payload) => {
    skipped.push(payload as unknown as { reasons: readonly string[] });
  });

  await bus.publish("SignalApproved", {
    signal: makeSignal(options?.signal),
    market,
    approvedAt: Date.now(),
  } as unknown as RuntimeEventMap["SignalApproved"]);
  await bus.drain();

  return { placed, skipped, cache: candidateBookCache };
}

describe("SignalToOrderBridge — probe-entry pricing with an unknown minimum", () => {
  it("routes through the candidate book instead of settling for base-market pricing", async () => {
    const { placed, skipped, cache } = await runBridge(makePricingMarket());

    expect(cache.waitForFreshEntry).toHaveBeenCalledTimes(1);
    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("keeps the base-market short-circuit when the minimum is already known", async () => {
    const { placed, cache } = await runBridge(makePricingMarket({ minOrderSize: 5 }));

    expect(cache.waitForFreshEntry).not.toHaveBeenCalled();
    expect(placed).toHaveLength(1);
  });

  it("routes a live-lite SELL through the candidate book so the exit can learn the minimum", async () => {
    // Without this the position is stuck: `evaluateSellPreSubmitGuard` rejects
    // `sell-residual-unknown-min` in live-lite, and nothing on the SELL path
    // fetches `/books` — the exit-book fallback carries no minimum.
    const { cache } = await runBridge(makePricingMarket(), {
      signal: { side: "sell", reason: "bounce-exit" },
      liveLite: true,
    });

    expect(cache.waitForFreshEntry).toHaveBeenCalledTimes(1);
  });

  it("leaves a non-live-lite SELL on the base-market short-circuit", async () => {
    // Outside live-lite the unknown-minimum rejection never fires, so a REST
    // refresh on every exit would be latency for nothing.
    const { cache } = await runBridge(makePricingMarket(), {
      signal: { side: "sell", reason: "bounce-exit" },
    });

    expect(cache.waitForFreshEntry).not.toHaveBeenCalled();
  });

  it("does not reroute a scale-in BUY (sellable sizing only floors the first entry)", async () => {
    const { cache } = await runBridge(makePricingMarket(), {
      signal: { reason: "confirm-scale" },
    });

    expect(cache.waitForFreshEntry).not.toHaveBeenCalled();
  });

  it("rejects a fresh cache hit that omits the minimum and holds out for the REST book", async () => {
    // A WSS book is fresh but never carries a minimum. Accepting it as a hit is
    // exactly how the loop stayed alive: pricing would fall through to the
    // `entry_unknown_min` skip, which changes no state and re-emits next tick.
    // Both min-less stages must be rejected — the cached lookup AND the WSS
    // wait, which in production resolves to that very same min-less book — or
    // the REST fetch that is the only source of the minimum never happens.
    const { placed, skipped, cache } = await runBridge(makePricingMarket(), {
      freshEntry: makeCachedEntry(null, "ws"),
      waiterEntry: makeCachedEntry(null, "ws"),
      restEntry: makeCachedEntry(5),
    });

    expect(cache.waitForFreshEntry).toHaveBeenCalledTimes(1);
    expect(cache.getFreshOrRefresh).toHaveBeenCalledWith(
      TOKEN,
      expect.any(Number),
      expect.objectContaining({ requireKnownMinOrderSize: true }),
    );
    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });

  it("still takes a fresh cache hit that carries the minimum", async () => {
    const { placed, cache } = await runBridge(makePricingMarket(), {
      freshEntry: makeCachedEntry(5),
    });

    expect(cache.waitForFreshEntry).not.toHaveBeenCalled();
    expect(placed).toHaveLength(1);
  });

  it("emits a skip the decision module must not re-evaluate at 0 ms", async () => {
    // The planner guard only pre-empts this emission for tokens market-data can
    // republish. Everywhere else the signal still reaches the bridge and skips
    // here — and until this reason was registered as inputs-unchanged, that skip
    // re-triggered its own evaluation immediately: the production tight loop
    // (1.94 M decision_signal_log rows over 151 tokens in 3 days).
    //
    // The reason is read off the real emission rather than hard-coded twice, so
    // renaming the bridge's literal cannot silently unregister it.
    const { placed, skipped } = await runBridge(makePricingMarket(), {
      freshEntry: makeCachedEntry(null, "ws"),
      waiterEntry: makeCachedEntry(null, "ws"),
      restEntry: null,
    });

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reasons).toEqual(["entry_unknown_min"]);
    expect(conversionSkipReEvalDelayMs(skipped[0]!.reasons)).toBeGreaterThan(0);
  });

  it("keeps the immediate re-eval for a reason that clears on its own", () => {
    // The set is for skips that provably reproduce themselves until an
    // input-changing event lands. A gate that clears as time passes must stay
    // out of it, or a freed budget waits for the next unrelated event.
    expect(conversionSkipReEvalDelayMs(["order-placement-rate-limited"])).toBe(0);
  });
});

// ─── F2b — the cache refuses to serve a min-less hit to a caller that needs it ─

describe("CandidateBookCache.getFreshOrRefresh — requireKnownMinOrderSize", () => {
  function makeRestCache(): {
    cache: CandidateBookCache;
    getOrderBooks: ReturnType<typeof vi.fn>;
  } {
    const getOrderBooks = vi.fn(
      async (tokenIds: string[]) =>
        new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId, 5)])),
    );
    const cache = new CandidateBookCache({
      gateway: { getOrderBooks } as unknown as CandidateBookGateway,
      log: makeLogger(),
    });
    return { cache, getOrderBooks };
  }

  it("refreshes past a fresh WSS book instead of short-circuiting on it", async () => {
    const { cache, getOrderBooks } = makeRestCache();
    cache.upsertBooks(new Map([[TOKEN, makeBook(TOKEN, null)]]), Date.now(), "ws");

    const resolution = await cache.getFreshOrRefresh(TOKEN, Date.now(), {
      requireKnownMinOrderSize: true,
    });

    expect(getOrderBooks).toHaveBeenCalledTimes(1);
    expect(resolution.entry?.book.minOrderSize).toBe(5);
    cache.dispose();
  });

  it("still short-circuits on the same entry when the caller does not need the minimum", async () => {
    const { cache, getOrderBooks } = makeRestCache();
    cache.upsertBooks(new Map([[TOKEN, makeBook(TOKEN, null)]]), Date.now(), "ws");

    const resolution = await cache.getFreshOrRefresh(TOKEN, Date.now());

    expect(getOrderBooks).not.toHaveBeenCalled();
    expect(resolution.status).toBe("fresh-cache");
    cache.dispose();
  });

  it("hands back no entry when the REST refresh itself omits the minimum", async () => {
    // A valid-but-partial /books payload satisfies nothing for this caller.
    // Returning it would read as "requirement met" and let the sellable-floor
    // decision walk straight back into the skip this change removes.
    const getOrderBooks = vi.fn(
      async (tokenIds: string[]) =>
        new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId, null)])),
    );
    const cache = new CandidateBookCache({
      gateway: { getOrderBooks } as unknown as CandidateBookGateway,
      log: makeLogger(),
    });
    cache.upsertBooks(new Map([[TOKEN, makeBook(TOKEN, null)]]), Date.now(), "ws");

    const resolution = await cache.getFreshOrRefresh(TOKEN, Date.now(), {
      requireKnownMinOrderSize: true,
    });

    expect(getOrderBooks).toHaveBeenCalledTimes(1);
    expect(resolution.entry).toBeNull();
    expect(resolution.status).toBe("cache-stale");
    cache.dispose();
  });

  it("re-announces the minimum when a fresh known entry short-circuits the lookup", async () => {
    // The first observation can be dropped downstream (the token was not in
    // MarketData's cache at the time) while the book cache keeps the value. The
    // refresh request is then deduped for ten minutes, so a silent cache hit
    // would leave the suppression alive with nothing left to clear it.
    const observed: Array<[string, number]> = [];
    const getOrderBooks = vi.fn(
      async (tokenIds: string[]) =>
        new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId, 5)])),
    );
    const cache = new CandidateBookCache({
      gateway: { getOrderBooks } as unknown as CandidateBookGateway,
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) => observed.push([tokenId, minOrderSize]),
    });
    await cache.prime([TOKEN]);
    expect(observed).toEqual([[TOKEN, 5]]);
    observed.length = 0;

    const resolution = await cache.getFreshOrRefresh(TOKEN, Date.now(), {
      requireKnownMinOrderSize: true,
    });

    expect(resolution.status).toBe("fresh-cache");
    expect(getOrderBooks).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([[TOKEN, 5]]);
    cache.dispose();
  });

  it("does not let an older /books response overwrite a newer one", async () => {
    // Two refreshes for the same token can be open at once: the flush window is
    // 10 ms and `flushQueuedRefreshes` clears its queue BEFORE awaiting. If the
    // older response is applied on arrival it regresses the cached book and
    // re-announces a superseded minimum, which sizes the next entry against a
    // floor the exchange has since moved.
    const observed: Array<[string, number]> = [];
    const resolvers: Array<(books: Map<string, OrderBookSnapshot>) => void> = [];
    const getOrderBooks = vi.fn(
      () => new Promise<Map<string, OrderBookSnapshot>>((resolve) => resolvers.push(resolve)),
    );
    const cache = new CandidateBookCache({
      gateway: { getOrderBooks } as unknown as CandidateBookGateway,
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) => observed.push([tokenId, minOrderSize]),
    });

    const older = cache.prime([TOKEN]);
    // Distinct poll clocks — same-millisecond batches are simultaneous, not ordered.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = cache.prime([TOKEN]);
    expect(resolvers).toHaveLength(2);

    resolvers[1]!(new Map([[TOKEN, makeBook(TOKEN, 10)]]));
    await newer;
    resolvers[0]!(new Map([[TOKEN, makeBook(TOKEN, 5)]]));
    await older;

    expect(cache.getEntry(TOKEN)?.book.minOrderSize).toBe(10);
    expect(observed).toEqual([[TOKEN, 10]]);
    cache.dispose();
  });

  it("still announces the older response's minimum when the newer one omits it", async () => {
    // A /books payload can omit `min_order_size` while the previous one carried
    // it. Skipping the superseded response wholesale — correct for the BOOK —
    // then throws away the only minimum anyone observed, and the refresh is
    // deduped, so the entry stays suppressed with nothing left to clear it.
    const observed: Array<[string, number]> = [];
    const resolvers: Array<(books: Map<string, OrderBookSnapshot>) => void> = [];
    const getOrderBooks = vi.fn(
      () => new Promise<Map<string, OrderBookSnapshot>>((resolve) => resolvers.push(resolve)),
    );
    const cache = new CandidateBookCache({
      gateway: { getOrderBooks } as unknown as CandidateBookGateway,
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) => observed.push([tokenId, minOrderSize]),
    });

    const older = cache.prime([TOKEN]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = cache.prime([TOKEN]);
    expect(resolvers).toHaveLength(2);

    resolvers[1]!(new Map([[TOKEN, makeBook(TOKEN, null)]]));
    await newer;
    resolvers[0]!(new Map([[TOKEN, makeBook(TOKEN, 5)]]));
    await older;

    // The newer book still wins the cache — announcing the minimum must not
    // regress the book the ordering guard exists to protect.
    expect(cache.getEntry(TOKEN)?.book.minOrderSize ?? null).toBeNull();
    expect(observed).toEqual([[TOKEN, 5]]);
    cache.dispose();
  });
});

// ─── F3 — the entry pre-filter suppresses and hydrates, never deadlocks ──────

function createMockBus() {
  const handlers = new Map<string, Array<(payload: unknown) => Promise<void>>>();
  const subscribe = vi.fn((event: string, handler: (payload: unknown) => Promise<void>) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(handler);
    return () => undefined;
  });
  const publish = vi.fn(async (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) await handler(payload);
  });
  return { subscribe, publish } as unknown as EventBus & {
    publish: ReturnType<typeof vi.fn>;
  };
}

function makeAlgoRulesRepo(): AlgoRulesRepository {
  const buyRule: AlgoDecisionRule = {
    id: 1,
    priority: 1,
    ruleId: "FALLBACK",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "BUY",
  };
  const buySize: AlgoSizeRule = {
    id: 1,
    actionType: "BUY",
    priority: 1,
    ruleId: "FALLBACK-BUY",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1,
  };
  return {
    getDecisionRules: vi.fn(() => [buyRule]),
    getSizeRules: vi.fn((actionType: string) => (actionType === "BUY" ? [buySize] : [])),
    refresh: vi.fn(),
  } as unknown as AlgoRulesRepository;
}

function buildAlgoModule(
  bus: EventBus,
  requestMinOrderSizeHydration?: (tokenId: string) => void,
  extraDeps?: Record<string, unknown>,
): AlgoDecisionModule {
  return new AlgoDecisionModule({
    bus,
    legStateRepo: {
      findByTokenId: vi.fn(() => null),
      findOpen: vi.fn(() => []),
      getAll: vi.fn(() => []),
      upsert: vi.fn(),
    } as unknown as LegStateRepository,
    algoRulesRepo: makeAlgoRulesRepo(),
    selectedMarketCache: {
      isEligible: vi.fn(() => true),
      getEligibleTokenIds: vi.fn(() => [createTokenId(TOKEN)]),
    } as unknown as SelectedMarketCache,
    log: makeLogger(),
    sweepIntervalMs: 60_000,
    executionPolicy: () => ({
      ...sellableFlowPolicy(),
      // 0 ⇒ min-age gate bypassed, so the pre-filter under test is the only gate left.
      entryMinMarketAgeSeconds: 0,
    }),
    ...(requestMinOrderSizeHydration ? { requestMinOrderSizeHydration } : {}),
    ...(extraDeps ?? {}),
  } as never);
}

async function emitMarketUpdate(
  bus: EventBus & { publish: ReturnType<typeof vi.fn> },
  market: NormalizedMarket,
): Promise<void> {
  await bus.publish("NormalizedMarketUpdated", { markets: [market], timestamp: Date.now() });
}

describe("AlgoDecisionModule — unknown minimum pre-filter", () => {
  it("suppresses the probe entry and asks for hydration once per dedupe window", async () => {
    const bus = createMockBus();
    const requestHydration = vi.fn();
    const mod = buildAlgoModule(bus, requestHydration);
    await mod.start();

    const market = makePricingMarket({ minOrderSize: null });
    await emitMarketUpdate(bus, market);
    await emitMarketUpdate(bus, market);

    const produced = bus.publish.mock.calls.filter(([event]) => event === "SignalProduced");
    expect(produced).toHaveLength(0);
    // Two ticks, one book request: the dedupe window keeps the self-heal kick
    // from becoming the very request storm this change exists to remove.
    expect(requestHydration).toHaveBeenCalledTimes(1);
    expect(requestHydration).toHaveBeenCalledWith(TOKEN);

    await mod.stop();
  });

  it("emits normally once the minimum is known", async () => {
    const bus = createMockBus();
    const requestHydration = vi.fn();
    const mod = buildAlgoModule(bus, requestHydration);
    await mod.start();

    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: 5 }));

    const produced = bus.publish.mock.calls.filter(([event]) => event === "SignalProduced");
    expect(produced).toHaveLength(1);
    expect(requestHydration).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("stays inert without a hydration capability — suppressing there would be permanent", async () => {
    const bus = createMockBus();
    const mod = buildAlgoModule(bus);
    await mod.start();

    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));

    const produced = bus.publish.mock.calls.filter(([event]) => event === "SignalProduced");
    expect(produced).toHaveLength(1);

    await mod.stop();
  });

  it("stays inert for a token market-data cannot republish (the discovery tier)", async () => {
    const bus = createMockBus();
    const requestHydration = vi.fn();
    const mod = buildAlgoModule(bus, requestHydration, { canHydrateMinOrderSize: () => false });
    await mod.start();

    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));

    // Discovery markets are deliberately outside MarketData's caches, so the
    // observed minimum can never be republished to us. Suppressing here blocks
    // the entry for the market's whole life AND hides the signal from
    // signal-to-order, which fetches the minimum itself before placing.
    const produced = bus.publish.mock.calls.filter(([event]) => event === "SignalProduced");
    expect(produced).toHaveLength(1);

    await mod.stop();
  });

  it("releases the retry backoff once the minimum arrives", async () => {
    const bus = createMockBus();
    const mod = buildAlgoModule(bus, vi.fn());
    await mod.start();

    // White-box, because the emission that would prove the release behaviourally
    // also reserves a pending entry, which suppresses the next tick for an
    // unrelated reason.
    const dedupe = (mod as unknown as { minOrderSizeHydrationDedupe: Map<string, number> })
      .minOrderSizeHydrationDedupe;

    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));
    expect(dedupe.has(TOKEN)).toBe(true);

    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: 5 }));

    // The window is a backoff for a refresh that produced nothing. Holding it
    // after a successful one means a drop-and-re-add inside the window gets a
    // fresh null snapshot with no refresh requested — suppressed with no way out.
    expect(dedupe.has(TOKEN)).toBe(false);

    await mod.stop();
  });

  it("retries the hydration request on its own backoff, not the telemetry dedupe window", async () => {
    const bus = createMockBus();
    const requestHydration = vi.fn();
    const mod = buildAlgoModule(bus, requestHydration);
    await mod.start();

    // Rewinding the stamp is how time passes here — the module reads Date.now().
    const dedupe = (mod as unknown as { minOrderSizeHydrationDedupe: Map<string, number> })
      .minOrderSizeHydrationDedupe;

    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));
    expect(requestHydration).toHaveBeenCalledTimes(1);

    dedupe.set(TOKEN, Date.now() - 30_000);
    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));
    expect(requestHydration).toHaveBeenCalledTimes(1);

    // A /books request that fails or omits the token must not cost a full
    // 10-minute entry blackout: the planner suppresses BEFORE the bridge, so no
    // other entry path can fetch the minimum while the backoff holds.
    dedupe.set(TOKEN, Date.now() - 61_000);
    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));
    expect(requestHydration).toHaveBeenCalledTimes(2);

    await mod.stop();
  });

  it("re-arms an unknown-minimum conversion skip only after the retry backoff", async () => {
    const bus = createMockBus();
    const mod = buildAlgoModule(bus, vi.fn());
    await mod.start();

    const internals = mod as unknown as {
      markDirty: (tokenId: string) => void;
      scheduleDirtyEvaluation: (delayMs?: number) => void;
    };
    const markDirty = vi.spyOn(internals, "markDirty");
    const schedule = vi.spyOn(internals, "scheduleDirtyEvaluation");

    async function publishSkip(reasons: readonly string[]): Promise<void> {
      await bus.publish("SignalConversionSkipped", {
        signal: makeSignal(),
        stage: "execution-terms",
        reasons,
        diagnostics: {},
        skippedAt: Date.now(),
      });
    }

    // Installed only now: `start()` must run on real timers.
    vi.useFakeTimers();
    try {
      // The bridge's own literal — a different string from the planner's
      // suppression code, and the one the F2 skip test pins against the emission.
      await publishSkip(["entry_unknown_min"]);

      // The delay helper alone proves nothing: the handler returns BEFORE ever
      // consulting it, so a skip that re-armed the token here would keep looping
      // whatever the helper says. This early return is the production loop's exit.
      expect(markDirty).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();

      await publishSkip(["order-placement-rate-limited"]);

      // ...while a gate that clears on its own still re-arms immediately.
      expect(markDirty).toHaveBeenCalledTimes(1);
      expect(schedule).toHaveBeenCalledWith(0);

      markDirty.mockClear();
      schedule.mockClear();

      // Exiting the loop must not mean abandoning the token: a GATE-bypass token
      // is in neither `getEligibleTokenIds()` nor the leg/position working set,
      // so the 60 s full sweep never reaches it and the next discovery rotation
      // is hours away. The backoff — not the sweep — is its recovery route.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(markDirty).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_500);
      expect(markDirty).toHaveBeenCalledWith(TOKEN);
      expect(schedule).toHaveBeenCalledWith(0);

      // Exactly once per window — the staging set is drained, not re-armed on
      // its own, so a token that never resolves costs 1 evaluation per 60 s.
      markDirty.mockClear();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(markDirty).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    await mod.stop();
  });

  it("re-arms a planner-side suppression whose hydration request never lands", async () => {
    const bus = createMockBus();
    // A refresh that silently does nothing: `/books` omitting the token, or
    // MarketData parking the value behind a pause / stale pricing. This path
    // suppresses BEFORE any signal is emitted, so no `SignalConversionSkipped`
    // ever arrives and the bridge-side re-arm cannot cover it.
    const requestHydration = vi.fn();
    const mod = buildAlgoModule(bus, requestHydration);
    await mod.start();

    const internals = mod as unknown as {
      markDirty: (tokenId: string) => void;
      scheduleDirtyEvaluation: (delayMs?: number) => void;
    };
    const markDirty = vi.spyOn(internals, "markDirty");
    const schedule = vi.spyOn(internals, "scheduleDirtyEvaluation");

    vi.useFakeTimers();
    try {
      await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));
      expect(requestHydration).toHaveBeenCalledTimes(1);

      // The update itself dirties the token; only what follows is the re-arm.
      markDirty.mockClear();
      schedule.mockClear();

      await vi.advanceTimersByTimeAsync(59_000);
      expect(markDirty).not.toHaveBeenCalled();

      // `markFullSweepDirty` unions leg state, open positions and
      // `getEligibleTokenIds()` — never `gateBypassEligible` — so a quiet
      // GATE-bypass token has no other route back and would wait out a discovery
      // rotation (~8 h) instead.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(markDirty).toHaveBeenCalledWith(TOKEN);
      expect(schedule).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }

    await mod.stop();
  });

  it("keeps re-arming a token the shared timer flushed inside its own backoff", async () => {
    const bus = createMockBus();
    const requestHydration = vi.fn();
    const mod = buildAlgoModule(bus, requestHydration);
    await mod.start();

    const late = createTokenId("tok-min-hydration-late");
    vi.useFakeTimers();
    try {
      // The first token starts the shared re-arm timer, so its deadline — not
      // the late token's — is the one both will be flushed on.
      await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));
      await vi.advanceTimersByTimeAsync(59_000);
      await emitMarketUpdate(
        bus,
        makePricingMarket({
          tokenId: late,
          conditionId: "cond-late" as ConditionId,
          minOrderSize: null,
        }),
      );
      expect(requestHydration).toHaveBeenCalledWith(String(late));
      requestHydration.mockClear();

      // t=60s: the flush lands one second into the late token's own 60s backoff,
      // so its refresh is deduped away. The re-arm must survive that anyway —
      // a deduped tick that also dropped the re-arm would strand the token.
      await vi.advanceTimersByTimeAsync(1_500);
      expect(requestHydration).not.toHaveBeenCalledWith(String(late));

      await vi.advanceTimersByTimeAsync(60_000);
      expect(requestHydration).toHaveBeenCalledWith(String(late));
    } finally {
      vi.useRealTimers();
    }

    await mod.stop();
  });

  it("re-requests hydration after the token left and rejoined the tracked set", async () => {
    const bus = createMockBus();
    const requestHydration = vi.fn();
    const mod = buildAlgoModule(bus, requestHydration);
    await mod.start();

    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));
    expect(requestHydration).toHaveBeenCalledTimes(1);

    await bus.publish("TrackedMarketsChanged", {
      addedTokenIds: [],
      removedTokenIds: [createTokenId(TOKEN)],
      activeTokenIds: [],
      timestamp: Date.now(),
    });
    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));

    // Churn discards everything we knew about the token, so the backoff for a
    // refresh whose result we threw away must go with it.
    expect(requestHydration).toHaveBeenCalledTimes(2);

    await mod.stop();
  });

  it("suppresses and hydrates across the decision-worker clone boundary", async () => {
    // Production defaults `ALGO_DECISION_WORKER_COUNT` to cpus-1, so the
    // suppressions that drive hydration normally arrive from a worker thread
    // and the input crosses `postMessage`'s structured clone on the way in.
    // Asserting only the module's outcome cannot see a flag lost in that clone:
    // the pool's local fallback would keep suppressing while a live worker
    // silently emitted. So capture the dispatched input and clone it here.
    const bus = createMockBus();
    const requestHydration = vi.fn();
    const mod = buildAlgoModule(bus, requestHydration, { decisionWorkerCount: 1 });
    const pool = (mod as unknown as { decisionWorkerPool: DecisionWorkerPool }).decisionWorkerPool;
    const evaluate = pool.evaluate.bind(pool);
    const dispatched: DecisionPlanningInput[] = [];
    vi.spyOn(pool, "evaluate").mockImplementation(async (inputs) => {
      dispatched.push(...inputs);
      return evaluate(inputs);
    });
    await mod.start();

    await emitMarketUpdate(bus, makePricingMarket({ minOrderSize: null }));

    const produced = bus.publish.mock.calls.filter(([event]) => event === "SignalProduced");
    expect(produced).toHaveLength(0);
    expect(requestHydration).toHaveBeenCalledWith(TOKEN);

    const input = dispatched.find((entry) => String(entry.tokenId) === TOKEN);
    expect(input?.minOrderSizeHydrationAvailable).toBe(true);
    // `structuredClone` is exactly what the worker boundary applies: a
    // non-cloneable field throws here instead of in production, and a dropped
    // flag shows up as the missing suppression below.
    const result = evaluateDecisionPlan(structuredClone(input!));
    expect(result.type).toBe("none");
    expect(result.suppressions.map((suppression) => suppression.reasonCode)).toContain(
      ENTRY_MIN_ORDER_SIZE_UNKNOWN_REASON,
    );

    await mod.stop();
  });
});

// ─── F4 — end-to-end self-heal on the real modules, no second poll ───────────

describe("min-order-size self-heal — real cache + market-data + normalization + decision", () => {
  it("hydrates from REST and emits without another poll or book tick", async () => {
    const bus = new InProcessEventBus();
    const marketData = makeMarketDataModule(bus, {
      // The pricing payload a live Gamma poll returns: everything the entry
      // gates need EXCEPT the minimum, which only the REST /books path carries.
      bestBid: 0.04,
      bestAsk: 0.04,
      acceptingOrders: true,
      enableOrderBook: true,
      liquidity: 10_000,
      volume24h: 100_000,
      volume24hr: 100_000,
      bookSource: "clob",
    });
    const getOrderBooks = vi.fn(
      async (tokenIds: string[]) =>
        new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId, 5)])),
    );
    const candidateBookCache = new CandidateBookCache({
      gateway: { getOrderBooks } as unknown as CandidateBookGateway,
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) =>
        marketData.noteMinOrderSizeObserved(tokenId, minOrderSize),
    });
    const normalization = new NormalizationModule({ bus, log: makeLogger() });
    const algo = buildAlgoModule(
      bus,
      (tokenId) => {
        void candidateBookCache.getFreshOrRefresh(tokenId, Date.now(), {
          requireKnownMinOrderSize: true,
        });
      },
      // The real advertiser, wired exactly as index.ts does. Defaulting it to
      // "always available" would let this test pass over a module state that
      // cannot actually deliver.
      { canHydrateMinOrderSize: (tokenId: string) => marketData.canHydrateMinOrderSize(tokenId) },
    );
    await normalization.start();
    await algo.start();

    const produced: unknown[] = [];
    bus.subscribe("SignalProduced", async (payload) => {
      produced.push(payload);
    });

    await marketData.poll();
    await bus.drain();

    await vi.waitFor(() => {
      expect(produced).toHaveLength(1);
    });
    // One poll, one REST book, one emission: the loop self-heals from a single
    // unknown-minimum tick instead of waiting for the next scanner cycle.
    expect(marketData.pricingCalls).toHaveBeenCalledTimes(1);
    expect(getOrderBooks).toHaveBeenCalledTimes(1);

    candidateBookCache.dispose();
    await algo.stop();
    await normalization.stop();
  });
});
