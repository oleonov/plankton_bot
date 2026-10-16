import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_REPRICE_CHAIN_POLICY,
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  isLiveBook,
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
  type TokenId,
} from "@krabs/domain";
import {
  bootstrapLedgerDb,
  SqliteFloorIntentRepository,
  SqliteHoldResolutionStateRepository,
  type DbConnection,
} from "@krabs/db";
import { InProcessEventBus } from "@krabs/event-bus";
import { cleanStaleEntryOrders } from "../stale-order-cleaner.js";
import type { Logger } from "../../../logger.js";
import { buildBookContext } from "../context-builders/track-c-context-builders.js";
import { resolveMidpointAnchoredSellPrice } from "../../strategy/signal-to-order.js";

const NOW = Date.parse("2026-06-02T12:00:00.000Z");
const DEFAULT_CONDITION = createConditionId("cond-track-c-phase-c");

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Track C Phase C backward compatibility", () => {
  const scenarios = Array.from({ length: 20 }, (_, index) => ({
    label: `legacy-gap-${index}`,
    gapTicks: index,
    expectedCancel: expectDownpriceCancelAfterTrackLGuard({
      expectedRepriceDecision: index >= 5,
      orderPrice: 0.05 + index * 0.001,
      bestBid: 0.05,
      bestAsk: 0.06,
      tickSize: 0.001,
    }),
  }));

  it.each(scenarios)(
    "C.2 legacy fallback matches unknown pass-through when Track C deps are absent: $label",
    async ({ gapTicks, expectedCancel }) => {
      const legacyFallback = makeCleanerEnv({
        orderPrice: 0.05 + gapTicks * 0.001,
        bestBid: 0.05,
        tickSize: 0.001,
        omitTrackC: true,
      });
      const unknownPassThrough = makeCleanerEnv({
        orderPrice: 0.05 + gapTicks * 0.001,
        bestBid: 0.05,
        tickSize: 0.001,
        bookSignals: null,
      });

      const legacyResult = await legacyFallback.run();
      await legacyFallback.bus.drain();
      const passThroughResult = await unknownPassThrough.run();
      await unknownPassThrough.bus.drain();

      expect(legacyResult).toEqual(passThroughResult);
      expect(legacyFallback.cancelled.map((event) => event.command.reason)).toEqual(
        unknownPassThrough.cancelled.map((event) => event.command.reason),
      );
      expect(legacyResult.downpriceRepriceCancelled > 0).toBe(expectedCancel);
      expect(unknownPassThrough.holdResolutionRepo.insertActive).not.toHaveBeenCalled();
      expect(unknownPassThrough.floorIntentRepo.insertActive).not.toHaveBeenCalled();
    },
  );
});

describe("Track C Phase C repository persistence through cleaner", () => {
  it("C.3 creates one idempotent hold_resolution_state across repeated detections", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-track-c-phase-c-"));
    const conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
    try {
      const tokenId = createTokenId("phase-c-persist-token");
      const holdRepo = new SqliteHoldResolutionStateRepository(conn.db);
      const floorRepo = new SqliteFloorIntentRepository(conn.db);
      const env = makeCleanerEnv({
        tokenId,
        orderPrice: 0.1,
        bestBid: 0.05,
        bestAsk: 0.2,
        bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
        legState: makeLegState({ tokenId, repriceChainCount24h: 13, sellCount: 0 }),
        position: makePosition({
          tokenId,
          openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
        }),
        holdResolutionRepo: holdRepo,
        floorIntentRepo: floorRepo,
      });

      await env.run();
      await env.bus.drain();
      await env.run();
      await env.bus.drain();

      expect(holdRepo.findActiveByTokenId(tokenId)).toMatchObject({
        tokenId,
        status: "active",
        staleReason: "chain",
        livenessVerdict: "dead",
      });
      expect(floorRepo.findActiveByTokenId(tokenId)).toBeNull();
      expect(readActiveHoldRows(conn, tokenId)).toBe(1);
      expect(holdRepo.transitionActive(tokenId, { status: "cancelled" })).toBe(true);
      expect(holdRepo.findActiveByTokenId(tokenId)).toBeNull();
    } finally {
      conn.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("C.3 treats a SQL-level active hold collision as an idempotent cleaner write", async () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-track-c-phase-c-race-"));
    const conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
    try {
      const tokenId = createTokenId("phase-c-race-token");
      const holdRepo = new SqliteHoldResolutionStateRepository(conn.db);
      const floorRepo = new SqliteFloorIntentRepository(conn.db);
      insertActiveHoldResolutionDirect(conn, tokenId, "race_seed");
      expectDuplicateActiveHoldInsertBlocked(conn, tokenId);

      const env = makeCleanerEnv({
        tokenId,
        orderPrice: 0.1,
        bestBid: 0.05,
        bestAsk: 0.2,
        bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
        legState: makeLegState({ tokenId, repriceChainCount24h: 13, sellCount: 0 }),
        position: makePosition({
          tokenId,
          openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
        }),
        holdResolutionRepo: holdRepo,
        floorIntentRepo: floorRepo,
      });

      await expect(env.run()).resolves.toMatchObject({ downpriceRepriceCancelled: 0 });
      await env.bus.drain();

      expect(readActiveHoldRows(conn, tokenId)).toBe(1);
      expect(holdRepo.findActiveByTokenId(tokenId)).toMatchObject({
        tokenId,
        status: "active",
        staleReason: "race_seed",
        livenessVerdict: "dead",
      });
      expect(floorRepo.findActiveByTokenId(tokenId)).toBeNull();
    } finally {
      conn.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Track C Phase C Phase 2 scaffolding", () => {
  it.skip("C.4 Track G: replace mocked book signals with production getBookSignals provider", async () => {
    // GATED ON: Track G production getBookSignals provider. Today this body uses the runtime
    // builder with mocked populated signals; unskip once those signals are available from runtime.
    const tokenId = createTokenId("phase-c-track-g-token");
    const bookContext = buildBookContext({
      tokenId,
      market: makePricing({ tokenId, bestBid: 0.04, bestAsk: 0.05, snapshotTs: NOW - 1_000 }),
      bidPersistenceS: 10,
      bidMovement30m: 0.002,
      ts: NOW,
    });

    const verdict = isLiveBook(bookContext);
    expect(verdict.verdict).toBe("live");

    const env = makeCleanerEnv({
      tokenId,
      orderPrice: 0.1,
      bestBid: 0.096,
      bestAsk: 0.1,
      tickSize: 0.001,
      bookSignals: { bidPersistenceS: 10, bidMovement30m: 0.002 },
    });
    await expect(env.run()).resolves.toMatchObject({ downpriceRepriceCancelled: 1 });
  });

  it.skip("C.4 Phase 2: floor action re-enable changes hold_resolution to floor_intents", async () => {
    // GATED ON: Phase 2 floor_close re-enable decision. Current Phase 1 code must keep this
    // scenario as hold_resolution; when Phase 2 lands, this body becomes the floor_intents test.
    const tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-track-c-phase-c-floor-"));
    const conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
    try {
      const tokenId = createTokenId("phase-c-floor-token");
      const holdRepo = new SqliteHoldResolutionStateRepository(conn.db);
      const floorRepo = new SqliteFloorIntentRepository(conn.db);
      const env = makeCleanerEnv({
        tokenId,
        floorCloseRatioThreshold: 0.1,
        orderPrice: 0.1,
        bestBid: 0.05,
        bestAsk: 0.2,
        bookSignals: { bidPersistenceS: 10, bidMovement30m: 0 },
        legState: makeLegState({ tokenId, repriceChainCount24h: 13, sellCount: 0 }),
        position: makePosition({
          tokenId,
          currentValueUsdc: 0.01,
          openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
        }),
        holdResolutionRepo: holdRepo,
        floorIntentRepo: floorRepo,
      });

      await env.run();
      await env.bus.drain();

      expect(holdRepo.findActiveByTokenId(tokenId)).toMatchObject({
        tokenId,
        status: "active",
      });
      expect(floorRepo.findActiveByTokenId(tokenId)).toBeNull();
    } finally {
      conn.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function expectDownpriceCancelAfterTrackLGuard(input: {
  readonly expectedRepriceDecision: boolean;
  readonly orderPrice: number;
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly tickSize: number;
}): boolean {
  if (!input.expectedRepriceDecision) return false;
  const predictedPrice = resolveMidpointAnchoredSellPrice(
    input.bestBid,
    input.bestAsk,
    input.tickSize,
    DEFAULT_EXECUTION_POLICY.exitMidpointAnchorTicks,
  );
  if (predictedPrice == null) return true;
  return input.orderPrice - predictedPrice >= input.tickSize - 1e-9;
}

function makeCleanerEnv(input: {
  readonly tokenId?: TokenId;
  readonly slug?: string;
  readonly orderPrice: number;
  readonly bestBid: number | null;
  readonly bestAsk?: number | null;
  readonly tickSize?: number;
  readonly omitTrackC?: boolean;
  readonly floorCloseRatioThreshold?: number | null;
  readonly bookSignals?: {
    readonly bidPersistenceS?: number | null;
    readonly bidMovement30m?: number | null;
  } | null;
  readonly legState?: LegState | null;
  readonly position?: Position | null;
  readonly holdResolutionRepo?: {
    insertActive: SqliteHoldResolutionStateRepository["insertActive"];
    findActiveByTokenId: SqliteHoldResolutionStateRepository["findActiveByTokenId"];
  };
  readonly floorIntentRepo?: {
    insertActive: SqliteFloorIntentRepository["insertActive"];
    findActiveByTokenId: SqliteFloorIntentRepository["findActiveByTokenId"];
  };
}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  const tokenId = input.tokenId ?? createTokenId("phase-c-token");
  const bus = new InProcessEventBus();
  const cancelled: RuntimeEventMap["CancelOrderRequested"][] = [];
  bus.subscribe("CancelOrderRequested", async (event) => {
    cancelled.push(event);
  });
  const holdResolutionRepo = input.holdResolutionRepo ?? {
    insertActive: vi.fn(),
    findActiveByTokenId: vi.fn().mockReturnValue(null),
  };
  const floorIntentRepo = input.floorIntentRepo ?? {
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
          orderRepo: makeOrderRepo([makeSellOrder({ tokenId, price: input.orderPrice })]),
          marketRepo: makeMarketRepo(
            makeMarket({ tokenId, slug: input.slug ?? "weather-threshold-strike" }),
          ),
          bus: bus as EventBus,
          log: silentLog,
          exitRepriceOnDownprice: {
            snapshot: () => ({
              policy: {
                ...DEFAULT_EXECUTION_POLICY.exitRepriceOnDownprice,
                enabled: true,
                thresholdTicks: 5,
                maxRepricesPerOrder: 3,
              },
              anchorTicks: DEFAULT_EXECUTION_POLICY.exitMidpointAnchorTicks,
            }),
            getMarket: () =>
              makePricing({
                tokenId,
                bestBid: input.bestBid,
                bestAsk: input.bestAsk ?? 0.06,
                tickSize: input.tickSize ?? 0.001,
              }),
          },
          repriceChainGate: {
            policy: () => DEFAULT_REPRICE_CHAIN_POLICY,
            legStateRepo: { get: () => input.legState ?? makeLegState({ tokenId }) },
          },
          ...(input.omitTrackC
            ? {}
            : {
                trackCExit: {
                  positionRepo: {
                    findByTokenId: () => input.position ?? makePosition({ tokenId }),
                  },
                  legStateRepo: { get: () => input.legState ?? makeLegState({ tokenId }) },
                  holdResolutionRepo,
                  floorIntentRepo,
                  ...(input.bookSignals !== undefined
                    ? { getBookSignals: () => input.bookSignals ?? null }
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

function makeSellOrder(overrides: Partial<Order> = {}): Order {
  const tokenId = overrides.tokenId ?? createTokenId("phase-c-token");
  return {
    orderId: createOrderId(`ord-${String(tokenId).slice(-16)}`),
    clientOrderId: "client-track-c-phase-c" as ClientOrderId,
    tokenId,
    conditionId: DEFAULT_CONDITION,
    side: "sell",
    orderType: "GTC",
    price: 0.1,
    size: 10,
    sizeUsdc: 1,
    status: "open",
    exchangeOrderId: "ex-track-c-phase-c",
    signalId: "sig-track-c-phase-c",
    signalReason: "repricing-exit",
    botRunId: createBotRunId("run-track-c-phase-c"),
    createdAt: new Date(NOW - 2 * 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides: Partial<Market> = {}): Market {
  const tokenId = overrides.tokenId ?? createTokenId("phase-c-token");
  return {
    tokenId,
    conditionId: String(DEFAULT_CONDITION),
    slug: "weather-threshold-strike",
    eventSlug: "track-c-phase-c",
    question: "Will this Track C test pass?",
    outcome: "Yes",
    regime: null,
    horizon: "daily",
    endDate: new Date(NOW + 2 * 24 * 60 * 60_000).toISOString(),
    active: true,
    tradable: true,
    tickSize: 0.001,
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
      | "tokenId"
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
  const bestBid = overrides.bestBid ?? 0.05;
  const bestAsk = overrides.bestAsk ?? 0.06;
  return {
    tokenId: overrides.tokenId ?? createTokenId("phase-c-token"),
    bestBid,
    bestAsk,
    bestAskSize: 100,
    askDepthExcludingOurs: 100,
    midPrice: bestBid == null || bestAsk == null ? null : (bestBid + bestAsk) / 2,
    spread: bestBid == null || bestAsk == null ? null : bestAsk - bestBid,
    tickSize: 0.001,
    publicTradeCount24h: 1,
    snapshotTs: NOW - 60_000,
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  const tokenId = overrides.tokenId ?? createTokenId("phase-c-token");
  return {
    positionId: createPositionId(`pos-${String(tokenId).slice(-16)}`),
    tokenId,
    conditionId: DEFAULT_CONDITION,
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
  const tokenId = overrides.tokenId ?? createTokenId("phase-c-token");
  return {
    tokenId,
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

function readActiveHoldRows(conn: DbConnection, tokenId: TokenId): number {
  const row = conn.db
    .prepare(
      "SELECT COUNT(*) AS count FROM hold_resolution_states WHERE token_id = ? AND status = 'active'",
    )
    .get(String(tokenId)) as { count: number };
  return row.count;
}

function insertActiveHoldResolutionDirect(
  conn: DbConnection,
  tokenId: TokenId,
  staleReason: string,
): void {
  conn.db
    .prepare(
      `INSERT INTO hold_resolution_states
         (id, token_id, status, marker_created_at, stale_reason, liveness_verdict)
       VALUES (?, ?, 'active', ?, ?, 'dead')`,
    )
    .run(
      `direct-${String(tokenId)}`,
      String(tokenId),
      new Date(NOW - 1_000).toISOString(),
      staleReason,
    );
}

function expectDuplicateActiveHoldInsertBlocked(conn: DbConnection, tokenId: TokenId): void {
  expect(() =>
    conn.db
      .prepare(
        `INSERT INTO hold_resolution_states
           (id, token_id, status, marker_created_at, stale_reason, liveness_verdict)
         VALUES (?, ?, 'active', ?, 'duplicate', 'dead')`,
      )
      .run(`duplicate-${String(tokenId)}`, String(tokenId), new Date(NOW).toISOString()),
  ).toThrow();
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;
