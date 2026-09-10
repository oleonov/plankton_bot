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
  type TokenMinimumAuthority,
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
  type Order,
  type Fill,
  type Position,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  bootstrapDatabase,
  SqliteOrderRepository,
  SqliteFillRepository,
  SqlitePositionRepository,
} from "@krabs/db";
import { LiveExchangeGateway, LiveMarketDataGateway } from "@krabs/exchange";
import {
  OrderBuilder,
  type UserOrderV2,
  type CreateOrderOptions,
} from "@polymarket/clob-client-v2";
import { RiskInventoryModule } from "../modules/risk-inventory/risk-inventory-module.js";
import { ExecutionModule } from "../modules/execution/execution-module.js";
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

function createObservedCache(deps: ConstructorParameters<typeof CandidateBookCache>[0]) {
  let authority: TokenMinimumAuthority;
  const gateway = deps.gateway;
  return new CandidateBookCache({
    ...deps,
    gateway: {
      setTokenMinimumAuthority: (source) => {
        authority = source;
      },
      getOrderBooks: async (tokens) => {
        const request = authority.begin(tokens);
        let books = new Map<string, OrderBookSnapshot>();
        try {
          books = await gateway.getOrderBooks(tokens);
          return books;
        } finally {
          authority.complete(
            request,
            new Map(tokens.map((id) => [id, books.get(id)?.minOrderSize ?? null])),
          );
        }
      },
    },
  });
}

const TOKEN = "tok-min-hydration";

function capturedDerekFixture() {
  const tokenId = "25440768084173492596124660289664772112753850137373593713699019611407231160558";
  const conditionId = "0xd961ab66c35dac3003e9c85dfdcf46433e6822de6a58a20569643990af941da9";
  const positionId = `pos-${tokenId}-1788556600272`;
  const ladderId = `${tokenId}:2026-09-04T21:16:30.000Z`;
  const sourceBuyRootOrderIds = [
    "0xa795341667ae50892bfe65777e50a8305df69272b27f35e04255652cb2917953",
  ];
  const position = {
    positionId,
    tokenId,
    conditionId,
    side: "buy",
    size: 39.129999999999995,
    avgEntryPrice: 0.011849987222080246,
    costBasisUsdc: 0.46368999999999994,
    currentValueUsdc: 0.5869499999999999,
    liquidationValueUsdc: 0.20651999999999995,
    liquidationPrice: 0.005277791975466394,
    liquidationDepthExhausted: false,
    liquidationValueUpdatedAt: "2026-09-08T08:33:12.434Z",
    realizedPnl: 0.0052499999999999995,
    status: "open",
    entryStyle: "maker",
    entryLane: "R23",
    exitOwner: "bounce",
    openedAt: "2026-09-04T21:16:40.272Z",
    closedAt: null,
    updatedAt: "2026-09-08T08:33:12.434Z",
  } as Position;
  const rows = [
    {
      orderId: "0x937128b78edd2f42d18e69254d48b28556b7a732c7e2e66aff431ebf1f34bc9e",
      clientOrderId: "krb_505c2a4860b32b12",
      price: 0.018,
      size: 7.553999999999999,
      sizeUsdc: 0.13597199999999998,
      status: "cancelled",
      fillProgressShares: 0.41,
      signalId: "b3a731a6-ad6f-4aca-9879-c16f58803058",
      signalTimestamp: "2026-09-04T22:26:00.235Z",
      createdAt: "2026-09-04T22:26:00.318Z",
      updatedAt: "2026-09-05T14:07:16.199Z",
      botRunId: "run-1788533217099",
      rungIndex: 0,
      fraction: 0.3,
      remaining: 25.18,
      uncommitted: 15.107999999999999,
      cacheStatus: "fresh-cache",
      bestBid: 0.013,
      bestAsk: 0.038,
      snapshotTs: 1788560758073,
    },
    {
      orderId: "0x62dd70504dac7ee990ff055aac787d848bd717710a29339600871b7b158136cb",
      clientOrderId: "krb_87c52cd57cdf8fe3",
      price: 0.018,
      size: 7.144000000000002,
      sizeUsdc: 0.128592,
      status: "cancelled",
      fillProgressShares: 0.64,
      signalId: "952c154a-f44b-45c3-b600-08785f676d65",
      signalTimestamp: "2026-09-05T14:11:25.286Z",
      createdAt: "2026-09-05T14:11:36.368Z",
      updatedAt: "2026-09-06T16:12:37.037Z",
      botRunId: "run-1788568103620",
      rungIndex: 0,
      fraction: 0.3,
      remaining: 24.77,
      uncommitted: 7.144000000000002,
      cacheStatus: "exit-book-fallback",
      bestBid: 0.012,
      bestAsk: 0.021,
      snapshotTs: 1788617412540,
    },
    {
      orderId: "0xc6cc590845306fd602eaef7ba7bcb8e4b4e7287ab91c93f4ea9d628af33a264d",
      clientOrderId: "krb_f01c2aa98046ab36",
      price: 0.027,
      size: 7.5539999999999985,
      sizeUsdc: 0.20395799999999994,
      status: "open",
      fillProgressShares: null,
      signalId: "bb1fcef6-401c-4b25-a51b-fc47cd251425",
      signalTimestamp: "2026-09-04T22:26:02.569Z",
      createdAt: "2026-09-04T22:26:02.899Z",
      updatedAt: "2026-09-04T23:12:56.311Z",
      botRunId: "run-1788533217099",
      rungIndex: 2,
      fraction: 0.3,
      remaining: 25.18,
      uncommitted: 7.5539999999999985,
      cacheStatus: "fresh-cache",
      bestBid: 0.013,
      bestAsk: 0.018,
      snapshotTs: 1788560760402,
    },
    {
      orderId: "0x87974dc8ba6121dbdf0d21d819a6e37462c4097b7844202dd7667d6ebba1551d",
      clientOrderId: "krb_945cf1e2718f4ee7",
      price: 0.022,
      size: 10.072000000000001,
      sizeUsdc: 0.221584,
      status: "open",
      fillProgressShares: null,
      signalId: "6ce6220e-f2ef-485c-a21a-9401a10473aa",
      signalTimestamp: "2026-09-04T22:43:12.168Z",
      createdAt: "2026-09-04T22:43:30.178Z",
      updatedAt: "2026-09-04T23:12:56.733Z",
      botRunId: "run-1788533217099",
      rungIndex: 1,
      fraction: 0.4,
      remaining: 25.18,
      uncommitted: 10.072000000000003,
      cacheStatus: "exit-book-fallback",
      bestBid: 0.013,
      bestAsk: 0.018,
      snapshotTs: 1788561626894,
    },
    {
      orderId: "0x6dbdd9cddbf0583351fb4bfeab888d51db7142a228a0cdebb00bedf99d47d04f",
      clientOrderId: "krb_11d6448d5dfa4a7c",
      price: 0.027,
      size: 14.999999999999996,
      sizeUsdc: 0.4049999999999999,
      status: "open",
      fillProgressShares: null,
      signalId: "4d1940b7-cbd0-420b-8689-7072c3c689e2",
      signalTimestamp: "2026-09-05T22:16:28.730Z",
      createdAt: "2026-09-05T22:16:40.025Z",
      updatedAt: "2026-09-05T22:16:40.944Z",
      botRunId: "run-1788568103620",
      rungIndex: 2,
      fraction: 0.5957108816521047,
      remaining: 39.77,
      uncommitted: 14.999999999999996,
      cacheStatus: "exit-book-fallback",
      bestBid: null,
      bestAsk: null,
      snapshotTs: null,
    },
  ];
  const orders = rows.map((row, i) => ({
    orderId: row.orderId,
    clientOrderId: row.clientOrderId,
    tokenId,
    conditionId,
    positionId,
    side: "sell",
    orderType: "GTC",
    postOnly: true,
    price: row.price,
    size: row.size,
    sizeUsdc: row.sizeUsdc,
    status: row.status,
    cancelReason: row.status === "cancelled" ? "stale_exit_ttl" : null,
    cancelAgeMs: null,
    cancelAgeBucket: null,
    fillProgressShares: row.fillProgressShares,
    marketHorizon: null,
    exchangeOrderId: row.orderId,
    signalId: row.signalId,
    signalReason: "repricing-exit",
    decisionRuleId: "BOUNCE_EXIT_TARGET",
    signalTimestamp: row.signalTimestamp,
    entryStyle: "maker",
    exchangeErrorCode: null,
    exchangeErrorMessage: null,
    exchangeErrorPayload: null,
    exchangeRejectionReason: null,
    botRunId: row.botRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    metadata: {
      executionPricingMode: "bounce-exit-target",
      cacheStatus: row.cacheStatus,
      marketData: { bookSource: "clob", minOrderSize: 5, effectiveMinOrderSize: 5 },
      bounceRung: {
        ladderId,
        rungIndex: row.rungIndex,
        anchorPrice: 0.013,
        fraction: row.fraction,
        originalPositionSize: 25.18,
        remainingPositionSize: row.remaining,
        uncommittedRemainder: row.uncommitted,
        ...(i === 4 ? { isCleanupRung: true } : {}),
      },
      orderSource: "strategy",
      ...(i === 4
        ? {}
        : {
            quoteMotionV1: {
              version: 1,
              kind: "bounce_exit_target",
              cohortId: ladderId,
              originalSuggestedPrice: row.price,
              originalTargetPrice: row.price,
              entryPriceCeiling: null,
              policySchemaVersion: 1,
              policyControlRevision: 121,
              permanentR23ActivationId: null,
              permanentR23ActivatedAtUtc: null,
              initialBook: {
                depthStatus: "full",
                bestBid: row.bestBid,
                bestAsk: row.bestAsk,
                tickSize: 0.001,
                snapshotTs: row.snapshotTs,
                source: row.cacheStatus,
              },
            },
            bounceAskCaptureLineageV1: {
              version: 1,
              rootOrderId: row.orderId,
              predecessorOrderId: null,
              replacementIndex: 0,
              positionId,
              sourceCohortActivatedAtUtc: "2026-08-28T09:16:57.368Z",
              permanentR23ActivationId: "9ba3259e-29de-4394-8233-8f5e4eb05cbd",
              permanentR23ActivatedAtUtc: "2026-08-28T09:16:57.368Z",
              originalTargetPrice: row.price,
              sourceBuyRootOrderIds,
            },
          }),
    },
  })) as unknown as Order[];
  const fills = [
    {
      fillId: "85f6bd14-173f-423b-9057-316c0a9cc4da#maker:0",
      size: 0.41,
      sizeUsdc: 0.007379999999999999,
      filledAt: "2026-09-05T14:06:37.000Z",
    },
    {
      fillId: "1cbb641b-6233-4c31-a589-1ab709d7d6a9#maker:0",
      size: 0.64,
      sizeUsdc: 0.011519999999999999,
      filledAt: "2026-09-06T16:11:42.000Z",
    },
  ].map((fill, i) => ({
    ...fill,
    orderId: rows[i]!.orderId,
    tokenId,
    conditionId,
    side: "sell",
    price: 0.018,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    signalId: rows[i]!.signalId,
    decisionRuleId: "BOUNCE_EXIT_TARGET",
    signalTimestamp: rows[i]!.signalTimestamp,
  })) as Fill[];
  return {
    capturedAt: "2026-09-08T08:37:52.997Z",
    position,
    orders,
    fills,
    candidate: {
      at: "2026-09-08T08:18:17.828Z",
      signalId: "8856e7b6-3689-46a7-af4f-f802f8a49e45",
      reasonCode: "per_token_sell_limit",
      suppressedSinceLast: 0,
      inputs: {
        suggestedSize: 6.504000000000005,
        suggestedPrice: 0.018,
        positionId,
        bounceRung: {
          ladderId,
          rungIndex: 0,
          anchorPrice: 0.013,
          fraction: 0.3,
          originalPositionSize: 25.18,
          remainingPositionSize: 39.13,
          uncommittedRemainder: 6.504000000000005,
          rungIndicesCovered: [0],
        },
        signalMarketMinOrderSize: null,
        riskMinOrderSizeAtEvaluation: null,
      },
    },
  };
}

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
    const cache = createObservedCache({
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
    const cache = createObservedCache({
      gateway,
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) => observed.push([tokenId, minOrderSize]),
    });

    await cache.prime([TOKEN]);
    cache.upsertBooks(new Map([[TOKEN, makeBook(TOKEN, 0)]]));

    expect(observed).toEqual([]);
  });

  it("does not create authority or announce metadata from cache insertion", () => {
    const observed: Array<[string, number]> = [];
    const cache = createObservedCache({
      gateway: { getOrderBooks: vi.fn(async () => new Map()) },
      log: makeLogger(),
      onMinOrderSizeObserved: (tokenId, minOrderSize) => observed.push([tokenId, minOrderSize]),
    });

    cache.upsertBooks(new Map([[TOKEN, makeBook(TOKEN, 5)]]), Date.now(), "rest");

    expect(observed).toEqual([]);
    expect(cache.tokenMinimum.read(TOKEN)).toEqual({ remembered: null, latest: null });
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
    const cache = createObservedCache({
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
    const cache = createObservedCache({
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

  it("does not re-announce a REST observation on a fresh cache read", async () => {
    const observed: Array<[string, number]> = [];
    const getOrderBooks = vi.fn(
      async (tokenIds: string[]) =>
        new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId, 5)])),
    );
    const cache = createObservedCache({
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
    expect(observed).toEqual([]);
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
    const cache = createObservedCache({
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

  it("remembers older valid knowledge without overriding newer unavailable authority", async () => {
    // A /books payload can omit `min_order_size` while the previous one carried
    // it. Skipping the superseded response wholesale — correct for the BOOK —
    // then throws away the only minimum anyone observed, and the refresh is
    // deduped, so the entry stays suppressed with nothing left to clear it.
    const observed: Array<[string, number]> = [];
    const resolvers: Array<(books: Map<string, OrderBookSnapshot>) => void> = [];
    const getOrderBooks = vi.fn(
      () => new Promise<Map<string, OrderBookSnapshot>>((resolve) => resolvers.push(resolve)),
    );
    const cache = createObservedCache({
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
    expect(observed).toEqual([]);
    expect(cache.tokenMinimum.read(TOKEN)).toMatchObject({
      remembered: 5,
      latest: { minimum: null },
    });
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
    getSizeRules: vi.fn((actionType: string) => [{ ...buySize, actionType }]),
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

function supplementalDeps() {
  const firstTradeAt = new Date(Date.now() - 60_000).toISOString();
  const leg = {
    tokenId: createTokenId(TOKEN),
    buyCount: 2,
    sellCount: 0,
    firstTradeAt,
    lastTradeAt: firstTradeAt,
    firstTradePrice: 0.013,
    cumulativeBuySize: 39.13,
    cumulativeBuyNotional: 39.13 * 0.013,
    cumulativeSellSize: 0,
    cumulativeSellNotional: 0,
  };
  const position = {
    tokenId: createTokenId(TOKEN),
    conditionId: "cond-min-hydration",
    positionId: "derek",
    status: "open",
    side: "buy",
    entryLane: "GATE",
    exitOwner: "bounce",
    size: 39.13,
    avgEntryPrice: 0.013,
    openedAt: firstTradeAt,
  };
  const orders = [
    [2, 7.554],
    [1, 10.072],
    [2, 15],
  ].map(([rungIndex, size], i) => ({
    tokenId: createTokenId(TOKEN),
    orderId: `derek-${i}`,
    side: "sell",
    status: "open",
    decisionRuleId: "BOUNCE_EXIT_TARGET",
    size,
    price: 0.04,
    createdAt: firstTradeAt,
    metadata: {
      bounceRung: {
        ladderId: `${TOKEN}:${firstTradeAt}`,
        rungIndex,
        originalPositionSize: 25.18,
        isCleanupRung: i === 2,
      },
    },
  }));
  return {
    legStateRepo: {
      getAll: () => [leg],
      get: (tokenId: string) => ({ ...leg, tokenId }),
      findOpen: () => [leg],
    },
    positionRepo: {
      findOpen: () => [position],
      findByTokenId: (tokenId: string) => ({ ...position, tokenId }),
    },
    orderRepo: {
      findOpen: () => orders,
      findByTokenId: (tokenId: string) =>
        orders.map((order) => ({
          ...order,
          tokenId,
          metadata: {
            bounceRung: { ...order.metadata.bounceRung, ladderId: `${tokenId}:${firstTradeAt}` },
          },
        })),
      findRecentByTokenId: () => orders,
      hasNonterminalBounceAskCaptureIntentForPosition: () => false,
    },
    fillRepo: { findByOrderIds: () => [], findByOrderId: () => [] },
    executionPolicy: () => ({
      ...sellableFlowPolicy(),
      entryMinMarketAgeSeconds: 0,
      bounceExit: {
        ...DEFAULT_EXECUTION_POLICY.bounceExit,
        enabled: true,
        mode: "micro_live",
        whitelistConditionIds: ["cond-min-hydration"],
      },
    }),
  };
}

async function emitMarketUpdate(
  bus: EventBus & { publish: ReturnType<typeof vi.fn> },
  market: NormalizedMarket,
): Promise<void> {
  await bus.publish("NormalizedMarketUpdated", { markets: [market], timestamp: Date.now() });
}

describe("AlgoDecisionModule — unknown minimum pre-filter", () => {
  it("MINFIX delayed profile skip preserves another Algo pending signal and schedules no rearm", async () => {
    const bus = new InProcessEventBus();
    const mod = buildAlgoModule(bus, vi.fn());
    await mod.start();
    const produced: RuntimeEventMap["SignalProduced"][] = [];
    bus.subscribe("SignalProduced", async (event) => {
      produced.push(event);
    });
    const internals = mod as unknown as { scheduleMinOrderSizeRearm: (token: string) => void };
    const rearm = vi.spyOn(internals, "scheduleMinOrderSizeRearm");
    try {
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makePricingMarket({ minOrderSize: 5 })],
        timestamp: Date.now(),
      });
      await vi.waitFor(() => expect(produced).toHaveLength(1));
      await bus.publish("SignalConversionSkipped", {
        signal: makeSignal({
          signalId: "older-profile-add",
          reason: "scale-in",
          decisionRuleId: "EXECUTION_PROFILE_SCALE_IN",
        }) as never,
        stage: "execution-terms",
        reasons: ["entry_unknown_min"],
        diagnostics: {},
        skippedAt: Date.now(),
      });
      await bus.publish("NormalizedMarketUpdated", {
        markets: [makePricingMarket({ minOrderSize: 5 })],
        timestamp: Date.now(),
      });
      await bus.drain();
      expect(rearm).not.toHaveBeenCalled();
      expect(produced).toHaveLength(1);
    } finally {
      await mod.stop();
    }
  });

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
      expect(markDirty).toHaveBeenCalledWith(TOKEN, "retry");
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
      expect(markDirty).toHaveBeenCalledWith(TOKEN, "retry");
      expect(schedule).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }

    await mod.stop();
  });

  it.each(["entry", "supplemental"])(
    "MINFIX %s keeps re-arming a late join inside its own backoff",
    async (kind) => {
      const bus = createMockBus();
      const requestHydration = vi.fn();
      const mod = buildAlgoModule(
        bus,
        requestHydration,
        kind === "supplemental" ? supplementalDeps() : {},
      );
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
    },
  );

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
  it("admits the captured Derek residual through planning, Risk, Execution and SDK signing without price delivery", async () => {
    const captured = capturedDerekFixture();
    const { position, orders, fills, candidate } = captured;
    const bus = new InProcessEventBus();
    const db = bootstrapDatabase(":memory:");
    const orderRepo = new SqliteOrderRepository(db.db);
    const fillRepo = new SqliteFillRepository(db.db);
    const positionRepo = new SqlitePositionRepository(db.db);
    orders.forEach((order) => orderRepo.save(order));
    fills.forEach((fill) => fillRepo.save(fill));
    fillRepo.markReconciled(fills.map((fill) => fill.fillId));
    positionRepo.save(position);
    const beforeOrders = orders.map((order) => orderRepo.findById(order.orderId));
    const beforeFills = fillRepo.findByTokenId(position.tokenId);
    const builder = new OrderBuilder(
      {
        getAddress: async () => "0x1111111111111111111111111111111111111111",
        _signTypedData: async () => `0x${"11".repeat(65)}`,
      },
      137,
    );
    const client = {
      chainId: 137,
      createOrder: vi.fn((order: UserOrderV2, options: CreateOrderOptions) =>
        builder.buildOrder(order, options, 2),
      ),
      postOrder: vi.fn(async () => ({
        orderID: orderRepo.findOpen().find((order) => order.status === "pending")!.orderId,
      })),
    };
    const marketData = new LiveMarketDataGateway({ client });
    const exchange = new LiveExchangeGateway({ client });
    const cache = new CandidateBookCache({
      gateway: marketData,
      log: makeLogger(),
      onMinimumChanged: (tokenId, minimum) => {
        void bus.publish("TokenMinimumChanged", { tokenId, minimum });
      },
    });
    exchange.setTokenMinimumSource(cache.tokenMinimum);
    const rawBook = {
      asset_id: String(position.tokenId),
      min_order_size: "5",
      bids: [{ price: "0.013", size: "100" }],
      asks: [{ price: "0.018", size: "100" }],
      timestamp: String(Date.now()),
    };
    let finish!: (response: Response) => void;
    const response = () => new Response(JSON.stringify([rawBook]), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () => response())
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finish = resolve;
            }),
        ),
    );
    const policy = {
      ...supplementalDeps().executionPolicy(),
      bounceExit: {
        ...supplementalDeps().executionPolicy().bounceExit,
        mode: "micro_live" as const,
        whitelistConditionIds: [String(position.conditionId)],
      },
    };
    const leg = {
      ...supplementalDeps().legStateRepo.getAll()[0]!,
      tokenId: position.tokenId,
      firstTradeAt: "2026-09-04T21:16:30.000Z",
      lastTradeAt: position.openedAt,
      cumulativeBuySize: 40.18,
      cumulativeSellSize: 1.05,
    };
    // These price and FIFO inputs exercise execution; they are not a claimed 08:18 heap capture.
    const executableMarket = makePricingMarket({
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      tickSize: 0.001,
      bestBid: 0.013,
      bestAsk: 0.018,
      midPrice: 0.0155,
      spread: 0.005,
      minOrderSize: null,
      snapshotTs: Date.now(),
    });
    const lots = {
      findOpen: () => [
        {
          positionId: position.positionId,
          tokenId: position.tokenId,
          remainingSize: position.size,
          entryPrice: position.avgEntryPrice,
          createdAt: position.openedAt,
        },
      ],
      findByTokenId: () => [],
    };
    const markets = {
      findByTokenId: () => ({
        ...makeTrackedMarket(),
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        tickSize: 0.001,
      }),
    };
    const runtimeControl = { isPaused: () => false };
    const delivery = makeMarketDataModule(bus, {});
    expect(delivery.canHydrateMinOrderSize(String(position.tokenId))).toBe(false);
    const requests: Promise<unknown>[] = [];
    const algo = buildAlgoModule(
      bus,
      (id) => {
        requests.push(cache.forceRefresh(id));
      },
      {
        tokenMinimum: cache.tokenMinimum,
        canHydrateMinOrderSize: () => true,
        runtimeControl,
        positionRepo,
        orderRepo,
        fillRepo,
        executionPolicy: () => policy,
        selectedMarketCache: {
          isEligible: () => true,
          getEligibleTokenIds: () => [position.tokenId],
        },
        legStateRepo: { getAll: () => [leg], get: () => leg, findOpen: () => [leg] },
      },
    );
    const risk = new RiskInventoryModule({
      bus,
      positionRepo,
      inventoryLotRepo: lots as never,
      orderRepo,
      fillRepo,
      marketRepo: markets,
      db: db.db,
      log: makeLogger(),
      runtimeControl,
      tokenMinimum: cache.tokenMinimum,
      executionPolicy: () => policy,
      markToMarketEnabled: false,
      emitStrandedFillAlert: () => {},
    });
    const execution = new ExecutionModule({
      bus,
      gateway: exchange,
      marketRepo: markets as never,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo: lots as never,
      log: makeLogger(),
      runtimeMode: "live-lite",
      runtimeControl,
      tokenMinimum: cache.tokenMinimum,
      executionPolicy: () => policy,
      botRunId: "incident-regression" as never,
    });
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      candidateBookCache: cache,
      positionRepo,
      orderRepo,
      policy: () => policy,
    });
    const produced: RuntimeEventMap["SignalProduced"][] = [];
    const approved: RuntimeEventMap["SignalApproved"][] = [];
    const cancelled = vi.fn();
    const priceEvents = vi.fn();
    bus.subscribe("SignalProduced", async (event) => {
      produced.push(event);
    });
    bus.subscribe("SignalApproved", async (event) => {
      approved.push(event);
    });
    bus.subscribe("CancelOrderRequested", cancelled);
    bus.subscribe("NormalizedMarketUpdated", priceEvents);
    const bounded = async (label: string, work: Promise<unknown>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label)), 1_500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      await bounded("Risk startup stalled", risk.start());
      await bounded("Execution startup stalled", execution.start());
      bridge.subscribe();
      await bounded("Algo startup stalled", algo.start());
      expect(cache.tokenMinimum.read(String(position.tokenId)).remembered).toBeNull();
      expect(risk.getLatestMinOrderSize(position.tokenId)).toBeNull();
      const publishing = bus.publish("NormalizedMarketUpdated", {
        markets: [executableMarket],
        timestamp: Date.now(),
      });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      finish(response());
      await bounded("initial market delivery stalled", publishing);
      await bounded("minimum hydration stalled", Promise.all(requests));
      await vi.waitFor(() => expect(client.postOrder).toHaveBeenCalledOnce());
      await bus.drain();
      expect(produced[0]?.signal.suggestedSize).toBe(candidate.inputs.suggestedSize);
      expect(produced[0]?.signal.suggestedPrice).toBe(candidate.inputs.suggestedPrice);
      expect(produced[0]?.market.minOrderSize).toBe(5);
      expect(approved[0]?.market.minOrderSize).toBe(5);
      expect(risk.getLatestMinOrderSize(position.tokenId)).toBe(5);
      const signed = await client.createOrder.mock.results[0]!.value;
      expect(signed.makerAmount).toBe("6500000");
      expect(client.createOrder.mock.calls[0]?.[0].size).toBe(candidate.inputs.suggestedSize);
      expect(cancelled).not.toHaveBeenCalled();
      expect(priceEvents).toHaveBeenCalledOnce();
      expect(orderRepo.findOpen()).toHaveLength(4);
      expect(
        orderRepo.findOpen().find((order) => !orders.some((old) => old.orderId === order.orderId)),
      ).toMatchObject({ status: "open", size: candidate.inputs.suggestedSize, price: 0.018 });
      expect(orders.map((order) => orderRepo.findById(order.orderId))).toEqual(beforeOrders);
      expect(fillRepo.findByTokenId(position.tokenId)).toEqual(beforeFills);
      expect(captured.capturedAt).toBe("2026-09-08T08:37:52.997Z");
      expect(position.updatedAt).toBe("2026-09-08T08:33:12.434Z");
    } finally {
      finish?.(response());
      cache.dispose();
      bridge.unsubscribe();
      await Promise.allSettled([
        bounded("Algo shutdown stalled", algo.stop()),
        bounded("Execution shutdown stalled", execution.stop()),
        bounded("Risk shutdown stalled", risk.stop()),
      ]);
      db.close();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    "success",
    "changed-orders",
    "invalid",
    "missing",
    "failure",
    "pause",
    "remove",
    "stop",
  ])("MINFIX supplemental SELL real hydration chain: %s", async (outcome) => {
    const bus = new InProcessEventBus();
    let paused = false;
    const runtimeControl = { isPaused: () => paused };
    const marketData = makeMarketDataModule(
      bus,
      {
        bestBid: 0.04,
        bestAsk: 0.04,
        bookSource: "clob",
        acceptingOrders: true,
        enableOrderBook: true,
      },
      runtimeControl,
    );
    let finish!: (books: Map<string, OrderBookSnapshot>) => void;
    let fail!: (error: Error) => void;
    const getOrderBooks = vi.fn(
      () =>
        new Promise<Map<string, OrderBookSnapshot>>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const cache = createObservedCache({
      gateway: { getOrderBooks },
      log: makeLogger(),
      onMinOrderSizeObserved: (token, minimum) =>
        marketData.noteMinOrderSizeObserved(token, minimum),
    });
    const requests: Promise<unknown>[] = [];
    const deps = supplementalDeps();
    const algo = buildAlgoModule(
      bus,
      (token) => {
        requests.push(
          cache.getFreshOrRefresh(token, Date.now(), { requireKnownMinOrderSize: true }),
        );
      },
      {
        ...deps,
        runtimeControl,
        canHydrateMinOrderSize: (token: string) => marketData.canHydrateMinOrderSize(token),
      },
    );
    const normalization = new NormalizationModule({ bus, log: makeLogger() });
    const produced: RuntimeEventMap["SignalProduced"][] = [];
    const effects: string[] = [];
    bus.subscribe("SignalProduced", async (p) => {
      produced.push(p);
    });
    for (const name of ["PlaceOrderRequested", "CancelOrderRequested"] as const) {
      bus.subscribe(name, async () => {
        effects.push(name);
      });
    }
    await normalization.start();
    await algo.start();
    if (outcome === "stop") vi.useFakeTimers();
    try {
      await marketData.poll();
      await vi.waitFor(() => expect(getOrderBooks).toHaveBeenCalledTimes(1));
      expect(produced).toHaveLength(0);
      expect(effects).toEqual([]);
      if (outcome === "changed-orders") deps.orderRepo.findOpen()[2]!.size = 16;
      if (outcome === "pause") paused = true;
      if (outcome === "stop") await algo.stop();
      if (outcome === "remove") {
        marketData.trackedCalls.mockReturnValue([]);
        await marketData.poll();
      }
      if (outcome === "failure") fail(new Error("fixture REST failure"));
      else
        finish(
          outcome === "missing"
            ? new Map()
            : new Map([[TOKEN, makeBook(TOKEN, outcome === "invalid" ? 0 : 5)]]),
        );
      await Promise.all(requests);
      await bus.drain();
      if (outcome === "success" || outcome === "changed-orders") {
        await vi.waitFor(() => expect(produced).toHaveLength(1));
        expect(produced[0]?.market?.minOrderSize).toBe(5);
        expect(produced[0]?.signal.suggestedSize).toBeCloseTo(
          outcome === "success" ? 6.504 : 5.504,
          10,
        );
        expect(produced[0]?.signal.bounceRung?.rungIndex).toBe(0);
        expect(marketData.pricingCalls).toHaveBeenCalledTimes(1);
      } else expect(produced).toHaveLength(0);
      if (outcome === "pause") {
        paused = false;
        await marketData.poll();
        await vi.waitFor(() => expect(produced).toHaveLength(1));
        expect(produced[0]?.market?.minOrderSize).toBe(5);
      }
      expect(effects).toEqual([]);
      if (outcome === "stop") {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(getOrderBooks).toHaveBeenCalledTimes(1);
        expect(produced).toHaveLength(0);
      }
    } finally {
      cache.dispose();
      await algo.stop();
      await normalization.stop();
      vi.useRealTimers();
    }
  });

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
    const candidateBookCache = createObservedCache({
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
