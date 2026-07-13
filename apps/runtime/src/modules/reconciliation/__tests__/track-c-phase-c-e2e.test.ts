import { readFileSync } from "node:fs";
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
  decideExitAction,
  isLiveBook,
  isStaleSell,
  type BookContext,
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
  type StaleVerdict,
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
import {
  buildBookContext,
  buildExitDecisionContext,
  buildStaleSellContext,
} from "../context-builders/track-c-context-builders.js";
import { resolveMidpointAnchoredSellPrice } from "../../strategy/signal-to-order.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../../..");
const NOW = Date.parse("2026-06-02T12:00:00.000Z");
const DEFAULT_CONDITION = createConditionId("cond-track-c-phase-c");

interface Point1Results {
  readonly fixtures: {
    readonly alive_anchors: readonly Point1Fixture[];
    readonly dead_anchors: readonly Point1Fixture[];
    readonly stuck_positions: readonly Point1Fixture[];
  };
}

interface Point1Fixture {
  readonly anchor_ts: number | string;
  readonly asset_id: string;
  readonly slug: string;
  readonly expected_verdict: "LIVE" | "DEAD";
  readonly signals: {
    readonly bid_movement_30m: number | null;
    readonly bid_persistence_s: number | null;
    readonly spread_ratio: number | null;
    readonly public_trade_count_1h: number | null;
  };
  readonly best_bid: number | null;
  readonly best_ask: number | null;
}

interface Point2Results {
  readonly fixtures: {
    readonly alive_reprice_expected_true: readonly Point2Fixture[];
    readonly alive_reprice_expected_false: readonly Point2Fixture[];
  };
}

interface Point2Fixture {
  readonly anchor_ts: number | string;
  readonly asset_id: string;
  readonly expected_reprice_decision: boolean;
  readonly metrics: {
    readonly ask_movement_ticks_30m: number;
  };
}

interface Point3Results {
  readonly fixtures: {
    readonly plankton_stale_positive_proxy: readonly Point3Fixture[];
    readonly plankton_stale_negative_proxy: readonly Point3Fixture[];
    readonly known_stuck_positions: readonly Point3Fixture[];
  };
}

interface Point3Fixture {
  readonly anchor_ts?: number | string;
  readonly asset_id?: string;
  readonly slug: string;
  readonly expected_stale: boolean;
  readonly metrics: {
    readonly sell_price?: number | null;
    readonly current_sell_price?: number | null;
    readonly best_ask?: number | null;
    readonly current_ask?: number | null;
    readonly lifecycle_s?: number | null;
    readonly age_days?: number | null;
    readonly reprice_chain_count_24h?: number | null;
    readonly sell_fills?: number | null;
  };
}

const point1 = loadJson<Point1Results>("research_plankton/track_c/point_1_islivebook_results.json");
const point2 = loadJson<Point2Results>(
  "research_plankton/track_c/point_2_reprice_threshold_results.json",
);
const point3 = loadJson<Point3Results>(
  "research_plankton/track_c/point_3_stale_sell_detection_results.json",
);

const point1Fixtures = [
  ...point1.fixtures.alive_anchors.map((fixture) => ({ cohort: "alive", fixture })),
  ...point1.fixtures.dead_anchors.map((fixture) => ({ cohort: "dead", fixture })),
  ...point1.fixtures.stuck_positions.map((fixture) => ({ cohort: "stuck", fixture })),
] as const;
const point2Fixtures = [
  ...point2.fixtures.alive_reprice_expected_true,
  ...point2.fixtures.alive_reprice_expected_false,
] as const;
const point3Fixtures = [
  ...point3.fixtures.plankton_stale_positive_proxy,
  ...point3.fixtures.plankton_stale_negative_proxy,
  ...point3.fixtures.known_stuck_positions,
] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Track C Phase C counter-factual E2E fixtures", () => {
  it("loads the expected Pt 1-3 fixture counts", () => {
    expect(point1.fixtures.alive_anchors).toHaveLength(20);
    expect(point1.fixtures.dead_anchors).toHaveLength(20);
    expect(point1.fixtures.stuck_positions).toHaveLength(5);
    expect(point2.fixtures.alive_reprice_expected_true).toHaveLength(30);
    expect(point2.fixtures.alive_reprice_expected_false).toHaveLength(30);
    expect(point3.fixtures.plankton_stale_positive_proxy).toHaveLength(20);
    expect(point3.fixtures.plankton_stale_negative_proxy).toHaveLength(20);
    expect(point3.fixtures.known_stuck_positions).toHaveLength(5);
  });

  it.each(point1Fixtures)(
    "C.1.1 Pt1+Pt4 fixture $cohort/$fixture.slug -> $fixture.expected_verdict",
    ({ cohort, fixture }) => {
      const ctx = bookContextFromPoint1(fixture);
      const liveness = isLiveBook(ctx);
      const staleVerdict = stale(cohort === "stuck" ? "chain" : "none");
      const action = decideExitAction(
        buildExitDecisionContext({
          order: makeSellOrder({
            tokenId: createTokenId(fixture.asset_id),
            price: fixture.best_ask ?? 0.05,
          }),
          market: makeMarket({
            tokenId: createTokenId(fixture.asset_id),
            slug: fixture.slug,
          }),
          position: makePosition({
            tokenId: createTokenId(fixture.asset_id),
            openedAt: new Date(anchorMs(fixture.anchor_ts) - 13 * 60 * 60_000).toISOString(),
          }),
          livenessVerdict: liveness.verdict,
          staleVerdict,
          subtype: "strike",
          ts: anchorMs(fixture.anchor_ts),
        }),
      );

      expect(liveness.verdict).toBe(fixture.expected_verdict.toLowerCase());
      if (fixture.expected_verdict === "LIVE") {
        expect(action.action).toBe("continue_normal");
      } else if (cohort === "stuck") {
        expect(action.action).toBe("hold_resolution");
      } else {
        expect(action.action).toBe("continue_passive_sit");
      }
    },
  );

  it.each(point2Fixtures)(
    "C.1.2 Pt2 runtime fixed_3 fixture $asset_id expects reprice=$expected_reprice_decision",
    async (fixture) => {
      const gapTicks = fixture.metrics.ask_movement_ticks_30m;
      const orderPrice = 0.05 + gapTicks * 0.001;
      const expectedCancel = expectDownpriceCancelAfterTrackLGuard({
        expectedRepriceDecision: fixture.expected_reprice_decision,
        orderPrice,
        bestBid: 0.05,
        bestAsk: 0.06,
        tickSize: 0.001,
      });
      const env = makeCleanerEnv({
        tokenId: createTokenId(fixture.asset_id),
        orderPrice,
        bestBid: 0.05,
        tickSize: 0.001,
        bookSignals: { bidPersistenceS: 10, bidMovement30m: 0.002 },
        legState: makeLegState({
          tokenId: createTokenId(fixture.asset_id),
          repriceChainCount24h: 0,
        }),
      });

      const result = await env.run();
      await env.bus.drain();

      expect(result.downpriceRepriceCancelled > 0).toBe(expectedCancel);
      expect(env.holdResolutionRepo.insertActive).not.toHaveBeenCalled();
    },
  );

  it.each(point3Fixtures)("C.1.3 Pt3 fixture $slug stale=$expected_stale", (fixture) => {
    const tokenId = createTokenId(fixture.asset_id ?? `phase-c-${fixture.slug}`);
    const ts = anchorMs(fixture.anchor_ts ?? NOW);
    const staleVerdict = staleVerdictFromPoint3(fixture, tokenId, ts);
    const expectedReason = expectedPoint3Reason(fixture);
    const action = decideExitAction(
      buildExitDecisionContext({
        order: makeSellOrder({ tokenId, price: sellPrice(fixture) ?? 0.05 }),
        market: makeMarket({ tokenId, slug: fixture.slug }),
        position: makePosition({
          tokenId,
          openedAt: new Date(ts - positionAgeMs(fixture)).toISOString(),
        }),
        livenessVerdict: "dead",
        staleVerdict,
        subtype: "strike",
        floorCloseRatioThreshold: 1,
        ts,
      }),
    );

    expect(staleVerdict.stale).toBe(fixture.expected_stale);
    expect(staleVerdict.reason).toBe(expectedReason);
    if (staleVerdict.reason === "price_only") {
      expect(action.action).toBe("continue_passive_sit");
    }
    expect(action.action).not.toBe("floor_close");
  });

  it.each(point3.fixtures.known_stuck_positions)(
    "C.1.4 five-stuck baseline writes hold_resolution for $slug",
    async (fixture) => {
      const p1 = findPoint1Stuck(fixture.slug);
      const tokenId = createTokenId(p1.asset_id);
      const env = makeCleanerEnv({
        tokenId,
        slug: fixture.slug,
        orderPrice: sellPrice(fixture) ?? 0.05,
        bestBid: p1.best_bid,
        bestAsk: p1.best_ask ?? currentAsk(fixture) ?? 0.05,
        bookSignals: {
          bidPersistenceS: p1.signals.bid_persistence_s,
          bidMovement30m: p1.signals.bid_movement_30m,
        },
        legState: makeLegState({
          tokenId,
          repriceChainCount24h: fixture.metrics.reprice_chain_count_24h ?? 13,
          sellCount: fixture.metrics.sell_fills ?? 0,
        }),
        position: makePosition({
          tokenId,
          openedAt: new Date(NOW - positionAgeMs(fixture)).toISOString(),
        }),
      });

      await env.run();
      await env.bus.drain();

      expect(env.holdResolutionRepo.insertActive).toHaveBeenCalledOnce();
      expect(env.floorIntentRepo.insertActive).not.toHaveBeenCalled();
    },
  );
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

function loadJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf-8")) as T;
}

function bookContextFromPoint1(fixture: Point1Fixture): BookContext {
  const ts = anchorMs(fixture.anchor_ts);
  return {
    assetId: createTokenId(fixture.asset_id),
    bestBid: fixture.best_bid,
    bestAsk: fixture.best_ask,
    spreadRatio: fixture.signals.spread_ratio,
    bidPersistenceS: fixture.signals.bid_persistence_s,
    bidMovement30m: fixture.signals.bid_movement_30m,
    publicTradeCount1h: fixture.signals.public_trade_count_1h,
    capturedAt: ts - 60_000,
    ts,
  };
}

function staleVerdictFromPoint3(
  fixture: Point3Fixture,
  tokenId: TokenId,
  ts: number,
): StaleVerdict {
  return isStaleSell(
    buildStaleSellContext({
      order: makeSellOrder({
        tokenId,
        price: sellPrice(fixture) ?? 0.05,
        createdAt: new Date(ts - sellAgeMs(fixture)).toISOString(),
      }),
      market: {
        bestBid: null,
        bestAsk: currentAsk(fixture),
      },
      legState: makeLegState({
        tokenId,
        repriceChainCount24h: fixture.metrics.reprice_chain_count_24h ?? 0,
        sellCount: fixture.metrics.sell_fills ?? 0,
      }),
      position: makePosition({
        tokenId,
        openedAt: new Date(ts - positionAgeMs(fixture)).toISOString(),
      }),
      livenessVerdict: "dead",
      ts,
    }),
  );
}

function expectedPoint3Reason(fixture: Point3Fixture): StaleVerdict["reason"] {
  const price = hasPriceBranch(fixture);
  const chain = hasChainBranch(fixture);
  if (price && chain) return "chain+price";
  if (chain) return "chain";
  if (price) return "price_only";
  return "none";
}

function hasPriceBranch(fixture: Point3Fixture): boolean {
  const sell = sellPrice(fixture);
  const ask = currentAsk(fixture);
  return sell != null && ask != null && sell > 0 && ask > 0 && sellAgeMs(fixture) > 30 * 60_000
    ? sell / ask >= 1.01
    : false;
}

function hasChainBranch(fixture: Point3Fixture): boolean {
  return (
    (fixture.metrics.reprice_chain_count_24h ?? 0) >= 13 &&
    (fixture.metrics.sell_fills ?? 0) === 0 &&
    positionAgeMs(fixture) > 12 * 60 * 60_000
  );
}

function findPoint1Stuck(slug: string): Point1Fixture {
  const fixture = point1.fixtures.stuck_positions.find((row) => row.slug === slug);
  if (!fixture) throw new Error(`missing Point 1 stuck fixture for ${slug}`);
  return fixture;
}

function stale(reason: StaleVerdict["reason"]): StaleVerdict {
  return { stale: reason !== "none", reason };
}

function sellPrice(fixture: Point3Fixture): number | null {
  return fixture.metrics.sell_price ?? fixture.metrics.current_sell_price ?? null;
}

function currentAsk(fixture: Point3Fixture): number | null {
  return fixture.metrics.best_ask ?? fixture.metrics.current_ask ?? null;
}

function sellAgeMs(fixture: Point3Fixture): number {
  return (fixture.metrics.lifecycle_s ?? 0) * 1000;
}

function positionAgeMs(fixture: Point3Fixture): number {
  if (fixture.metrics.age_days != null) return fixture.metrics.age_days * 24 * 60 * 60_000;
  return sellAgeMs(fixture);
}

function anchorMs(anchor: number | string): number {
  return typeof anchor === "number" ? anchor * 1000 : Date.parse(anchor);
}

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
            policy: () => ({
              ...DEFAULT_EXECUTION_POLICY.exitRepriceOnDownprice,
              enabled: true,
              thresholdTicks: 5,
              maxRepricesPerOrder: 3,
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
