import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_SELL_LOOP_GUARD_POLICY,
  OrderType,
  PositionStatus,
  createCommandId,
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
  type AlgoDecisionRule,
  type AlgoSizeRule,
  type ClientOrderId,
  type LegState,
  type NormalizedMarket,
  type Order,
  type OrderBookSnapshot,
  type OrderRepository,
  type Position,
  type PositionRepository,
  type RiskEventRepository,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { RuntimeMetricWriter } from "../../../runtime-metric-writer.js";
import type { Logger } from "../../../logger.js";
import { evaluateDecisionPlan } from "../../algo-decision/decision-planner.js";
import { SellLoopGuardModule } from "../../sell-loop-guard/sell-loop-guard-module.js";
import { S1_LADDER_RULE_ID, S1LadderModule } from "../s1-ladder-module.js";
import type Database from "better-sqlite3";

const tokenId = createTokenId("s1-align-token");
const conditionId = createConditionId("s1-align-condition");
const NOW = Date.parse("2026-06-12T10:00:00.000Z");

const silentLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("s1-pos"),
    tokenId,
    conditionId,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.014,
    costBasisUsdc: 1.4,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: PositionStatus.Open,
    entryStyle: "probe",
    openedAt: "2026-06-12T09:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-12T09:00:00.000Z",
    ...overrides,
  };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("s1-order-1"),
    clientOrderId: "s1-client-1" as ClientOrderId,
    tokenId,
    conditionId,
    side: "sell",
    orderType: OrderType.Gtc,
    postOnly: true,
    price: 0.05,
    size: 10,
    sizeUsdc: 0.5,
    status: "open",
    exchangeOrderId: "exchange-s1-order-1",
    signalId: "s1-signal",
    signalReason: "repricing-exit",
    decisionRuleId: S1_LADDER_RULE_ID,
    botRunId: "run-1" as any,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    metadata: { s1: { ladderId: "ladder-1", tierIndex: 0, handoffStartedAt: null } },
    ...overrides,
  };
}

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId,
    slug: "align-like-market",
    eventSlug: "align-like",
    eventMarketCount: 1,
    question: "ALIGN like?",
    outcome: "YES",
    regime: "threshold",
    horizon: "daily",
    endDate: "2026-06-12T12:00:01.000Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.046,
    bestAsk: 0.176,
    midPrice: 0.111,
    spread: 0.13,
    minOrderSize: 10,
    gammaCreatedAt: null,
    snapshotTs: NOW,
    ...overrides,
  };
}

function book(overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    tokenId,
    bids: [{ price: 0.046, size: 5 }],
    asks: [{ price: 0.176, size: 100 }],
    bestBid: 0.046,
    bestAsk: 0.176,
    midPrice: 0.111,
    spread: 0.13,
    minOrderSize: 10,
    timestamp: NOW,
    ...overrides,
  };
}

function makePositionRepo(positions: Position[]): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn((id) => positions.find((p) => p.tokenId === id) ?? null),
    findOpen: vi.fn(() => positions.filter((p) => p.status === PositionStatus.Open)),
    findDust: vi.fn(() => []),
    findAll: vi.fn(() => positions),
    findOpenByEntryStyle: vi.fn(() => []),
  };
}

function makeOrderRepo(orders: Order[]): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn((id) => orders.find((o) => o.orderId === id) ?? null),
    findByClientOrderId: vi.fn((id) => orders.find((o) => o.clientOrderId === id) ?? null),
    findByExchangeOrderId: vi.fn((id) => orders.find((o) => o.exchangeOrderId === id) ?? null),
    findOpen: vi.fn(() =>
      orders.filter((o) => ["pending", "open", "partially-filled"].includes(o.status)),
    ),
    findByTokenId: vi.fn((id) => orders.filter((o) => o.tokenId === id)),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn(() => 0),
  };
}

function makeRiskEvents(): RiskEventRepository & {
  inserts: Array<{ eventType: string; payload: Record<string, unknown> }>;
} {
  const inserts: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  return {
    inserts,
    insert: (event) => inserts.push(event),
    countSince: () => 0,
  };
}

const decisionRules: AlgoDecisionRule[] = [
  {
    id: 1,
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
    action: "HOLD",
  },
];

const buySizeRules: AlgoSizeRule[] = [
  {
    id: 1,
    actionType: "BUY",
    priority: 1,
    ruleId: "BUY-SIZE",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1,
  },
];

const sellSizeRules: AlgoSizeRule[] = [
  {
    id: 2,
    actionType: "SELL",
    priority: 1,
    ruleId: "SELL-SIZE",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1,
  },
];

function legState(overrides: Partial<LegState> = {}): LegState {
  return {
    tokenId,
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.014,
    firstTradeAt: "2026-06-12T09:00:00.000Z",
    lastTradeAt: "2026-06-12T09:00:00.000Z",
    updatedAt: "2026-06-12T09:00:00.000Z",
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 1.4,
    cumulativeSellSize: 0,
    ...overrides,
  };
}

function readMetricValue(db: Database.Database, metricName: string): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(value), 0) AS value FROM runtime_metrics WHERE metric_name = ?")
    .get(metricName) as { value: number } | undefined;
  return row?.value ?? 0;
}

describe("S1LadderModule", () => {
  let metricsDb: Database.Database;

  beforeEach(async () => {
    const Database = (await import("better-sqlite3")).default;
    metricsDb = new Database(":memory:");
    metricsDb.exec(`
      CREATE TABLE runtime_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        labels TEXT,
        captured_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  afterEach(() => {
    metricsDb.close();
  });

  it("places one deterministic four-tier ladder and assumes ownership for ALIGN-like thin books", async () => {
    const bus = new InProcessEventBus();
    const placed: Array<{
      command: { clientOrderId: ClientOrderId; decisionRuleId?: string | null };
    }> = [];
    bus.subscribe("PlaceOrderRequested", async (event) => {
      placed.push(event);
    });
    const riskEvents = makeRiskEvents();
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo([]),
      policy: () => ({ ...DEFAULT_EXECUTION_POLICY.trackS1, enabled: true }),
      runtimeMetrics: new RuntimeMetricWriter(metricsDb, () => new Date(NOW)),
      riskEventRepo: riskEvents,
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market()],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market()],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW + 1,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await bus.drain();

    expect(module.isS1OwnedToken(tokenId)).toBe(true);
    expect(placed).toHaveLength(4);
    expect(new Set(placed.map((p) => p.command.clientOrderId)).size).toBe(4);
    expect(placed.every((p) => p.command.decisionRuleId === S1_LADDER_RULE_ID)).toBe(true);
    expect(riskEvents.inserts.some((e) => e.eventType === "s1_ownership_assumed")).toBe(true);
    await module.stop();
  });

  it("runs the ALIGN chain: ownership, deterministic ladder, D8 suppression, loop guard exemption, and BUY continuity", async () => {
    const bus = new InProcessEventBus();
    const placed: Array<{
      command: { clientOrderId: ClientOrderId; decisionRuleId?: string | null };
    }> = [];
    bus.subscribe("PlaceOrderRequested", async (event) => {
      placed.push(event);
    });
    const metrics = new RuntimeMetricWriter(metricsDb, () => new Date(NOW));
    const riskEvents = makeRiskEvents();
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo([]),
      policy: () => ({ ...DEFAULT_EXECUTION_POLICY.trackS1, enabled: true }),
      runtimeMetrics: metrics,
      riskEventRepo: riskEvents,
      log: silentLog,
      now: () => NOW,
    });
    const loopGuard = new SellLoopGuardModule({
      bus,
      policy: () => DEFAULT_SELL_LOOP_GUARD_POLICY,
      runtimeMetrics: metrics,
      riskEventRepo: riskEvents,
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    await loopGuard.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market()],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await bus.drain();

    const s1Ownership = module.getSnapshot(tokenId);
    expect(s1Ownership?.owned).toBe(true);
    expect(placed).toHaveLength(4);
    expect(new Set(placed.map((p) => p.command.clientOrderId)).size).toBe(4);

    const d8Result = evaluateDecisionPlan({
      tokenId,
      now: NOW,
      selectedForEntry: false,
      hasPendingBuyOrder: false,
      legState: legState(),
      position: position(),
      market: market(),
      prevMidPrice: null,
      decisionRules,
      buySizeRules,
      sellSizeRules,
      executionPolicy: {
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, holdSecondsMin: 0 },
        lossExit: { ...DEFAULT_EXECUTION_POLICY.lossExit, enabled: false },
      },
      continuationFacts: { tradeCount: 1, tradeCountSource: "leg_local", stop: false },
      continuationMode: "leg_local",
      r23MaxMidpoint: null,
      dropReferencePrice: null,
      postBuyCooldown: null,
      latestSellOrder: null,
      hasActiveSellOrderForQd: false,
      sellLoopGuard: null,
      s1Ownership,
    });
    expect(d8Result.type).toBe("none");
    expect(d8Result.suppressions).toContainEqual(
      expect.objectContaining({ reasonCode: "s1_owned_token", decisionRuleId: "D8_PROFIT_RATIO" }),
    );

    for (let index = 0; index < 10; index++) {
      await bus.publish("OrderSkipped", {
        commandId: createCommandId(`s1-align-skip-${index}`),
        clientOrderId: `s1-align-client-${index}` as ClientOrderId,
        tokenId,
        conditionId,
        reasonCode: "post-only-cross-pre-submit",
        side: "sell",
        price: 0.046,
        size: 10,
        signalReason: "repricing-exit",
        signalId: `s1-align-signal-${index}`,
        decisionRuleId: S1_LADDER_RULE_ID,
        signalTimestamp: null,
        details: {},
        timestamp: NOW + index,
      });
    }
    await bus.drain();
    expect(loopGuard.getSnapshot(tokenId, NOW + 10)?.activeCount ?? 0).toBe(0);

    const buyResult = evaluateDecisionPlan({
      tokenId,
      now: NOW,
      selectedForEntry: true,
      hasPendingBuyOrder: false,
      legState: null,
      position: null,
      market: market({ midPrice: 0.1, bestBid: 0.09, bestAsk: 0.11, spread: 0.02 }),
      prevMidPrice: null,
      decisionRules,
      buySizeRules,
      sellSizeRules,
      executionPolicy: {
        ...DEFAULT_EXECUTION_POLICY,
        entryMinMarketAgeSeconds: 0,
        r23DipTrigger: { enabled: true, dropThresholdRatio: 0.683, windowMs: 86_400_000 },
      },
      continuationFacts: null,
      continuationMode: "leg_local",
      r23MaxMidpoint: 0.2,
      dropReferencePrice: null,
      postBuyCooldown: null,
      latestSellOrder: null,
      hasActiveSellOrderForQd: false,
      sellLoopGuard: null,
      s1Ownership,
    });
    expect(buyResult.type).toBe("signal");
    if (buyResult.type === "signal") expect(buyResult.signal.side).toBe("buy");

    await loopGuard.stop();
    await module.stop();
  });

  it("initiates idempotent Q.D handoff when an active ladder is inside the last hour", async () => {
    const bus = new InProcessEventBus();
    const cancels: Array<{ command: { orderId: string; reason: string } }> = [];
    bus.subscribe("CancelOrderRequested", async (event) => {
      cancels.push(event);
    });
    const riskEvents = makeRiskEvents();
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo([
        order({ orderId: createOrderId("s1-order-a") }),
        order({ orderId: createOrderId("s1-order-b") }),
      ]),
      policy: () => ({ ...DEFAULT_EXECUTION_POLICY.trackS1, enabled: true }),
      runtimeMetrics: new RuntimeMetricWriter(metricsDb, () => new Date(NOW)),
      riskEventRepo: riskEvents,
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    const payload = {
      markets: [market({ endDate: "2026-06-12T10:30:00.000Z" })],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW,
      reason: "full_lifetime_active_position" as const,
      source: "market-data" as const,
    };
    await bus.publish("MarketSnapshotHeartbeat", payload);
    await bus.publish("MarketSnapshotHeartbeat", payload);
    await bus.drain();

    expect(cancels).toHaveLength(2);
    expect(cancels.every((c) => c.command.reason === "s1_handoff_to_qd")).toBe(true);
    expect(riskEvents.inserts.filter((e) => e.eventType === "s1_handoff_to_qd")).toHaveLength(1);
    await module.stop();
  });

  it("releases ownership after terminal S1 order cancellation", async () => {
    const bus = new InProcessEventBus();
    const riskEvents = makeRiskEvents();
    const orders = [order({ orderId: createOrderId("s1-order-terminal") })];
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo(orders),
      policy: () => ({ ...DEFAULT_EXECUTION_POLICY.trackS1, enabled: true }),
      runtimeMetrics: new RuntimeMetricWriter(metricsDb, () => new Date(NOW)),
      riskEventRepo: riskEvents,
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    expect(module.isS1OwnedToken(tokenId)).toBe(true);
    orders[0] = { ...orders[0]!, status: "cancelled" };
    await bus.publish("OrderCancelled", {
      commandId: "cancel-s1" as any,
      orderId: createOrderId("s1-order-terminal"),
      tokenId,
      conditionId,
      reason: "operator",
      signalReason: "repricing-exit",
      timestamp: NOW + 1,
    });
    await bus.drain();

    expect(module.isS1OwnedToken(tokenId)).toBe(false);
    expect(riskEvents.inserts.some((e) => e.eventType === "s1_ownership_released")).toBe(true);
    await module.stop();
  });

  it("releases ownership after all S1 ladder tiers fill", async () => {
    const bus = new InProcessEventBus();
    const orders = Array.from({ length: 4 }, (_, index) =>
      order({
        orderId: createOrderId(`s1-fill-order-${index}`),
        clientOrderId: `s1-fill-client-${index}` as ClientOrderId,
        metadata: { s1: { ladderId: "ladder-fill", tierIndex: index, handoffStartedAt: null } },
      }),
    );
    const metrics = new RuntimeMetricWriter(metricsDb, () => new Date(NOW));
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo(orders),
      policy: () => ({ ...DEFAULT_EXECUTION_POLICY.trackS1, enabled: true }),
      runtimeMetrics: metrics,
      riskEventRepo: makeRiskEvents(),
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    expect(module.isS1OwnedToken(tokenId)).toBe(true);
    for (let index = 0; index < orders.length; index++) {
      orders[index] = { ...orders[index]!, status: "filled" };
      await bus.publish("FillReceived", {
        fillId: createFillId(`s1-fill-${index}`),
        orderId: orders[index]!.orderId,
        clientOrderId: orders[index]!.clientOrderId,
        tokenId,
        conditionId,
        side: "sell",
        price: orders[index]!.price,
        size: orders[index]!.size,
        sizeUsdc: orders[index]!.price * orders[index]!.size,
        liquidityRole: "maker",
        fee: 0,
        feeRateBps: 0,
        signalReason: "repricing-exit",
        signalId: orders[index]!.signalId,
        decisionRuleId: S1_LADDER_RULE_ID,
        signalTimestamp: null,
        timestamp: NOW + index,
      });
    }
    await bus.drain();
    metrics.flushCounters(new Date(NOW).toISOString());

    expect(module.isS1OwnedToken(tokenId)).toBe(false);
    expect(readMetricValue(metricsDb, "track_s1_ladder_completed")).toBe(1);
    await module.stop();
  });

  it("force-releases ownership when handoff timeout expires", async () => {
    const bus = new InProcessEventBus();
    const cancels: Array<{ command: { orderId: string; reason: string } }> = [];
    bus.subscribe("CancelOrderRequested", async (event) => {
      cancels.push(event);
    });
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo([order({ orderId: createOrderId("s1-order-timeout") })]),
      policy: () => ({
        ...DEFAULT_EXECUTION_POLICY.trackS1,
        enabled: true,
        handoffTimeoutSeconds: 300,
      }),
      runtimeMetrics: new RuntimeMetricWriter(metricsDb, () => new Date(NOW)),
      riskEventRepo: makeRiskEvents(),
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    const payload = {
      markets: [market({ endDate: "2026-06-12T10:30:00.000Z" })],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW,
      reason: "full_lifetime_active_position" as const,
      source: "market-data" as const,
    };
    await bus.publish("MarketSnapshotHeartbeat", payload);
    await bus.publish("MarketSnapshotHeartbeat", {
      ...payload,
      timestamp: NOW + 300_000,
    });
    await bus.drain();

    expect(cancels).toHaveLength(2);
    expect(module.isS1OwnedToken(tokenId)).toBe(false);
    await module.stop();
  });

  it("restores handoffStartedAt on restart and keeps waiting before timeout", async () => {
    const bus = new InProcessEventBus();
    const cancels: Array<unknown> = [];
    bus.subscribe("CancelOrderRequested", async (event) => {
      cancels.push(event);
    });
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo([
        order({
          orderId: createOrderId("s1-restart-wait"),
          metadata: {
            s1: {
              ladderId: "ladder-restart",
              tierIndex: 0,
              handoffStartedAt: new Date(NOW - 60_000).toISOString(),
            },
          },
        }),
      ]),
      policy: () => ({
        ...DEFAULT_EXECUTION_POLICY.trackS1,
        enabled: true,
        handoffTimeoutSeconds: 300,
      }),
      runtimeMetrics: new RuntimeMetricWriter(metricsDb, () => new Date(NOW)),
      riskEventRepo: makeRiskEvents(),
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ endDate: "2026-06-12T10:30:00.000Z" })],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await bus.drain();

    expect(cancels).toHaveLength(0);
    expect(module.isS1OwnedToken(tokenId)).toBe(true);
    await module.stop();
  });

  it("restores handoffStartedAt on restart and force-cancels after timeout", async () => {
    const bus = new InProcessEventBus();
    const cancels: Array<unknown> = [];
    bus.subscribe("CancelOrderRequested", async (event) => {
      cancels.push(event);
    });
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo([
        order({
          orderId: createOrderId("s1-restart-timeout"),
          metadata: {
            s1: {
              ladderId: "ladder-restart",
              tierIndex: 0,
              handoffStartedAt: new Date(NOW - 301_000).toISOString(),
            },
          },
        }),
      ]),
      policy: () => ({
        ...DEFAULT_EXECUTION_POLICY.trackS1,
        enabled: true,
        handoffTimeoutSeconds: 300,
      }),
      runtimeMetrics: new RuntimeMetricWriter(metricsDb, () => new Date(NOW)),
      riskEventRepo: makeRiskEvents(),
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market({ endDate: "2026-06-12T10:30:00.000Z" })],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await bus.drain();

    expect(cancels).toHaveLength(1);
    expect(module.isS1OwnedToken(tokenId)).toBe(false);
    await module.stop();
  });

  it("blocks replacement frequency even after ownership is released", async () => {
    const bus = new InProcessEventBus();
    const placed: Array<unknown> = [];
    bus.subscribe("PlaceOrderRequested", async (event) => {
      placed.push(event);
    });
    const orders: Order[] = [];
    const module = new S1LadderModule({
      bus,
      positionRepo: makePositionRepo([position()]),
      orderRepo: makeOrderRepo(orders),
      policy: () => ({
        ...DEFAULT_EXECUTION_POLICY.trackS1,
        enabled: true,
        maxLadderReplacementsPerHour: 1,
      }),
      runtimeMetrics: new RuntimeMetricWriter(metricsDb, () => new Date(NOW)),
      riskEventRepo: makeRiskEvents(),
      log: silentLog,
      now: () => NOW,
    });

    await module.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market()],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await bus.drain();
    await bus.publish("PositionUpdated", {
      position: position({ status: PositionStatus.Closed, size: 0 }),
    });
    await bus.drain();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market()],
      booksByToken: new Map([[String(tokenId), book()]]),
      timestamp: NOW + 61_000,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await bus.drain();

    expect(placed).toHaveLength(4);
    await module.stop();
  });
});
