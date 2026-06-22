import Database from "better-sqlite3";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AlgoDecisionModule,
  conversionSkipReEvalDelayMs,
  isInputsUnchangedConversionSkip,
} from "../algo-decision-module.js";
import { RuntimeMetricWriter } from "../../../runtime-metric-writer.js";
import type { SelectedMarketCache } from "../algo-decision-module.js";
import type {
  DecisionPlanSideEffect,
  QdShadowProjection,
  TrackQShadowProjection,
} from "../decision-planner.js";
import type {
  EventBus,
  LegStateRepository,
  AlgoRulesRepository,
  AlgoDecisionRule,
  AlgoSizeRule,
  NormalizedMarket,
  LegState,
  RuntimeEventMap,
  DecisionSignalLogRepository,
  RiskEventRepository,
  Position,
  Order,
  OrderRepository,
} from "@krabs/domain";
import { createTokenId, createCommandId, createOrderId, createPositionId } from "@krabs/domain";
import type { ConditionId } from "@krabs/domain";
import { DEFAULT_EXECUTION_POLICY, S1_LADDER_RULE_ID } from "@krabs/domain";
import type { Logger } from "../../../logger.js";
import { LiveLiteGuard } from "../../../live-lite-guard.js";

const PHASE_ONE_ACTIVE_MARKET_CAP = 250;

// ─── Seed rules ───────────────────────────────────────────────────────────────

/** Minimal decision rules. REDEEM rows are present to prove runtime ignores algo-REDEEM. */
const SEED_DECISION_RULES: AlgoDecisionRule[] = [
  {
    id: 1,
    priority: 10,
    ruleId: "REDEEM-S1",
    stateCondition: "S1",
    priceOperator: "<",
    priceValue: 0.05,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: "<=",
    holdDurationSeconds: 3600, // 1 hour cap
    action: "REDEEM",
  },
  {
    id: 2,
    priority: 11,
    ruleId: "REDEEM-S2",
    stateCondition: "S2",
    priceOperator: "<",
    priceValue: 0.05,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: "<=",
    holdDurationSeconds: 3600,
    action: "REDEEM",
  },
  {
    id: 99,
    priority: 99,
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
  },
  {
    id: 50,
    priority: 50,
    ruleId: "D7-SELL-S1",
    stateCondition: "S1",
    priceOperator: ">=",
    priceValue: 0.1,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "SELL",
  },
];

/** Size rules: B5 for nth_buy=1 and FALLBACK BUY / SELL. */
const SEED_SIZE_RULES_BUY: AlgoSizeRule[] = [
  {
    id: 1,
    actionType: "BUY",
    priority: 5,
    ruleId: "B5",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: 1,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 0.99,
  },
  {
    id: 99,
    actionType: "BUY",
    priority: 99,
    ruleId: "FALLBACK-BUY",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 2.73,
  },
];

const SEED_SIZE_RULES_SELL: AlgoSizeRule[] = [
  {
    id: 99,
    actionType: "SELL",
    priority: 99,
    ruleId: "FALLBACK-SELL",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 2.63,
  },
];

// ─── Mock helpers ─────────────────────────────────────────────────────────────

type BusHandler<K extends keyof RuntimeEventMap> = (payload: RuntimeEventMap[K]) => Promise<void>;

function createMockBus() {
  const handlers = new Map<string, BusHandler<any>[]>();

  const subscribe = vi.fn((event: string, handler: BusHandler<any>) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event)!.push(handler);
    return () => {
      const list = handlers.get(event) ?? [];
      const idx = list.indexOf(handler);
      if (idx !== -1) list.splice(idx, 1);
    };
  });

  const publish = vi.fn(async (event: string, payload: unknown) => {
    const list = handlers.get(event) ?? [];
    for (const h of list) await h(payload);
  });

  const emit = async <K extends keyof RuntimeEventMap>(event: K, payload: RuntimeEventMap[K]) => {
    await publish(event, payload);
  };

  return { subscribe, publish, emit, handlers } as unknown as EventBus & {
    emit: typeof emit;
    publish: typeof publish;
    handlers: typeof handlers;
  };
}

function createMockLegStateRepo(states: LegState[] = []): LegStateRepository {
  const map = new Map(states.map((s) => [String(s.tokenId), s]));
  return {
    get: vi.fn((tokenId) => map.get(String(tokenId)) ?? null),
    upsert: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(() => [...map.values()]),
    incrementSellResidualReject: vi.fn((tokenId, nowIso, abandon) => {
      const key = String(tokenId);
      const state = map.get(key);
      if (!state) return { count: 0, markedAbandoned: false };
      const count = (state.consecutiveSellResidualRejects ?? 0) + 1;
      const markedAbandoned =
        abandon != null && count >= abandon.threshold && state.abandonedAtTs == null;
      map.set(key, {
        ...state,
        consecutiveSellResidualRejects: count,
        abandonedAtPrice: markedAbandoned ? abandon.price : state.abandonedAtPrice,
        abandonedAtTs: markedAbandoned ? nowIso : state.abandonedAtTs,
        updatedAt: nowIso,
      });
      return { count, markedAbandoned };
    }),
    markAbandoned: vi.fn(),
    resetAbandoned: vi.fn(),
    applyRepriceChainEvent: vi.fn(),
  };
}

function createMockAlgoRulesRepo(): AlgoRulesRepository {
  return {
    getDecisionRules: vi.fn(() => SEED_DECISION_RULES),
    getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
      actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
    ),
  };
}

function createMockSelectedMarketCache(eligible: string[] = []): SelectedMarketCache {
  const set = new Set(eligible);
  return {
    isEligible: vi.fn((tokenId) => set.has(String(tokenId))),
    getEligibleTokenIds: vi.fn(() => eligible.map((id) => createTokenId(id))),
  };
}

function createMockLogger(): Logger {
  const child = vi.fn(() => createMockLogger());
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child,
  } as unknown as Logger;
}

/**
 * ADR-016 — richer control-db mock that pattern-matches on the SQL string so
 * a single instance answers continuation-mode and continuation-mode-version
 * queries from `readContinuationMode` and `readContinuationModeVersion`.
 *
 * Mutate via `setMode` to simulate an operator flip; the helper bumps the
 * version automatically so the runtime's hot-reload poller observes a change.
 */
function createContinuationControlDb(opts: {
  continuationMode?: "leg_local" | "market_wide";
  continuationModeVersion?: number;
}) {
  const state = {
    continuationMode: opts.continuationMode ?? "leg_local",
    continuationModeVersion: opts.continuationModeVersion ?? 0,
  };
  const db = {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes("continuation_mode_version")) {
          return { v: state.continuationModeVersion };
        }
        if (sql.includes("continuation_mode AS m")) {
          return { m: state.continuationMode };
        }
        return undefined;
      }),
    })),
  };
  return {
    db,
    setMode(next: "leg_local" | "market_wide") {
      if (state.continuationMode === next) return;
      state.continuationMode = next;
      state.continuationModeVersion += 1;
    },
    state,
  };
}

function createMockTradeCountProvider(returnValue: number | null = null) {
  const countCalls: Array<{ conditionId: string; cap: number }> = [];
  const prefetchCalls: Array<{ conditionIds: readonly string[]; cap: number }> = [];
  let nextValue: number | null = returnValue;
  return {
    countTrades: vi.fn(async (conditionId: string, cap: number) => {
      countCalls.push({ conditionId, cap });
      return nextValue;
    }),
    prefetch: vi.fn(async (conditionIds: readonly string[], cap: number) => {
      prefetchCalls.push({ conditionIds: [...conditionIds], cap });
    }),
    countCalls,
    prefetchCalls,
    setReturnValue(value: number | null) {
      nextValue = value;
    },
  };
}

function makeMarket(
  tokenId: string,
  _familyId: string | null,
  midPrice: number | null,
  conditionId: string = "cond-1",
): NormalizedMarket {
  return {
    tokenId: createTokenId(tokenId),
    conditionId: conditionId as ConditionId,
    slug: "test-market",
    eventSlug: null,
    question: "Test?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    // Tests use the small B5 probe-entry budget ($0.99) at midPrice ≈ 0.45,
    // which yields ~2 shares — below the production fallback of 5. The
    // algo-decision pre-filter (order-size-below-minimum) would suppress
    // these signals. Set a permissive floor so emission tests remain
    // focused on decision logic, not exchange size policy.
    minOrderSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: midPrice !== null ? midPrice - 0.01 : null,
    bestAsk: midPrice !== null ? midPrice + 0.01 : null,
    midPrice,
    spread: 0.02,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
  };
}

function makeSellReadyLegState(tokenId: string, overrides: Partial<LegState> = {}): LegState {
  const nowIso = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  return {
    tokenId: createTokenId(tokenId),
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.1,
    firstTradeAt: nowIso,
    lastTradeAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

function makeOpenPosition(tokenId: string, overrides: Partial<Position> = {}): Position {
  const nowIso = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  return {
    positionId: createPositionId(`pos-${tokenId}`),
    tokenId: createTokenId(tokenId),
    conditionId: "cond-1" as ConditionId,
    side: "buy",
    size: 10,
    avgEntryPrice: 0.1,
    costBasisUsdc: 1,
    currentValueUsdc: 1,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: nowIso,
    closedAt: null,
    updatedAt: nowIso,
    ...overrides,
  };
}

function createPositionRepoForOpenPositions(positions: Position[]) {
  const map = new Map(positions.map((position) => [String(position.tokenId), position]));
  return {
    findOpen: vi.fn(() => [...map.values()].filter((position) => position.status === "open")),
    findByTokenId: vi.fn((tokenId) => map.get(String(tokenId)) ?? null),
    remove(tokenId: string) {
      map.delete(tokenId);
    },
  };
}

function makeOpenPositions(count: number, prefix = "token-open"): Position[] {
  return Array.from({ length: count }, (_, index) => makeOpenPosition(`${prefix}-${index}`));
}

function makeBuyFill(
  tokenId: string,
  timestamp: number,
  overrides: Partial<RuntimeEventMap["FillReceived"]> = {},
): RuntimeEventMap["FillReceived"] {
  return {
    fillId: `fill-${tokenId}-${timestamp}` as RuntimeEventMap["FillReceived"]["fillId"],
    orderId: createOrderId(`order-${tokenId}-${timestamp}`),
    clientOrderId:
      `client-${tokenId}-${timestamp}` as RuntimeEventMap["FillReceived"]["clientOrderId"],
    tokenId: createTokenId(tokenId),
    conditionId: "cond-1" as ConditionId,
    side: "buy",
    price: 0.1,
    size: 10,
    sizeUsdc: 1,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    signalReason: "scale-in",
    timestamp,
    ...overrides,
  };
}

function makeOrderPlaced(
  tokenId: string,
  side: "buy" | "sell",
  timestamp = Date.now(),
): RuntimeEventMap["OrderPlaced"] {
  return {
    commandId: createCommandId(`cmd-${side}-${tokenId}-${timestamp}`),
    clientOrderId:
      `client-${side}-${tokenId}-${timestamp}` as RuntimeEventMap["OrderPlaced"]["clientOrderId"],
    orderId: createOrderId(`order-${side}-${tokenId}-${timestamp}`),
    tokenId: createTokenId(tokenId),
    conditionId: "cond-1" as ConditionId,
    side,
    price: 0.1,
    size: 10,
    orderType: "GTC",
    signalReason: "test",
    timestamp,
  };
}

function makeSuppressionFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tokenId = String(overrides.tokenId ?? "token-rollup");
  return {
    tokenId: createTokenId(tokenId),
    conditionId: "cond-1",
    reasonCode: "sell-spread-too-wide-below-avg-entry",
    reasons: ["sell-spread-too-wide-below-avg-entry"],
    side: "SELL",
    decisionRuleId: "D8_PROFIT_RATIO",
    state: "S1",
    price: 0.04,
    buyCount: 1,
    timeSinceLastSeconds: 300,
    emissionFacts: {
      firstTradePrice: 0.02,
      firstTradeAt: "2026-06-14T00:00:00.000Z",
      legTradeCount: 1,
    },
    timestamp: "2026-06-14T00:00:00.000Z",
    extra: { spreadTicks: 40 },
    ...overrides,
  };
}

function makeOrder(tokenId: string, overrides: Partial<Order> = {}): Order {
  const nowIso = new Date(Date.now()).toISOString();
  const status = overrides.status ?? "open";
  const side = overrides.side ?? "sell";
  const idSuffix = `${status}-${side}-${overrides.createdAt ?? nowIso}`;
  return {
    orderId: createOrderId(`order-${tokenId}-${idSuffix}`),
    clientOrderId: `client-${tokenId}-${idSuffix}` as Order["clientOrderId"],
    tokenId: createTokenId(tokenId),
    conditionId: "cond-1" as ConditionId,
    side,
    orderType: "GTC",
    postOnly: true,
    price: 0.03,
    size: 10,
    sizeUsdc: 0.3,
    status,
    cancelReason: null,
    cancelAgeMs: null,
    cancelAgeBucket: null,
    fillProgressShares: null,
    marketHorizon: null,
    exchangeOrderId: null,
    signalId: null,
    signalReason: null,
    decisionRuleId: null,
    signalTimestamp: null,
    exchangeErrorCode: null,
    exchangeErrorMessage: null,
    exchangeErrorPayload: null,
    exchangeRejectionReason: null,
    botRunId: "bot-test" as Order["botRunId"],
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

function policyWithPostBuyCooldown(cooldownMs = 5_000) {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    postBuyFillSellCooldownMs: cooldownMs,
  } as typeof DEFAULT_EXECUTION_POLICY & { postBuyFillSellCooldownMs: number };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AlgoDecisionModule", () => {
  let bus: ReturnType<typeof createMockBus>;
  let legStateRepo: LegStateRepository;
  let algoRulesRepo: AlgoRulesRepository;
  let selectedMarketCache: SelectedMarketCache;
  let log: Logger;

  function buildModule(
    overrides: Partial<import("../algo-decision-module.js").AlgoDecisionModuleDeps> = {},
  ) {
    return new AlgoDecisionModule({
      bus: bus as unknown as EventBus,
      legStateRepo,
      algoRulesRepo,
      selectedMarketCache,
      log,
      sweepIntervalMs: 60_000,
      // Tests observe per-emission telemetry (dropFromLastSeen, entryPriceBucket,
      // r23DipRatio, …) through the legacy `risk_events.signal_emitted` payload.
      // Production opts out via the v063 dedup; tests opt back in unless the
      // override explicitly turns it off.
      persistSignalEmittedTelemetry: true,
      ...overrides,
    });
  }

  beforeEach(() => {
    bus = createMockBus();
    legStateRepo = createMockLegStateRepo();
    algoRulesRepo = createMockAlgoRulesRepo();
    selectedMarketCache = createMockSelectedMarketCache();
    log = createMockLogger();
  });

  it("hydrates open DB positions into the evaluation working set on startup", async () => {
    const tokenId = "token-open-working-set";
    const position = makeOpenPosition(tokenId);
    const positionRepo = {
      findOpen: vi.fn().mockReturnValue([position]),
      findByTokenId: vi.fn().mockReturnValue(position),
    };

    const mod = buildModule({
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
    });
    await mod.start();

    expect((mod as any).dirtyTokenIds.has(tokenId)).toBe(true);
    expect((mod as any).positionCache.get(tokenId)).toEqual(position);

    await mod.stop();
  });

  it("logs stale open positions that are not evaluated within the guard window", async () => {
    const tokenId = "token-stale-open";
    const position = makeOpenPosition(tokenId, {
      openedAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    });
    const positionRepo = {
      findOpen: vi.fn().mockReturnValue([position]),
      findByTokenId: vi.fn().mockReturnValue(position),
    };

    const mod = buildModule({
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
    });
    await mod.start();
    (mod as any).openPositionLastEvaluatedAt.delete(tokenId);
    (mod as any).refreshOpenPositionWorkingSet(Date.parse("2026-05-24T12:00:00.000Z"), true);

    expect((mod as any).log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId, positionId: String(position.positionId) }),
      "open position has not been evaluated recently",
    );

    await mod.stop();
  });

  it("rolls up sell-spread suppression rows at the recordDecisionSuppressed chokepoint", () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const runtimeMetrics = {
      writeCounter: vi.fn(),
      writeLatest: vi.fn(),
    } as unknown as RuntimeMetricWriter;
    const mod = buildModule({
      riskEventRepo,
      runtimeMetrics,
      plannerSuppressionRollupWindowMs: 300_000,
    });

    (mod as any).recordDecisionSuppressed(makeSuppressionFacts({ price: 0.04 }));
    (mod as any).recordDecisionSuppressed(
      makeSuppressionFacts({
        price: 0.05,
        timestamp: "2026-06-14T00:01:00.000Z",
        extra: { spreadTicks: 35 },
      }),
    );

    expect(riskEventRepo.insert).not.toHaveBeenCalled();
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "track_planner_suppressed_total",
      1,
      JSON.stringify({ reason: "sell-spread-too-wide-below-avg-entry" }),
    );

    expect((mod as any).plannerRollup.flushAll("periodic")).toBe(1);

    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "planner_suppressed_rollup",
        payload: expect.objectContaining({
          tokenId: "token-rollup",
          reasonCode: "sell-spread-too-wide-below-avg-entry",
          decisionRuleId: "D8_PROFIT_RATIO",
          side: "SELL",
          count: 2,
          windowMs: 300_000,
          firstPayloadSample: expect.objectContaining({ price: 0.04, spreadTicks: 40 }),
          lastPayloadSample: expect.objectContaining({ price: 0.05, spreadTicks: 35 }),
          flushReason: "periodic",
          schemaVersion: 1,
        }),
      }),
    );
  });

  it("keeps legacy suppression writes when rollup is disabled", () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const runtimeMetrics = {
      writeCounter: vi.fn(),
      writeLatest: vi.fn(),
    } as unknown as RuntimeMetricWriter;
    const mod = buildModule({
      riskEventRepo,
      runtimeMetrics,
      plannerSuppressionRollupWindowMs: 0,
    });

    (mod as any).recordDecisionSuppressed(makeSuppressionFacts());

    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          tokenId: "token-rollup",
          reasonCode: "sell-spread-too-wide-below-avg-entry",
        }),
      }),
    );
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "track_planner_suppressed_total",
      1,
      JSON.stringify({ reason: "sell-spread-too-wide-below-avg-entry" }),
    );
  });

  it("bounds R23 no-dip raw suppression rows while preserving per-occurrence counters", () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const runtimeMetrics = {
      writeCounter: vi.fn(),
      writeLatest: vi.fn(),
    } as unknown as RuntimeMetricWriter;
    const mod = buildModule({
      riskEventRepo,
      runtimeMetrics,
      plannerSuppressionRollupWindowMs: 0,
    });

    for (const tokenId of ["token-r23-a", "token-r23-b", "token-r23-c"]) {
      (mod as any).recordDecisionSuppressed(
        makeSuppressionFacts({
          tokenId,
          reasonCode: "r23-no-dip",
          reasons: ["r23-no-dip"],
          side: "BUY",
          decisionRuleId: "R23_DIP_TRIGGER",
          state: "S0",
          buyCount: 0,
          emissionFacts: {
            firstTradePrice: null,
            legTradeCount: 0,
            r23DipRatio: 0.97,
            r23MaxMidpoint: 0.45,
            r23WindowMs: 86_400_000,
          },
          timestamp: "2026-06-14T00:00:00.000Z",
        }),
      );
    }

    const r23NoDipEvents = (riskEventRepo.insert as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) =>
        event.eventType === "signal_suppressed" &&
        event.payload?.reasonCode === "r23-no-dip" &&
        event.payload?.decisionRuleId === "R23_DIP_TRIGGER",
    );
    const r23CounterCalls = (
      runtimeMetrics.writeCounter as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([name, , labels]) =>
        name === "track_planner_suppressed_total" &&
        labels === JSON.stringify({ reason: "r23-no-dip" }),
    );

    expect(r23NoDipEvents).toHaveLength(1);
    expect(r23CounterCalls).toHaveLength(3);
  });

  it("bounds static below-floor raw suppression rows while preserving per-occurrence counters", () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const runtimeMetrics = {
      writeCounter: vi.fn(),
      writeLatest: vi.fn(),
    } as unknown as RuntimeMetricWriter;
    const mod = buildModule({
      riskEventRepo,
      runtimeMetrics,
      plannerSuppressionRollupWindowMs: 0,
    });

    for (const timestamp of [
      "2026-06-14T00:00:00.000Z",
      "2026-06-14T00:00:30.000Z",
      "2026-06-14T00:01:00.000Z",
    ]) {
      (mod as any).recordDecisionSuppressed(
        makeSuppressionFacts({
          tokenId: "token-static-floor",
          reasonCode: "static_rule_sell_below_avg_entry_guard",
          reasons: ["static_rule_sell_below_avg_entry_guard"],
          side: "SELL",
          decisionRuleId: "D7",
          state: "S3",
          price: 0.19,
          timestamp,
          extra: {
            proposedExitPrice: 0.19,
            entryFloorPrice: 0.2,
            positiveFloorPrice: 0.21,
            floor: 0.21,
          },
        }),
      );
    }

    const rawEvents = (riskEventRepo.insert as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) =>
        event.eventType === "signal_suppressed" &&
        event.payload?.reasonCode === "static_rule_sell_below_avg_entry_guard",
    );
    const counterCalls = (
      runtimeMetrics.writeCounter as ReturnType<typeof vi.fn>
    ).mock.calls.filter(
      ([name, , labels]) =>
        name === "track_planner_suppressed_total" &&
        labels === JSON.stringify({ reason: "static_rule_sell_below_avg_entry_guard" }),
    );

    expect(rawEvents).toHaveLength(1);
    expect(counterCalls).toHaveLength(3);
  });

  it("keeps static below-floor dedupe keyed by token, rule, state, proposed price, and floor", () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      riskEventRepo,
      plannerSuppressionRollupWindowMs: 0,
    });

    for (const overrides of [
      { tokenId: "token-static-floor-a" },
      { tokenId: "token-static-floor-b" },
      { decisionRuleId: "D4" },
      { state: "S2" },
      { price: 0.18, extra: { proposedExitPrice: 0.18, positiveFloorPrice: 0.21 } },
      { price: 0.19, extra: { proposedExitPrice: 0.19, positiveFloorPrice: 0.22 } },
    ]) {
      (mod as any).recordDecisionSuppressed(
        makeSuppressionFacts({
          tokenId: "token-static-floor-a",
          reasonCode: "static_rule_sell_below_avg_entry_guard",
          reasons: ["static_rule_sell_below_avg_entry_guard"],
          side: "SELL",
          decisionRuleId: "D7",
          state: "S3",
          price: 0.19,
          timestamp: "2026-06-14T00:00:00.000Z",
          extra: {
            proposedExitPrice: 0.19,
            entryFloorPrice: 0.2,
            positiveFloorPrice: 0.21,
            floor: 0.21,
          },
          ...overrides,
        }),
      );
    }

    const rawEvents = (riskEventRepo.insert as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) =>
        event.eventType === "signal_suppressed" &&
        event.payload?.reasonCode === "static_rule_sell_below_avg_entry_guard",
    );

    expect(rawEvents).toHaveLength(6);
  });

  it("allows another static below-floor raw suppression row after the bounded window expires", () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      riskEventRepo,
      plannerSuppressionRollupWindowMs: 0,
    });

    for (const timestamp of [
      "2026-06-14T00:00:00.000Z",
      "2026-06-14T00:09:59.000Z",
      "2026-06-14T00:10:01.000Z",
    ]) {
      (mod as any).recordDecisionSuppressed(
        makeSuppressionFacts({
          tokenId: "token-static-floor",
          reasonCode: "static_rule_sell_below_avg_entry_guard",
          reasons: ["static_rule_sell_below_avg_entry_guard"],
          side: "SELL",
          decisionRuleId: "D7",
          state: "S3",
          price: 0.19,
          timestamp,
          extra: {
            proposedExitPrice: 0.19,
            entryFloorPrice: 0.2,
            positiveFloorPrice: 0.21,
            floor: 0.21,
          },
        }),
      );
    }

    const rawEvents = (riskEventRepo.insert as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) =>
        event.eventType === "signal_suppressed" &&
        event.payload?.reasonCode === "static_rule_sell_below_avg_entry_guard",
    );

    expect(rawEvents).toHaveLength(2);
  });

  it("allows another R23 no-dip raw suppression row after the bounded window expires", () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      riskEventRepo,
      plannerSuppressionRollupWindowMs: 0,
    });

    for (const timestamp of [
      "2026-06-14T00:00:00.000Z",
      "2026-06-14T00:09:59.000Z",
      "2026-06-14T00:10:01.000Z",
    ]) {
      (mod as any).recordDecisionSuppressed(
        makeSuppressionFacts({
          tokenId: `token-${timestamp}`,
          reasonCode: "r23-no-dip",
          reasons: ["r23-no-dip"],
          side: "BUY",
          decisionRuleId: "R23_DIP_TRIGGER",
          state: "S0",
          buyCount: 0,
          emissionFacts: {
            firstTradePrice: null,
            legTradeCount: 0,
            r23DipRatio: 0.97,
            r23MaxMidpoint: 0.45,
            r23WindowMs: 86_400_000,
          },
          timestamp,
        }),
      );
    }

    const r23NoDipEvents = (riskEventRepo.insert as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) =>
        event.eventType === "signal_suppressed" &&
        event.payload?.reasonCode === "r23-no-dip" &&
        event.payload?.decisionRuleId === "R23_DIP_TRIGGER",
    );

    expect(r23NoDipEvents).toHaveLength(2);
  });

  it("keeps non-R23 suppression rows unaffected by the R23 no-dip bound", () => {
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      riskEventRepo,
      plannerSuppressionRollupWindowMs: 0,
    });

    (mod as any).recordDecisionSuppressed(
      makeSuppressionFacts({
        tokenId: "token-custom-a",
        reasonCode: "custom-suppression",
        reasons: ["custom-suppression"],
        decisionRuleId: "CUSTOM_RULE",
        timestamp: "2026-06-14T00:00:00.000Z",
      }),
    );
    (mod as any).recordDecisionSuppressed(
      makeSuppressionFacts({
        tokenId: "token-custom-b",
        reasonCode: "custom-suppression",
        reasons: ["custom-suppression"],
        decisionRuleId: "CUSTOM_RULE",
        timestamp: "2026-06-14T00:00:01.000Z",
      }),
    );

    const customEvents = (riskEventRepo.insert as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) =>
        event.eventType === "signal_suppressed" &&
        event.payload?.reasonCode === "custom-suppression",
    );

    expect(customEvents).toHaveLength(2);
  });

  it("flushes planner suppression rollups on SELL state transitions before early returns", async () => {
    const mod = buildModule({ plannerSuppressionRollupWindowMs: 300_000 });
    const fakeRollup = {
      record: vi.fn(() => false),
      flushToken: vi.fn(() => 0),
      flushAll: vi.fn(() => 0),
      start: vi.fn(),
      stop: vi.fn(),
    };
    (mod as any).plannerRollup = fakeRollup;
    await mod.start();

    await (bus as any).emit("OrderPlaced", makeOrderPlaced("token-transition", "sell"));
    await (bus as any).emit("OrderPlaced", makeOrderPlaced("token-transition", "buy"));
    await (bus as any).emit(
      "FillReceived",
      makeBuyFill("token-transition", Date.now(), { side: "sell" }),
    );
    await (bus as any).emit("LegStateCleared", {
      type: "LegStateCleared",
      tokenId: createTokenId("token-transition"),
      reason: "position-closed",
      timestamp: Date.now(),
    });
    await (bus as any).emit("PositionSettled", {
      positionId: createPositionId("pos-token-transition"),
      tokenId: createTokenId("token-transition"),
      resolution: "YES",
      settlementPrice: 1,
      realizedPnl: 0,
      size: 10,
      avgEntryPrice: 0.1,
      timestamp: Date.now(),
    });

    expect(fakeRollup.flushToken).toHaveBeenCalledTimes(4);
    expect(fakeRollup.flushToken).toHaveBeenNthCalledWith(1, "token-transition", "order_placed");
    expect(fakeRollup.flushToken).toHaveBeenNthCalledWith(2, "token-transition", "fill_received");
    expect(fakeRollup.flushToken).toHaveBeenNthCalledWith(
      3,
      "token-transition",
      "leg_state_cleared",
    );
    expect(fakeRollup.flushToken).toHaveBeenNthCalledWith(
      4,
      "token-transition",
      "position_settled",
    );

    await mod.stop();
  });

  it("emits SignalProduced for an eligible token with no position", async () => {
    const tokenId = "token-abc";
    const familyId = "fam-1";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule();
    await mod.start();

    const market = makeMarket(tokenId, familyId, 0.45);

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    expect(signalCalls.length).toBe(1);
    const signal = signalCalls[0]![1].signal as import("@krabs/domain").Signal;
    expect(signal.side).toBe("buy");
    expect(signal.decisionRuleId).toBe("FALLBACK");
    expect(signal.reason).toBe("probe-entry");
    expect(signal.suggestedSizeUsdc).toBeCloseTo(0.99, 5);
    expect(signal.conditionId).toBe("cond-1");
    // ADR-024 §D-C — sizingRuleId is propagated from evaluateSize onto the
    // emitted Signal. Seed B5 fires here (nthBuy=1, sizeUsdc=0.99).
    expect(signal.sizingRuleId).toBe("B5");

    // Phase 2.A: payload embeds the NormalizedMarket snapshot observed by the
    // pre-entry hard-liveness gate so the bridge downstream can re-use it.
    expect(signalCalls[0]![1].market).toBe(market);

    await mod.stop();
  });

  it("applies stock-close YES-tail damp on the live evaluateTokens worker path", async () => {
    const tokenId = "token-stock-tail";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    const runtimeMetrics = { writeCounter: vi.fn() } as unknown as RuntimeMetricWriter;

    const mod = buildModule({
      runtimeMetrics,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
      }),
    });
    await mod.start();

    const market = {
      ...makeMarket(tokenId, "fam-1", 0.45),
      slug: "will-meta-meta-close-at-560-570-on-june-19",
      question: "Will Meta (META) close at $560-$570 on June 19?",
      outcome: "Yes",
      tags: ["stocks"],
    };

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    const signal = signalCalls[0]![1].signal as import("@krabs/domain").Signal;
    expect(signal.reason).toBe("probe-entry");
    expect(signal.suggestedSizeUsdc).toBeCloseTo(0.495, 6);
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "stock_close_yes_tail_size_damp_applied_total",
      1,
      expect.stringContaining('"action":"apply"'),
    );
    const rawLabels = vi.mocked(runtimeMetrics.writeCounter).mock.calls[0]?.[2];
    expect(typeof rawLabels).toBe("string");
    const metricLabels = JSON.parse(rawLabels as string);
    expect(Object.keys(metricLabels).sort()).toEqual([
      "action",
      "confidence",
      "marketClass",
      "reason",
      "thresholdBucket",
    ]);

    await mod.stop();
  });

  it("records first-entry fresh-edge diagnostics without changing the BUY signal", async () => {
    const tokenId = "token-entry-fresh-edge";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const now = Date.now();
    const priceHistoryProvider = {
      findReferencePrice: vi.fn(() => null),
      midpointStatsInWindow: vi.fn(() => ({
        minMidpoint: 0.2,
        maxMidpoint: 0.6,
        minAtMs: now - 15 * 60_000,
        maxAtMs: now - 50 * 60_000,
        firstMidpoint: 0.25,
        lastMidpoint: 0.45,
        sampleCount: 5,
      })),
    };
    const mod = buildModule({
      decisionSignalLogRepo,
      priceHistoryProvider,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 2504,
      }),
    });
    await mod.start();

    const market = {
      ...makeMarket(tokenId, null, 0.45),
      gammaCreatedAt: new Date(now - 3_600_000).toISOString(),
    };
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: now,
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    const signal = signalCalls[0]![1].signal as import("@krabs/domain").Signal;
    expect(signal.side).toBe("buy");
    expect(signal.suggestedPrice).toBe(0.45);
    expect(signal.suggestedSizeUsdc).toBeCloseTo(0.99, 5);

    const logged = vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]?.[0];
    expect(logged).toMatchObject({
      side: "BUY",
      decisionRuleId: "FALLBACK",
      price: 0.45,
      entryFreshEdgeKind: "first_entry",
      entryFreshEdgeShadowClass: expect.any(String),
    });
    const payload = JSON.parse(logged?.entryFreshEdgePayloadJson ?? "{}");
    expect(payload).toMatchObject({
      tokenId,
      decisionRuleId: "FALLBACK",
      signalReason: "probe-entry",
      entryKind: "first_entry",
      marketAge: {
        thresholdSeconds: 2504,
        gatePassed: true,
      },
    });
    expect(payload.current.mid).toBe(0.45);
    expect(payload.windows["1h"].midpointPercentile).toBeCloseTo(0.625, 8);

    await mod.stop();
  });

  it("emits R23_DIP_TRIGGER BUY before FALLBACK HOLD when the 24h dip threshold is met", async () => {
    const tokenId = "token-r23-dip";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    algoRulesRepo = {
      getDecisionRules: vi.fn(() =>
        SEED_DECISION_RULES.map((rule) =>
          rule.ruleId === "FALLBACK" ? { ...rule, action: "HOLD" as const } : rule,
        ),
      ),
      getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
        actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
      ),
    };
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const priceHistoryProvider = {
      findReferencePrice: vi.fn(() => null),
      maxMidpointInWindow: vi.fn(() => 0.6),
    };
    const mod = buildModule({
      decisionSignalLogRepo,
      riskEventRepo,
      priceHistoryProvider,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        r23DipTrigger: { ...DEFAULT_EXECUTION_POLICY.r23DipTrigger, enabled: true },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.3)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    const signal = signalCalls[0]![1].signal as import("@krabs/domain").Signal;
    expect(signal.side).toBe("buy");
    expect(signal.decisionRuleId).toBe("R23_DIP_TRIGGER");
    expect(priceHistoryProvider.maxMidpointInWindow).toHaveBeenCalledWith(
      createTokenId(tokenId),
      86_400_000,
      expect.any(Number),
    );
    expect(decisionSignalLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ decisionRuleId: "R23_DIP_TRIGGER" }),
    );
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "signal_emitted",
        payload: expect.objectContaining({
          decisionRuleId: "R23_DIP_TRIGGER",
          r23DipRatio: 0.5,
          r23MaxMidpoint: 0.6,
          r23WindowMs: 86_400_000,
        }),
      }),
    );

    await mod.stop();
  });

  it("skips flat R23 probe candidates upstream when live-lite active market cap is full", async () => {
    const tokenId = "token-r23-cap-full";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    algoRulesRepo = {
      getDecisionRules: vi.fn(() =>
        SEED_DECISION_RULES.map((rule) =>
          rule.ruleId === "FALLBACK" ? { ...rule, action: "HOLD" as const } : rule,
        ),
      ),
      getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
        actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
      ),
    };
    const runtimeMetrics = { writeCounter: vi.fn() } as unknown as RuntimeMetricWriter;
    const priceHistoryProvider = {
      findReferencePrice: vi.fn(() => null),
      maxMidpointInWindow: vi.fn(() => 0.6),
    };
    const positionRepo = createPositionRepoForOpenPositions(
      makeOpenPositions(PHASE_ONE_ACTIVE_MARKET_CAP),
    );
    const mod = buildModule({
      runtimeMetrics,
      priceHistoryProvider,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
      liveLiteGuard: new LiveLiteGuard({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: PHASE_ONE_ACTIVE_MARKET_CAP,
      }),
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        r23DipTrigger: { ...DEFAULT_EXECUTION_POLICY.r23DipTrigger, enabled: true },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.3)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(0);
    expect(priceHistoryProvider.maxMidpointInWindow).not.toHaveBeenCalled();
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "r23_probe_skipped_active_market_cap_full_total",
      1,
      expect.not.stringContaining("token"),
    );
    const labels = JSON.parse(
      (runtimeMetrics.writeCounter as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as string,
    );
    expect(Object.keys(labels).sort()).toEqual(["action", "mode", "reason", "rule", "source"]);
    expect(labels).toMatchObject({
      action: "skip",
      reason: "live_lite_active_markets_cap_full",
      rule: "R23_DIP_TRIGGER",
      source: "probe-entry",
    });

    await mod.stop();
  });

  it("allows flat R23 probe candidates below the live-lite active market cap", async () => {
    const tokenId = "token-r23-cap-room";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    algoRulesRepo = {
      getDecisionRules: vi.fn(() =>
        SEED_DECISION_RULES.map((rule) =>
          rule.ruleId === "FALLBACK" ? { ...rule, action: "HOLD" as const } : rule,
        ),
      ),
      getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
        actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
      ),
    };
    const runtimeMetrics = { writeCounter: vi.fn() } as unknown as RuntimeMetricWriter;
    const priceHistoryProvider = {
      findReferencePrice: vi.fn(() => null),
      maxMidpointInWindow: vi.fn(() => 0.6),
    };
    const positionRepo = createPositionRepoForOpenPositions(
      makeOpenPositions(PHASE_ONE_ACTIVE_MARKET_CAP - 1),
    );
    const mod = buildModule({
      runtimeMetrics,
      priceHistoryProvider,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
      liveLiteGuard: new LiveLiteGuard({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: PHASE_ONE_ACTIVE_MARKET_CAP,
      }),
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        r23DipTrigger: { ...DEFAULT_EXECUTION_POLICY.r23DipTrigger, enabled: true },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.3)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]![1].signal.decisionRuleId).toBe("R23_DIP_TRIGGER");
    expect(priceHistoryProvider.maxMidpointInWindow).toHaveBeenCalled();
    expect(runtimeMetrics.writeCounter).not.toHaveBeenCalledWith(
      "r23_probe_skipped_active_market_cap_full_total",
      expect.any(Number),
      expect.any(String),
    );

    await mod.stop();
  });

  it("resumes flat R23 probe generation after an active market slot is freed", async () => {
    const tokenId = "token-r23-resume";
    const activeTokenId = "token-active-before-close";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    algoRulesRepo = {
      getDecisionRules: vi.fn(() =>
        SEED_DECISION_RULES.map((rule) =>
          rule.ruleId === "FALLBACK" ? { ...rule, action: "HOLD" as const } : rule,
        ),
      ),
      getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
        actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
      ),
    };
    const runtimeMetrics = { writeCounter: vi.fn() } as unknown as RuntimeMetricWriter;
    const positionRepo = createPositionRepoForOpenPositions([makeOpenPosition(activeTokenId)]);
    const mod = buildModule({
      runtimeMetrics,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
      liveLiteGuard: new LiveLiteGuard({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: 1,
      }),
      priceHistoryProvider: {
        findReferencePrice: vi.fn(() => null),
        maxMidpointInWindow: vi.fn(() => 0.6),
      },
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        r23DipTrigger: { ...DEFAULT_EXECUTION_POLICY.r23DipTrigger, enabled: true },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.3)],
      timestamp: Date.now(),
    });
    expect(
      (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      ),
    ).toHaveLength(0);

    positionRepo.remove(activeTokenId);
    await (bus as any).emit("PositionSettled", {
      positionId: createPositionId(`pos-${activeTokenId}`),
      tokenId: createTokenId(activeTokenId),
      resolution: "YES",
      settlementPrice: 1,
      realizedPnl: 0,
      size: 10,
      avgEntryPrice: 0.1,
      timestamp: Date.now(),
    });
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.3)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]![1].signal.decisionRuleId).toBe("R23_DIP_TRIGGER");

    await mod.stop();
  });

  it("does not block same-market scale-in candidates when live-lite active market cap is full", async () => {
    const tokenId = "token-existing-scale-in";
    selectedMarketCache = createMockSelectedMarketCache([]);
    const legState = makeSellReadyLegState(tokenId, {
      firstTradePrice: 0.2,
      buyCount: 6,
      sellCount: 0,
    });
    legStateRepo = createMockLegStateRepo([legState]);
    algoRulesRepo = {
      getDecisionRules: vi.fn(() => [
        {
          id: 20,
          priority: 20,
          ruleId: "D3",
          stateCondition: "ANY",
          priceOperator: "<=",
          priceValue: 0.12,
          timeSinceLastOperator: null,
          timeSinceLastSeconds: null,
          buyCountMin: null,
          buyCountMax: null,
          holdDurationOperator: null,
          holdDurationSeconds: null,
          action: "BUY",
        },
        {
          id: 99,
          priority: 99,
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
          action: "HOLD",
        },
      ]),
      getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
        actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
      ),
    };
    const positionRepo = createPositionRepoForOpenPositions([makeOpenPosition(tokenId)]);
    const mod = buildModule({
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
      liveLiteGuard: new LiveLiteGuard({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: 1,
      }),
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.1)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]![1].signal.side).toBe("buy");
    expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D3");

    await mod.stop();
  });

  it("does not block SELL candidates when live-lite active market cap is full", async () => {
    const tokenId = "token-existing-sell";
    selectedMarketCache = createMockSelectedMarketCache([]);
    legStateRepo = createMockLegStateRepo([makeSellReadyLegState(tokenId)]);
    const positionRepo = createPositionRepoForOpenPositions([makeOpenPosition(tokenId)]);
    const mod = buildModule({
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
      liveLiteGuard: new LiveLiteGuard({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: 1,
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.45)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]![1].signal.side).toBe("sell");

    await mod.stop();
  });

  it("falls through to FALLBACK HOLD without emitting BUY when R23 sees no dip", async () => {
    const tokenId = "token-r23-no-dip";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    algoRulesRepo = {
      getDecisionRules: vi.fn(() =>
        SEED_DECISION_RULES.map((rule) =>
          rule.ruleId === "FALLBACK" ? { ...rule, action: "HOLD" as const } : rule,
        ),
      ),
      getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
        actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
      ),
    };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      riskEventRepo,
      priceHistoryProvider: {
        findReferencePrice: vi.fn(() => null),
        maxMidpointInWindow: vi.fn(() => 0.4),
      },
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        r23DipTrigger: { ...DEFAULT_EXECUTION_POLICY.r23DipTrigger, enabled: true },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.3)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(0);
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          reasonCode: "r23-no-dip",
          decisionRuleId: "R23_DIP_TRIGGER",
          r23DipRatio: expect.closeTo(0.75, 8),
        }),
      }),
    );
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          reasonCode: "decision-rule-hold",
          decisionRuleId: "FALLBACK",
        }),
      }),
    );

    await mod.stop();
  });

  it("falls through to FALLBACK HOLD without emitting BUY when R23 lacks history", async () => {
    const tokenId = "token-r23-no-history";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    algoRulesRepo = {
      getDecisionRules: vi.fn(() =>
        SEED_DECISION_RULES.map((rule) =>
          rule.ruleId === "FALLBACK" ? { ...rule, action: "HOLD" as const } : rule,
        ),
      ),
      getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
        actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
      ),
    };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      riskEventRepo,
      priceHistoryProvider: {
        findReferencePrice: vi.fn(() => null),
        maxMidpointInWindow: vi.fn(() => null),
      },
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        r23DipTrigger: { ...DEFAULT_EXECUTION_POLICY.r23DipTrigger, enabled: true },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.3)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(0);
    expect(riskEventRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          reasonCode: "r23-no-history",
          decisionRuleId: "R23_DIP_TRIGGER",
        }),
      }),
    );

    await mod.stop();
  });

  it("pre-filter uses bestBid (not midPrice) for BUY executability — keeps signals downstream would accept", async () => {
    // Spec: order-size-below-minimum pre-filter must stay strictly more
    // permissive than signal-to-order.resolveOrderSize, which uses the
    // edge-mode execution price (= bestBid for BUY). Sizing here:
    //   suggestedSizeUsdc = $0.99 (B5 probe-entry seed)
    //   midPrice = 0.20 → size@mid = 4.95
    //   bestBid  = 0.18 → size@bestBid = 5.50
    //   minOrderSize = 5
    // size@mid would (incorrectly) suppress this signal even though
    // signal-to-order at edge mode would accept it.
    const tokenId = "token-edge-bid";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule();
    await mod.start();

    const market: NormalizedMarket = {
      ...makeMarket(tokenId, null, 0.2),
      bestBid: 0.18,
      bestAsk: 0.22,
      minOrderSize: 5,
    };

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls.length).toBe(1);

    await mod.stop();
  });

  it("pre-filter suppresses BUY whose size cannot meet minOrderSize even at bestBid", async () => {
    const tokenId = "token-truly-below-min";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule();
    await mod.start();

    // size@bestBid = 0.99 / 0.45 ≈ 2.2 shares — below min=5 under any price.
    const market: NormalizedMarket = {
      ...makeMarket(tokenId, null, 0.5),
      bestBid: 0.45,
      bestAsk: 0.55,
      minOrderSize: 5,
    };

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls.length).toBe(0);

    await mod.stop();
  });

  it("falls back to midPrice when bestBid is null and still suppresses below-min BUY", async () => {
    const tokenId = "token-no-bestbid";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule();
    await mod.start();

    // No bestBid → fallback to midPrice. size@mid = 0.99 / 0.50 ≈ 1.98 < 5.
    const market: NormalizedMarket = {
      ...makeMarket(tokenId, null, 0.5),
      bestBid: null,
      bestAsk: null,
      minOrderSize: 5,
    };

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls.length).toBe(0);

    await mod.stop();
  });

  it("pre-filter uses cumulative unsold size for SELL executability", async () => {
    const tokenId = "token-sell-actual-position-size";
    legStateRepo = createMockLegStateRepo([
      makeSellReadyLegState(tokenId, {
        cumulativeBuySize: 7,
        cumulativeSellSize: 0,
      }),
    ]);

    const mod = buildModule();
    await mod.start();

    const market: NormalizedMarket = {
      ...makeMarket(tokenId, null, 0.65, "cond-sell-actual-position-size"),
      minOrderSize: 5,
    };

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    const signal = signalCalls[0]![1].signal as import("@krabs/domain").Signal;
    expect(signal.side).toBe("sell");
    expect(signal.suggestedSize).toBeLessThan(5);
    expect(signal.decisionRuleId).toBe("D7-SELL-S1");

    await mod.stop();
  });

  it("pre-filter still suppresses SELL when suggested and cumulative unsold sizes are below min", async () => {
    const tokenId = "token-sell-below-actual-position-size";
    legStateRepo = createMockLegStateRepo([
      makeSellReadyLegState(tokenId, {
        cumulativeBuySize: 4,
        cumulativeSellSize: 0,
      }),
    ]);

    const mod = buildModule();
    await mod.start();

    const market: NormalizedMarket = {
      ...makeMarket(tokenId, null, 0.65, "cond-sell-below-actual-position-size"),
      minOrderSize: 5,
    };

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(0);

    await mod.stop();
  });

  it("dedupes order-size-below-minimum signal_suppressed rows across sweeps", async () => {
    const tokenId = "token-sticky-below-min";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({ riskEventRepo });
    await mod.start();

    // Sticky below-min market: size ≈ 2.2 shares < min=5 on every sweep.
    const market: NormalizedMarket = {
      ...makeMarket(tokenId, null, 0.5),
      bestBid: 0.45,
      bestAsk: 0.55,
      minOrderSize: 5,
    };

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });
    // Second sweep within the 10-min dedupe window — must NOT write another
    // signal_suppressed row for the same (reasonCode, tokenId, conditionId,
    // side, continuationMode) key.
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now() + 1_000,
    });

    const belowMinInserts = vi
      .mocked(riskEventRepo.insert)
      .mock.calls.filter(
        ([event]) =>
          event.eventType === "signal_suppressed" &&
          (event.payload as { reasonCode: string }).reasonCode === "order-size-below-minimum",
      );
    expect(belowMinInserts).toHaveLength(1);

    await mod.stop();
  });

  it("emits SignalProduced for eligible token with no familyId", async () => {
    const tokenId = "token-no-family";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule();
    await mod.start();

    const market = makeMarket(tokenId, null, 0.45, "cond-1");

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    expect(signalCalls.length).toBe(1);
    const signal = signalCalls[0]![1].signal as import("@krabs/domain").Signal;
    expect(signal.conditionId).toBe("cond-1" as ConditionId);

    await mod.stop();
  });

  it("passes non-probe BUY when the 1h reference price dropped by at least threshold", async () => {
    const tokenId = "token-drop-pass";
    const nowIso = new Date(Date.now() - 25 * 60_000).toISOString();
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    legStateRepo = createMockLegStateRepo([
      {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 1,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: nowIso,
        lastTradeAt: nowIso,
        updatedAt: nowIso,
      },
    ]);
    const priceHistoryProvider = { findReferencePrice: vi.fn(() => 0.06) };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      priceHistoryProvider,
      riskEventRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        dropTrigger: {
          ...DEFAULT_EXECUTION_POLICY.dropTrigger,
          enabled: true,
          thresholdPct: -0.02,
        },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.0585)],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(priceHistoryProvider.findReferencePrice).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(riskEventRepo.insert)
        .mock.calls.some(
          ([event]) =>
            event.eventType === "signal_emitted" && event.payload.dropTriggerStatus === "passed",
        ),
    ).toBe(true);

    await mod.stop();
  });

  it("suppresses non-probe BUY when the 1h reference price did not drop enough", async () => {
    const tokenId = "token-drop-reject";
    const nowIso = new Date(Date.now() - 25 * 60_000).toISOString();
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    legStateRepo = createMockLegStateRepo([
      {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 1,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: nowIso,
        lastTradeAt: nowIso,
        updatedAt: nowIso,
      },
    ]);
    const priceHistoryProvider = { findReferencePrice: vi.fn(() => 0.06) };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      priceHistoryProvider,
      riskEventRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        dropTrigger: {
          ...DEFAULT_EXECUTION_POLICY.dropTrigger,
          enabled: true,
          thresholdPct: -0.02,
        },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.0591)],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    expect(publishCalls.filter(([ev]) => ev === "SignalProduced")).toHaveLength(0);
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_suppressed",
      payload: expect.objectContaining({
        tokenId,
        reasonCode: "no_drop_signal",
        side: "BUY",
      }),
    });

    await mod.stop();
  });

  it("allows non-probe BUY when drop-trigger history is unavailable", async () => {
    const tokenId = "token-drop-missing-history";
    const nowIso = new Date(Date.now() - 25 * 60_000).toISOString();
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    legStateRepo = createMockLegStateRepo([
      {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 1,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: nowIso,
        lastTradeAt: nowIso,
        updatedAt: nowIso,
      },
    ]);
    const priceHistoryProvider = { findReferencePrice: vi.fn(() => null) };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      priceHistoryProvider,
      riskEventRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        dropTrigger: { ...DEFAULT_EXECUTION_POLICY.dropTrigger, enabled: true },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.0591)],
      timestamp: Date.now(),
    });

    expect(
      (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      ),
    ).toHaveLength(1);
    expect(
      vi
        .mocked(riskEventRepo.insert)
        .mock.calls.some(
          ([event]) =>
            event.eventType === "signal_emitted" &&
            event.payload.dropTriggerStatus === "no_drop_data",
        ),
    ).toBe(true);

    await mod.stop();
  });

  it("suppresses non-probe BUY with no history when drop-trigger failOpenOnNoData is false", async () => {
    const tokenId = "token-drop-missing-history-strict";
    const nowIso = new Date(Date.now() - 25 * 60_000).toISOString();
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    legStateRepo = createMockLegStateRepo([
      {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 1,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: nowIso,
        lastTradeAt: nowIso,
        updatedAt: nowIso,
      },
    ]);
    const priceHistoryProvider = { findReferencePrice: vi.fn(() => null) };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      priceHistoryProvider,
      riskEventRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        dropTrigger: {
          ...DEFAULT_EXECUTION_POLICY.dropTrigger,
          enabled: true,
          failOpenOnNoData: false,
        },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.0591)],
      timestamp: Date.now(),
    });

    expect(
      (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      ),
    ).toHaveLength(0);
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_suppressed",
      payload: expect.objectContaining({
        tokenId,
        reasonCode: "no_drop_data",
        side: "BUY",
      }),
    });

    await mod.stop();
  });

  it("does not call price history when drop-trigger is disabled", async () => {
    const tokenId = "token-drop-disabled";
    const nowIso = new Date(Date.now() - 25 * 60_000).toISOString();
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    legStateRepo = createMockLegStateRepo([
      {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 1,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: nowIso,
        lastTradeAt: nowIso,
        updatedAt: nowIso,
      },
    ]);
    const priceHistoryProvider = { findReferencePrice: vi.fn(() => 0.9) };
    const mod = buildModule({
      priceHistoryProvider,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        dropTrigger: { ...DEFAULT_EXECUTION_POLICY.dropTrigger, enabled: false },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.0591)],
      timestamp: Date.now(),
    });

    expect(priceHistoryProvider.findReferencePrice).not.toHaveBeenCalled();
    expect(
      (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      ),
    ).toHaveLength(1);

    await mod.stop();
  });

  it("bypasses drop trigger for probe-entry BUY", async () => {
    const tokenId = "token-drop-probe";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    const priceHistoryProvider = { findReferencePrice: vi.fn(() => 0.9) };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      priceHistoryProvider,
      riskEventRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        dropTrigger: { ...DEFAULT_EXECUTION_POLICY.dropTrigger, enabled: true },
      }),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.45)],
      timestamp: Date.now(),
    });

    expect(
      (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      ),
    ).toHaveLength(1);
    expect(priceHistoryProvider.findReferencePrice).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(riskEventRepo.insert)
        .mock.calls.some(
          ([event]) =>
            event.eventType === "signal_emitted" &&
            event.payload.dropTriggerStatus === "bypass_probe",
        ),
    ).toBe(true);

    await mod.stop();
  });

  it("persists BUY/SELL decision signal telemetry", async () => {
    const tokenId = "token-sell";
    const nowIso = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 1,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: nowIso,
      lastTradeAt: nowIso,
      updatedAt: nowIso,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(tokenId, null, 0.15, "cond-sell"),
          bestBid: 0.15,
          bestAsk: 0.16,
          spread: 0.01,
          tradable: false,
        },
      ],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0]).toMatchObject({
      tokenId: createTokenId(tokenId),
      conditionId: "cond-sell",
      side: "SELL",
      decisionRuleId: "D7-SELL-S1",
      sizingRuleId: "FALLBACK-SELL",
      // sizeUsdc=2.63 falls in the §4.6 "$2-$5" bucket.
      notionalBucket: "$2-$5",
      state: "S1",
      price: 0.15,
      buyCount: 1,
    });
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_emitted",
      payload: expect.objectContaining({
        tokenId,
        conditionId: "cond-sell",
        side: "SELL",
        decisionRuleId: "D7-SELL-S1",
        state: "S1",
        firstTradePrice: 0.1,
        legTradeCount: 2,
      }),
    });

    await mod.stop();
  });

  it("denormalizes §11.1 adds telemetry on add-BUY signals", async () => {
    const tokenId = "token-add";
    // buyCount=2 + firstTradePrice=0.1 satisfies R2 continuation
    // (legTradeCount>=2 ∧ firstTradePrice>=0.05); add-BUY can fire.
    const ninetyMinAgoMs = Date.now() - 90 * 60 * 1000;
    const ninetyMinAgo = new Date(ninetyMinAgoMs).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 2,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: ninetyMinAgo,
      lastTradeAt: ninetyMinAgo,
      updatedAt: ninetyMinAgo,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
    await mod.start();

    // Price 0.07 is below D7-SELL-S1 (0.1) and above REDEEM-S2 (<0.05);
    // FALLBACK BUY fires on the existing S2 leg → add-BUY.
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.07, "cond-add")],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0];
    expect(inserted).toMatchObject({
      side: "BUY",
      buyCount: 2,
      isAdd: 1,
      addAgeBucket: "1-3h",
      addPriceChangeBucket: "-50% to -25%",
      nthBuyAtEmit: 3,
    });
    expect(inserted.addPriceChangePct).toBeCloseTo(-0.3, 5);
    expect(inserted.addAgeMs).toBeGreaterThanOrEqual(90 * 60 * 1000);
    expect(inserted.addAgeMs).toBeLessThan(91 * 60 * 1000);

    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_emitted",
      payload: expect.objectContaining({
        side: "BUY",
        isAdd: 1,
        addAgeBucket: "1-3h",
        addPriceChangeBucket: "-50% to -25%",
        nthBuyAtEmit: 3,
      }),
    });

    await mod.stop();
  });

  it("denormalizes §11.2 exit telemetry on SELL signals (first-sell, vwap pnl, ratio)", async () => {
    const tokenId = "token-exit";
    // 90 minutes ago → should land in "1-6h" holding-time bucket.
    const ninetyMinAgoMs = Date.now() - 90 * 60 * 1000;
    const ninetyMinAgo = new Date(ninetyMinAgoMs).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 0, // first-sell condition
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: ninetyMinAgo,
      lastTradeAt: ninetyMinAgo,
      updatedAt: ninetyMinAgo,
      // Cost basis VWAP = 0.10 → exit @ 0.15 = +50%. Boundary is left-inclusive
      // (`pct < 0.5` puts <0.5 in "+25% to +50%", so an exact 0.5 lands in
      // "+50% to +100%"). Float-snap in classifyExitPnlBucket pulls the
      // (0.15-0.10)/0.10 = 0.4999...9 binary artifact up to exact 0.5.
      cumulativeBuySize: 100,
      cumulativeBuyNotional: 10,
      cumulativeSellSize: 0,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
    await mod.start();

    // Non-tradable market + SELL price > D7-SELL-S1 threshold (0.10) → SELL fires.
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(tokenId, null, 0.15, "cond-exit"),
          bestBid: 0.15,
          bestAsk: 0.16,
          spread: 0.01,
          tradable: false,
        },
      ],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0];
    expect(inserted).toMatchObject({
      side: "SELL",
      isExit: 1,
      isFirstSell: 1,
      holdingTimeBucket: "1-6h",
      exitPnlBucket: "+50% to +100%",
      soldBoughtRatioBucket: "0%",
    });
    expect(inserted.exitPnlPct).toBeCloseTo(0.5, 5);
    expect(inserted.soldBoughtRatio).toBe(0);
    expect(inserted.holdingTimeMs).toBeGreaterThanOrEqual(90 * 60 * 1000);
    expect(inserted.holdingTimeMs).toBeLessThan(91 * 60 * 1000);

    await mod.stop();
  });

  it("sets isExit=0 and leaves SELL-only exit telemetry null on BUY signals", async () => {
    const tokenId = "token-exit-buy-null";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.45, "cond-exit-buy-null")],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0]).toMatchObject({
      side: "BUY",
      isExit: 0,
      isFirstSell: null,
      holdingTimeMs: null,
      holdingTimeBucket: null,
      exitPnlPct: null,
      exitPnlBucket: null,
      soldBoughtRatio: null,
      soldBoughtRatioBucket: null,
    });

    await mod.stop();
  });

  it("suppresses repeated SELL residuals below exchange min size before signal telemetry", async () => {
    const tokenId = "token-sell-residual";
    const nowIso = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: nowIso,
      lastTradeAt: nowIso,
      updatedAt: nowIso,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const positionRepo = {
      findByTokenId: vi.fn().mockReturnValue({ size: 2, avgEntryPrice: 0.2 }),
    };

    const mod = buildModule({
      decisionSignalLogRepo,
      riskEventRepo,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
    });
    await mod.start();

    const market = {
      ...makeMarket(tokenId, null, 0.15, "cond-residual"),
      tradable: false,
      minOrderSize: 5,
    };
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    const signalEmittedCalls = vi
      .mocked(riskEventRepo.insert)
      .mock.calls.filter(([event]) => event.eventType === "signal_emitted");
    const residualSuppressionCalls = vi
      .mocked(riskEventRepo.insert)
      .mock.calls.filter(
        ([event]) => event.payload.reasonCode === "sell-residual-below-min-order-size",
      );

    expect(signalCalls).toHaveLength(0);
    expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();
    expect(signalEmittedCalls).toHaveLength(0);
    expect(residualSuppressionCalls).toHaveLength(1);
    expect(residualSuppressionCalls[0]![0]).toMatchObject({
      eventType: "signal_suppressed",
      payload: {
        tokenId,
        side: "SELL",
        decisionRuleId: "D7-SELL-S1",
      },
    });

    await mod.stop();
  });

  it("suppresses SELL during the post-BUY fill cooldown", async () => {
    const tokenId = "token-post-buy-cooldown";
    legStateRepo = createMockLegStateRepo([makeSellReadyLegState(tokenId)]);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      riskEventRepo,
      executionPolicy: () => policyWithPostBuyCooldown(),
    });
    await mod.start();

    const now = Date.now();
    await (bus as any).emit("FillReceived", makeBuyFill(tokenId, now - 1_000));
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(tokenId, null, 0.15, "cond-cooldown"), tradable: false }],
      timestamp: now,
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(0);
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_suppressed",
      payload: expect.objectContaining({
        reasonCode: "post-buy-fill-cooldown",
        side: "SELL",
        decisionRuleId: "D7-SELL-S1",
      }),
    });

    await mod.stop();
  });

  it("allows SELL after the post-BUY fill cooldown expires", async () => {
    const tokenId = "token-post-buy-cooldown-expired";
    legStateRepo = createMockLegStateRepo([makeSellReadyLegState(tokenId)]);
    const mod = buildModule({
      executionPolicy: () => policyWithPostBuyCooldown(),
    });
    await mod.start();

    const now = Date.now();
    await (bus as any).emit("FillReceived", makeBuyFill(tokenId, now - 6_000));
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(tokenId, null, 0.15, "cond-cooldown-expired"), tradable: false }],
      timestamp: now,
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]![1].signal).toMatchObject({
      side: "sell",
      decisionRuleId: "D7-SELL-S1",
    });

    await mod.stop();
  });

  it("anchors the post-BUY fill cooldown to the latest BUY fill", async () => {
    const tokenId = "token-post-buy-cooldown-latest";
    legStateRepo = createMockLegStateRepo([makeSellReadyLegState(tokenId)]);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const mod = buildModule({
      riskEventRepo,
      executionPolicy: () => policyWithPostBuyCooldown(),
    });
    await mod.start();

    const now = Date.now();
    await (bus as any).emit("FillReceived", makeBuyFill(tokenId, now - 6_000));
    await (bus as any).emit("FillReceived", makeBuyFill(tokenId, now - 1_000));
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(tokenId, null, 0.15, "cond-cooldown-latest"), tradable: false }],
      timestamp: now,
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(0);
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_suppressed",
      payload: expect.objectContaining({ reasonCode: "post-buy-fill-cooldown" }),
    });

    await mod.stop();
  });

  it("allows SELL when there is no preceding BUY fill", async () => {
    const tokenId = "token-post-buy-cooldown-no-fill";
    legStateRepo = createMockLegStateRepo([makeSellReadyLegState(tokenId)]);
    const mod = buildModule({
      executionPolicy: () => policyWithPostBuyCooldown(),
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(tokenId, null, 0.15, "cond-cooldown-no-fill"), tradable: false }],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]![1].signal).toMatchObject({
      side: "sell",
      decisionRuleId: "D7-SELL-S1",
    });

    await mod.stop();
  });

  it("integration: 10th reject triggers DB write", async () => {
    const tokenId = "token-dust-abandon";
    const nowIso = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: nowIso,
      lastTradeAt: nowIso,
      updatedAt: nowIso,
      consecutiveSellResidualRejects: 9,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const positionRepo = {
      findByTokenId: vi.fn().mockReturnValue({ size: 2, avgEntryPrice: 0.2 }),
    };

    const mod = buildModule({
      riskEventRepo,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(tokenId, null, 0.15, "cond-dust-abandon"),
          bestBid: 0.15,
          bestAsk: 0.16,
          spread: 0.01,
          tradable: false,
          minOrderSize: 5,
        },
      ],
      timestamp: Date.now(),
    });

    expect(legStateRepo.incrementSellResidualReject).toHaveBeenCalledWith(
      createTokenId(tokenId),
      expect.any(String),
      { threshold: DEFAULT_EXECUTION_POLICY.dustAbandonment.maxConsecutiveRejects, price: 0.15 },
    );
    expect(legStateRepo.get(createTokenId(tokenId))?.consecutiveSellResidualRejects).toBe(10);
    expect(legStateRepo.get(createTokenId(tokenId))?.abandonedAtPrice).toBe(0.15);
    expect(
      vi
        .mocked(riskEventRepo.insert)
        .mock.calls.some(([event]) => event.payload.reasonCode === "dust-abandoned"),
    ).toBe(true);

    await mod.stop();
  });

  it("integration: abandoned token short-circuit", async () => {
    const tokenId = "token-dust-short-circuit";
    const nowIso = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: nowIso,
      lastTradeAt: nowIso,
      updatedAt: nowIso,
      abandonedAtPrice: 0.1,
      abandonedAtTs: nowIso,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const positionRepo = {
      findByTokenId: vi.fn().mockReturnValue({ size: 5, avgEntryPrice: 0.1 }),
    };

    const mod = buildModule({
      decisionSignalLogRepo,
      riskEventRepo,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.12, "cond-dust-short-circuit")],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(0);
    expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();
    expect(legStateRepo.incrementSellResidualReject).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(riskEventRepo.insert)
        .mock.calls.some(([event]) => event.payload.reasonCode === "dust-abandoned"),
    ).toBe(true);

    await mod.stop();
  });

  it("integration: price recovery", async () => {
    const tokenId = "token-dust-recovery";
    const nowIso = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: nowIso,
      lastTradeAt: nowIso,
      updatedAt: nowIso,
      abandonedAtPrice: 0.1,
      abandonedAtTs: nowIso,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const positionRepo = {
      findByTokenId: vi.fn().mockReturnValue({ size: 5, avgEntryPrice: 0.1 }),
    };

    const mod = buildModule({
      riskEventRepo,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(tokenId, null, 0.16, "cond-dust-recovery"),
          bestBid: 0.16,
          bestAsk: 0.17,
          spread: 0.01,
          tradable: false,
          minOrderSize: 5,
        },
      ],
      timestamp: Date.now(),
    });

    expect(legStateRepo.resetAbandoned).toHaveBeenCalledWith(
      createTokenId(tokenId),
      expect.any(String),
    );
    expect(
      vi
        .mocked(riskEventRepo.insert)
        .mock.calls.some(([event]) => event.payload.reasonCode === "dust-recovered"),
    ).toBe(true);
    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]![1].signal.side).toBe("sell");

    await mod.stop();
  });

  it("keeps SELL eligible when position size meets exchange min size", async () => {
    const tokenId = "token-sell-min-ok";
    const nowIso = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: nowIso,
      lastTradeAt: nowIso,
      updatedAt: nowIso,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const positionRepo = {
      findByTokenId: vi.fn().mockReturnValue({ size: 5, avgEntryPrice: 0.2 }),
    };

    const mod = buildModule({
      riskEventRepo,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
    });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(tokenId, null, 0.15, "cond-min-ok"),
          tradable: false,
          minOrderSize: 5,
        },
      ],
      timestamp: Date.now(),
    });

    const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([ev]) => ev === "SignalProduced",
    );
    expect(signalCalls).toHaveLength(1);
    expect(signalCalls[0]![1].signal.side).toBe("sell");

    await mod.stop();
  });

  it("uses positions.avg_entry_price as cost basis after partial sells (FIFO-rebased)", async () => {
    // ADR-027 §D-B — after partial sells, inventory engine recomputes
    // positions.avg_entry_price via FIFO from remaining lots. The lifetime
    // VWAP (cumulative_buy_notional / cumulative_buy_size) does not get
    // adjusted — so exit_pnl_pct must source the rolling cost basis from
    // positions.avg_entry_price, not the lifetime VWAP. Without this fix, a
    // SELL @ 0.15 with FIFO basis 0.20 would log 0% (vs lifetime 0.15)
    // instead of the correct -25%.
    const tokenId = "token-exit-fifo";
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    // S1 state (buyCount=1, sellCount=1, lastAction=BUY) so D7-SELL-S1 fires.
    // Lifetime VWAP intentionally diverges from positions.avgEntryPrice
    // (0.15 vs 0.20) to exercise the rolling-basis preference.
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 1,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: ninetyMinAgo,
      lastTradeAt: ninetyMinAgo,
      updatedAt: ninetyMinAgo,
      cumulativeBuySize: 200,
      cumulativeBuyNotional: 30, // lifetime VWAP = 0.15
      cumulativeSellSize: 100,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
    const positionRepo = {
      findByTokenId: vi.fn().mockReturnValue({ avgEntryPrice: 0.2 }),
    };

    const mod = buildModule({
      decisionSignalLogRepo,
      riskEventRepo,
      positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
    });
    await mod.start();

    // SELL @ 0.15 with rolling basis 0.20 → exit_pnl_pct = (0.15-0.20)/0.20 = -0.25
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(tokenId, null, 0.15, "cond-fifo"),
          bestBid: 0.15,
          bestAsk: 0.16,
          spread: 0.01,
          tradable: false,
        },
      ],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0];
    expect(inserted.side).toBe("SELL");
    expect(inserted.exitPnlPct).toBeCloseTo(-0.25, 5);
    expect(inserted.exitPnlBucket).toBe("-50% to -10%");
    expect(positionRepo.findByTokenId).toHaveBeenCalledWith(createTokenId(tokenId));

    await mod.stop();
  });

  it("falls back to lifetime cumulative VWAP for exit_pnl_pct when positionRepo is omitted", async () => {
    // Defensive fallback: tests / control-only deployments that don't wire
    // positionRepo still get exit_pnl_pct (lifetime VWAP), matching the
    // pre-fix behavior. Production wires positionRepo so the FIFO-rebased
    // basis is preferred; this guards regression of the optional-dep contract.
    const tokenId = "token-exit-fallback";
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: ninetyMinAgo,
      lastTradeAt: ninetyMinAgo,
      updatedAt: ninetyMinAgo,
      cumulativeBuySize: 100,
      cumulativeBuyNotional: 10, // VWAP = 0.10
      cumulativeSellSize: 0,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [
        {
          ...makeMarket(tokenId, null, 0.12, "cond-fallback"),
          bestBid: 0.12,
          bestAsk: 0.13,
          spread: 0.01,
          tradable: false,
        },
      ],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0];
    expect(inserted.exitPnlPct).toBeCloseTo(0.2, 5);

    await mod.stop();
  });

  it("flags isFirstSell=0 on subsequent SELL signals after the first", async () => {
    const tokenId = "token-exit-second";
    const ninetyMinAgo = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    // buyCount=1, lastAction=BUY → state S1 (post S3 re-entry); D7-SELL-S1
    // fires on price>=0.10. sellCount=1 makes this NOT the first SELL.
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 1,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: ninetyMinAgo,
      lastTradeAt: ninetyMinAgo,
      updatedAt: ninetyMinAgo,
      cumulativeBuySize: 200,
      cumulativeBuyNotional: 20,
      cumulativeSellSize: 50, // 50/200 = 0.25 → buckets are [_, 0.25) so lands in "25-50%"
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(tokenId, null, 0.15, "cond-exit-2"), tradable: false }],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0]).toMatchObject({
      side: "SELL",
      isExit: 1,
      isFirstSell: 0,
      soldBoughtRatioBucket: "25-50%",
    });

    await mod.stop();
  });

  it("leaves §11.1 adds telemetry null on first-entry BUY signals", async () => {
    const tokenId = "token-first-entry";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, null, 0.45, "cond-first")],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0]).toMatchObject({
      side: "BUY",
      buyCount: 0,
      isAdd: 0,
      addAgeMs: null,
      addAgeBucket: null,
      addPriceChangePct: null,
      addPriceChangeBucket: null,
      nthBuyAtEmit: 1,
      isExit: 0,
    });

    await mod.stop();
  });

  it("does not emit algo RedeemRequested even when legacy REDEEM conditions are met", async () => {
    const tokenId = "token-redeem";
    const familyId = "fam-2";
    const conditionId = "cond-redeem";

    // legState = S2 (buyCount=2, lastAction=BUY), firstTradeAt = 25 min ago (~1500s ≤ 3600s)
    const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 2,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: twentyFiveMinAgo,
      lastTradeAt: twentyFiveMinAgo,
      updatedAt: twentyFiveMinAgo,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
    await mod.start();

    // Legacy REDEEM-S2 matches in the rules table, but runtime algo-REDEEM is disabled.
    const market = makeMarket(tokenId, familyId, 0.03, conditionId);
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    expect(redeemCalls.length).toBe(0);
    expect(signalCalls.length).toBe(1);
    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0]).toMatchObject({
      tokenId: createTokenId(tokenId),
      conditionId,
      side: "BUY",
      decisionRuleId: "FALLBACK",
      sizingRuleId: "FALLBACK-BUY",
      state: "S2",
      price: 0.03,
      buyCount: 2,
      isExit: 0,
      isFirstSell: null,
      holdingTimeMs: null,
      holdingTimeBucket: null,
      exitPnlPct: null,
      exitPnlBucket: null,
      soldBoughtRatio: null,
      soldBoughtRatioBucket: null,
    });
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_emitted",
      payload: expect.objectContaining({
        tokenId,
        conditionId,
        side: "BUY",
        decisionRuleId: "FALLBACK",
        state: "S2",
        firstTradePrice: 0.1,
        legTradeCount: 2,
      }),
    });

    await mod.stop();
  });

  it("does NOT emit RedeemRequested when market endDate is in the future", async () => {
    // On-chain redeemPositions() reverts before UMA resolution, so emitting
    // RedeemRequested against a live market is pure bus noise. Gate keeps it off.
    const tokenId = "token-redeem-live";
    const conditionId = "cond-redeem-live";

    const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 2,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: twentyFiveMinAgo,
      lastTradeAt: twentyFiveMinAgo,
      updatedAt: twentyFiveMinAgo,
    };
    legStateRepo = createMockLegStateRepo([legState]);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = buildModule({ riskEventRepo });
    await mod.start();

    const market = {
      ...makeMarket(tokenId, null, 0.03, conditionId),
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
    expect(redeemCalls.length).toBe(0);
    const emittedRedeem = vi
      .mocked(riskEventRepo.insert)
      .mock.calls.some(
        ([event]) => event.eventType === "signal_emitted" && event.payload.side === "REDEEM",
      );
    expect(emittedRedeem).toBe(false);

    await mod.stop();
  });

  it("does not emit algo RedeemRequested when market endDate is in the past", async () => {
    const tokenId = "token-redeem-past";
    const conditionId = "cond-redeem-past";

    const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 2,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: twentyFiveMinAgo,
      lastTradeAt: twentyFiveMinAgo,
      updatedAt: twentyFiveMinAgo,
    };
    legStateRepo = createMockLegStateRepo([legState]);

    const mod = buildModule();
    await mod.start();

    const market = {
      ...makeMarket(tokenId, null, 0.03, conditionId),
      endDate: new Date(Date.now() - 60_000).toISOString(),
    };
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
    expect(redeemCalls.length).toBe(0);
    expect(signalCalls.length).toBe(1);

    await mod.stop();
  });

  it("does not emit algo RedeemRequested when market endDate is null", async () => {
    const tokenId = "token-redeem-null";
    const conditionId = "cond-redeem-null";

    const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 2,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: twentyFiveMinAgo,
      lastTradeAt: twentyFiveMinAgo,
      updatedAt: twentyFiveMinAgo,
    };
    legStateRepo = createMockLegStateRepo([legState]);

    const mod = buildModule();
    await mod.start();

    const market = makeMarket(tokenId, null, 0.03, conditionId); // endDate: null
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
    expect(redeemCalls.length).toBe(0);
    expect(signalCalls.length).toBe(1);

    await mod.stop();
  });

  it("skips tokens that already have a signal-time pending BUY reservation", async () => {
    const tokenId = "token-pending";
    const familyId = "fam-3";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule();
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, familyId, 0.45)],
      timestamp: Date.now(),
    });

    // Reset publish mock so we only see calls from the second market update.
    (bus.publish as ReturnType<typeof vi.fn>).mockClear();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, familyId, 0.45)],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    expect(signalCalls.length).toBe(0);

    await mod.stop();
  });

  describe("continuation gate", () => {
    it("allows BUY when continuation passes (tradeCount >= 6)", async () => {
      const tokenId = "token-cont-buy";
      const familyId = "fam-cont";
      // legState: S1 (buyCount=1), sellCount=5 → tradeCount = 6 → CONTINUE
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 5,
        lastAction: "BUY",
        firstTradePrice: 0.03,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);
      // Tradable market → eligible for scale-in BUYs (not preserved-for-lifecycle)
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.45)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.side).toBe("buy");

      await mod.stop();
    });

    it("suppresses BUY when continuation fails — emits nothing when no SELL rule matches", async () => {
      const tokenId = "token-cont-stop";
      const familyId = "fam-cont";
      // legState: S2 (buyCount=2), sellCount=0 → tradeCount = 2
      // firstTradePrice = 0.03 < 0.05 → R2 fails, tradeCount < 6 → R1 fails → STOP
      // S2 state has no SELL rule in seed → no signal
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 2,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice: 0.03,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.45)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);
      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          tokenId,
          reasonCode: "continuation-stop",
          state: "S2",
          firstTradePrice: 0.03,
          legTradeCount: 2,
        }),
      });

      await mod.stop();
    });

    it("STOP path still emits SELL when an existing-leg SELL rule matches", async () => {
      const tokenId = "token-cont-sell";
      const familyId = "fam-cont";
      // legState: S1 (buyCount=1), sellCount=0 → tradeCount = 1
      // firstTradePrice = 0.03 < 0.05 → STOP
      // S1 + price >= 0.10 matches D7-SELL-S1 and must remain reachable as an exit.
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice: 0.03,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.15)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.side).toBe("sell");
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D7-SELL-S1");
      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_emitted",
        payload: expect.objectContaining({
          tokenId,
          side: "SELL",
          decisionRuleId: "D7-SELL-S1",
          continuationStop: true,
          tradeCount: 1,
          tradeCountSource: "leg_local",
        }),
      });

      await mod.stop();
    });

    it("does not force SELL priority when continuation passes", async () => {
      const tokenId = "token-cont-pass-sell-match";
      const familyId = "fam-cont";
      // tradeCount=2 and firstTradePrice=0.05 → continuation passes.
      // FALLBACK BUY and SELL-LATE both match; when not in STOP, the unchanged
      // evaluateDecision order must decide the action instead of the STOP-only
      // SELL bypass forcing a SELL.
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 1,
        lastAction: "BUY",
        firstTradePrice: 0.05,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);
      algoRulesRepo = {
        getDecisionRules: vi.fn(() => [
          {
            id: 100,
            priority: 10,
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
          },
          {
            id: 101,
            priority: 20,
            ruleId: "SELL-LATE",
            stateCondition: "S1",
            priceOperator: ">=",
            priceValue: 0.1,
            timeSinceLastOperator: null,
            timeSinceLastSeconds: null,
            buyCountMin: null,
            buyCountMax: null,
            holdDurationOperator: null,
            holdDurationSeconds: null,
            action: "SELL",
          },
        ]),
        getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
          actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
        ),
      };

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.15)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.side).toBe("buy");
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("FALLBACK");

      await mod.stop();
    });

    it("boundary: legTradeCount=6 → continuation passes → normal decision flow", async () => {
      const tokenId = "token-cont-boundary";
      const familyId = "fam-cont";
      // legTradeCount = 6 (R1 threshold) → continuation=true → normal flow
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 3,
        sellCount: 3,
        lastAction: "SELL",
        firstTradePrice: 0.03,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.45)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBeGreaterThanOrEqual(1);

      await mod.stop();
    });

    it("legacy REDEEM does not bypass the continuation gate", async () => {
      const tokenId = "token-cont-redeem";
      const familyId = "fam-cont";
      const conditionId = "cond-redeem-cont";
      // S1 with low trade count → STOP. Legacy REDEEM rows must not bypass it.
      const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice: 0.03,
        firstTradeAt: thirtyMinAgo,
        lastTradeAt: thirtyMinAgo,
        updatedAt: thirtyMinAgo,
      };
      legStateRepo = createMockLegStateRepo([legState]);

      const mod = buildModule();
      await mod.start();

      // Price 0.03 < 0.05 + holdDuration ~1800s ≤ 3600s would match legacy REDEEM.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.03, conditionId)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
      expect(redeemCalls.length).toBe(0);

      // No SignalProduced
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);

      await mod.stop();
    });

    it("preserved-for-lifecycle market (legState + tradable:false) emits only SELL, never BUY", async () => {
      const tokenId = "token-preserved";
      const familyId = "fam-cont";
      // legState with tradeCount >= 6 would normally allow BUY (CONTINUE path),
      // but the market is preserved-for-lifecycle (tradable:false), so only
      // SELL rules may fire per spec v2.2 §0 pre-entry gate.
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 5,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);
      // Cache may or may not contain tokenId — preservedOnly keys on
      // market.tradable directly, not eligibility.
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      const preservedMarket: NormalizedMarket = {
        ...makeMarket(tokenId, familyId, 0.15),
        tradable: false,
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [preservedMarket],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      // S1 + price 0.15 triggers D7-SELL-S1, never any BUY rule
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.side).toBe("sell");

      await mod.stop();
    });

    it("continuation gate does not apply to tokens with no legState", async () => {
      const tokenId = "token-no-leg";
      const familyId = "fam-cont";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.45)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.side).toBe("buy");

      await mod.stop();
    });
  });

  // ADR-016 — opt-in `market_wide` continuation mode.
  describe("ADR-016 market_wide continuation mode", () => {
    const SHARED_CONDITION_ID = "cond-adr016";

    function legAtBuy1(tokenId: string, firstTradePrice = 0.03): LegState {
      return {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    it("market_wide + provider returns 6 → continuation passes; signal fires where leg-local would STOP", async () => {
      // Under leg_local, legTradeCount=1 + firstTradePrice=0.03 → STOP, no signal.
      // Under market_wide, provider returns 6 → R1 passes → decision flow runs
      // and emits a signal. (The specific decision-rule that wins is exercised
      // by sibling tests; what's under test here is the gate flip.)
      const tokenId = "token-mw-pass";
      const familyId = "fam-mw";
      legStateRepo = createMockLegStateRepo([legAtBuy1(tokenId)]);

      const controlDb = createContinuationControlDb({
        continuationMode: "market_wide",
        continuationModeVersion: 1,
      });
      const provider = createMockTradeCountProvider(6);

      const mod = buildModule({ controlDb: controlDb.db, tradeCountProvider: provider });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.05, SHARED_CONDITION_ID)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(1);
      // Provider was consulted (prefetch path or per-token countTrades).
      expect(provider.prefetchCalls.length + provider.countCalls.length).toBeGreaterThanOrEqual(1);

      await mod.stop();
    });

    it("market_wide + provider returns 1 → STOP; suppression carries source=market_wide", async () => {
      const tokenId = "token-mw-stop";
      const familyId = "fam-mw";
      legStateRepo = createMockLegStateRepo([legAtBuy1(tokenId)]);

      const controlDb = createContinuationControlDb({
        continuationMode: "market_wide",
        continuationModeVersion: 1,
      });
      const provider = createMockTradeCountProvider(1);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({
        controlDb: controlDb.db,
        tradeCountProvider: provider,
        riskEventRepo,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.05, SHARED_CONDITION_ID)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      expect(publishCalls.filter(([ev]) => ev === "SignalProduced").length).toBe(0);
      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          tokenId,
          reasonCode: "continuation-stop",
          tradeCount: 1,
          tradeCountSource: "market_wide",
          continuationMode: "market_wide",
          legTradeCount: 1,
        }),
      });

      await mod.stop();
    });

    it("market_wide + provider returns null → fallback to leg-local; suppression source=leg_local_fallback", async () => {
      const tokenId = "token-mw-fallback";
      const familyId = "fam-mw";
      legStateRepo = createMockLegStateRepo([legAtBuy1(tokenId)]);

      const controlDb = createContinuationControlDb({
        continuationMode: "market_wide",
        continuationModeVersion: 1,
      });
      const provider = createMockTradeCountProvider(null);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({
        controlDb: controlDb.db,
        tradeCountProvider: provider,
        riskEventRepo,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.05, SHARED_CONDITION_ID)],
        timestamp: Date.now(),
      });

      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          tokenId,
          reasonCode: "continuation-stop",
          tradeCount: 1,
          tradeCountSource: "leg_local_fallback",
          continuationMode: "market_wide",
        }),
      });

      await mod.stop();
    });

    it("leg_local mode (default): provider is not consulted; suppression source=leg_local", async () => {
      const tokenId = "token-ll";
      const familyId = "fam-mw";
      legStateRepo = createMockLegStateRepo([legAtBuy1(tokenId)]);

      const controlDb = createContinuationControlDb({
        continuationMode: "leg_local",
        continuationModeVersion: 0,
      });
      const provider = createMockTradeCountProvider(6);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({
        controlDb: controlDb.db,
        tradeCountProvider: provider,
        riskEventRepo,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.05, SHARED_CONDITION_ID)],
        timestamp: Date.now(),
      });

      // Provider must not be consulted in leg_local mode.
      expect(provider.countCalls.length).toBe(0);
      expect(provider.prefetchCalls.length).toBe(0);
      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          reasonCode: "continuation-stop",
          tradeCount: 1,
          tradeCountSource: "leg_local",
          continuationMode: "leg_local",
        }),
      });

      await mod.stop();
    });

    it("hot-reload: bumping continuation_mode_version flips the active mode on the next tick", async () => {
      const tokenId = "token-hot-reload";
      const familyId = "fam-mw";
      legStateRepo = createMockLegStateRepo([legAtBuy1(tokenId)]);

      const controlDb = createContinuationControlDb({
        continuationMode: "leg_local",
        continuationModeVersion: 0,
      });
      const provider = createMockTradeCountProvider(6);

      const mod = buildModule({ controlDb: controlDb.db, tradeCountProvider: provider });
      await mod.start();

      // Tick 1 — leg_local: provider must not be consulted.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.15, SHARED_CONDITION_ID)],
        timestamp: Date.now(),
      });
      expect(provider.countCalls.length).toBe(0);
      expect(provider.prefetchCalls.length).toBe(0);

      // Operator flips the mode → version bumps to 1.
      controlDb.setMode("market_wide");

      // Tick 2 — refreshContinuationMode picks up v=1, switches to market_wide.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.15, SHARED_CONDITION_ID)],
        timestamp: Date.now(),
      });
      expect(provider.prefetchCalls.length + provider.countCalls.length).toBeGreaterThanOrEqual(1);

      await mod.stop();
    });

    it("prefetch: deduplicates conditionIds across legState tokens; skips tokens with no legState", async () => {
      const tokenA = "token-pre-a";
      const tokenB = "token-pre-b";
      const tokenC = "token-pre-c"; // no legState
      const familyId = "fam-mw";
      // Two open-leg tokens share one conditionId so the prefetch list dedupes to size 1.
      legStateRepo = createMockLegStateRepo([legAtBuy1(tokenA), legAtBuy1(tokenB)]);
      selectedMarketCache = createMockSelectedMarketCache([tokenC]);

      const controlDb = createContinuationControlDb({
        continuationMode: "market_wide",
        continuationModeVersion: 1,
      });
      const provider = createMockTradeCountProvider(2);

      const mod = buildModule({ controlDb: controlDb.db, tradeCountProvider: provider });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          makeMarket(tokenA, familyId, 0.15, SHARED_CONDITION_ID),
          makeMarket(tokenB, familyId, 0.15, SHARED_CONDITION_ID),
          makeMarket(tokenC, familyId, 0.15, "cond-no-leg"),
        ],
        timestamp: Date.now(),
      });

      expect(provider.prefetchCalls.length).toBe(1);
      expect(provider.prefetchCalls[0]!.conditionIds).toEqual([SHARED_CONDITION_ID]);
      expect(provider.prefetchCalls[0]!.cap).toBe(6);

      await mod.stop();
    });
  });

  it("REDEEM does not fire when holdDuration exceeds 3600s even if price<0.05 and state is S1/S2", async () => {
    const tokenId = "token-redeem-expired";
    const familyId = "fam-redeem-exp";
    const conditionId = "cond-redeem-exp";

    // legState = S1 (buyCount=1, lastAction=BUY), firstTradeAt = 2 hours ago (7200s > 3600s)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const legState: LegState = {
      tokenId: createTokenId(tokenId),
      buyCount: 1,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.1,
      firstTradeAt: twoHoursAgo,
      lastTradeAt: twoHoursAgo,
      updatedAt: twoHoursAgo,
    };
    legStateRepo = createMockLegStateRepo([legState]);

    const mod = buildModule();
    await mod.start();

    // price 0.03 < 0.05 satisfies price condition, but holdDuration ~7200s > 3600s → REDEEM must NOT fire
    const market = makeMarket(tokenId, familyId, 0.03, conditionId);
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
    expect(redeemCalls.length).toBe(0);

    await mod.stop();
  });

  describe("timeSinceLast computation", () => {
    /**
     * D1-like rule: S2 + timeSinceLast <= 60 → BUY. Drives assertions about
     * the (now - lastTradeAt) conversion into `timeSinceLastSeconds` inside
     * `evaluateToken` — without this computation, rules gated on that field
     * would silently skip.
     */
    const D1_LIKE_RULES: AlgoDecisionRule[] = [
      {
        id: 20,
        priority: 20,
        ruleId: "D1-LIKE",
        stateCondition: "S2",
        priceOperator: "<",
        priceValue: 0.05,
        timeSinceLastOperator: "<=",
        timeSinceLastSeconds: 60,
        buyCountMin: null,
        buyCountMax: null,
        holdDurationOperator: null,
        holdDurationSeconds: null,
        action: "BUY",
      },
      {
        id: 99,
        priority: 99,
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
      },
    ];

    function withRules(rules: AlgoDecisionRule[]): AlgoRulesRepository {
      return {
        getDecisionRules: vi.fn(() => rules),
        getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
          actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
        ),
      };
    }

    // firstTradePrice=0.10 keeps the continuation gate (R2: price>=0.05 && tradeCount>=2) passing
    // so timeSinceLast gating is exercised in isolation.
    function makeTimedLegState(tokenId: string, lastTradeAtMsAgo: number): LegState {
      const ts = new Date(Date.now() - lastTradeAtMsAgo).toISOString();
      return {
        tokenId: createTokenId(tokenId),
        buyCount: 2,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: ts,
        lastTradeAt: ts,
        updatedAt: ts,
      };
    }

    it("D1-LIKE fires when lastTradeAt is 30s ago (timeSinceLast ≈ 30 ≤ 60)", async () => {
      const tokenId = "token-tsl-30";
      legStateRepo = createMockLegStateRepo([makeTimedLegState(tokenId, 30_000)]);
      algoRulesRepo = withRules(D1_LIKE_RULES);
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, "fam-tsl", 0.03, "cond-tsl-30")],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D1-LIKE");

      await mod.stop();
    });

    it("D1-LIKE does NOT fire when lastTradeAt is 120s ago (timeSinceLast ≈ 120 > 60) — falls through to FALLBACK", async () => {
      const tokenId = "token-tsl-120";
      legStateRepo = createMockLegStateRepo([makeTimedLegState(tokenId, 120_000)]);
      algoRulesRepo = withRules(D1_LIKE_RULES);
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, "fam-tsl", 0.03, "cond-tsl-120")],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("FALLBACK");

      await mod.stop();
    });

    it("D1-LIKE fires exactly at the 60s boundary (inclusive <=)", async () => {
      const tokenId = "token-tsl-60";
      // 59_000ms ago → timeSinceLast = 59s ≤ 60s. Using 60_000 exactly would race against
      // the (now - lastTradeAt) read inside evaluateToken, which happens a few ms later.
      legStateRepo = createMockLegStateRepo([makeTimedLegState(tokenId, 59_000)]);
      algoRulesRepo = withRules(D1_LIKE_RULES);
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, "fam-tsl", 0.03, "cond-tsl-60")],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D1-LIKE");

      await mod.stop();
    });
  });

  describe("R37 D6 HOLD suppression", () => {
    const R37_RULES: AlgoDecisionRule[] = [
      {
        id: 10,
        priority: 10,
        ruleId: "D1",
        stateCondition: "S2",
        priceOperator: "<",
        priceValue: 0.05,
        timeSinceLastOperator: "<=",
        timeSinceLastSeconds: 60,
        buyCountMin: null,
        buyCountMax: null,
        holdDurationOperator: null,
        holdDurationSeconds: null,
        action: "BUY",
      },
      {
        id: 30,
        priority: 30,
        ruleId: "D3",
        stateCondition: "S1",
        priceOperator: "<",
        priceValue: 0.05,
        timeSinceLastOperator: null,
        timeSinceLastSeconds: null,
        buyCountMin: null,
        buyCountMax: null,
        holdDurationOperator: null,
        holdDurationSeconds: null,
        action: "BUY",
      },
      {
        id: 50,
        priority: 50,
        ruleId: "D4",
        stateCondition: "S2",
        priceOperator: ">=",
        priceValue: 0.2,
        timeSinceLastOperator: ">",
        timeSinceLastSeconds: 60,
        buyCountMin: null,
        buyCountMax: null,
        holdDurationOperator: null,
        holdDurationSeconds: null,
        action: "SELL",
      },
      {
        id: 70,
        priority: 70,
        ruleId: "D6",
        stateCondition: "S2",
        priceOperator: null,
        priceValue: null,
        timeSinceLastOperator: null,
        timeSinceLastSeconds: null,
        buyCountMin: 4,
        buyCountMax: null,
        holdDurationOperator: null,
        holdDurationSeconds: null,
        action: "HOLD",
      },
      {
        id: 80,
        priority: 80,
        ruleId: "D7",
        stateCondition: "S3",
        priceOperator: null,
        priceValue: null,
        timeSinceLastOperator: null,
        timeSinceLastSeconds: null,
        buyCountMin: null,
        buyCountMax: null,
        holdDurationOperator: null,
        holdDurationSeconds: null,
        action: "SELL",
      },
      {
        id: 999,
        priority: 999,
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
      },
    ];

    function withR37Rules(rules: AlgoDecisionRule[] = R37_RULES): AlgoRulesRepository {
      return {
        getDecisionRules: vi.fn(() => rules),
        getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
          actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
        ),
      };
    }

    function makeR37LegState(
      tokenId: string,
      args: Partial<Pick<LegState, "buyCount" | "sellCount" | "lastAction">> & {
        lastTradeAtMsAgo?: number;
      } = {},
    ): LegState {
      const lastTradeAt = new Date(Date.now() - (args.lastTradeAtMsAgo ?? 120_000)).toISOString();
      const firstTradeAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      return {
        tokenId: createTokenId(tokenId),
        buyCount: args.buyCount ?? 4,
        sellCount: args.sellCount ?? 0,
        lastAction: args.lastAction ?? "BUY",
        firstTradePrice: 0.1,
        firstTradeAt,
        lastTradeAt,
        updatedAt: lastTradeAt,
      };
    }

    async function emitOne(tokenId: string, price: number, riskEventRepo?: RiskEventRepository) {
      algoRulesRepo = withR37Rules();
      const mod = buildModule(riskEventRepo ? { riskEventRepo } : {});
      await mod.start();
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, "r37", price, `cond-${tokenId}`)],
        timestamp: Date.now(),
      });
      await mod.stop();
      return (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
    }

    it("D9 loss exit fires before canonical D6 HOLD when loss market is liquid", async () => {
      const tokenId = "token-d9-liquid-loss";
      algoRulesRepo = withR37Rules();
      legStateRepo = createMockLegStateRepo([
        {
          ...makeR37LegState(tokenId),
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 10,
        },
      ]);
      const mod = buildModule({
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          lossExit: {
            ...DEFAULT_EXECUTION_POLICY.lossExit,
            enabled: true,
            states: ["S1", "S2"],
            minPublicTradeCount24h: 41,
          },
        }),
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, "r37", 0.07, `cond-${tokenId}`),
            publicTradeCount24h: 100,
          },
        ],
        timestamp: Date.now(),
      });
      await mod.stop();

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(1);
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D9_LOSS_EXIT");
      expect(signalCalls[0]![1].signal.side).toBe("sell");
    });

    it("wires runtime profile-ladder ownership into D9 suppression", async () => {
      const tokenId = "token-d9-runtime-profile-owned";
      algoRulesRepo = withR37Rules();
      legStateRepo = createMockLegStateRepo([
        {
          ...makeR37LegState(tokenId),
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 10,
        },
      ]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const profileLadderOwnership = {
        isProfileLadderOwned: vi.fn().mockReturnValue(true),
      };
      const mod = buildModule({
        riskEventRepo,
        runtimeMetrics,
        profileLadderOwnership,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          lossExit: {
            ...DEFAULT_EXECUTION_POLICY.lossExit,
            enabled: true,
            states: ["S1", "S2"],
            minPublicTradeCount24h: 41,
          },
        }),
      } as any);
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, "r37", 0.07, `cond-${tokenId}`),
            publicTradeCount24h: 100,
          },
        ],
        timestamp: Date.now(),
      });
      await mod.stop();

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(0);
      expect(profileLadderOwnership.isProfileLadderOwned).toHaveBeenCalledWith(
        createTokenId(tokenId),
      );
      expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith("d9_suppressed_on_profile_owned", 1);
      expect(riskEventRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "d9_suppressed_on_profile_owned",
          payload: expect.objectContaining({ tokenId }),
        }),
      );
    });

    it("suppresses D9 loss exit below position avg entry and records guard telemetry", async () => {
      const tokenId = "token-d9-below-avg-guard";
      algoRulesRepo = withR37Rules();
      legStateRepo = createMockLegStateRepo([
        {
          ...makeR37LegState(tokenId, { buyCount: 1 }),
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 10,
        },
      ]);
      const position = makeOpenPosition(tokenId, {
        avgEntryPrice: 0.1,
        costBasisUsdc: 10,
        size: 100,
      });
      const positionRepo = {
        findOpen: vi.fn().mockReturnValue([position]),
        findByTokenId: vi.fn().mockReturnValue(position),
      };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const mod = buildModule({
        positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
        riskEventRepo,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          lossExit: {
            ...DEFAULT_EXECUTION_POLICY.lossExit,
            enabled: true,
            states: ["S1", "S2"],
            minPublicTradeCount24h: 41,
          },
        }),
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, "r37", 0.07, `cond-${tokenId}`),
            bestBid: 0.06,
            bestAsk: 0.08,
            publicTradeCount24h: 100,
          },
        ],
        timestamp: Date.now(),
      });
      await mod.stop();

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(0);
      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          tokenId,
          reasonCode: "d9_loss_exit_below_avg_entry_guard",
          decisionRuleId: "D9_LOSS_EXIT",
          side: "SELL",
          price: 0.06,
          avgEntryPrice: 0.1,
          proposedExitPrice: 0.06,
          exitToAvgEntryRatio: expect.closeTo(0.6, 8),
          originalD9Reason: "d9-loss-exit-fired",
          suppressionReason: "d9_loss_exit_below_avg_entry_guard",
          d9ProfitRatio: expect.closeTo(0.6, 8),
          d9AvgBuyPrice: 0.1,
          d9PublicTradeCount24h: 100,
        }),
      });
    });

    it("D9 loss exit falls through to D6 HOLD when public market is illiquid", async () => {
      const tokenId = "token-d9-illiquid-loss";
      algoRulesRepo = withR37Rules();
      legStateRepo = createMockLegStateRepo([
        {
          ...makeR37LegState(tokenId),
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 10,
        },
      ]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const mod = buildModule({
        riskEventRepo,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          lossExit: {
            ...DEFAULT_EXECUTION_POLICY.lossExit,
            enabled: true,
            states: ["S1", "S2"],
            minPublicTradeCount24h: 41,
          },
        }),
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, "r37", 0.07, `cond-${tokenId}`),
            publicTradeCount24h: 20,
          },
        ],
        timestamp: Date.now(),
      });
      await mod.stop();

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(0);
      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          reasonCode: "d6-suppressed",
          decisionRuleId: "D6",
        }),
      });
    });

    it("records H5_wide guard suppression before falling through to D6 HOLD", async () => {
      const tokenId = "token-d9-h5-guarded-loss";
      algoRulesRepo = withR37Rules();
      legStateRepo = createMockLegStateRepo([
        {
          ...makeR37LegState(tokenId),
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 10,
        },
      ]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const mod = buildModule({
        riskEventRepo,
        executionPolicy: () => ({
          ...DEFAULT_EXECUTION_POLICY,
          lossExit: {
            ...DEFAULT_EXECUTION_POLICY.lossExit,
            enabled: true,
            states: ["S1", "S2"],
            minPublicTradeCount24h: 41,
          },
        }),
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, "r37", 0.07, `cond-${tokenId}`),
            endDate: new Date(Date.now() + 100 * 86_400_000).toISOString(),
            publicTradeCount24h: 100,
          },
        ],
        timestamp: Date.now(),
      });
      await mod.stop();

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(0);
      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          reasonCode: "h5-wide-cohort-guard",
          decisionRuleId: "D9_LOSS_EXIT",
          side: "SELL",
          state: "S2",
          buyCount: 4,
          d9ProfitRatio: expect.any(Number),
          d9AvgBuyPrice: expect.any(Number),
          d9DaysToResolve: expect.any(Number),
          d9PublicTradeCount24h: 100,
        }),
      });
    });

    it("suppresses canonical D6: S2 + buyCount>=4 HOLD", async () => {
      const tokenId = "token-d6-suppressed";
      legStateRepo = createMockLegStateRepo([makeR37LegState(tokenId)]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const signalCalls = await emitOne(tokenId, 0.1, riskEventRepo);

      expect(signalCalls.length).toBe(0);
      expect(riskEventRepo.insert).toHaveBeenCalledWith({
        eventType: "signal_suppressed",
        payload: expect.objectContaining({
          reasonCode: "d6-suppressed",
          decisionRuleId: "D6",
          side: "BUY",
          state: "S2",
          buyCount: 4,
        }),
      });
    });

    it("allows D1 despite S2 + buyCount>=4", async () => {
      const tokenId = "token-d1-allowed";
      legStateRepo = createMockLegStateRepo([
        makeR37LegState(tokenId, { lastTradeAtMsAgo: 30_000 }),
      ]);

      const signalCalls = await emitOne(tokenId, 0.03);

      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D1");
    });

    it("suppresses D6 boundary when D1 time window is missed", async () => {
      const tokenId = "token-d1-window-missed";
      legStateRepo = createMockLegStateRepo([
        makeR37LegState(tokenId, { lastTradeAtMsAgo: 120_000 }),
      ]);

      const signalCalls = await emitOne(tokenId, 0.03);

      expect(signalCalls.length).toBe(0);
    });

    it("does not suppress D3 because state is S1", async () => {
      const tokenId = "token-d3-allowed";
      legStateRepo = createMockLegStateRepo([
        makeR37LegState(tokenId, { buyCount: 1, sellCount: 1, lastAction: "BUY" }),
      ]);

      const signalCalls = await emitOne(tokenId, 0.03);

      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D3");
    });

    it("does not suppress D4 SELL", async () => {
      const tokenId = "token-d4-allowed";
      legStateRepo = createMockLegStateRepo([makeR37LegState(tokenId)]);

      const signalCalls = await emitOne(tokenId, 0.25);

      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D4");
      expect(signalCalls[0]![1].signal.side).toBe("sell");
    });

    it("does not suppress D7 SELL", async () => {
      const tokenId = "token-d7-allowed";
      legStateRepo = createMockLegStateRepo([
        makeR37LegState(tokenId, { sellCount: 1, lastAction: "SELL" }),
      ]);

      const signalCalls = await emitOne(tokenId, 0.1);

      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D7");
      expect(signalCalls[0]![1].signal.side).toBe("sell");
    });
  });

  describe("hard-liveness gate for new entries", () => {
    it("skips SignalProduced when a new-entry market has acceptingOrders=false", async () => {
      const tokenId = "token-not-accepting";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      const market = { ...makeMarket(tokenId, null, 0.45), acceptingOrders: false };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);

      await mod.stop();
    });

    it("dedupes noisy signal_suppressed risk events within one suppression window", async () => {
      const tokenId = "token-not-accepting-dedupe";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      const market = { ...makeMarket(tokenId, null, 0.45), acceptingOrders: false };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const suppressedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) =>
            event.eventType === "signal_suppressed" &&
            event.payload.reasonCode === "market-not-live",
        );
      expect(suppressedCalls).toHaveLength(1);

      await mod.stop();
    });

    it("aggregates entry-sweep market-not-live suppressions across tokens", async () => {
      const tokenIds = ["token-not-live-1", "token-not-live-2", "token-not-live-3"];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.map((tokenId, idx) => ({
          ...makeMarket(tokenId, null, 0.1 + idx * 0.01, `cond-not-live-${idx}`),
          acceptingOrders: false,
          enableOrderBook: false,
        })),
        timestamp: Date.now(),
      });

      const suppressedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) =>
            event.eventType === "signal_suppressed" &&
            event.payload.reasonCode === "market-not-live",
        );
      expect(suppressedCalls).toHaveLength(1);

      await mod.stop();
    });

    it("keeps market-not-live suppressions per token for existing legs", async () => {
      const tokenIds = ["token-open-not-live-1", "token-open-not-live-2"];
      const nowIso = new Date(Date.now() - 60_000).toISOString();
      legStateRepo = createMockLegStateRepo(
        tokenIds.map((tokenId) => ({
          tokenId: createTokenId(tokenId),
          buyCount: 1,
          sellCount: 0,
          lastAction: "BUY",
          firstTradePrice: 0.1,
          firstTradeAt: nowIso,
          lastTradeAt: nowIso,
          updatedAt: nowIso,
        })),
      );
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.map((tokenId, idx) => ({
          ...makeMarket(tokenId, null, 0.1 + idx * 0.01, `cond-open-not-live-${idx}`),
          acceptingOrders: false,
          enableOrderBook: false,
        })),
        timestamp: Date.now(),
      });

      const suppressedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) =>
            event.eventType === "signal_suppressed" &&
            event.payload.reasonCode === "market-not-live",
        );
      expect(suppressedCalls).toHaveLength(2);

      await mod.stop();
    });

    it("reports liveness suppression counters and would-match rule mix in healthCheck", async () => {
      const tokenId = "token-liveness-metrics-d3";
      const nowIso = new Date(Date.now() - 60_000).toISOString();
      legStateRepo = createMockLegStateRepo([
        {
          tokenId: createTokenId(tokenId),
          buyCount: 1,
          sellCount: 0,
          lastAction: "BUY",
          firstTradePrice: 0.1,
          firstTradeAt: nowIso,
          lastTradeAt: nowIso,
          updatedAt: nowIso,
        },
      ]);
      algoRulesRepo = {
        getDecisionRules: vi.fn(() => [
          {
            id: 1,
            priority: 10,
            ruleId: "D3",
            stateCondition: "S1",
            priceOperator: "<",
            priceValue: 0.05,
            timeSinceLastOperator: null,
            timeSinceLastSeconds: null,
            buyCountMin: null,
            buyCountMax: null,
            holdDurationOperator: null,
            holdDurationSeconds: null,
            action: "BUY",
          },
          {
            id: 99,
            priority: 999,
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
          },
        ]),
        getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
          actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
        ),
      };

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, null, 0.03, "cond-liveness-metrics"),
            acceptingOrders: false,
            enableOrderBook: false,
          },
        ],
        timestamp: Date.now(),
      });

      const detail = (await mod.healthCheck()).detail ?? "";
      expect(detail).toContain("eval_total=1");
      expect(detail).toContain("suppressed_market_not_live=1");
      expect(detail).toContain("liveness_not_accepting_orders=1");
      expect(detail).toContain("liveness_order_book_disabled=1");
      expect(detail).toContain("liveness_both_flags=1");
      expect(detail).toContain("wouldMatchRule D3=1");

      await mod.stop();
    });

    it("publishes liveness evaluation counters to the metrics sink", async () => {
      const tokenId = "token-liveness-metrics-sink";
      const sink = vi.fn();
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const mod = buildModule({
        evalMetricsSink: sink,
        evalMetricsEmitIntervalMs: 0,
        priceHistoryProvider: {
          findReferencePrice: vi.fn(() => null),
          getWindowMaxCacheMetrics: vi.fn(() => ({
            invocations: 4,
            hits: 1,
            misses: 3,
            hitRate: 0.25,
            entries: 3,
            ttlMs: 60_000,
            maxEntries: 10_000,
          })),
        },
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, null, 0.03, "cond-liveness-metrics-sink"),
            acceptingOrders: false,
            enableOrderBook: false,
          },
        ],
        timestamp: Date.now(),
      });

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0]?.[0]).toMatchObject({
        evalTotal: 1,
        suppressedMarketNotLive: 1,
        livenessBothFlags: 1,
        r23Cache: {
          invocations: 4,
          hits: 1,
          misses: 3,
          hitRate: 0.25,
        },
      });
      expect(sink.mock.calls[0]?.[0].decisionTickLatency.p95Ms).toEqual(expect.any(Number));

      await mod.stop();
    });

    it("publishes zero evaluation heartbeat to the metrics sink", async () => {
      const sink = vi.fn();
      selectedMarketCache = createMockSelectedMarketCache([]);
      const mod = buildModule({ evalMetricsSink: sink, evalMetricsEmitIntervalMs: 0 });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [],
        timestamp: Date.now(),
      });

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0]?.[0]).toMatchObject({
        evalTotal: 0,
        emitted: 0,
        suppressedMarketNotLive: 0,
        wouldMatchRule: {},
      });

      await mod.stop();
    });

    // Regression: continuation-stop is sticky — a leg that fails R1/R2 fails
    // identically on every sweep tick, so without dedupe a handful of stuck
    // legs floods decision_signal_log/risk_events ~1/sec. The dedupe set must
    // include "continuation-stop" or the operator can no longer read the log.
    it("dedupes continuation-stop suppressions within one suppression window", async () => {
      const tokenId = "token-cont-dedupe";
      const familyId = "fam-cont-dedupe";
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 2,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice: 0.03, // below 0.05 → R2 fails, tradeCount<6 → R1 fails → STOP
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      const market = makeMarket(tokenId, familyId, 0.45);
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const suppressedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) =>
            event.eventType === "signal_suppressed" &&
            event.payload.reasonCode === "continuation-stop",
        );
      expect(suppressedCalls).toHaveLength(1);

      await mod.stop();
    });

    it("skips SignalProduced when a new-entry market has enableOrderBook=false", async () => {
      const tokenId = "token-book-off";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      const market = { ...makeMarket(tokenId, null, 0.45), enableOrderBook: false };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);

      await mod.stop();
    });

    // Guards the shared `isAlive` contract against a malformed NormalizedMarket:
    // normal market-data path keeps `midPrice` and `bestBid` in sync, but the
    // gate must still reject if that invariant breaks (e.g. a future pricing
    // fallback populates midPrice from lastTradePrice while bestBid is null).
    it("skips SignalProduced on inconsistent market with midPrice set but bestBid null", async () => {
      const tokenId = "token-no-bid";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      const market = { ...makeMarket(tokenId, null, 0.45), bestBid: null };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);

      await mod.stop();
    });

    it("suppresses legacy-REDEEM fallback BUY when market is unhealthy", async () => {
      const tokenId = "token-redeem-unhealthy";
      const conditionId = "cond-redeem-unhealthy";
      const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 2,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: twentyFiveMinAgo,
        lastTradeAt: twentyFiveMinAgo,
        updatedAt: twentyFiveMinAgo,
      };
      legStateRepo = createMockLegStateRepo([legState]);

      const mod = buildModule();
      await mod.start();

      // Unhealthy market (acceptingOrders=false) suppresses the CLOB fallback BUY.
      const market = {
        ...makeMarket(tokenId, null, 0.03, conditionId),
        acceptingOrders: false,
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(redeemCalls.length).toBe(0);
      expect(signalCalls.length).toBe(0);

      await mod.stop();
    });

    // CLOB signals (BUY scale-in / SELL exit) would be rejected by the bridge's
    // own `isAlive` check regardless of side, so suppress them upstream — no
    // point allocating signals that can't reach the exchange.
    it("suppresses CLOB SELL for open-position token when market acceptingOrders=false", async () => {
      const tokenId = "token-sell-suppressed";
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 5, // S1, tradeCount=6 → continuation passes
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);

      const mod = buildModule();
      await mod.start();

      // S1 + price 0.15 would normally match D7-SELL-S1, but acceptingOrders=false
      // means the bridge would reject the resulting SELL order — suppress here.
      const market = {
        ...makeMarket(tokenId, null, 0.15),
        acceptingOrders: false,
        tradable: false, // preserved-only branch (SELL-only)
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);

      await mod.stop();
    });
  });

  describe("wallet buy budget ownership", () => {
    it("does not apply wallet-budget gating before SignalProduced", async () => {
      const tokenId = "token-budget-owned-by-risk";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ decisionSignalLogRepo, riskEventRepo });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(1);
      expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
      const signalEmittedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.eventType === "signal_emitted");
      expect(signalEmittedCalls).toHaveLength(1);

      await mod.stop();
    });

    it("counts emitted-but-not-placed BUYs against same-sweep wallet budget", async () => {
      const tokenIds = ["token-budget-1", "token-budget-2", "token-budget-3"];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const canAttemptBuy = vi.fn((requiredNotionalUsdc: number) => ({
        canAttempt: requiredNotionalUsdc <= 2,
      }));

      const mod = buildModule({
        decisionSignalLogRepo,
        riskEventRepo,
        buySignalBudgetCircuitBreaker: { canAttemptBuy },
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.map((tokenId) => makeMarket(tokenId, null, 0.45)),
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(2);
      expect(signalCalls.every(([, payload]) => payload.signal.side === "buy")).toBe(true);
      expect(canAttemptBuy.mock.calls.map(([required]) => Number(required.toFixed(2)))).toEqual([
        0.99, 1.98, 2.97,
      ]);
      const suppressionCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.payload.reasonCode === "wallet_buy_budget_exhausted");
      expect(suppressionCalls).toHaveLength(1);

      await mod.stop();
    });

    it("passes same-sweep pending BUY count into the budget circuit breaker", async () => {
      const tokenIds = ["token-count-1", "token-count-2", "token-count-3"];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);
      const canAttemptBuy = vi.fn((_requiredNotionalUsdc, _signal, context) => ({
        canAttempt: (context?.pendingPreOpenBuyCount ?? 0) < 2,
        reasonCode: "wallet_buy_capacity_exhausted",
        activateCooldown: false,
      }));

      const mod = buildModule({
        buySignalBudgetCircuitBreaker: { canAttemptBuy },
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.map((tokenId) => makeMarket(tokenId, null, 0.45)),
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(2);
      expect(
        canAttemptBuy.mock.calls.map(([, , context]) => context?.pendingPreOpenBuyCount),
      ).toEqual([0, 1, 2]);

      await mod.stop();
    });

    it("suppresses BUY telemetry while the budget circuit breaker is exhausted", async () => {
      const tokenIds = ["token-budget-1", "token-budget-2", "token-budget-3"];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const canAttemptBuy = vi.fn(() => ({ canAttempt: false }));

      const mod = buildModule({
        decisionSignalLogRepo,
        riskEventRepo,
        buySignalBudgetCircuitBreaker: { canAttemptBuy },
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.map((tokenId) => makeMarket(tokenId, null, 0.45)),
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      const signalEmittedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.eventType === "signal_emitted");
      const suppressionCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.payload.reasonCode === "wallet_buy_budget_exhausted");

      expect(signalCalls).toHaveLength(0);
      expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();
      expect(signalEmittedCalls).toHaveLength(0);
      expect(suppressionCalls).toHaveLength(1);
      expect(canAttemptBuy).toHaveBeenCalledTimes(1);

      await mod.stop();
    });

    it("records capacity-specific reason when decision preflight blocks BUY capacity", async () => {
      const tokenId = "token-capacity-preflight";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const canAttemptBuy = vi.fn(() => ({
        canAttempt: false,
        reasonCode: "wallet_buy_capacity_exhausted",
      }));

      const mod = buildModule({
        decisionSignalLogRepo,
        riskEventRepo,
        buySignalBudgetCircuitBreaker: { canAttemptBuy },
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      const suppressionCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) => event.payload.reasonCode === "wallet_buy_capacity_exhausted",
        );

      expect(signalCalls).toHaveLength(0);
      expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();
      expect(suppressionCalls).toHaveLength(1);
      expect(canAttemptBuy).toHaveBeenCalledTimes(1);

      await mod.stop();
    });

    it("does not globally cooldown BUYs for token-local capacity preflight blocks", async () => {
      const tokenIds = [
        "token-local-capacity-blocked",
        "token-local-capacity-allowed-1",
        "token-local-capacity-allowed-2",
      ];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const canAttemptBuy = vi
        .fn()
        .mockReturnValueOnce({
          canAttempt: false,
          reasonCode: "per_token_buy_limit",
          activateCooldown: false,
        })
        .mockReturnValue({ canAttempt: true });

      const mod = buildModule({
        decisionSignalLogRepo,
        riskEventRepo,
        buySignalBudgetCircuitBreaker: { canAttemptBuy },
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.map((tokenId) => makeMarket(tokenId, null, 0.45)),
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      const suppressionCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.payload.reasonCode === "per_token_buy_limit");

      expect(canAttemptBuy).toHaveBeenCalledTimes(3);
      expect(signalCalls).toHaveLength(2);
      expect(suppressionCalls).toHaveLength(0);

      await mod.stop();
    });

    it("keeps BUY emission suppressed until the budget cooldown expires", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));

      const tokenId = "token-budget-recovered";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      let budgetAvailable = false;
      const canAttemptBuy = vi.fn(() => ({ canAttempt: budgetAvailable }));

      const mod = buildModule({
        decisionSignalLogRepo,
        buySignalBudgetCircuitBreaker: { canAttemptBuy },
        buySignalBudgetCooldownMs: 5,
      });
      await mod.start();

      try {
        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [makeMarket(tokenId, null, 0.45)],
          timestamp: Date.now(),
        });
        expect(
          (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
            ([ev]) => ev === "SignalProduced",
          ),
        ).toHaveLength(0);

        budgetAvailable = true;
        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [makeMarket(tokenId, null, 0.45)],
          timestamp: Date.now(),
        });

        expect(
          (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
            ([ev]) => ev === "SignalProduced",
          ),
        ).toHaveLength(0);
        expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();

        vi.setSystemTime(Date.now() + 10);
        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [makeMarket(tokenId, null, 0.45)],
          timestamp: Date.now(),
        });

        const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([ev]) => ev === "SignalProduced",
        );
        expect(signalCalls).toHaveLength(1);
        expect(signalCalls[0]![1].signal.side).toBe("buy");
        expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
        expect(canAttemptBuy).toHaveBeenCalledTimes(2);
      } finally {
        await mod.stop();
        vi.useRealTimers();
      }
    });

    it("does not clear cooldown early just because stale cancels free some budget", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));

      const expensiveTokenId = "token-budget-expensive";
      const cheapTokenId = "token-budget-cheap";
      selectedMarketCache = createMockSelectedMarketCache([expensiveTokenId, cheapTokenId]);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      let freeBudgetUsdc = 1.5;
      const canAttemptBuy = vi.fn((requiredNotionalUsdc: number) => ({
        canAttempt: freeBudgetUsdc >= requiredNotionalUsdc,
      }));
      const buySizeRules: AlgoSizeRule[] = [
        {
          id: 101,
          actionType: "BUY",
          priority: 1,
          ruleId: "B1",
          stateCondition: "OTHER",
          priceOperator: ">=",
          priceValue: 0.2,
          nthBuy: null,
          buyCountMin: null,
          buyCountMax: null,
          sizeUsdc: 8.41,
        },
        ...SEED_SIZE_RULES_BUY,
      ];
      algoRulesRepo = {
        getDecisionRules: vi.fn(() => SEED_DECISION_RULES),
        getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
          actionType === "BUY" ? buySizeRules : SEED_SIZE_RULES_SELL,
        ),
      };

      const mod = buildModule({
        decisionSignalLogRepo,
        riskEventRepo,
        buySignalBudgetCircuitBreaker: { canAttemptBuy },
        buySignalBudgetCooldownMs: 5,
      });
      await mod.start();

      try {
        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [makeMarket(expensiveTokenId, null, 0.45), makeMarket(cheapTokenId, null, 0.12)],
          timestamp: Date.now(),
        });
        expect(
          (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
            ([ev]) => ev === "SignalProduced",
          ),
        ).toHaveLength(0);
        expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();
        expect(canAttemptBuy.mock.calls.map(([required]) => required)).toEqual([8.41]);

        canAttemptBuy.mockClear();
        (bus.publish as ReturnType<typeof vi.fn>).mockClear();
        freeBudgetUsdc = 2;
        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [makeMarket(cheapTokenId, null, 0.12)],
          timestamp: Date.now(),
        });
        expect(
          (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
            ([ev]) => ev === "SignalProduced",
          ),
        ).toHaveLength(0);
        expect(canAttemptBuy).not.toHaveBeenCalled();

        canAttemptBuy.mockClear();
        (bus.publish as ReturnType<typeof vi.fn>).mockClear();
        freeBudgetUsdc = 9;
        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [makeMarket(cheapTokenId, null, 0.12)],
          timestamp: Date.now(),
        });

        const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([ev]) => ev === "SignalProduced",
        );
        expect(signalCalls).toHaveLength(0);
        expect(canAttemptBuy).not.toHaveBeenCalled();
        expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();

        vi.setSystemTime(Date.now() + 10);
        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [makeMarket(cheapTokenId, null, 0.12)],
          timestamp: Date.now(),
        });

        const postExpirySignalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([ev]) => ev === "SignalProduced",
        );
        expect(postExpirySignalCalls).toHaveLength(1);
        expect(postExpirySignalCalls[0]![1].signal.suggestedSizeUsdc).toBeCloseTo(0.99, 5);
        expect(canAttemptBuy.mock.calls.map(([required]) => required)).toEqual([0.99]);
        expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
        const suppressionCalls = vi
          .mocked(riskEventRepo.insert)
          .mock.calls.filter(
            ([event]) => event.payload.reasonCode === "wallet_buy_budget_exhausted",
          );
        expect(suppressionCalls).toHaveLength(1);
      } finally {
        await mod.stop();
        vi.useRealTimers();
      }
    });

    it("stops same-sweep BUY publishing after wallet-budget risk rejection", async () => {
      const tokenIds = [
        "token-budget-publish-1",
        "token-budget-publish-2",
        "token-budget-publish-3",
      ];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      let walletExhausted = false;

      const mod = buildModule({
        decisionSignalLogRepo,
        buySignalBudgetCircuitBreaker: {
          canAttemptBuy: vi.fn(() => ({ canAttempt: !walletExhausted })),
        },
        buySignalBudgetCooldownMs: 60 * 60 * 1000,
      });
      await mod.start();

      let emittedRejection = false;
      bus.subscribe("SignalProduced", async (payload) => {
        if (emittedRejection) return;
        emittedRejection = true;
        walletExhausted = true;
        await (bus as any).emit("SignalRejected", {
          signal: payload.signal,
          reason: "wallet_buy_budget_exhausted",
          rejectedAt: Date.now(),
        });
      });

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.map((tokenId) => makeMarket(tokenId, null, 0.45)),
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(1);
      expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);

      await mod.stop();
    });

    it("does not commit or publish a BUY if pause lands during in-flight evaluation", async () => {
      const tokenId = "token-budget-pause-mid-flight";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      let paused = false;

      const mod = buildModule({
        decisionSignalLogRepo,
        runtimeControl: { isPaused: () => paused },
        buySignalBudgetCircuitBreaker: {
          canAttemptBuy: () => {
            paused = true;
            return { canAttempt: true };
          },
        },
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(0);
      expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();

      await mod.stop();
    });

    it("keeps first-BUY pending dedupe after emitted non-budget risk rejections", async () => {
      const tokenIds = ["token-budget-a", "token-budget-b", "token-budget-c"];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.slice(0, 2).map((tokenId) => makeMarket(tokenId, null, 0.45)),
        timestamp: Date.now(),
      });
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenIds[0]!, null, 0.45), makeMarket(tokenIds[2]!, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(3);
      expect(signalCalls.map(([, payload]) => String(payload.signal.tokenId))).toEqual([
        tokenIds[0],
        tokenIds[1],
        tokenIds[2],
      ]);

      await mod.stop();
    });

    it("does not block SELL signals in the decision layer", async () => {
      const tokenId = "token-budget-sell";
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 1,
        sellCount: 5,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [{ ...makeMarket(tokenId, null, 0.15), tradable: false }],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(1);
      expect(signalCalls[0]![1].signal.side).toBe("sell");

      await mod.stop();
    });

    it("does not block SELL signals while the BUY budget circuit breaker is active", async () => {
      const buyTokenId = "token-budget-empty";
      const sellTokenId = "token-budget-sell-active";
      const legState: LegState = {
        tokenId: createTokenId(sellTokenId),
        buyCount: 1,
        sellCount: 5,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: new Date(Date.now() - 60_000).toISOString(),
        lastTradeAt: new Date(Date.now() - 60_000).toISOString(),
        updatedAt: new Date().toISOString(),
      };
      legStateRepo = createMockLegStateRepo([legState]);
      selectedMarketCache = createMockSelectedMarketCache([buyTokenId]);

      const mod = buildModule({
        buySignalBudgetCircuitBreaker: { canAttemptBuy: () => ({ canAttempt: false }) },
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          makeMarket(buyTokenId, null, 0.45),
          { ...makeMarket(sellTokenId, null, 0.15), tradable: false },
        ],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(1);
      expect(signalCalls[0]![1].signal.side).toBe("sell");

      await mod.stop();
    });

    it("clears a signal-time reservation when non-budget risk rejects the signal", async () => {
      const tokenId = "token-wallet-retry";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const firstSignal = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        ([ev]) => ev === "SignalProduced",
      )?.[1].signal as import("@krabs/domain").Signal;
      expect(firstSignal).toBeDefined();

      await (bus as any).emit("SignalRejected", {
        signal: firstSignal,
        reason: "non_budget_wallet_buy_budget_exhausted_substring",
        rejectedAt: Date.now(),
      });
      (bus.publish as ReturnType<typeof vi.fn>).mockClear();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(1);

      await mod.stop();
    });

    it("holds BUY emissions after a wallet-budget risk rejection until recovery or expiry", async () => {
      const tokenId = "token-wallet-budget-cooldown";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };

      const mod = buildModule({
        decisionSignalLogRepo,
        buySignalBudgetCooldownMs: 60 * 60 * 1000,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const firstSignal = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        ([ev]) => ev === "SignalProduced",
      )?.[1].signal as import("@krabs/domain").Signal;
      expect(firstSignal).toBeDefined();

      await (bus as any).emit("SignalRejected", {
        signal: firstSignal,
        reason: "wallet_buy_budget_exhausted",
        rejectedAt: Date.now(),
      });
      (bus.publish as ReturnType<typeof vi.fn>).mockClear();
      vi.mocked(decisionSignalLogRepo.insert).mockClear();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls).toHaveLength(0);
      expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();

      await mod.stop();
    });

    it("clears a signal-time reservation when execution rejects the converted order", async () => {
      const tokenId = "token-wallet-order-reject";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const firstSignal = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        ([ev]) => ev === "SignalProduced",
      )?.[1].signal as import("@krabs/domain").Signal;
      expect(firstSignal).toBeDefined();

      await (bus as any).emit("PlaceOrderRequested", {
        command: {
          type: "PlaceOrderCommand",
          commandId: createCommandId("cmd-wallet-order-reject"),
          clientOrderId: "plk_wallet_order_reject" as any,
          source: "strategy",
          tokenId: createTokenId(tokenId),
          conditionId: "cond-1" as ConditionId,
          side: "buy",
          size: firstSignal.suggestedSize,
          price: firstSignal.suggestedPrice,
          orderType: "GTC",
          tickSize: 0.01,
          negRisk: false,
          gammaCreatedAt: null,
          sequenceInTick: 0,
          signalReason: firstSignal.reason,
        },
        timestamp: Date.now(),
      });
      await (bus as any).emit("OrderRejected", {
        commandId: createCommandId("cmd-wallet-order-reject"),
        clientOrderId: "plk_wallet_order_reject" as any,
        tokenId: createTokenId(tokenId),
        conditionId: "cond-1" as ConditionId,
        reason: "reserved-usdc-limit",
        errorCode: "INSUFFICIENT_BALANCE",
        signalReason: firstSignal.reason,
        timestamp: Date.now(),
      });
      (bus.publish as ReturnType<typeof vi.fn>).mockClear();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(1);

      await mod.stop();
    });
  });

  it("emits Fallback BUY signal with suggestedSizeUsdc=2.10 for OTHER-state token", async () => {
    const tokenId = "token-other-state";
    const familyId = "fam-other";

    // No LegState for this token — it is in the initial OTHER state (brand new)
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule();
    await mod.start();

    // Mid-range price 0.12: does not match any S1/S2/S3 rule, falls through to FALLBACK BUY
    const market = makeMarket(tokenId, familyId, 0.12);
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    expect(signalCalls.length).toBe(1);
    const signal = signalCalls[0]![1].signal as import("@krabs/domain").Signal;
    expect(signal.side).toBe("buy");
    expect(signal.decisionRuleId).toBe("FALLBACK");
    // B5 size rule: nth_buy=1 (first purchase) → 2.10 USDC
    expect(signal.suggestedSizeUsdc).toBeCloseTo(0.99, 5);

    await mod.stop();
  });

  it("evicts marketCache entries when TrackedMarketsChanged removes tokens", async () => {
    const keptToken = "token-kept";
    const droppedToken = "token-dropped";
    selectedMarketCache = createMockSelectedMarketCache([keptToken, droppedToken]);

    const mod = buildModule();
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(keptToken, null, 0.45), makeMarket(droppedToken, null, 0.45)],
      timestamp: Date.now(),
    });

    expect((await mod.healthCheck()).detail).toContain("markets=2");

    await (bus as any).emit("TrackedMarketsChanged", {
      addedTokenIds: [],
      removedTokenIds: [createTokenId(droppedToken)],
      activeTokenIds: [createTokenId(keptToken)],
      timestamp: Date.now(),
    });

    expect((await mod.healthCheck()).detail).toContain("markets=1");

    await mod.stop();
  });

  // Step 0 §P3 — min-age gate (spec §1.7 R1, `06:423`).
  // Gate fires only on the legState==null branch; SELL / REDEEM / continuation
  // must be unaffected.
  describe("min-age gate", () => {
    function makePolicy(entryMinMarketAgeSeconds: number) {
      return () => ({
        ...DEFAULT_EXECUTION_POLICY,
        version: 1 as const,
        entryPriceCeiling: 0.99,
        exitOrderTtlMs: 60_000,
        entryMinMarketAgeSeconds,
        marketSelection: { maxMidPrice: 0.5, minLiquidity: 100 },
        deadSideGuard: { mode: "off" as const, askCeiling: 0.2, maxTimeToEndMs: 0 },
        pricing: {
          mode: "edge" as const,
          maxEntrySpreadTicks: 100,
          maxExitSpreadTicks: 100,
          maxImprovementTicks: 0,
          minExitPriceSignalRatio: 0.5,
          wideSpreadPolicy: "edge" as const,
          oneSidedPolicy: "edge" as const,
        },
        telemetry: { deadSideCanary: false, pricingShadow: false },
      });
    }

    it("suppresses BUY with reason market_too_young when gammaCreatedAt is 10 min ago and threshold=2504", async () => {
      const tokenId = "token-too-young";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({
        riskEventRepo,
        executionPolicy: makePolicy(2_504),
      });
      await mod.start();

      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const market: NormalizedMarket = {
        ...makeMarket(tokenId, null, 0.45),
        gammaCreatedAt: tenMinutesAgo,
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);

      const suppressedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) =>
            event.eventType === "signal_suppressed" &&
            event.payload.reasonCode === "market_too_young",
        );
      expect(suppressedCalls).toHaveLength(1);

      await mod.stop();
    });

    it("suppresses with market_age_unknown when gammaCreatedAt is null and threshold>0", async () => {
      const tokenId = "token-age-unknown";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({
        riskEventRepo,
        executionPolicy: makePolicy(2_504),
      });
      await mod.start();

      const market: NormalizedMarket = {
        ...makeMarket(tokenId, null, 0.45),
        gammaCreatedAt: null,
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);

      const suppressedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) =>
            event.eventType === "signal_suppressed" &&
            event.payload.reasonCode === "market_age_unknown",
        );
      expect(suppressedCalls).toHaveLength(1);

      await mod.stop();
    });

    it("threshold=0 fully bypasses the gate even with null gammaCreatedAt", async () => {
      const tokenId = "token-bypass";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule({ executionPolicy: makePolicy(0) });
      await mod.start();

      const market: NormalizedMarket = {
        ...makeMarket(tokenId, null, 0.45),
        gammaCreatedAt: null,
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(1);

      await mod.stop();
    });

    it("does NOT gate existing-leg fallback BUY even when gammaCreatedAt is too young", async () => {
      const tokenId = "token-sell-not-gated";
      const conditionId = "cond-sell-not-gated";
      const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 2,
        sellCount: 0,
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: twentyFiveMinAgo,
        lastTradeAt: twentyFiveMinAgo,
        updatedAt: twentyFiveMinAgo,
      };
      legStateRepo = createMockLegStateRepo([legState]);

      const mod = buildModule({ executionPolicy: makePolicy(2_504) });
      await mod.start();

      const market: NormalizedMarket = {
        ...makeMarket(tokenId, null, 0.03, conditionId),
        // Recent createdAt would gate a fresh BUY, but this token has an existing leg.
        gammaCreatedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(redeemCalls.length).toBe(0);
      expect(signalCalls.length).toBe(1);

      await mod.stop();
    });

    it("dedupes market_too_young suppressions within one window", async () => {
      const tokenId = "token-too-young-dedupe";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({
        riskEventRepo,
        executionPolicy: makePolicy(2_504),
      });
      await mod.start();

      const tooYoung: NormalizedMarket = {
        ...makeMarket(tokenId, null, 0.45),
        gammaCreatedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [tooYoung],
        timestamp: Date.now(),
      });
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [tooYoung],
        timestamp: Date.now(),
      });

      const suppressedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) =>
            event.eventType === "signal_suppressed" &&
            event.payload.reasonCode === "market_too_young",
        );
      expect(suppressedCalls).toHaveLength(1);

      await mod.stop();
    });
  });

  // ADR-022 §D-F — F-telemetry on signal_emitted + healthCheck triggerMix
  describe("ADR-022 F-telemetry", () => {
    it("emits dropFromLastSeen=null and entryPriceBucket on first observation", async () => {
      const tokenId = "token-fresh";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      // Single observation → no prior midPrice → dropFromLastSeen must be null.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const emitted = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.find(([event]) => event.eventType === "signal_emitted");
      expect(emitted).toBeDefined();
      expect(emitted![0].payload.dropFromLastSeen).toBeNull();
      // 0.45 > 0.20 → ">0.20" bucket per R24 §9.6.
      expect(emitted![0].payload.entryPriceBucket).toBe(">0.20");

      await mod.stop();
    });

    it("computes dropFromLastSeen against the previous NormalizedMarketUpdated", async () => {
      const tokenId = "token-drop";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      // First update at 0.40 — emits a signal_emitted with dropFromLastSeen=null
      // (no prior). The first BUY parks `pendingEntries[tokenId]` so the
      // second update would be suppressed with `pending-buy-order` unless we
      // simulate the in-flight signal failing — emit `SignalRejected` with the
      // captured signal to mirror what the bridge does on rejection.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.4)],
        timestamp: Date.now(),
      });
      const firstSignal = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        ([ev]) => ev === "SignalProduced",
      )?.[1] as { signal: import("@krabs/domain").Signal; market: NormalizedMarket };
      expect(firstSignal).toBeDefined();
      await (bus as any).emit("SignalRejected", {
        signal: firstSignal.signal,
        market: firstSignal.market,
        reason: "test-clear-pending",
        rejectedAt: Date.now(),
      });

      // Second update at 0.30 should yield (0.30-0.40)/0.40 = -0.25.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.3)],
        timestamp: Date.now(),
      });

      const emittedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.eventType === "signal_emitted");
      expect(emittedCalls.length).toBeGreaterThanOrEqual(2);
      const latest = emittedCalls.at(-1)!;
      expect(latest[0].payload.price).toBeCloseTo(0.3, 6);
      expect(latest[0].payload.dropFromLastSeen as number).toBeCloseTo(-0.25, 6);
      expect(latest[0].payload.entryPriceBucket).toBe(">0.20");

      await mod.stop();
    });

    it("resets dropFromLastSeen across a null-midPrice gap", async () => {
      // ADR-022 §D-F: prevMidPrice references the IMMEDIATELY previous update.
      // A null-mid update clears the slot, so the next non-null observation
      // must report dropFromLastSeen=null (not delta-from-pre-gap).
      const tokenId = "token-null-gap";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.4)],
        timestamp: Date.now(),
      });
      const firstSignal = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        ([ev]) => ev === "SignalProduced",
      )?.[1] as { signal: import("@krabs/domain").Signal; market: NormalizedMarket };
      expect(firstSignal).toBeDefined();
      await (bus as any).emit("SignalRejected", {
        signal: firstSignal.signal,
        market: firstSignal.market,
        reason: "test-clear-pending",
        rejectedAt: Date.now(),
      });

      // Null-mid update wipes prevMidPrices for this token.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, null)],
        timestamp: Date.now(),
      });

      vi.mocked(riskEventRepo.insert).mockClear();

      // Next non-null observation must see dropFromLastSeen=null.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.3)],
        timestamp: Date.now(),
      });

      const emitted = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.find(([event]) => event.eventType === "signal_emitted");
      expect(emitted).toBeDefined();
      expect(emitted![0].payload.dropFromLastSeen).toBeNull();

      await mod.stop();
    });

    it.each<[number, "<=0.005" | "0.005-0.05" | "0.05-0.20" | ">0.20"]>([
      [0.003, "<=0.005"],
      [0.005, "<=0.005"],
      [0.04, "0.005-0.05"],
      [0.05, "0.005-0.05"],
      [0.15, "0.05-0.20"],
      [0.2, "0.05-0.20"],
      [0.3, ">0.20"],
    ])("classifies entryPriceBucket for price=%f → %s", async (price, expected) => {
      const tokenId = `token-bucket-${price}`;
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, price)],
        timestamp: Date.now(),
      });

      const emitted = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.find(([event]) => event.eventType === "signal_emitted");
      expect(emitted).toBeDefined();
      expect(emitted![0].payload.entryPriceBucket).toBe(expected);

      await mod.stop();
    });

    it("includes triggerMix segment in healthCheck after signals are emitted", async () => {
      const tokenId = "token-mix";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);

      const mod = buildModule();
      await mod.start();

      // Pre-emission: triggerMix segment is suppressed (empty histogram).
      const before = await mod.healthCheck();
      expect(before.detail).not.toContain("triggerMix");

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      // ADR-022 §D-F — the histogram is promoted into `lastTickRuleMix` at
      // the END of the sweep, so healthcheck immediately after one emission
      // already reports the triggerMix segment.
      const after = await mod.healthCheck();
      expect(after.detail).toContain("triggerMix");
      expect(after.detail).toContain("FALLBACK=1");

      await mod.stop();
    });

    it("clears prevMidPrices when token leaves the tracked universe", async () => {
      const tokenId = "token-evict";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({ riskEventRepo });
      await mod.start();

      // Seed first observation to populate prevMidPrices.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.4)],
        timestamp: Date.now(),
      });

      // First BUY parks pendingEntries — clear it so the next update isn't suppressed.
      const firstSignal = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.find(
        ([ev]) => ev === "SignalProduced",
      )?.[1] as { signal: import("@krabs/domain").Signal; market: NormalizedMarket };
      expect(firstSignal).toBeDefined();
      await (bus as any).emit("SignalRejected", {
        signal: firstSignal.signal,
        market: firstSignal.market,
        reason: "test-clear-pending",
        rejectedAt: Date.now(),
      });

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.3)],
        timestamp: Date.now(),
      });

      // Clear pendingEntries again before eviction.
      const secondSignal = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
        .filter(([ev]) => ev === "SignalProduced")
        .at(-1)?.[1] as { signal: import("@krabs/domain").Signal; market: NormalizedMarket };
      expect(secondSignal).toBeDefined();
      await (bus as any).emit("SignalRejected", {
        signal: secondSignal.signal,
        market: secondSignal.market,
        reason: "test-clear-pending",
        rejectedAt: Date.now(),
      });

      // Evict via TrackedMarketsChanged; subsequent re-add should observe
      // dropFromLastSeen=null again (history wiped, not (0.45-0.30)/0.30).
      await (bus as any).emit("TrackedMarketsChanged", {
        addedTokenIds: [],
        removedTokenIds: [createTokenId(tokenId)],
        timestamp: Date.now(),
      });
      vi.mocked(riskEventRepo.insert).mockClear();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const emitted = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.find(([event]) => event.eventType === "signal_emitted");
      expect(emitted).toBeDefined();
      expect(emitted![0].payload.dropFromLastSeen).toBeNull();

      await mod.stop();
    });
  });

  // v063 — production dedup of the `risk_events.signal_emitted` JSON mirror.
  // The structured `decision_signal_log` row keeps flowing; only the legacy
  // telemetry payload is suppressed unless a caller opts back in.
  describe("v063 signal_emitted dedup", () => {
    it("does not write risk_events.signal_emitted when persistSignalEmittedTelemetry is false (prod default)", async () => {
      const tokenId = "token-dedup-off";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };

      const mod = buildModule({
        riskEventRepo,
        decisionSignalLogRepo,
        persistSignalEmittedTelemetry: false,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.4)],
        timestamp: Date.now(),
      });

      const emittedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.eventType === "signal_emitted");
      expect(emittedCalls).toHaveLength(0);
      // The structured row must still land — that's the surviving observation
      // surface for downstream analytics.
      expect(decisionSignalLogRepo.insert).toHaveBeenCalled();

      await mod.stop();
    });
  });

  // Surgical fix for the russia-ticker busy-loop (see
  // research_plankton/krabs_russia_ticker_rate_investigation_2026-05-24.md):
  // a frozen-price dust leg bounced inputs-unchanged conversion skips back
  // through self-triggered dirty evaluation. Inputs-unchanged skips now wait
  // for real input changes or the full sweep; inputs-changeable skips keep the
  // immediate re-eval.
  describe("SignalConversionSkipped re-trigger throttling", () => {
    function makeSkipSignal(tokenId: string): import("@krabs/domain").Signal {
      return {
        signalId: `sig-${tokenId}`,
        tokenId: createTokenId(tokenId),
        conditionId: "cond-1" as ConditionId,
        side: "sell",
        suggestedPrice: 0.32,
        suggestedSize: 22,
        suggestedSizeUsdc: 7,
        reason: "reduce-only",
        strategyTick: Date.now(),
        sequenceInTick: 0,
        decisionRuleId: "D5",
        sizingRuleId: "FALLBACK-SELL",
        generatedAt: new Date().toISOString(),
      };
    }

    function emitSkip(tokenId: string, reasons: string[]) {
      return (bus as any).emit("SignalConversionSkipped", {
        type: "SignalConversionSkipped",
        signal: makeSkipSignal(tokenId),
        stage: "execution-terms",
        reasons,
        diagnostics: {},
        skippedAt: Date.now(),
      });
    }

    it("does not self-trigger re-evaluation for an inputs-unchanged skip", async () => {
      const tokenId = "token-cooldown-skip";
      const mod = buildModule();
      await mod.start();
      const spy = vi.spyOn(
        mod as unknown as { scheduleDirtyEvaluation: (n?: number) => void },
        "scheduleDirtyEvaluation",
      );

      await emitSkip(tokenId, ["same-price-cooldown"]);

      expect(spy).not.toHaveBeenCalled();
      await mod.stop();
    });

    it("does not self-trigger re-evaluation for a sticky taker margin skip", async () => {
      const tokenId = "token-taker-margin-skip";
      const mod = buildModule();
      await mod.start();
      const spy = vi.spyOn(
        mod as unknown as { scheduleDirtyEvaluation: (n?: number) => void },
        "scheduleDirtyEvaluation",
      );

      await emitSkip(tokenId, ["taker-below-margin"]);

      expect(spy).not.toHaveBeenCalled();
      await mod.stop();
    });

    it("keeps the immediate (0 ms) re-eval for an inputs-changeable skip (budget-exhausted)", async () => {
      const tokenId = "token-budget-skip";
      const mod = buildModule();
      await mod.start();
      const spy = vi.spyOn(
        mod as unknown as { scheduleDirtyEvaluation: (n?: number) => void },
        "scheduleDirtyEvaluation",
      );

      await emitSkip(tokenId, ["budget-exhausted"]);

      expect(spy).toHaveBeenCalledWith(0);
      await mod.stop();
    });

    // Faithful closed-loop reproduction: every produced SELL bounces back as a
    // same-price-cooldown skip (as RiskInventory does on a frozen tick). With
    // the 250 ms debounce the loop is capped at ~4 re-evals/sec; the pre-fix
    // 0 ms path emitted ~220/sec (and would blow vitest's timer-recursion cap).
    it("caps a stuck same-price-cooldown leg to <10 re-evals per virtual second", async () => {
      vi.useFakeTimers();
      try {
        const tokenId = "token-stuck-dust";
        selectedMarketCache = createMockSelectedMarketCache([tokenId]);
        legStateRepo = createMockLegStateRepo([
          makeSellReadyLegState(tokenId, { cumulativeBuySize: 22, cumulativeSellSize: 0 }),
        ]);
        const mod = buildModule();
        await mod.start();

        let emitted = 0;
        (bus as any).subscribe(
          "SignalProduced",
          async (p: { signal: import("@krabs/domain").Signal }) => {
            emitted += 1;
            await (bus as any).emit("SignalConversionSkipped", {
              type: "SignalConversionSkipped",
              signal: p.signal,
              stage: "execution-terms",
              reasons: ["same-price-cooldown"],
              diagnostics: {},
              skippedAt: Date.now(),
            });
          },
        );

        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [makeMarket(tokenId, null, 0.65)],
          timestamp: Date.now(),
        });

        await vi.advanceTimersByTimeAsync(1000);

        expect(emitted).toBeGreaterThan(0);
        expect(emitted).toBeLessThan(10);
        await mod.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ─── Track Q shadow telemetry ────────────────────────────────────────────
  // Observe-only: the planner emits a `track_q_shadow` side effect for
  // SELL-eligible legs on wide books (the population classified live
  // spread suppression can block before the execution-layer EPO shard sees it).
  // The module must surface it as a deduped,
  // structured risk event + cumulative healthCheck counters WITHOUT changing
  // the suppressed SELL. See research_plankton/track_q_shadow_design_2026-06-11.md.
  describe("Track Q shadow telemetry", () => {
    it("emits a structured track_q_shadow risk event on a wide SELL book without changing the suppressed SELL", async () => {
      const tokenId = "token-trackq-wide";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      // S1 leg (buyCount=1, sellCount=0, lastAction=BUY) so D7-SELL-S1 fires at price >= 0.1.
      legStateRepo = createMockLegStateRepo([makeSellReadyLegState(tokenId)]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const positionRepo = {
        findByTokenId: vi.fn().mockReturnValue(makeOpenPosition(tokenId, { avgEntryPrice: 0.1 })),
      };

      const mod = buildModule({
        riskEventRepo,
        positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
        executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      });
      await mod.start();

      // Wide book: spread/mid = 0.2/0.15 = 1.33 > 0.5 → SELL guard suppresses the
      // executable price. mid 0.15 >= 0.1 keeps D7-SELL-S1 attempting the SELL.
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, null, 0.15, "cond-trackq-wide"),
            tickSize: 0.01,
            bestBid: 0.05,
            bestAsk: 0.25,
            spread: 0.2,
          },
        ],
        timestamp: Date.now(),
      });

      // Production behavior unchanged: the SELL stays suppressed (no signal placed).
      const sellSignals = (bus.publish as ReturnType<typeof vi.fn>).mock.calls
        .filter(([ev]) => ev === "SignalProduced")
        .filter(([, p]) => (p as { signal: { side: string } }).signal.side === "sell");
      expect(sellSignals).toHaveLength(0);

      expect((mod as any).plannerRollup.flushAll("periodic")).toBe(1);

      const insertCalls = vi.mocked(riskEventRepo.insert).mock.calls;
      // The live wide-spread suppression is preserved and classified by the
      // non-loss guard, but v1 stores the spammy sell-spread subset as rollups.
      expect(
        insertCalls.some(
          ([e]) =>
            e.eventType === "planner_suppressed_rollup" &&
            e.payload.reasonCode === "sell-spread-too-wide-below-avg-entry" &&
            e.payload.count === 1,
        ),
      ).toBe(true);

      // New: a structured, queryable track_q_shadow telemetry row.
      const shadow = insertCalls.find(([e]) => e.eventType === "track_q_shadow");
      expect(shadow).toBeDefined();
      const payload = shadow![0].payload;
      expect(payload.tokenId).toBe(tokenId);
      expect(payload.conditionId).toBe("cond-trackq-wide");
      expect(payload.reason).toBe("tier_floor_applied");
      expect(payload.p3WouldActivate).toBe(true);
      expect(payload.currentGuardWouldSuppress).toBe(true);
      expect(payload.bidAnchoredPrice).toBeCloseTo(0.09, 9);
      expect(payload.p3CandidatePrice).toBeCloseTo(0.14, 9);
      expect(payload.tierTarget).toBeCloseTo(0.136, 9);

      await mod.stop();
    });

    it("dedupes repeated shadow events per (token, reason) yet counts every eval in healthCheck", async () => {
      const tokenId = "token-trackq-dedupe";
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const mod = buildModule({ riskEventRepo });
      await mod.start();

      const projection: TrackQShadowProjection = {
        p3WouldActivate: true,
        reason: "tier_floor_applied",
        spreadMidRatio: 1.6,
        bidAskRatio: 0.1,
        bidAnchoredPrice: 0.09,
        tierMarkup: 1.36,
        tierTarget: 0.136,
        insideAsk: 0.24,
        p3CandidatePrice: 0.14,
        avgEntry: 0.1,
        currentGuardWouldSuppress: true,
        proposedGuardWouldSuppress: true,
        d8FireAtCurrentPrice: false,
        d8FireAtP3Candidate: true,
        d8FireWouldChange: true,
      };
      const sideEffect: DecisionPlanSideEffect = {
        kind: "track_q_shadow",
        tokenId: createTokenId(tokenId),
        conditionId: "cond-trackq-dedupe",
        timestamp: "2026-06-11T00:00:00.000Z",
        evalPrice: 0.15,
        projection,
      };

      // Two identical evals within the dedupe window.
      (mod as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      (mod as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);

      // Rate-controlled persistence: only one row hits the DB.
      const shadowInserts = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([e]) => e.eventType === "track_q_shadow");
      expect(shadowInserts).toHaveLength(1);

      // Cumulative counters are NOT deduped — every eval is counted.
      const health = await mod.healthCheck();
      expect(health.detail).toContain("trackQShadow evals=2 tokens=1");
      expect(health.detail).toContain("wouldActivate=2");

      await mod.stop();
    });

    it("persists shadow eval counters to runtime_metrics and recovers them by SUM across a restart", async () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE runtime_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL,
          value REAL NOT NULL,
          labels TEXT,
          captured_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const sumOf = (metricName: string): number =>
        (
          db
            .prepare(
              "SELECT COALESCE(SUM(value), 0) AS s FROM runtime_metrics WHERE metric_name = ?",
            )
            .get(metricName) as { s: number }
        ).s;

      const projection: TrackQShadowProjection = {
        p3WouldActivate: true,
        reason: "tier_floor_applied",
        spreadMidRatio: 1.6,
        bidAskRatio: 0.1,
        bidAnchoredPrice: 0.09,
        tierMarkup: 1.36,
        tierTarget: 0.136,
        insideAsk: 0.24,
        p3CandidatePrice: 0.14,
        avgEntry: 0.1,
        currentGuardWouldSuppress: true,
        proposedGuardWouldSuppress: false,
        d8FireAtCurrentPrice: false,
        d8FireAtP3Candidate: false,
        d8FireWouldChange: true,
      };
      const sideEffect: DecisionPlanSideEffect = {
        kind: "track_q_shadow",
        tokenId: createTokenId("token-trackq-persist"),
        conditionId: "cond-trackq-persist",
        timestamp: "2026-06-12T00:00:00.000Z",
        evalPrice: 0.15,
        projection,
      };

      // ── Process #1: two evals, then flush the central writer. ──
      const writer1 = new RuntimeMetricWriter(db);
      const mod1 = buildModule({
        runtimeMetrics: writer1,
        riskEventRepo: { insert: vi.fn(), countSince: vi.fn() },
      });
      await mod1.start();
      (mod1 as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      (mod1 as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      writer1.flushCounters();
      await mod1.stop();

      expect(sumOf("track_q_shadow_evals_total")).toBe(2);

      // ── Process #2: restart on the SAME db — in-memory counters reset, the
      // persisted deltas survive and accumulate via SUM. ──
      const writer2 = new RuntimeMetricWriter(db);
      const mod2 = buildModule({
        runtimeMetrics: writer2,
        riskEventRepo: { insert: vi.fn(), countSince: vi.fn() },
      });
      await mod2.start();
      expect((mod2 as any).trackQShadow.evals).toBe(0); // fresh process, in-memory reset
      (mod2 as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      writer2.flushCounters();
      await mod2.stop();

      // Cumulative across the restart is recovered by summing the delta rows.
      expect(sumOf("track_q_shadow_evals_total")).toBe(3);
      expect(sumOf("track_q_shadow_d8_fire_would_change_total")).toBe(3);
      expect(sumOf("track_q_shadow_would_activate_total")).toBe(3);
      // The non-summable distinct-token count is NOT persisted via writeCounter.
      expect(sumOf("track_q_shadow_tokens_total")).toBe(0);

      const byReason = (
        db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM runtime_metrics WHERE metric_name = ? AND labels = ?",
          )
          .get(
            "track_q_shadow_by_reason_total",
            JSON.stringify({ reason: "tier_floor_applied" }),
          ) as {
          s: number;
        }
      ).s;
      expect(byReason).toBe(3);

      db.close();
    });
  });

  describe("sell loop guard suppression telemetry", () => {
    it("writes track_q_loop_guard_suppressed_total when applying the suppression side effect", async () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE runtime_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL,
          value REAL NOT NULL,
          labels TEXT,
          captured_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const sumByLabel = (metricName: string, labels: string): number =>
        (
          db
            .prepare(
              "SELECT COALESCE(SUM(value), 0) AS s FROM runtime_metrics WHERE metric_name = ? AND labels = ?",
            )
            .get(metricName, labels) as { s: number }
        ).s;

      const writer = new RuntimeMetricWriter(db);
      const mod = buildModule({ runtimeMetrics: writer });
      await mod.start();

      const sideEffect: DecisionPlanSideEffect = {
        kind: "sell_loop_guard_suppressed",
        tokenId: createTokenId("token-loop-guard"),
        conditionId: "cond-loop-guard",
        decisionRuleId: "D8_PROFIT_RATIO",
        activeCount: 12,
        threshold: 10,
        timestamp: "2026-06-12T00:00:00.000Z",
      };
      (mod as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      writer.flushCounters();
      await mod.stop();

      expect(
        sumByLabel(
          "track_q_loop_guard_suppressed_total",
          JSON.stringify({ decisionRuleId: "D8_PROFIT_RATIO" }),
        ),
      ).toBe(1);

      db.close();
    });
  });

  describe("profile ladder D9 suppression telemetry", () => {
    function makeD9ProfileOwnedSideEffect(
      overrides: Partial<
        Extract<DecisionPlanSideEffect, { kind: "d9_suppressed_on_profile_owned" }>
      > = {},
    ): DecisionPlanSideEffect {
      return {
        kind: "d9_suppressed_on_profile_owned",
        tokenId: createTokenId("token-profile-d9"),
        conditionId: "cond-profile-d9",
        decisionRuleId: "D9_LOSS_EXIT",
        price: 0.07,
        state: "S1",
        timestamp: "2026-06-15T00:00:00.000Z",
        emissionFacts: {
          firstTradePrice: 0.12,
          firstTradeAt: "2026-06-14T00:00:00.000Z",
          legTradeCount: 1,
          d9ProfitRatio: 0.5833333333,
          d9AvgBuyPrice: 0.12,
          d9DaysToResolve: 1,
          d9PublicTradeCount24h: 100,
        },
        d9Reason: "d9-loss-exit-fired",
        ...overrides,
      };
    }

    it("writes d9_suppressed_on_profile_owned counters on every occurrence", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const mod = buildModule({ runtimeMetrics, riskEventRepo });
      await mod.start();

      const sideEffect = makeD9ProfileOwnedSideEffect();
      (mod as any).applyDecisionPlanSideEffects(
        [sideEffect, sideEffect, sideEffect],
        DEFAULT_EXECUTION_POLICY,
      );
      await mod.stop();

      const metricCalls = vi.mocked(runtimeMetrics.writeCounter).mock.calls;
      expect(
        metricCalls.filter(([name]) => name === "d9_suppressed_on_profile_owned"),
      ).toHaveLength(3);
      expect(
        metricCalls.filter(([name]) => name === "d9_would_have_fired_on_profile_owned"),
      ).toHaveLength(3);
      expect(
        metricCalls
          .filter(([name]) => name === "d9_suppressed_on_profile_owned")
          .every((call) => call.length === 2),
      ).toBe(true);
      expect(riskEventRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "d9_suppressed_on_profile_owned",
          payload: expect.objectContaining({
            tokenId: "token-profile-d9",
            conditionId: "cond-profile-d9",
            decisionRuleId: "D9_LOSS_EXIT",
            price: 0.07,
            state: "S1",
            d9Reason: "d9-loss-exit-fired",
            signalTimestamp: "2026-06-15T00:00:00.000Z",
          }),
        }),
      );
    });

    it("dedupes repeated identical d9_suppressed_on_profile_owned raw risk events", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const mod = buildModule({ runtimeMetrics, riskEventRepo });
      await mod.start();

      const first = makeD9ProfileOwnedSideEffect();
      const withinWindow = makeD9ProfileOwnedSideEffect({
        timestamp: "2026-06-15T00:04:59.000Z",
      });
      const afterWindow = makeD9ProfileOwnedSideEffect({
        timestamp: "2026-06-15T00:05:01.000Z",
      });
      (mod as any).applyDecisionPlanSideEffects(
        [first, withinWindow, afterWindow],
        DEFAULT_EXECUTION_POLICY,
      );
      await mod.stop();

      expect(
        vi
          .mocked(runtimeMetrics.writeCounter)
          .mock.calls.filter(([name]) => name === "d9_suppressed_on_profile_owned"),
      ).toHaveLength(3);
      expect(vi.mocked(riskEventRepo.insert).mock.calls).toHaveLength(2);
    });

    it("persists materially different d9_suppressed_on_profile_owned raw risk events separately", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const mod = buildModule({ runtimeMetrics, riskEventRepo });
      await mod.start();

      (mod as any).applyDecisionPlanSideEffects(
        [
          makeD9ProfileOwnedSideEffect(),
          makeD9ProfileOwnedSideEffect({
            tokenId: createTokenId("token-profile-d9-other"),
            conditionId: "cond-profile-d9-other",
          }),
          makeD9ProfileOwnedSideEffect({ state: "S2" }),
          makeD9ProfileOwnedSideEffect({ d9Reason: "d9-loss-exit-fallback" }),
        ],
        DEFAULT_EXECUTION_POLICY,
      );
      await mod.stop();

      expect(vi.mocked(riskEventRepo.insert).mock.calls).toHaveLength(4);
    });
  });

  describe("profile ladder legacy guard observability", () => {
    it("wires runtime profile-ladder ownership into D4 observability", async () => {
      const tokenId = "token-d4-runtime-profile-owned";
      legStateRepo = createMockLegStateRepo([makeSellReadyLegState(tokenId)]);
      algoRulesRepo = {
        getDecisionRules: vi.fn(() => [
          ...SEED_DECISION_RULES.filter((rule) => rule.ruleId === "FALLBACK"),
          {
            id: 404,
            priority: 1,
            ruleId: "D4",
            stateCondition: "S1",
            priceOperator: ">=",
            priceValue: 0.1,
            timeSinceLastOperator: null,
            timeSinceLastSeconds: null,
            buyCountMin: null,
            buyCountMax: null,
            holdDurationOperator: null,
            holdDurationSeconds: null,
            action: "SELL",
          },
        ]),
        getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
          actionType === "BUY" ? SEED_SIZE_RULES_BUY : SEED_SIZE_RULES_SELL,
        ),
      };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const position = makeOpenPosition(tokenId, { avgEntryPrice: 0.1 });
      const positionRepo = {
        findOpen: vi.fn().mockReturnValue([position]),
        findByTokenId: vi.fn().mockReturnValue(position),
      };
      const profileLadderOwnership = {
        isProfileLadderOwned: vi.fn().mockReturnValue(true),
      };
      const mod = buildModule({
        riskEventRepo,
        runtimeMetrics,
        positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
        profileLadderOwnership,
      } as any);
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.15, `cond-${tokenId}`)],
        timestamp: Date.now(),
      });
      await mod.stop();

      expect(profileLadderOwnership.isProfileLadderOwned).toHaveBeenCalledWith(
        createTokenId(tokenId),
      );
      expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
        "legacy_guard_fired_on_profile_owned",
        1,
        JSON.stringify({ guard: "d4" }),
      );
      expect(riskEventRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "legacy_guard_fired_on_profile_owned",
          payload: expect.objectContaining({
            guard: "d4",
            tokenId,
            decisionRuleId: "D4",
          }),
        }),
      );
    });

    it("writes legacy_guard_fired_on_profile_owned counter and risk event", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const mod = buildModule({ runtimeMetrics, riskEventRepo });
      await mod.start();

      const sideEffect = {
        kind: "legacy_guard_fired_on_profile_owned",
        guard: "d8",
        tokenId: createTokenId("token-profile-d8"),
        conditionId: "cond-profile-d8",
        decisionRuleId: "D8_PROFIT_RATIO",
        proposedPrice: 0.08,
        avgEntryPrice: 0.05,
        state: "S1",
        timestamp: "2026-06-15T00:05:00.000Z",
        emissionFacts: {
          firstTradePrice: 0.05,
          firstTradeAt: "2026-06-14T00:00:00.000Z",
          legTradeCount: 1,
          d8ProfitRatio: 1.7,
          d8Threshold: 1.2412,
          d8AvgBuyPrice: 0.05,
        },
      } as unknown as DecisionPlanSideEffect;

      (mod as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      await mod.stop();

      expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
        "legacy_guard_fired_on_profile_owned",
        1,
        JSON.stringify({ guard: "d8" }),
      );
      expect(riskEventRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "legacy_guard_fired_on_profile_owned",
          payload: expect.objectContaining({
            guard: "d8",
            tokenId: "token-profile-d8",
            conditionId: "cond-profile-d8",
            decisionRuleId: "D8_PROFIT_RATIO",
            proposedPrice: 0.08,
            avgEntryPrice: 0.05,
            state: "S1",
            signalTimestamp: "2026-06-15T00:05:00.000Z",
          }),
        }),
      );
    });

    it("rate-limits repeated legacy_guard_fired_on_profile_owned risk events per token/rule/state key", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const mod = buildModule({ runtimeMetrics, riskEventRepo });
      await mod.start();

      const sideEffect = {
        kind: "legacy_guard_fired_on_profile_owned",
        guard: "d8",
        tokenId: createTokenId("token-profile-dedupe"),
        conditionId: "cond-profile-dedupe",
        decisionRuleId: "D8_PROFIT_RATIO",
        proposedPrice: 0.08,
        avgEntryPrice: 0.05,
        state: "S1",
        timestamp: "2026-06-15T00:05:00.000Z",
        emissionFacts: {
          firstTradePrice: 0.05,
          firstTradeAt: "2026-06-14T00:00:00.000Z",
          legTradeCount: 1,
        },
      } as unknown as DecisionPlanSideEffect;

      (mod as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      (mod as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      await mod.stop();

      const riskEvents = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.eventType === "legacy_guard_fired_on_profile_owned");
      expect(riskEvents).toHaveLength(1);

      const counters = vi
        .mocked(runtimeMetrics.writeCounter)
        .mock.calls.filter(([metricName]) => metricName === "legacy_guard_fired_on_profile_owned");
      expect(counters).toHaveLength(2);
    });

    it("lets distinct legacy guard dedupe keys and expired windows emit risk events", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const mod = buildModule({ riskEventRepo });
      await mod.start();

      const baseSideEffect = {
        kind: "legacy_guard_fired_on_profile_owned",
        guard: "d8",
        tokenId: createTokenId("token-profile-window"),
        conditionId: "cond-profile-window",
        decisionRuleId: "D8_PROFIT_RATIO",
        proposedPrice: 0.08,
        avgEntryPrice: 0.05,
        state: "S1",
        timestamp: "2026-06-15T00:05:00.000Z",
        emissionFacts: {
          firstTradePrice: 0.05,
          firstTradeAt: "2026-06-14T00:00:00.000Z",
          legTradeCount: 1,
        },
      } as unknown as DecisionPlanSideEffect;
      const differentToken = {
        ...baseSideEffect,
        tokenId: createTokenId("token-profile-window-other"),
      } as unknown as DecisionPlanSideEffect;
      const afterWindow = {
        ...baseSideEffect,
        timestamp: "2026-06-15T00:15:00.000Z",
      } as unknown as DecisionPlanSideEffect;

      (mod as any).applyDecisionPlanSideEffects([baseSideEffect], DEFAULT_EXECUTION_POLICY);
      (mod as any).applyDecisionPlanSideEffects([differentToken], DEFAULT_EXECUTION_POLICY);
      (mod as any).applyDecisionPlanSideEffects([afterWindow], DEFAULT_EXECUTION_POLICY);
      await mod.stop();

      const riskEvents = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.eventType === "legacy_guard_fired_on_profile_owned");
      expect(riskEvents).toHaveLength(3);
      expect(riskEvents.map(([event]) => event.payload.tokenId)).toEqual([
        "token-profile-window",
        "token-profile-window-other",
        "token-profile-window",
      ]);
    });
  });

  describe("static-rule below-entry SELL guard telemetry", () => {
    function staticGuardSideEffect(
      overrides: Record<string, unknown> = {},
    ): DecisionPlanSideEffect {
      return {
        kind: "static_rule_sell_below_avg_entry_suppressed",
        tokenId: createTokenId("token-static-guard"),
        conditionId: "cond-static-guard",
        decisionRuleId: "D7",
        proposedPrice: 0.19,
        entryFloorPrice: 0.2,
        positiveFloorPrice: 0.21,
        floor: 0.21,
        avgEntryPrice: 0.2,
        state: "S2",
        timestamp: "2026-06-15T00:10:00.000Z",
        emissionFacts: {
          firstTradePrice: 0.2,
          firstTradeAt: "2026-06-14T00:00:00.000Z",
          legTradeCount: 2,
        },
        ...overrides,
      } as unknown as DecisionPlanSideEffect;
    }

    it("writes static_rule_sell_below_avg_entry_suppressed counter and risk event", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const mod = buildModule({ runtimeMetrics, riskEventRepo });
      await mod.start();

      (mod as any).applyDecisionPlanSideEffects(
        [staticGuardSideEffect()],
        DEFAULT_EXECUTION_POLICY,
      );
      await mod.stop();

      expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
        "static_rule_sell_below_avg_entry_suppressed",
        1,
        JSON.stringify({ decisionRuleId: "D7" }),
      );
      expect(riskEventRepo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "static_rule_sell_below_avg_entry_suppressed",
          payload: expect.objectContaining({
            decisionRuleId: "D7",
            tokenId: "token-static-guard",
            conditionId: "cond-static-guard",
            avgEntryPrice: 0.2,
            proposedPrice: 0.19,
            entryFloorPrice: 0.2,
            positiveFloorPrice: 0.21,
            floor: 0.21,
            profileLadderOwned: true,
            state: "S2",
            signalTimestamp: "2026-06-15T00:10:00.000Z",
          }),
        }),
      );
    });

    it("rate-limits repeated static guard risk events per token/rule/state key", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const runtimeMetrics = {
        writeCounter: vi.fn(),
        writeLatest: vi.fn(),
      } as unknown as RuntimeMetricWriter;
      const mod = buildModule({ runtimeMetrics, riskEventRepo });
      await mod.start();

      (mod as any).applyDecisionPlanSideEffects(
        [staticGuardSideEffect()],
        DEFAULT_EXECUTION_POLICY,
      );
      (mod as any).applyDecisionPlanSideEffects(
        [staticGuardSideEffect()],
        DEFAULT_EXECUTION_POLICY,
      );
      await mod.stop();

      const riskEvents = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(
          ([event]) => event.eventType === "static_rule_sell_below_avg_entry_suppressed",
        );
      expect(riskEvents).toHaveLength(1);

      const counters = vi
        .mocked(runtimeMetrics.writeCounter)
        .mock.calls.filter(
          ([metricName]) => metricName === "static_rule_sell_below_avg_entry_suppressed",
        );
      expect(counters).toHaveLength(2);
    });
  });

  // Sub-Track Q.D shadow (observe-only): the planner emits a `track_q_d` side
  // effect for cheap-longshot legs inside the pre-resolution TTC window. The
  // module surfaces it as a deduped, structured risk event + cumulative
  // healthCheck counters, persisting summable eval deltas to runtime_metrics,
  // WITHOUT changing any placed order. See
  // research_plankton/track_q_d_spec_2026-06-12.md.
  describe("Sub-Track Q.D shadow telemetry", () => {
    function qdProjection(overrides: Partial<QdShadowProjection> = {}): QdShadowProjection {
      return {
        qdWouldActivate: true,
        reason: "would_fire",
        activationMode: "mode_a",
        avgEntry: 0.03,
        ttcMs: 3_600_000,
        shortMarket: false,
        withinTtc: true,
        imminentTtc: false,
        qualifyingBid: true,
        bidVsAvgEntry: 1.0,
        modeAApplies: true,
        modeBApplies: false,
        d8Fired: false,
        d9Fired: false,
        bestBid: 0.03,
        anchorTicks: 4,
        bidAnchoredPrice: 0.034,
        f2Cap: 0.0408,
        candidatePrice: 0.034,
        ...overrides,
      };
    }

    function qdSideEffect(
      overrides: Partial<QdShadowProjection> = {},
      token = "token-qd",
    ): DecisionPlanSideEffect {
      return {
        kind: "track_q_d",
        tokenId: createTokenId(token),
        conditionId: "cond-qd",
        timestamp: "2026-06-11T00:00:00.000Z",
        projection: qdProjection(overrides),
      };
    }

    it.each(["pending", "open", "partially-filled"] as const)(
      "marks %s SELL orders as active for Q.D yielding",
      async (status) => {
        const tokenId = `token-qd-active-${status}`;
        selectedMarketCache = createMockSelectedMarketCache([tokenId]);
        legStateRepo = createMockLegStateRepo([
          makeSellReadyLegState(tokenId, {
            cumulativeBuySize: 100,
            cumulativeBuyNotional: 3,
          }),
        ]);
        const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
        const positionRepo = {
          findByTokenId: vi
            .fn()
            .mockReturnValue(makeOpenPosition(tokenId, { avgEntryPrice: 0.03 })),
        };
        const orderRepo: Partial<OrderRepository> = {
          findRecentByTokenId: vi.fn().mockReturnValue([makeOrder(tokenId, { status })]),
          findByTokenId: vi.fn().mockReturnValue([]),
        };

        const mod = buildModule({
          riskEventRepo,
          positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
          orderRepo: orderRepo as OrderRepository,
          executionPolicy: () => DEFAULT_EXECUTION_POLICY,
        });
        await mod.start();

        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [
            {
              ...makeMarket(tokenId, null, 0.03, "cond-qd-active"),
              endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              bestBid: 0.03,
              bestAsk: 0.05,
              spread: 0.02,
              publicTradeCount24h: 5,
            },
          ],
          timestamp: Date.now(),
        });

        const qdInsert = vi
          .mocked(riskEventRepo.insert)
          .mock.calls.find(([event]) => event.eventType === "track_q_d");
        expect(qdInsert).toBeDefined();
        expect(qdInsert![0].payload.reason).toBe("has_active_sell");
        expect(qdInsert![0].payload.qdWouldActivate).toBe(false);

        await mod.stop();
      },
    );

    it.each(["filled", "cancelled", "rejected"] as const)(
      "does not mark %s SELL orders as active for Q.D yielding",
      async (status) => {
        const tokenId = `token-qd-terminal-${status}`;
        selectedMarketCache = createMockSelectedMarketCache([tokenId]);
        legStateRepo = createMockLegStateRepo([
          makeSellReadyLegState(tokenId, {
            cumulativeBuySize: 100,
            cumulativeBuyNotional: 3,
          }),
        ]);
        const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
        const positionRepo = {
          findByTokenId: vi
            .fn()
            .mockReturnValue(makeOpenPosition(tokenId, { avgEntryPrice: 0.03 })),
        };
        const orderRepo: Partial<OrderRepository> = {
          findRecentByTokenId: vi.fn().mockReturnValue([makeOrder(tokenId, { status })]),
          findByTokenId: vi.fn().mockReturnValue([]),
        };

        const mod = buildModule({
          riskEventRepo,
          positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
          orderRepo: orderRepo as OrderRepository,
          executionPolicy: () => DEFAULT_EXECUTION_POLICY,
        });
        await mod.start();

        await (bus as any).emit("NormalizedMarketUpdated", {
          markets: [
            {
              ...makeMarket(tokenId, null, 0.03, "cond-qd-terminal"),
              endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
              bestBid: 0.03,
              bestAsk: 0.05,
              spread: 0.02,
              publicTradeCount24h: 5,
            },
          ],
          timestamp: Date.now(),
        });

        const qdInsert = vi
          .mocked(riskEventRepo.insert)
          .mock.calls.find(([event]) => event.eventType === "track_q_d");
        expect(qdInsert).toBeDefined();
        expect(qdInsert![0].payload.reason).toBe("would_fire");
        expect(qdInsert![0].payload.qdWouldActivate).toBe(true);

        await mod.stop();
      },
    );

    it("does not mark active S1_LADDER SELL orders as active for Q.D handoff", async () => {
      const tokenId = "token-qd-active-s1-ladder";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      legStateRepo = createMockLegStateRepo([
        makeSellReadyLegState(tokenId, {
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 3,
        }),
      ]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const positionRepo = {
        findByTokenId: vi.fn().mockReturnValue(makeOpenPosition(tokenId, { avgEntryPrice: 0.03 })),
      };
      const orderRepo: Partial<OrderRepository> = {
        findRecentByTokenId: vi
          .fn()
          .mockReturnValue([
            makeOrder(tokenId, { status: "open", decisionRuleId: S1_LADDER_RULE_ID }),
          ]),
        findByTokenId: vi.fn().mockReturnValue([]),
      };

      const mod = buildModule({
        riskEventRepo,
        positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
        orderRepo: orderRepo as OrderRepository,
        executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, null, 0.03, "cond-qd-active-s1"),
            endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            bestBid: 0.03,
            bestAsk: 0.05,
            spread: 0.02,
            publicTradeCount24h: 5,
          },
        ],
        timestamp: Date.now(),
      });

      const qdInsert = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.find(([event]) => event.eventType === "track_q_d");
      expect(qdInsert).toBeDefined();
      expect(qdInsert![0].payload.reason).toBe("would_fire");
      expect(qdInsert![0].payload.qdWouldActivate).toBe(true);

      await mod.stop();
    });

    it("does not mark active profile-ladder SELL orders as active for Q.D handoff", async () => {
      const tokenId = "token-qd-active-profile-ladder";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      legStateRepo = createMockLegStateRepo([
        makeSellReadyLegState(tokenId, {
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 3,
        }),
      ]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const positionRepo = {
        findByTokenId: vi.fn().mockReturnValue(makeOpenPosition(tokenId, { avgEntryPrice: 0.03 })),
      };
      const orderRepo: Partial<OrderRepository> = {
        findRecentByTokenId: vi.fn().mockReturnValue([
          makeOrder(tokenId, {
            status: "open",
            decisionRuleId: "PROFILE_LADDER",
            metadata: { source: "profile_ladder" },
          }),
        ]),
        findByTokenId: vi.fn().mockReturnValue([]),
      };

      const mod = buildModule({
        riskEventRepo,
        positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
        orderRepo: orderRepo as OrderRepository,
        executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, null, 0.03, "cond-qd-active-profile"),
            endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            bestBid: 0.03,
            bestAsk: 0.05,
            spread: 0.02,
            publicTradeCount24h: 5,
          },
        ],
        timestamp: Date.now(),
      });

      const qdInsert = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.find(([event]) => event.eventType === "track_q_d");
      expect(qdInsert).toBeDefined();
      expect(qdInsert![0].payload.reason).toBe("would_fire");
      expect(qdInsert![0].payload.qdWouldActivate).toBe(true);

      await mod.stop();
    });

    it("detects an older active SELL even when the latest SELL row is cancelled", async () => {
      const tokenId = "token-qd-latest-cancelled-old-open";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      legStateRepo = createMockLegStateRepo([
        makeSellReadyLegState(tokenId, {
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 3,
        }),
      ]);
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const positionRepo = {
        findByTokenId: vi.fn().mockReturnValue(makeOpenPosition(tokenId, { avgEntryPrice: 0.03 })),
      };
      const orderRepo: Partial<OrderRepository> = {
        findRecentByTokenId: vi
          .fn()
          .mockReturnValue([
            makeOrder(tokenId, { status: "cancelled", createdAt: "2026-06-11T00:02:00.000Z" }),
            makeOrder(tokenId, { status: "open", createdAt: "2026-06-11T00:01:00.000Z" }),
          ]),
        findByTokenId: vi.fn().mockReturnValue([]),
      };

      const mod = buildModule({
        riskEventRepo,
        positionRepo: positionRepo as unknown as import("@krabs/domain").PositionRepository,
        orderRepo: orderRepo as OrderRepository,
        executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [
          {
            ...makeMarket(tokenId, null, 0.03, "cond-qd-old-open"),
            endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            bestBid: 0.03,
            bestAsk: 0.05,
            spread: 0.02,
            publicTradeCount24h: 5,
          },
        ],
        timestamp: Date.now(),
      });

      const qdInsert = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.find(([event]) => event.eventType === "track_q_d");
      expect(qdInsert).toBeDefined();
      expect(qdInsert![0].payload.reason).toBe("has_active_sell");
      expect(qdInsert![0].payload.qdWouldActivate).toBe(false);

      await mod.stop();
    });

    it("emits a structured, deduped track_q_d risk event yet counts every eval in healthCheck", async () => {
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };
      const mod = buildModule({ riskEventRepo });
      await mod.start();

      const sideEffect = qdSideEffect();
      (mod as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      (mod as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);

      const qdInserts = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([e]) => e.eventType === "track_q_d");
      expect(qdInserts).toHaveLength(1);
      const payload = qdInserts[0]![0].payload;
      expect(payload.tokenId).toBe("token-qd");
      expect(payload.conditionId).toBe("cond-qd");
      expect(payload.reason).toBe("would_fire");
      expect(payload.activationMode).toBe("mode_a");
      expect(payload.qdWouldActivate).toBe(true);
      expect(payload.candidatePrice).toBeCloseTo(0.034, 9);
      expect(payload.anchorTicks).toBe(4);

      const health = await mod.healthCheck();
      expect(health.detail).toContain("trackQdShadow evals=2 tokens=1");
      expect(health.detail).toContain("wouldActivate=2");
      expect(health.detail).toContain("modeA=2");

      await mod.stop();
    });

    it("persists Q.D eval counters to runtime_metrics and recovers them by SUM across a restart", async () => {
      const db = new Database(":memory:");
      db.exec(`
        CREATE TABLE runtime_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          metric_name TEXT NOT NULL,
          value REAL NOT NULL,
          labels TEXT,
          captured_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const sumOf = (metricName: string): number =>
        (
          db
            .prepare(
              "SELECT COALESCE(SUM(value), 0) AS s FROM runtime_metrics WHERE metric_name = ?",
            )
            .get(metricName) as { s: number }
        ).s;

      const sideEffect = qdSideEffect({}, "token-qd-persist");

      const writer1 = new RuntimeMetricWriter(db);
      const mod1 = buildModule({
        runtimeMetrics: writer1,
        riskEventRepo: { insert: vi.fn(), countSince: vi.fn() },
      });
      await mod1.start();
      (mod1 as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      (mod1 as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      writer1.flushCounters();
      await mod1.stop();

      expect(sumOf("track_q_d_shadow_evals_total")).toBe(2);

      const writer2 = new RuntimeMetricWriter(db);
      const mod2 = buildModule({
        runtimeMetrics: writer2,
        riskEventRepo: { insert: vi.fn(), countSince: vi.fn() },
      });
      await mod2.start();
      expect((mod2 as any).trackQdShadow.evals).toBe(0); // fresh process, in-memory reset
      (mod2 as any).applyDecisionPlanSideEffects([sideEffect], DEFAULT_EXECUTION_POLICY);
      writer2.flushCounters();
      await mod2.stop();

      expect(sumOf("track_q_d_shadow_evals_total")).toBe(3);
      expect(sumOf("track_q_d_shadow_would_activate_total")).toBe(3);
      expect(sumOf("track_q_d_shadow_mode_a_total")).toBe(3);

      const byReason = (
        db
          .prepare(
            "SELECT COALESCE(SUM(value), 0) AS s FROM runtime_metrics WHERE metric_name = ? AND labels = ?",
          )
          .get("track_q_d_shadow_by_reason_total", JSON.stringify({ reason: "would_fire" })) as {
          s: number;
        }
      ).s;
      expect(byReason).toBe(3);

      db.close();
    });
  });
});

describe("conversionSkipReEvalDelayMs", () => {
  it("defers a same-price-cooldown skip to the 250 ms debounce", () => {
    expect(conversionSkipReEvalDelayMs(["same-price-cooldown"])).toBe(250);
  });

  it("defers when every reason is inputs-unchanged", () => {
    expect(conversionSkipReEvalDelayMs(["same-price-cooldown", "order-size-below-minimum"])).toBe(
      250,
    );
    expect(conversionSkipReEvalDelayMs(["dead-side-near-end"])).toBe(250);
    expect(conversionSkipReEvalDelayMs(["price-above-entry-ceiling"])).toBe(250);
    expect(conversionSkipReEvalDelayMs(["sell-price-below-signal-floor"])).toBe(250);
    expect(conversionSkipReEvalDelayMs(["taker-below-margin"])).toBe(250);
    expect(conversionSkipReEvalDelayMs(["sell-order-acceptable-price-already-open"])).toBe(250);
    expect(conversionSkipReEvalDelayMs(["no_bid", "one-sided-book"])).toBe(250);
    expect(isInputsUnchangedConversionSkip(["spread-above-cap"])).toBe(true);
  });

  it("keeps immediate re-eval for inputs-changeable reasons", () => {
    expect(conversionSkipReEvalDelayMs(["budget-exhausted"])).toBe(0);
    expect(conversionSkipReEvalDelayMs(["order-lifetime-placement-blocked"])).toBe(0);
  });

  it("keeps immediate re-eval when any reason is inputs-changeable", () => {
    expect(conversionSkipReEvalDelayMs(["same-price-cooldown", "budget-exhausted"])).toBe(0);
  });

  it("keeps immediate re-eval for empty/unknown reason lists", () => {
    expect(conversionSkipReEvalDelayMs([])).toBe(0);
    expect(conversionSkipReEvalDelayMs(["totally-unknown-reason"])).toBe(0);
  });
});
