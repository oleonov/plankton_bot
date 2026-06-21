import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BUY_GUARDS_POLICY,
  DEFAULT_EXECUTION_PROFILE_POLICY,
  LiquidityRole,
  OrderType,
  PositionStatus,
  createBotRunId,
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
  type FillReceived,
  type NormalizedMarket,
  type Order,
  type OrderRepository,
  type Position,
  type PositionRepository,
  type ScaleInMarketSignals,
  type SignalSnapshot,
  type Signal,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { S1_LADDER_RULE_ID } from "@krabs/domain";
import {
  ExecutionProfileManager,
  type ExecutionProfileManagerDeps,
} from "../execution-profile-manager.js";
import { EXECUTION_PROFILE_RISK_EVENTS } from "../execution-profile-metrics.js";
import { ExecutionProfileRollup } from "../execution-profile-rollup.js";
import { DEFAULT_PROFILE_HYSTERESIS } from "../profile-resolver.js";
import { InMemoryExecutionProfileStateRepository } from "../state-repository.js";
import type { ExecutionProfilePolicy, ExecutionProfileStateRecord } from "../types.js";
import type { EffectiveResolutionGate } from "../../../effective-resolution-service.js";

const tokenId = createTokenId("manager-token");
const conditionId = createConditionId("manager-condition");
const NOW = Date.parse("2026-06-14T00:00:00.000Z");
const DEFAULT_POLICY: ExecutionProfilePolicy = {
  ...DEFAULT_EXECUTION_PROFILE_POLICY,
  enabled: false,
  maxTokensPerCycle: 100,
  qdHandoffThresholdMs: 3_600_000,
  profileHysteresis: DEFAULT_PROFILE_HYSTERESIS,
  monitoring: {
    healthCheckIntervalMs: 300_000,
    rollupWindowMs: 300_000,
    maxRollupBuckets: 10_000,
    pendingScaleInWarnAfterMs: 600_000,
    healthRiskEventEveryMs: 1_800_000,
    anomalyDetection: { enabled: false, cooldownMs: 3_600_000 },
  },
};

type HarvestingGuardOverrides = Omit<
  Partial<ExecutionProfilePolicy["scaleIn"]["harvestingGuard"]>,
  "override"
> & {
  override?: Partial<ExecutionProfilePolicy["scaleIn"]["harvestingGuard"]["override"]>;
};

type ScaleInOverrides = Omit<Partial<ExecutionProfilePolicy["scaleIn"]>, "harvestingGuard"> & {
  harvestingGuard?: HarvestingGuardOverrides;
};

type PolicyOverrides = Omit<Partial<ExecutionProfilePolicy>, "scaleIn" | "sellLadder"> & {
  scaleIn?: ScaleInOverrides;
  sellLadder?: Partial<ExecutionProfilePolicy["sellLadder"]>;
};

function policy(overrides: PolicyOverrides = {}): ExecutionProfilePolicy {
  return {
    ...DEFAULT_POLICY,
    ...overrides,
    profileHysteresis: {
      ...DEFAULT_POLICY.profileHysteresis,
      ...(overrides.profileHysteresis ?? {}),
    },
    sellLadder: {
      ...DEFAULT_POLICY.sellLadder,
      ...(overrides.sellLadder ?? {}),
    },
    costCaps: {
      ...DEFAULT_POLICY.costCaps,
      ...(overrides.costCaps ?? {}),
    },
    scaleIn: {
      ...DEFAULT_POLICY.scaleIn,
      ...(overrides.scaleIn ?? {}),
      harvestingGuard: {
        ...DEFAULT_POLICY.scaleIn.harvestingGuard,
        ...(overrides.scaleIn?.harvestingGuard ?? {}),
        override: {
          ...DEFAULT_POLICY.scaleIn.harvestingGuard.override,
          ...(overrides.scaleIn?.harvestingGuard?.override ?? {}),
        },
      },
    },
    profiles: {
      ...DEFAULT_POLICY.profiles,
      ...(overrides.profiles ?? {}),
    },
    adoptExistingPositions: {
      ...DEFAULT_POLICY.adoptExistingPositions,
      ...(overrides.adoptExistingPositions ?? {}),
    },
    adoptExistingS1Ladders: {
      ...DEFAULT_POLICY.adoptExistingS1Ladders,
      ...(overrides.adoptExistingS1Ladders ?? {}),
    },
    monitoring: {
      ...DEFAULT_POLICY.monitoring,
      ...(overrides.monitoring ?? {}),
      anomalyDetection: {
        ...DEFAULT_POLICY.monitoring.anomalyDetection,
        ...(overrides.monitoring?.anomalyDetection ?? {}),
      },
    },
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("manager-position"),
    tokenId,
    conditionId,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.12,
    costBasisUsdc: 12,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: PositionStatus.Open,
    entryStyle: "probe",
    openedAt: "2026-06-14T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("manager-order"),
    clientOrderId: "manager-client" as ClientOrderId,
    tokenId,
    conditionId,
    side: "sell",
    orderType: OrderType.Gtc,
    postOnly: true,
    price: 0.2,
    size: 10,
    sizeUsdc: 2,
    status: "open",
    exchangeOrderId: "exchange-order",
    signalId: "signal",
    signalReason: "repricing-exit",
    decisionRuleId: S1_LADDER_RULE_ID,
    botRunId: createBotRunId("run"),
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    metadata: { s1: { ladderId: "ladder-1" } },
    ...overrides,
  };
}

function makePositionRepo(rows: Position[]): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn(
      (id) => rows.find((row) => row.tokenId === id && row.status === PositionStatus.Open) ?? null,
    ),
    findOpen: vi.fn(() => rows.filter((row) => row.status === PositionStatus.Open)),
    findDust: vi.fn(() => []),
    findAll: vi.fn(() => rows),
    findOpenByEntryStyle: vi.fn(() => []),
  };
}

function makeOrderRepo(rows: Order[]): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn(),
    findOpen: vi.fn(() =>
      rows.filter((row) => ["pending", "open", "partially-filled"].includes(row.status)),
    ),
    findByTokenId: vi.fn(() => []),
    findRecentByTokenId: vi.fn(() => []),
    findFirstByTokenId: vi.fn(() => null),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn(() => 0),
  } as unknown as OrderRepository;
}

function state(overrides: Partial<ExecutionProfileStateRecord> = {}): ExecutionProfileStateRecord {
  return {
    tokenId,
    conditionId,
    profile: "medium",
    state: "PROBING",
    assumedAt: "2026-06-14T00:00:00.000Z",
    lastAvgEntry: 0.12,
    lastTransitionAt: "2026-06-14T00:00:00.000Z",
    activeLadderId: null,
    handoffStartedAt: null,
    metadata: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    addCount: 0,
    lastBuyAtMs: NOW - 60_000,
    initialProbeSizeUsd: 7.15,
    ...overrides,
  };
}

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId: String(conditionId),
    slug: "manager-market",
    eventSlug: null,
    eventMarketCount: 2,
    question: "Manager market?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.104,
    bestAsk: 0.106,
    midPrice: 0.105,
    spread: 0.002,
    lastTradePrice: 0.104,
    liquidity: 100,
    minOrderSize: 1,
    gammaCreatedAt: null,
    snapshotTs: NOW,
    ...overrides,
  };
}

function zeroSignals(overrides: Partial<ScaleInMarketSignals> = {}): ScaleInMarketSignals {
  return {
    recovery60: 0,
    range60: 0,
    std60: 0,
    tradeCount3h: 0,
    notional3h: 0,
    ...overrides,
  };
}

function signalSnapshot(overrides: Partial<SignalSnapshot> = {}): SignalSnapshot {
  return {
    tokenId,
    computedAtMs: NOW,
    windowStartMs: NOW - 3_600_000,
    hotSampleCount: 90,
    warmBucketCount3h: 180,
    recovery60: 0,
    range60: 0,
    std60: 0,
    tradeCount3h: 0,
    notional3h: null,
    midNow: 0.102,
    midMin60m: 0.1,
    midMax60m: 0.102,
    midMean60m: 0.101,
    insufficientForRecovery: false,
    insufficientForRange: false,
    insufficientForStd: false,
    insufficientForTradeCount: false,
    ...overrides,
  };
}

function fill(overrides: Partial<FillReceived> = {}): FillReceived {
  return {
    fillId: createFillId(`fill-${overrides.timestamp ?? NOW}`),
    orderId: createOrderId("fill-order"),
    clientOrderId: "fill-client" as ClientOrderId,
    tokenId,
    conditionId,
    side: "buy",
    price: 0.12,
    size: 50,
    sizeUsdc: 6,
    liquidityRole: LiquidityRole.Taker,
    fee: 0,
    feeRateBps: 0,
    signalReason: "scale-in",
    timestamp: NOW,
    ...overrides,
    type: "FillReceived",
  };
}

function makeManager(args: {
  profilePolicy?: ExecutionProfilePolicy;
  profilePolicyReader?: () => ExecutionProfilePolicy;
  positions?: Position[];
  orders?: Order[];
  repo?: InMemoryExecutionProfileStateRepository;
  bus?: InProcessEventBus;
  signalSnapshot?: ScaleInMarketSignals;
  signalFeedSnapshot?: SignalSnapshot | null;
  signalFeedSpy?: ReturnType<typeof vi.fn>;
  runtimeMetrics?: ReturnType<typeof makeMetrics>;
  riskEvents?: ReturnType<typeof makeRiskEvents>;
  rollup?: ExecutionProfileRollup;
  buyGuardsPolicy?: typeof DEFAULT_BUY_GUARDS_POLICY;
  effectiveResolution?: Pick<EffectiveResolutionGate, "toBuyRunwayFields">;
}): ExecutionProfileManager {
  const deps: ExecutionProfileManagerDeps = {
    bus: args.bus ?? new InProcessEventBus(),
    stateRepo: args.repo ?? new InMemoryExecutionProfileStateRepository(),
    positionRepo: makePositionRepo(args.positions ?? []),
    orderRepo: makeOrderRepo(args.orders ?? []),
    policy: args.profilePolicyReader ?? (() => args.profilePolicy ?? DEFAULT_POLICY),
    now: () => NOW,
  };
  if (args.buyGuardsPolicy != null) deps.buyGuardsPolicy = () => args.buyGuardsPolicy!;
  if (args.effectiveResolution != null) deps.effectiveResolution = args.effectiveResolution;
  if (args.runtimeMetrics != null) deps.runtimeMetrics = args.runtimeMetrics;
  if (args.riskEvents != null) deps.riskEvents = args.riskEvents;
  if (args.rollup != null) deps.rollup = args.rollup;
  if ("signalFeedSnapshot" in args) {
    const getSnapshot = args.signalFeedSpy ?? vi.fn(() => args.signalFeedSnapshot ?? null);
    deps.signalFeedReader = { getSnapshot };
  }
  if (args.signalSnapshot == null) return new ExecutionProfileManager(deps);
  return new ExecutionProfileManager({
    ...deps,
    scaleInSignalSource: {
      getSignalSnapshot: vi.fn(() => args.signalSnapshot as ScaleInMarketSignals),
    },
  });
}

function makeMetrics() {
  return {
    counters: [] as Array<{ name: string; value: number | undefined; labels: string | undefined }>,
    events: [] as Array<{ name: string; value: number; labels: string; capturedAt: string }>,
    writeCounter(name: string, value?: number, labels?: string): void {
      this.counters.push({ name, value, labels });
    },
    writeEvent(name: string, value: number, labels: string, capturedAt: string): void {
      this.events.push({ name, value, labels, capturedAt });
    },
  };
}

function makeRiskEvents() {
  return {
    inserts: [] as Array<{ eventType: string; payload: Record<string, unknown> }>,
    insert(event: { eventType: string; payload: Record<string, unknown> }): void {
      this.inserts.push(event);
    },
  };
}

function makeRollup(
  riskEvents = makeRiskEvents(),
  metrics = makeMetrics(),
): ExecutionProfileRollup {
  return new ExecutionProfileRollup({
    windowMs: 300_000,
    maxBuckets: 10_000,
    now: () => NOW,
    emit: (event) => riskEvents.insert(event),
    writeCounter: (name, value, labels) => metrics.writeCounter(name, value, labels),
    writeEvent: (name, value, labels, capturedAt) =>
      metrics.writeEvent(name, value, labels, capturedAt),
  });
}

describe("ExecutionProfileManager", () => {
  it("hydrates existing active state into the ownership cache", async () => {
    const repo = new InMemoryExecutionProfileStateRepository();
    repo.upsertState({
      tokenId,
      conditionId,
      profile: "medium",
      state: "ACCUMULATING",
      assumedAt: "2026-06-14T00:00:00.000Z",
      lastAvgEntry: 0.12,
      lastTransitionAt: "2026-06-14T00:00:00.000Z",
      activeLadderId: null,
      handoffStartedAt: null,
      metadata: null,
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
      addCount: 0,
      lastBuyAtMs: NOW - 60_000,
      initialProbeSizeUsd: 7.15,
    });
    const manager = makeManager({ profilePolicy: policy(), repo });

    await manager.start();

    expect(manager.getSnapshot(tokenId)).toMatchObject({
      profile: "medium",
      state: "ACCUMULATING",
    });
    expect(manager.isProfileOwned(tokenId)).toBe(true);
  });

  it("does not adopt generic open positions while sellLadder is disabled", async () => {
    const manager = makeManager({
      profilePolicy: policy({
        enabled: true,
        sellLadder: { enabled: false },
        adoptExistingPositions: { enabled: true },
      }),
      positions: [position()],
    });

    await manager.start();

    expect(manager.getSnapshot(tokenId)).toBeUndefined();
    expect(manager.shouldSuppressLegacySell(tokenId)).toBe(false);
  });

  it("adopts generic open positions only when sellLadder and adoption are both enabled", async () => {
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = makeManager({
      profilePolicy: policy({
        enabled: true,
        sellLadder: { enabled: true },
        adoptExistingPositions: { enabled: true },
      }),
      positions: [position()],
      runtimeMetrics: metrics,
      riskEvents,
    });

    await manager.start();

    expect(manager.getSnapshot(tokenId)).toMatchObject({ profile: "medium", state: "EXITING" });
    expect(manager.shouldSuppressLegacySell(tokenId)).toBe(true);
    expect(metrics.counters).toContainEqual({
      name: "track_execution_profile_assigned",
      value: 1,
      labels: '{"profile":"medium"}',
    });
    expect(riskEvents.inserts).toContainEqual({
      eventType: EXECUTION_PROFILE_RISK_EVENTS.assigned,
      payload: expect.objectContaining({ profile: "medium", state: "EXITING" }),
    });
  });

  it("adopts active S1_LADDER orders without enabling suppression while sellLadder is disabled", async () => {
    const manager = makeManager({
      profilePolicy: policy({
        enabled: true,
        sellLadder: { enabled: false },
        adoptExistingS1Ladders: { enabled: true },
      }),
      positions: [position({ avgEntryPrice: 0.02 })],
      orders: [order()],
    });

    await manager.start();

    expect(manager.getSnapshot(tokenId)).toMatchObject({
      profile: "cheap",
      state: "EXITING",
      activeLadderId: "ladder-1",
    });
    expect(manager.isProfileOwned(tokenId)).toBe(true);
    expect(manager.shouldSuppressLegacySell(tokenId)).toBe(false);
  });

  it("emits an UP scale-in BUY signal with stub signals when enabled and caps are disabled", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.106, midPrice: 0.1, lastTradePrice: 0.1 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      side: "buy",
      reason: "scale-in",
      decisionRuleId: "EXECUTION_PROFILE_SCALE_IN",
      suggestedPrice: 0.106,
    });
  });

  it("applies stock-close YES-tail size damp to profile scale-in", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const metrics = makeMetrics();
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000, initialProbeSizeUsd: 10 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [
        market({
          slug: "will-meta-meta-close-at-560-570-on-june-19",
          question: "Will Meta (META) close at $560-$570 on June 19?",
          outcome: "Yes",
          tags: ["stocks"],
          bestAsk: 0.106,
          midPrice: 0.1,
          lastTradePrice: 0.1,
        }),
      ],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      side: "buy",
      reason: "scale-in",
      suggestedSizeUsdc: 5,
    });
    expect(metrics.counters).toContainEqual(
      expect.objectContaining({
        name: "stock_close_yes_tail_size_damp_applied_total",
        labels: expect.stringContaining('"action":"apply"'),
      }),
    );
  });

  it("does not damp profile scale-in when applyToScaleIn is disabled", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const metrics = makeMetrics();
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000, initialProbeSizeUsd: 10 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      signalSnapshot: zeroSignals(),
      buyGuardsPolicy: {
        ...DEFAULT_BUY_GUARDS_POLICY,
        stockCloseTailSizeDamp: {
          ...DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp,
          applyToScaleIn: false,
        },
      },
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [
        market({
          slug: "will-meta-meta-close-at-560-570-on-june-19",
          question: "Will Meta (META) close at $560-$570 on June 19?",
          outcome: "Yes",
          tags: ["stocks"],
          bestAsk: 0.106,
          midPrice: 0.1,
          lastTradePrice: 0.1,
        }),
      ],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      side: "buy",
      reason: "scale-in",
      suggestedSizeUsdc: 10,
    });
    expect(metrics.counters).not.toContainEqual(
      expect.objectContaining({ name: "stock_close_yes_tail_size_damp_applied_total" }),
    );
  });

  it("skips profile scale-in when post-damp size falls below min add notional", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000, initialProbeSizeUsd: 10 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: true },
        profiles: {
          ...DEFAULT_POLICY.profiles,
          medium: {
            ...DEFAULT_POLICY.profiles.medium,
            scaleIn: {
              ...DEFAULT_POLICY.profiles.medium.scaleIn,
              minAddNotionalUsd: 6,
            },
          },
        },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [
        market({
          slug: "will-meta-meta-close-at-560-570-on-june-19",
          question: "Will Meta (META) close at $560-$570 on June 19?",
          outcome: "Yes",
          tags: ["stocks"],
          bestAsk: 0.106,
          midPrice: 0.1,
          lastTradePrice: 0.1,
        }),
      ],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(0);
    expect(manager.getPendingScaleIns()).toEqual([]);
    expect(metrics.counters).toContainEqual(
      expect.objectContaining({
        name: "stock_close_yes_tail_size_damp_skipped_total",
        labels: expect.stringContaining("stock_close_tail_damp_below_min_order"),
      }),
    );
    expect(riskEvents.inserts).toContainEqual(
      expect.objectContaining({ eventType: "stock_close_yes_tail_size_damp_skip" }),
    );
  });

  it("keeps base profile scale-in size when damped size is below min and skipBelowMinOrder is false", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const metrics = makeMetrics();
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000, initialProbeSizeUsd: 10 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      signalSnapshot: zeroSignals(),
      buyGuardsPolicy: {
        ...DEFAULT_BUY_GUARDS_POLICY,
        stockCloseTailSizeDamp: {
          ...DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp,
          skipBelowMinOrder: false,
        },
      },
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
        profiles: {
          ...DEFAULT_POLICY.profiles,
          medium: {
            ...DEFAULT_POLICY.profiles.medium,
            scaleIn: {
              ...DEFAULT_POLICY.profiles.medium.scaleIn,
              minAddNotionalUsd: 6,
            },
          },
        },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [
        market({
          slug: "will-meta-meta-close-at-560-570-on-june-19",
          question: "Will Meta (META) close at $560-$570 on June 19?",
          outcome: "Yes",
          tags: ["stocks"],
          bestAsk: 0.106,
          midPrice: 0.1,
          lastTradePrice: 0.1,
        }),
      ],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      side: "buy",
      reason: "scale-in",
      suggestedSizeUsdc: 10,
    });
    expect(metrics.counters).toContainEqual(
      expect.objectContaining({
        name: "stock_close_yes_tail_size_damp_telemetry_total",
        labels: expect.stringContaining("stock_close_tail_damp_below_min_order"),
      }),
    );
    expect(manager.getPendingScaleIns()).toHaveLength(1);
  });

  it("blocks profile D3 near-death scale-in inside effective runway", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const metrics = makeMetrics();
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000, initialProbeSizeUsd: 10 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      signalSnapshot: zeroSignals({ recovery60: 1 }),
      effectiveResolution: {
        toBuyRunwayFields: vi.fn(() => ({
          effectiveResolutionAt: new Date(NOW + 6 * 3_600_000).toISOString(),
          effectiveRunwayHours: 6,
          calendarMissing: false,
          appliesToBuy: false,
          marketClass: "OTHER" as const,
          confidence: "high" as const,
        })),
      },
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
        profiles: {
          ...DEFAULT_POLICY.profiles,
          medium: {
            ...DEFAULT_POLICY.profiles.medium,
            scaleIn: {
              ...DEFAULT_POLICY.profiles.medium.scaleIn,
              modes: {
                ...DEFAULT_POLICY.profiles.medium.scaleIn.modes,
                avgDown: {
                  ...DEFAULT_POLICY.profiles.medium.scaleIn.modes.avgDown,
                  enabled: true,
                  requireRecovery: false,
                },
              },
            },
          },
        },
      }),
      positions: [position({ avgEntryPrice: 0.08, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.03, midPrice: 0.03, lastTradePrice: 0.03 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(0);
    expect(manager.getPendingScaleIns()).toEqual([]);
    expect(metrics.counters).toContainEqual(
      expect.objectContaining({
        name: "d3_near_death_scale_in_suppressed_total",
        labels: expect.stringContaining("near_death_add"),
      }),
    );
  });

  it("does not block medium-confidence stock-close penny scale-in without severe drop", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000, initialProbeSizeUsd: 10 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      signalSnapshot: zeroSignals({ recovery60: 1 }),
      effectiveResolution: {
        toBuyRunwayFields: vi.fn(() => ({
          effectiveResolutionAt: new Date(NOW + 6 * 3_600_000).toISOString(),
          effectiveRunwayHours: 6,
          calendarMissing: false,
          appliesToBuy: true,
          marketClass: "US_EQUITY_CLOSE" as const,
          confidence: "medium" as const,
        })),
      },
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
        profiles: {
          ...DEFAULT_POLICY.profiles,
          medium: {
            ...DEFAULT_POLICY.profiles.medium,
            scaleIn: {
              ...DEFAULT_POLICY.profiles.medium.scaleIn,
              modes: {
                ...DEFAULT_POLICY.profiles.medium.scaleIn.modes,
                avgDown: {
                  ...DEFAULT_POLICY.profiles.medium.scaleIn.modes.avgDown,
                  enabled: true,
                  requireRecovery: false,
                },
              },
            },
          },
        },
      }),
      positions: [position({ avgEntryPrice: 0.012, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [
        market({
          slug: "will-meta-meta-close-at-560-570-on-june-19",
          question: "Will Meta (META) close at $560-$570 on June 19?",
          outcome: "Yes",
          tags: ["stocks"],
          bestAsk: 0.01,
          midPrice: 0.01,
          lastTradePrice: 0.01,
          minOrderSize: 1,
        }),
      ],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.suggestedPrice).toBe(0.01);
  });

  it("skips scale-in for ABANDONED_DORMANT state with a diagnostic counter", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const metrics = makeMetrics();
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ state: "ABANDONED_DORMANT", lastBuyAtMs: NOW - 2_000_000 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.106, midPrice: 0.1, lastTradePrice: 0.1 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(0);
    expect(metrics.counters).toContainEqual({
      name: "scale_in_skipped_dormant",
      value: 1,
      labels: "{}",
    });
  });

  it("records cost-cap counters and risk event when Spec 2 blocks scale-in", async () => {
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const rollup = makeRollup(riskEvents, metrics);
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000, addCount: 1, initialProbeSizeUsd: 7.15 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      rollup,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: true },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 30 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.106 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    rollup.flushAll("test");

    expect(metrics.counters).toContainEqual({
      name: "track_execution_profile_cost_cap_enforced",
      value: 1,
      labels: '{"decision":"block","profile":"medium","severity":"between"}',
    });
    expect(metrics.counters).toContainEqual({
      name: "track_execution_profile_cost_cap_between",
      value: 1,
      labels: '{"profile":"medium"}',
    });
    expect(riskEvents.inserts).toContainEqual({
      eventType: EXECUTION_PROFILE_RISK_EVENTS.costCapDecided,
      payload: expect.objectContaining({
        tokenId: String(tokenId),
        profile: "medium",
        allow: false,
        severity: "between",
      }),
    });
    expect(
      riskEvents.inserts.some(
        (event) => event.eventType === EXECUTION_PROFILE_RISK_EVENTS.decisionChainRollup,
      ),
    ).toBe(true);
  });

  it("uses lastBuyAtMs null as zero elapsed time and blocks adopted positions", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([state({ lastBuyAtMs: null })]);
    const manager = makeManager({
      bus,
      repo,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.106 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(0);
  });

  it("keeps using stub signals when signalFeed is disabled even if useRealFeed is true", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const realFeed = vi.fn(() => signalSnapshot({ tradeCount3h: 80 }));
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      signalFeedSnapshot: signalSnapshot({ tradeCount3h: 80 }),
      signalFeedSpy: realFeed,
      profilePolicy: policy({
        enabled: true,
        signalFeed: { ...DEFAULT_POLICY.signalFeed, enabled: false },
        scaleIn: { enabled: true, useRealFeed: true },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.102, midPrice: 0.101, lastTradePrice: 0.101 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(realFeed).not.toHaveBeenCalled();
    expect(signals).toHaveLength(0);
  });

  it("keeps using stub signals when useRealFeed is disabled while signalFeed buffers run", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const realFeed = vi.fn(() => signalSnapshot({ tradeCount3h: 80 }));
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      signalFeedSnapshot: signalSnapshot({ tradeCount3h: 80 }),
      signalFeedSpy: realFeed,
      profilePolicy: policy({
        enabled: true,
        signalFeed: { ...DEFAULT_POLICY.signalFeed, enabled: true },
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.102, midPrice: 0.101, lastTradePrice: 0.101 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(realFeed).not.toHaveBeenCalled();
    expect(signals).toHaveLength(0);
  });

  it("uses real signal snapshots only when signalFeed and useRealFeed are both enabled", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const realFeed = vi.fn(() => signalSnapshot({ tradeCount3h: 80 }));
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ lastBuyAtMs: NOW - 2_000_000 }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      signalFeedSnapshot: signalSnapshot({ tradeCount3h: 80 }),
      signalFeedSpy: realFeed,
      profilePolicy: policy({
        enabled: true,
        signalFeed: { ...DEFAULT_POLICY.signalFeed, enabled: true },
        scaleIn: { enabled: true, useRealFeed: true },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.102, midPrice: 0.101, lastTradePrice: 0.101 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(realFeed).toHaveBeenCalledWith(tokenId, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      side: "buy",
      reason: "scale-in",
      suggestedPrice: 0.102,
    });
  });

  it("records profile reclassification counter and risk event on BUY fill avg-entry update", async () => {
    const repo = new InMemoryExecutionProfileStateRepository([state({ state: "PROBING" })]);
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      profilePolicy: policy({ enabled: true }),
      positions: [position({ avgEntryPrice: 0.02 })],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ timestamp: NOW + 1_000, sizeUsdc: 1 }));

    expect(repo.getState(tokenId)).toMatchObject({ profile: "cheap" });
    expect(metrics.counters).toContainEqual({
      name: "track_execution_profile_reclassified",
      value: 1,
      labels: '{"fromProfile":"medium","toProfile":"cheap"}',
    });
    expect(riskEvents.inserts).toContainEqual({
      eventType: EXECUTION_PROFILE_RISK_EVENTS.reclassified,
      payload: expect.objectContaining({
        tokenId: String(tokenId),
        fromProfile: "medium",
        toProfile: "cheap",
      }),
    });
  });

  it("captures firstBuyAtMs metadata on the first BUY fill", async () => {
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ addCount: 0, metadata: null }),
    ]);
    const bus = new InProcessEventBus();
    const manager = makeManager({
      bus,
      repo,
      profilePolicy: policy({ enabled: true }),
      positions: [position({ avgEntryPrice: 0.12 })],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ timestamp: NOW }));

    expect(repo.getState(tokenId)?.metadata).toMatchObject({ firstBuyAtMs: NOW });
  });

  it("runs the abandonment scanner on interval when root and band are enabled", async () => {
    vi.useFakeTimers();
    const repo = new InMemoryExecutionProfileStateRepository([
      state({
        addCount: 3,
        lastBuyAtMs: NOW - 2_700_000,
        metadata: { firstBuyAtMs: NOW - 2_700_000 },
      }),
    ]);
    const manager = makeManager({
      repo,
      profilePolicy: policy({
        enabled: true,
        abandonment: {
          ...DEFAULT_POLICY.abandonment,
          enabled: true,
          evaluationIntervalMs: 60_000,
          bands: {
            ...DEFAULT_POLICY.abandonment.bands,
            medium_low: { ...DEFAULT_POLICY.abandonment.bands.medium_low, enabled: true },
          },
        },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 13.45 })],
    });

    await manager.start();
    vi.advanceTimersByTime(60_000);

    expect(repo.getState(tokenId)?.state).toBe("ABANDONED_DORMANT");
    await manager.stop();
    vi.useRealTimers();
  });

  it("keeps abandonment dark when root is enabled but all bands remain disabled", async () => {
    vi.useFakeTimers();
    const repo = new InMemoryExecutionProfileStateRepository([
      state({
        addCount: 3,
        lastBuyAtMs: NOW - 2_700_000,
        metadata: { firstBuyAtMs: NOW - 2_700_000 },
      }),
    ]);
    const manager = makeManager({
      repo,
      profilePolicy: policy({
        enabled: true,
        abandonment: {
          ...DEFAULT_POLICY.abandonment,
          enabled: true,
          evaluationIntervalMs: 60_000,
        },
      }),
      positions: [position({ avgEntryPrice: 0.1, costBasisUsdc: 13.45 })],
    });

    await manager.start();
    vi.advanceTimersByTime(60_000);

    expect(repo.getState(tokenId)?.state).toBe("PROBING");
    await manager.stop();
    vi.useRealTimers();
  });

  it("initializes a PROBING profile state on the first BUY fill when no prior state exists", async () => {
    const repo = new InMemoryExecutionProfileStateRepository();
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      profilePolicy: policy({ enabled: true }),
      positions: [position({ avgEntryPrice: 0.12 })],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ timestamp: NOW, sizeUsdc: 6 }));

    expect(repo.getState(tokenId)).toMatchObject({
      state: "PROBING",
      profile: "medium",
      addCount: 1,
      lastBuyAtMs: NOW,
      initialProbeSizeUsd: 6,
    });
    expect(manager.isProfileOwned(tokenId)).toBe(true);
    expect(
      metrics.counters.filter((counter) => counter.name === "track_execution_profile_assigned"),
    ).toEqual([
      { name: "track_execution_profile_assigned", value: 1, labels: '{"profile":"medium"}' },
    ]);
    expect(
      riskEvents.inserts.filter(
        (event) => event.eventType === EXECUTION_PROFILE_RISK_EVENTS.assigned,
      ),
    ).toHaveLength(1);
  });

  it("does not duplicate the assignment when the second BUY fill follows initialization", async () => {
    const repo = new InMemoryExecutionProfileStateRepository();
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      profilePolicy: policy({ enabled: true }),
      positions: [position({ avgEntryPrice: 0.12 })],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ timestamp: NOW, sizeUsdc: 6 }));
    await bus.publish("FillReceived", fill({ timestamp: NOW + 1_000, sizeUsdc: 5 }));

    expect(repo.getState(tokenId)).toMatchObject({ state: "ACCUMULATING", addCount: 2 });
    expect(
      metrics.counters.filter((counter) => counter.name === "track_execution_profile_assigned"),
    ).toHaveLength(1);
    expect(
      riskEvents.inserts.filter(
        (event) => event.eventType === EXECUTION_PROFILE_RISK_EVENTS.assigned,
      ),
    ).toHaveLength(1);
  });

  it("does not create profile state for a SELL fill when no prior state exists", async () => {
    const repo = new InMemoryExecutionProfileStateRepository();
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      profilePolicy: policy({ enabled: true }),
      positions: [position({ avgEntryPrice: 0.12 })],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ side: "sell", timestamp: NOW }));

    expect(repo.getState(tokenId)).toBeNull();
    expect(
      metrics.counters.filter((counter) => counter.name === "track_execution_profile_assigned"),
    ).toHaveLength(0);
  });

  it("transitions profile-owned profitable SELL fills into HARVESTING with last-sell metadata", async () => {
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ state: "ACCUMULATING", lastAvgEntry: 0.2, metadata: null }),
    ]);
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      profilePolicy: policy({ enabled: true }),
      positions: [position({ avgEntryPrice: 0.2 })],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ side: "sell", price: 0.265, timestamp: NOW }));

    expect(repo.getState(tokenId)).toMatchObject({
      state: "HARVESTING",
      metadata: {
        lastSellPrice: 0.265,
        lastSellAtMs: NOW,
        firstProfitableSellAtMs: NOW,
        harvestSellCount: 1,
      },
    });
    expect(metrics.counters).toContainEqual(
      expect.objectContaining({
        name: "harvesting_state_entered_total",
        labels: expect.stringContaining("first_profitable_sell"),
      }),
    );
    expect(riskEvents.inserts).toContainEqual(
      expect.objectContaining({ eventType: "harvest_lifecycle_activated" }),
    );
  });

  it("does not transition unprofitable SELL fills or when transition kill switch is off", async () => {
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ state: "ACCUMULATING", lastAvgEntry: 0.2 }),
    ]);
    const bus = new InProcessEventBus();
    const manager = makeManager({
      bus,
      repo,
      profilePolicy: policy({
        enabled: true,
        scaleIn: {
          ...DEFAULT_POLICY.scaleIn,
          harvestingGuard: {
            ...DEFAULT_POLICY.scaleIn.harvestingGuard,
            transitionEnabled: false,
          },
        },
      }),
      positions: [position({ avgEntryPrice: 0.2 })],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ side: "sell", price: 0.19, timestamp: NOW }));
    expect(repo.getState(tokenId)?.state).toBe("ACCUMULATING");

    await bus.publish("FillReceived", fill({ side: "sell", price: 0.265, timestamp: NOW + 1 }));
    expect(repo.getState(tokenId)?.state).toBe("ACCUMULATING");
  });

  it("does not transition S4 dust auto-close SELL fills into HARVESTING", async () => {
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ state: "ACCUMULATING", lastAvgEntry: 0.2 }),
    ]);
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      profilePolicy: policy({ enabled: true }),
      positions: [position({ avgEntryPrice: 0.2 })],
    });

    await manager.start();
    await bus.publish(
      "FillReceived",
      fill({
        side: "sell",
        price: 0.265,
        timestamp: NOW,
        decisionRuleId: "S4_DUST_AUTO_CLOSE",
      }),
    );

    expect(repo.getState(tokenId)?.state).toBe("ACCUMULATING");
    expect(metrics.counters).not.toContainEqual(
      expect.objectContaining({ name: "harvesting_state_entered_total" }),
    );
    expect(riskEvents.inserts).not.toContainEqual(
      expect.objectContaining({ eventType: "harvest_lifecycle_activated" }),
    );
  });

  it("honors hot-reloaded harvesting guard suppression kill switch", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const metrics = makeMetrics();
    let activePolicy = policy({
      enabled: true,
      scaleIn: { enabled: true, useRealFeed: false },
      costCaps: { enabled: false },
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({
        state: "HARVESTING",
        lastBuyAtMs: NOW - 2_000_000,
        initialProbeSizeUsd: 10,
        metadata: { lastSellPrice: 0.265, lastSellAtMs: NOW - 4 * 60_000 },
      }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      signalSnapshot: zeroSignals(),
      profilePolicyReader: () => activePolicy,
      positions: [position({ avgEntryPrice: 0.2, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.309, midPrice: 0.3, lastTradePrice: 0.3 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    expect(signals).toHaveLength(0);
    expect(metrics.counters).toContainEqual(
      expect.objectContaining({ name: "harvesting_buy_above_last_sell_suppressed_total" }),
    );

    activePolicy = policy({
      enabled: true,
      scaleIn: {
        enabled: true,
        useRealFeed: false,
        harvestingGuard: { enabled: false },
      },
      costCaps: { enabled: false },
    });
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.309, midPrice: 0.3, lastTradePrice: 0.3 })],
      timestamp: NOW + 1,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(repo.getState(tokenId)?.state).toBe("HARVESTING");
    expect(signals).toHaveLength(1);
  });

  it("honors hot-reloaded harvesting transition kill switch", async () => {
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ state: "ACCUMULATING", lastAvgEntry: 0.2 }),
    ]);
    const bus = new InProcessEventBus();
    let activePolicy = policy({ enabled: true });
    const manager = makeManager({
      bus,
      repo,
      profilePolicyReader: () => activePolicy,
      positions: [position({ avgEntryPrice: 0.2 })],
    });

    await manager.start();
    activePolicy = policy({
      enabled: true,
      scaleIn: {
        harvestingGuard: { transitionEnabled: false },
      },
    });
    await bus.publish("FillReceived", fill({ side: "sell", price: 0.265, timestamp: NOW }));

    expect(repo.getState(tokenId)?.state).toBe("ACCUMULATING");
  });

  it("honors both harvesting kill switches as a no-op hot reload", async () => {
    const repo = new InMemoryExecutionProfileStateRepository([
      state({ state: "ACCUMULATING", lastAvgEntry: 0.2 }),
    ]);
    const bus = new InProcessEventBus();
    let activePolicy = policy({ enabled: true });
    const manager = makeManager({
      bus,
      repo,
      profilePolicyReader: () => activePolicy,
      positions: [position({ avgEntryPrice: 0.2 })],
    });

    await manager.start();
    activePolicy = policy({
      enabled: true,
      scaleIn: {
        harvestingGuard: {
          enabled: false,
          transitionEnabled: false,
        },
      },
    });
    await bus.publish("FillReceived", fill({ side: "sell", price: 0.265, timestamp: NOW }));

    expect(repo.getState(tokenId)?.state).toBe("ACCUMULATING");
  });

  it("suppresses the Rai post-sell buyback in HARVESTING before publishing scale-in", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({
        state: "HARVESTING",
        lastBuyAtMs: NOW - 2_000_000,
        initialProbeSizeUsd: 10,
        metadata: { lastSellPrice: 0.265, lastSellAtMs: NOW - 4 * 60_000 },
      }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.2, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.309, midPrice: 0.3, lastTradePrice: 0.3 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(signals).toHaveLength(0);
    expect(manager.getPendingScaleIns()).toEqual([]);
    expect(metrics.counters).toContainEqual(
      expect.objectContaining({
        name: "harvesting_buy_above_last_sell_suppressed_total",
        labels: expect.stringContaining('"overrideStatus":"failed_closed"'),
      }),
    );
    expect(metrics.counters).not.toContainEqual(
      expect.objectContaining({
        name: "harvesting_buy_allowed_total",
      }),
    );
    expect(riskEvents.inserts).toContainEqual(
      expect.objectContaining({ eventType: "harvesting_buy_above_last_sell_suppressed" }),
    );
  });

  it("records allowed harvesting buy telemetry with the real scale-in mode", async () => {
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const repo = new InMemoryExecutionProfileStateRepository([
      state({
        state: "HARVESTING",
        lastBuyAtMs: NOW - 2_000_000,
        initialProbeSizeUsd: 10,
        metadata: { lastSellPrice: 0.265, lastSellAtMs: NOW - 4 * 60_000 },
      }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: { enabled: true, useRealFeed: false },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.2, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.25, midPrice: 0.25, lastTradePrice: 0.25 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(metrics.counters).toContainEqual(
      expect.objectContaining({
        name: "harvesting_buy_allowed_total",
        labels: expect.stringContaining('"mode":"up"'),
      }),
    );
    expect(metrics.counters).toContainEqual(
      expect.objectContaining({
        name: "harvesting_buy_allowed_total",
        labels: expect.stringContaining('"reason":"below_last_sell"'),
      }),
    );
  });

  it("allows HARVESTING buybacks below last sell, outside the window, or with strong override", async () => {
    const run = async (args: {
      bestAsk: number;
      lastSellAtMs: number;
      signalFeedSnapshot?: SignalSnapshot | null;
      scaleIn?: ScaleInOverrides;
    }): Promise<Signal[]> => {
      const bus = new InProcessEventBus();
      const signals: Signal[] = [];
      bus.subscribe("SignalProduced", async ({ signal }) => {
        signals.push(signal);
      });
      const repo = new InMemoryExecutionProfileStateRepository([
        state({
          state: "HARVESTING",
          lastBuyAtMs: NOW - 2_000_000,
          initialProbeSizeUsd: 10,
          metadata: { lastSellPrice: 0.265, lastSellAtMs: args.lastSellAtMs },
        }),
      ]);
      const managerArgs: Parameters<typeof makeManager>[0] = {
        bus,
        repo,
        signalSnapshot: zeroSignals(),
        profilePolicy: policy({
          enabled: true,
          signalFeed: { ...DEFAULT_POLICY.signalFeed, enabled: args.signalFeedSnapshot != null },
          scaleIn: args.scaleIn ?? { enabled: true, useRealFeed: false },
          costCaps: { enabled: false },
        }),
        positions: [position({ avgEntryPrice: 0.2, costBasisUsdc: 8 })],
      };
      if (args.signalFeedSnapshot !== undefined) {
        managerArgs.signalFeedSnapshot = args.signalFeedSnapshot;
      }
      const manager = makeManager(managerArgs);
      await manager.start();
      await bus.publish("MarketSnapshotHeartbeat", {
        markets: [
          market({ bestAsk: args.bestAsk, midPrice: args.bestAsk, lastTradePrice: args.bestAsk }),
        ],
        timestamp: NOW,
        reason: "full_lifetime_active_position",
        source: "market-data",
      });
      return signals;
    };

    await expect(run({ bestAsk: 0.25, lastSellAtMs: NOW - 4 * 60_000 })).resolves.toHaveLength(1);
    await expect(run({ bestAsk: 0.309, lastSellAtMs: NOW - 61 * 60_000 })).resolves.toHaveLength(1);
    await expect(
      run({
        bestAsk: 0.309,
        lastSellAtMs: NOW - 4 * 60_000,
        signalFeedSnapshot: signalSnapshot({ recovery60: 0.1 }),
        scaleIn: { ...DEFAULT_POLICY.scaleIn, enabled: true, useRealFeed: true },
      }),
    ).resolves.toHaveLength(1);
  });

  it("honors the harvesting guard enabled kill switch without disabling HARVESTING state", async () => {
    const bus = new InProcessEventBus();
    const signals: Signal[] = [];
    bus.subscribe("SignalProduced", async ({ signal }) => {
      signals.push(signal);
    });
    const repo = new InMemoryExecutionProfileStateRepository([
      state({
        state: "HARVESTING",
        lastBuyAtMs: NOW - 2_000_000,
        initialProbeSizeUsd: 10,
        metadata: { lastSellPrice: 0.265, lastSellAtMs: NOW - 4 * 60_000 },
      }),
    ]);
    const manager = makeManager({
      bus,
      repo,
      signalSnapshot: zeroSignals(),
      profilePolicy: policy({
        enabled: true,
        scaleIn: {
          ...DEFAULT_POLICY.scaleIn,
          enabled: true,
          harvestingGuard: {
            ...DEFAULT_POLICY.scaleIn.harvestingGuard,
            enabled: false,
          },
        },
        costCaps: { enabled: false },
      }),
      positions: [position({ avgEntryPrice: 0.2, costBasisUsdc: 8 })],
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ bestAsk: 0.309, midPrice: 0.3, lastTradePrice: 0.3 })],
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(repo.getState(tokenId)?.state).toBe("HARVESTING");
    expect(signals).toHaveLength(1);
  });

  it("does not create profile state on a BUY fill when no open position exists", async () => {
    const repo = new InMemoryExecutionProfileStateRepository();
    const bus = new InProcessEventBus();
    const manager = makeManager({
      bus,
      repo,
      profilePolicy: policy({ enabled: true }),
      positions: [],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ timestamp: NOW }));

    expect(repo.getState(tokenId)).toBeNull();
  });

  it("remains inert on a first BUY fill when the feature is disabled", async () => {
    const repo = new InMemoryExecutionProfileStateRepository();
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      profilePolicy: policy({ enabled: false }),
      positions: [position({ avgEntryPrice: 0.12 })],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ timestamp: NOW }));

    expect(repo.getState(tokenId)).toBeNull();
    expect(
      metrics.counters.filter((counter) => counter.name === "track_execution_profile_assigned"),
    ).toHaveLength(0);
  });

  it("updates addCount directly on repeated BUY fills while reducer state no-ops", async () => {
    const repo = new InMemoryExecutionProfileStateRepository([state({ state: "PROBING" })]);
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = makeManager({
      bus,
      repo,
      runtimeMetrics: metrics,
      riskEvents,
      profilePolicy: policy({ enabled: true }),
      positions: [position()],
    });

    await manager.start();
    await bus.publish("FillReceived", fill({ timestamp: NOW + 1_000, sizeUsdc: 6 }));
    expect(repo.getState(tokenId)).toMatchObject({
      state: "ACCUMULATING",
      addCount: 1,
      lastBuyAtMs: NOW + 1_000,
      initialProbeSizeUsd: 7.15,
    });
    expect(metrics.counters).toContainEqual({
      name: "track_execution_profile_state_transition",
      value: 1,
      labels: '{"from":"PROBING","to":"ACCUMULATING"}',
    });
    expect(riskEvents.inserts).toContainEqual({
      eventType: EXECUTION_PROFILE_RISK_EVENTS.stateChanged,
      payload: expect.objectContaining({ from: "PROBING", to: "ACCUMULATING" }),
    });

    await bus.publish("FillReceived", fill({ timestamp: NOW + 2_000, sizeUsdc: 5 }));
    expect(repo.getState(tokenId)).toMatchObject({
      state: "ACCUMULATING",
      addCount: 2,
      lastBuyAtMs: NOW + 2_000,
      initialProbeSizeUsd: 7.15,
    });

    await bus.publish("FillReceived", fill({ timestamp: NOW + 3_000, sizeUsdc: 4 }));
    expect(repo.getState(tokenId)).toMatchObject({
      state: "ACCUMULATING",
      addCount: 3,
      lastBuyAtMs: NOW + 3_000,
      initialProbeSizeUsd: 7.15,
    });
  });
});
