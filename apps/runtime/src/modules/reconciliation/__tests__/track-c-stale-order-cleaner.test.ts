import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_REPRICE_CHAIN_POLICY,
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
  type EventBus,
  type LegState,
  type Market,
  type MarketRepository,
  type NormalizedMarket,
  type Order,
  type OrderRepository,
  type Position,
  type RuntimeEventMap,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { cleanStaleEntryOrders } from "../stale-order-cleaner.js";
import type { Logger } from "../../../logger.js";
import { RuntimeMetricWriter } from "../../../runtime-metric-writer.js";

const TOKEN = createTokenId("tok-track-c-cleaner");
const CONDITION = createConditionId("cond-track-c-cleaner");
const NOW = Date.parse("2026-06-02T12:00:00.000Z");

describe("Track C stale-order-cleaner integration", () => {
  it("keeps legacy downprice behavior when Track C dependencies are absent", async () => {
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      pricing: makePricing({ bestBid: 0.05 }),
      omitTrackC: true,
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(env.cancelled).toHaveLength(1);
    expect(env.cancelled[0]?.command.reason).toBe("downpriced_reprice");
    expect(env.holdResolutionRepo.insertActive).not.toHaveBeenCalled();
  });

  it("uses fixed_3 reprice threshold for LIVE strike exit path", async () => {
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.08 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.06 }),
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0.002 },
      legState: makeLegState({ repriceChainCount24h: 0 }),
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(env.cancelled[0]?.command.reason).toBe("downpriced_reprice");
    expect(env.holdResolutionRepo.insertActive).not.toHaveBeenCalled();
  });

  it("passes unknown liveness through to legacy downprice behavior by default", async () => {
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.06, publicTradeCount24h: 0 }),
      bookSignals: null,
      legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(1);
    expect(env.cancelled[0]?.command.reason).toBe("downpriced_reprice");
    expect(env.holdResolutionRepo.insertActive).not.toHaveBeenCalled();
  });

  it("keeps liveness LIVE when supplied book signals are available", async () => {
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.08 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.06 }),
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0.002 },
      legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
    });

    await env.run();
    await env.bus.drain();

    expect(silentLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({ livenessVerdict: "live" }),
      "track_c_exit_evaluated",
    );
  });

  it("emits Track C decision counters for verdict, stale branch, and action", async () => {
    const metrics = { writeCounter: vi.fn() };
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.2 }),
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
      legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
      position: makePosition({ openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString() }),
      metrics,
    });

    await env.run();
    await env.bus.drain();

    expect(metrics.writeCounter).toHaveBeenCalledWith("track_c.verdict.dead");
    expect(metrics.writeCounter).toHaveBeenCalledWith("track_c.stale_branch.chain");
    expect(metrics.writeCounter).toHaveBeenCalledWith("track_c.action.hold_resolution");
  });

  it("emits Track C counters through RuntimeMetricWriter without losing method binding", async () => {
    const db = makeRuntimeMetricsDb();
    try {
      const metrics = new RuntimeMetricWriter(db);
      const env = makeEnv({
        order: makeExitSellOrder({ price: 0.1 }),
        pricing: makePricing({ bestBid: 0.05, bestAsk: 0.2 }),
        bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
        legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
        position: makePosition({ openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString() }),
        metrics,
      });

      await expect(env.run()).resolves.toMatchObject({ downpriceRepriceCancelled: 0 });
      metrics.flushCounters("2026-06-02T12:00:30.000Z");

      const rows = db
        .prepare("SELECT metric_name, value FROM runtime_metrics ORDER BY metric_name")
        .all() as Array<{ metric_name: string; value: number }>;
      expect(rows).toEqual([
        { metric_name: "track_c.action.hold_resolution", value: 1 },
        { metric_name: "track_c.stale_branch.chain", value: 1 },
        { metric_name: "track_c.verdict.dead", value: 1 },
      ]);
      expect(silentLog.error).not.toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(TypeError) }),
        "track_c_exit_evaluation_failed",
      );
    } finally {
      db.close();
    }
  });

  it("suppresses downprice reprice and writes hold_resolution for DEAD chain-stuck sell", async () => {
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.2 }),
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
      legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
      position: makePosition({ openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString() }),
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(env.cancelled).toHaveLength(0);
    expect(env.holdResolutionRepo.insertActive).toHaveBeenCalledOnce();
    expect(env.holdResolutionRepo.insertActive).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenId: TOKEN,
        conditionId: CONDITION,
        staleReason: "chain",
        livenessVerdict: "dead",
      }),
    );
  });

  it("does not re-insert hold_resolution when an active marker already exists", async () => {
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.2 }),
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
      legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
      position: makePosition({ openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString() }),
    });
    env.holdResolutionRepo.findActiveByTokenId.mockReturnValueOnce({
      tokenId: TOKEN,
      status: "active",
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(env.holdResolutionRepo.insertActive).not.toHaveBeenCalled();
    expect(silentLog.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        exitAction: "hold_resolution",
        exitReason: "hold_resolution_active",
      }),
      "track_c_exit_evaluated",
    );
  });

  it("preserves HARD RULE: DEAD price_only stale sell only passive-sits", async () => {
    const env = makeEnv({
      order: makeExitSellOrder({
        price: 0.1,
        createdAt: new Date(NOW - 31 * 60_000).toISOString(),
      }),
      pricing: makePricing({ bestBid: 0.005, bestAsk: 0.09, publicTradeCount24h: 0 }),
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
      legState: makeLegState({ repriceChainCount24h: 0, sellCount: 0 }),
    });

    const result = await env.run();
    await env.bus.drain();

    expect(result.downpriceRepriceCancelled).toBe(0);
    expect(env.cancelled).toHaveLength(0);
    expect(env.holdResolutionRepo.insertActive).not.toHaveBeenCalled();
    expect(env.floorIntentRepo.insertActive).not.toHaveBeenCalled();
  });

  it("keeps floor_intents inert with floor_close hardcoded off", async () => {
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.2 }),
      floorCloseRatioThreshold: 0.5,
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
      legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
      position: makePosition({
        costBasisUsdc: 10,
        currentValueUsdc: 4,
        openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
      }),
    });

    await env.run();
    await env.bus.drain();

    expect(env.floorIntentRepo.insertActive).not.toHaveBeenCalled();
    expect(env.holdResolutionRepo.insertActive).toHaveBeenCalledOnce();
    expect(env.holdResolutionRepo.insertActive.mock.calls[0]?.[0].metadata).toMatchObject({
      exitActionReason: "phase_1_floor_disabled",
    });
  });

  it("fails open when hold_resolution persistence throws", async () => {
    const metrics = { writeCounter: vi.fn() };
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.2 }),
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
      legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
      position: makePosition({ openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString() }),
      metrics,
    });
    env.holdResolutionRepo.insertActive.mockImplementationOnce(() => {
      throw new Error("sqlite busy");
    });

    await expect(env.run()).resolves.toMatchObject({ downpriceRepriceCancelled: 0 });

    expect(silentLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tokenId: String(TOKEN),
        action: "hold_resolution",
      }),
      "track_c_action_persist_failed",
    );
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "track_c_action_persist_failed_total",
      1,
      expect.stringContaining('"action":"hold_resolution"'),
    );
  });

  it("fails open to legacy reprice when Track C evaluation throws", async () => {
    const metrics = { writeCounter: vi.fn() };
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.06 }),
      bookSignals: null,
      metrics,
      getBookSignalsThrows: true,
    });

    await expect(env.run()).resolves.toMatchObject({ downpriceRepriceCancelled: 1 });
    expect(env.cancelled[0]?.command.reason).toBe("downpriced_reprice");
    expect(silentLog.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        tokenId: String(TOKEN),
      }),
      "track_c_exit_evaluation_failed",
    );
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "track_c_pipeline_failed_total",
      1,
      expect.stringContaining('"source":"stale_order_cleaner"'),
    );
  });

  it("opens a Track C isolation circuit after three consecutive evaluation failures", async () => {
    const metrics = { writeCounter: vi.fn() };
    const env = makeEnv({
      order: makeExitSellOrder({ price: 0.1 }),
      orders: [
        makeExitSellOrder({ orderId: createOrderId("ord-track-c-fail-1") }),
        makeExitSellOrder({ orderId: createOrderId("ord-track-c-fail-2") }),
        makeExitSellOrder({ orderId: createOrderId("ord-track-c-fail-3") }),
      ],
      pricing: makePricing({ bestBid: 0.05, bestAsk: 0.06 }),
      bookSignals: null,
      metrics,
      getBookSignalsThrows: true,
    });

    await expect(env.run()).resolves.toMatchObject({ downpriceRepriceCancelled: 1 });

    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "track_c_circuit_open_total",
      1,
      expect.stringContaining('"source":"stale_order_cleaner"'),
    );
  });
});

function makeEnv(input: {
  readonly order: Order;
  readonly orders?: readonly Order[];
  readonly pricing: ReturnType<typeof makePricing>;
  readonly omitTrackC?: boolean;
  readonly floorCloseRatioThreshold?: number | null;
  readonly bookSignals?: {
    readonly bidPersistenceS?: number | null;
    readonly bidMovement30m?: number | null;
  } | null;
  readonly legState?: LegState | null;
  readonly position?: Position | null;
  readonly metrics?: {
    writeCounter: (metricName: string, value?: number, labels?: string | null) => void;
  };
  readonly getBookSignalsThrows?: boolean;
}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const bus = new InProcessEventBus();
  const cancelled: RuntimeEventMap["CancelOrderRequested"][] = [];
  bus.subscribe("CancelOrderRequested", async (event) => {
    cancelled.push(event);
  });

  const orderRepo = makeOrderRepo(input.orders ?? [input.order]);
  const marketRepo = makeMarketRepo(makeMarket());
  const holdResolutionRepo = {
    insertActive: vi.fn(),
    findActiveByTokenId: vi.fn().mockReturnValue(null),
  };
  const floorIntentRepo = {
    insertActive: vi.fn(),
    findActiveByTokenId: vi.fn().mockReturnValue(null),
  };

  return {
    bus,
    cancelled,
    holdResolutionRepo,
    floorIntentRepo,
    run: () =>
      cleanStaleEntryOrders(
        {
          orderRepo,
          marketRepo,
          bus: bus as EventBus,
          log: silentLog,
          exitRepriceOnDownprice: {
            policy: () => ({
              ...DEFAULT_EXECUTION_POLICY.exitRepriceOnDownprice,
              enabled: true,
              thresholdTicks: 5,
              maxRepricesPerOrder: 3,
            }),
            getMarket: () => input.pricing,
          },
          repriceChainGate: {
            policy: () => DEFAULT_REPRICE_CHAIN_POLICY,
            legStateRepo: {
              get: () => input.legState ?? makeLegState(),
            },
            metrics: input.metrics,
          },
          ...(input.omitTrackC
            ? {}
            : {
                trackCExit: {
                  positionRepo: {
                    findByTokenId: () => input.position ?? makePosition(),
                  },
                  legStateRepo: {
                    get: () => input.legState ?? makeLegState(),
                  },
                  holdResolutionRepo,
                  floorIntentRepo,
                  ...(input.bookSignals !== undefined
                    ? {
                        getBookSignals: () => {
                          if (input.getBookSignalsThrows) throw new Error("book signal failure");
                          return input.bookSignals ?? null;
                        },
                      }
                    : {}),
                  floorCloseRatioThreshold: () => input.floorCloseRatioThreshold ?? null,
                },
              }),
        },
        new Map(),
      ),
  };
}

function makeOrderRepo(openOrders: readonly Order[]): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([...openOrders]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

function makeMarketRepo(market: Market): MarketRepository {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(market),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findTrackedForPricingTiered: vi.fn().mockReturnValue({
      executionCritical: [],
      entryCandidates: [],
      discoveryOnly: [],
    }),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
    updateTickSize: vi.fn(),
  };
}

function makeExitSellOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("ord-track-c-cleaner"),
    clientOrderId: "client-track-c-cleaner" as ClientOrderId,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "sell",
    orderType: "GTC",
    price: 0.1,
    size: 10,
    sizeUsdc: 1,
    status: "open",
    exchangeOrderId: "ex-track-c-cleaner",
    signalId: "sig-track-c-cleaner",
    signalReason: "repricing-exit",
    botRunId: createBotRunId("run-track-c-cleaner"),
    createdAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    tokenId: TOKEN,
    conditionId: String(CONDITION),
    slug: "generic-weather-threshold-market",
    eventSlug: "track-c-test-event",
    question: "Will Track C weather threshold pass?",
    outcome: "Yes",
    regime: null,
    horizon: "daily",
    endDate: new Date(NOW + 2 * 24 * 60 * 60_000).toISOString(),
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    tags: ["weather"],
    gammaCreatedAt: null,
    createdAt: new Date(NOW - 2 * 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function makePricing(
  overrides: Partial<
    Pick<
      NormalizedMarket,
      | "bestBid"
      | "bestAsk"
      | "bestAskSize"
      | "askDepthExcludingOurs"
      | "midPrice"
      | "spread"
      | "tickSize"
      | "publicTradeCount24h"
      | "snapshotTs"
    >
  > = {},
) {
  return {
    bestBid: 0.05,
    bestAsk: 0.06,
    bestAskSize: 100,
    askDepthExcludingOurs: 100,
    midPrice: 0.055,
    spread: 0.01,
    tickSize: 0.01,
    publicTradeCount24h: 1,
    snapshotTs: NOW - 60_000,
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("pos-track-c-cleaner"),
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    size: 10,
    avgEntryPrice: 0.08,
    costBasisUsdc: 0.8,
    currentValueUsdc: 0.5,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
    closedAt: null,
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function makeLegState(overrides: Partial<LegState> = {}): LegState {
  return {
    tokenId: TOKEN,
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.08,
    firstTradeAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
    lastTradeAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    repriceChainCount24h: 0,
    ...overrides,
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;

function makeRuntimeMetricsDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE runtime_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL,
      labels TEXT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_runtime_metrics_name_ts
      ON runtime_metrics(metric_name, captured_at DESC);
  `);
  return db;
}
