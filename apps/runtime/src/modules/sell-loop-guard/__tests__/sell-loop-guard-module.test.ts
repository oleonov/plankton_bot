import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SELL_LOOP_GUARD_POLICY,
  ExchangeErrorCode,
  LiquidityRole,
  OrderType,
  PositionStatus,
  createCommandId,
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
  type Position,
  type RiskEventRepository,
  type RuntimeEventMap,
  type SellLoopGuardPolicy,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { RuntimeMetricWriter } from "../../../runtime-metric-writer.js";
import type { Logger } from "../../../logger.js";
import { SellLoopGuardModule } from "../sell-loop-guard-module.js";

const TOKEN = createTokenId("tok-guard-1");
const CONDITION = createConditionId("cond-guard-1");
const NOW = Date.parse("2026-06-11T12:00:00.000Z");
const CLIENT_OID = "client-guard" as ClientOrderId;
const NO_ID_MESSAGE = "exchange returned no order id";

const silentLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => silentLog,
} as unknown as Logger;

interface RiskEventStub extends RiskEventRepository {
  inserts: Array<{ eventType: string; payload: Record<string, unknown> }>;
}

function makeRiskEventRepo(): RiskEventStub {
  const inserts: RiskEventStub["inserts"] = [];
  return {
    inserts,
    insert(event) {
      inserts.push(event);
    },
    countSince() {
      return 0;
    },
  };
}

function makeMetricsDb(): Database.Database {
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
  return db;
}

function makeRecoveryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY,
      client_order_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      condition_id TEXT NOT NULL DEFAULT '',
      side TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      exchange_error_message TEXT,
      exchange_rejection_reason TEXT,
      bot_run_id TEXT NOT NULL DEFAULT 'run',
      created_at TEXT NOT NULL
    );
    CREATE TABLE risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

interface Harness {
  bus: InProcessEventBus;
  module: SellLoopGuardModule;
  riskEvents: RiskEventStub;
  metrics: RuntimeMetricWriter;
  metricsDb: Database.Database;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

function makeHarness(
  opts: { policy?: Partial<SellLoopGuardPolicy>; db?: Database.Database } = {},
): Harness {
  const bus = new InProcessEventBus();
  const riskEvents = makeRiskEventRepo();
  const metricsDb = makeMetricsDb();
  const metrics = new RuntimeMetricWriter(metricsDb, () => new Date(NOW));
  const policy: SellLoopGuardPolicy = { ...DEFAULT_SELL_LOOP_GUARD_POLICY, ...opts.policy };
  const module = new SellLoopGuardModule({
    bus,
    policy: () => policy,
    riskEventRepo: riskEvents,
    runtimeMetrics: metrics,
    ...(opts.db ? { db: opts.db } : {}),
    log: silentLog,
    now: () => NOW,
  });
  return {
    bus,
    module,
    riskEvents,
    metrics,
    metricsDb,
    start: () => module.start(),
    stop: () => module.stop(),
  };
}

function skipPayload(
  overrides: Partial<RuntimeEventMap["OrderSkipped"]> = {},
): RuntimeEventMap["OrderSkipped"] {
  return {
    commandId: createCommandId("cmd-skip"),
    clientOrderId: CLIENT_OID,
    tokenId: TOKEN,
    conditionId: CONDITION,
    reasonCode: "post-only-cross-pre-submit",
    side: "sell",
    price: 0.5,
    size: 100,
    signalReason: "exit",
    signalId: "sig-1",
    decisionRuleId: "D8_PROFIT_RATIO",
    signalTimestamp: null,
    details: { bestBid: 0.5, bestAsk: 0.52 },
    timestamp: NOW,
    ...overrides,
  };
}

function rejectPayload(
  overrides: Partial<RuntimeEventMap["OrderRejected"]> = {},
): RuntimeEventMap["OrderRejected"] {
  return {
    commandId: createCommandId("cmd-reject"),
    clientOrderId: CLIENT_OID,
    tokenId: TOKEN,
    conditionId: CONDITION,
    reason: NO_ID_MESSAGE,
    errorCode: ExchangeErrorCode.Unknown,
    signalReason: "exit",
    side: "sell",
    signalId: "sig-1",
    decisionRuleId: "D8_PROFIT_RATIO",
    signalTimestamp: null,
    exchangeErrorMessage: NO_ID_MESSAGE,
    exchangeErrorDetails: null,
    timestamp: NOW,
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("pos-guard-1"),
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    size: 0,
    avgEntryPrice: 0.4,
    costBasisUsdc: 0,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: PositionStatus.Closed,
    entryStyle: null,
    openedAt: "2026-06-11T00:00:00.000Z",
    closedAt: "2026-06-11T11:00:00.000Z",
    updatedAt: "2026-06-11T11:00:00.000Z",
    ...overrides,
  };
}

async function publishSkips(h: Harness, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await h.bus.publish(
      "OrderSkipped",
      skipPayload({ commandId: createCommandId(`cmd-skip-${i}`) }),
    );
  }
  await h.bus.drain();
}

async function publishRejects(h: Harness, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await h.bus.publish(
      "OrderRejected",
      rejectPayload({ commandId: createCommandId(`cmd-reject-${i}`) }),
    );
  }
  await h.bus.drain();
}

let active: Harness | null = null;

afterEach(async () => {
  if (active) {
    await active.stop();
    active.metricsDb.close();
    active = null;
  }
});

describe("SellLoopGuardModule", () => {
  it("blocks the token after 10 SELL post-only-cross OrderSkipped events", async () => {
    active = makeHarness();
    await active.start();

    await publishSkips(active, 10);

    const snap = active.module.getSnapshot(TOKEN, NOW);
    expect(snap?.blocked).toBe(true);
    expect(snap?.activeCount).toBe(10);
  });

  it("does not block after only 9 OrderSkipped events", async () => {
    active = makeHarness();
    await active.start();

    await publishSkips(active, 9);

    const snap = active.module.getSnapshot(TOKEN, NOW);
    expect(snap?.blocked).toBe(false);
    expect(snap?.activeCount).toBe(9);
  });

  it("blocks the token after 10 SELL exchange-no-id OrderRejected events", async () => {
    active = makeHarness();
    await active.start();

    await publishRejects(active, 10);

    expect(active.module.getSnapshot(TOKEN, NOW)?.blocked).toBe(true);
  });

  it("ignores BUY skips and non-target rejects", async () => {
    active = makeHarness();
    await active.start();

    await active.bus.publish("OrderSkipped", skipPayload({ side: "buy" }));
    await active.bus.publish(
      "OrderRejected",
      rejectPayload({
        reason: "insufficient balance",
        exchangeErrorMessage: "insufficient balance",
      }),
    );
    await active.bus.drain();

    const snap = active.module.getSnapshot(TOKEN, NOW);
    expect(snap === null || snap.activeCount === 0).toBe(true);
  });

  it("resets the bucket on a SELL OrderPlaced", async () => {
    active = makeHarness();
    await active.start();
    await publishSkips(active, 10);

    await active.bus.publish("OrderPlaced", {
      commandId: createCommandId("cmd-placed"),
      clientOrderId: CLIENT_OID,
      orderId: createOrderId("ord-1"),
      tokenId: TOKEN,
      conditionId: CONDITION,
      side: "sell",
      price: 0.55,
      size: 100,
      orderType: OrderType.Gtc,
      signalReason: "exit",
      timestamp: NOW,
    });
    await active.bus.drain();

    expect(active.module.getSnapshot(TOKEN, NOW)?.blocked).toBe(false);
    expect(active.module.getSnapshot(TOKEN, NOW)?.activeCount).toBe(0);
  });

  it("resets the bucket on a SELL FillReceived", async () => {
    active = makeHarness();
    await active.start();
    await publishSkips(active, 10);

    await active.bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: CLIENT_OID,
      tokenId: TOKEN,
      conditionId: CONDITION,
      side: "sell",
      price: 0.55,
      size: 100,
      sizeUsdc: 55,
      liquidityRole: LiquidityRole.Maker,
      fee: 0,
      feeRateBps: 0,
      signalReason: "exit",
      timestamp: NOW,
    });
    await active.bus.drain();

    expect(active.module.getSnapshot(TOKEN, NOW)?.activeCount).toBe(0);
  });

  it("resets the bucket on a closed/flat PositionUpdated", async () => {
    active = makeHarness();
    await active.start();
    await publishSkips(active, 10);

    await active.bus.publish("PositionUpdated", {
      position: makePosition({ status: PositionStatus.Closed, size: 0 }),
    });
    await active.bus.drain();

    expect(active.module.getSnapshot(TOKEN, NOW)?.activeCount).toBe(0);
  });

  it("resets the bucket on PositionSettled", async () => {
    active = makeHarness();
    await active.start();
    await publishSkips(active, 10);

    await active.bus.publish("PositionSettled", {
      positionId: createPositionId("pos-1"),
      tokenId: TOKEN,
      resolution: "yes",
      settlementPrice: 1,
      realizedPnl: 0,
      size: 100,
      avgEntryPrice: 0.4,
      timestamp: NOW,
    });
    await active.bus.drain();

    expect(active.module.getSnapshot(TOKEN, NOW)?.activeCount).toBe(0);
  });

  it("emits one activation risk event and counts every outcome metric", async () => {
    active = makeHarness();
    await active.start();

    await publishSkips(active, 10);
    active.metrics.flushCounters("2026-06-11T12:00:00.000Z");

    const activationRows = active.riskEvents.inserts.filter(
      (e) => e.payload.reasonCode === "sell_loop_guard",
    );
    expect(activationRows).toHaveLength(1);
    expect(activationRows[0]!.eventType).toBe("signal_suppressed");

    const rows = active.metricsDb
      .prepare("SELECT metric_name, value, labels FROM runtime_metrics")
      .all() as Array<{ metric_name: string; value: number; labels: string | null }>;
    const counter = rows.find((r) => r.metric_name === "track_q_loop_guard_counter");
    const trigger = rows.find((r) => r.metric_name === "track_q_loop_guard_trigger_total");
    expect(counter?.value).toBe(10);
    expect(trigger?.value).toBe(1);
  });

  it("recovers blocked state from durable rows on start", async () => {
    const db = makeRecoveryDb();
    for (let i = 0; i < 10; i++) {
      db.prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, side, status, exchange_error_message, bot_run_id, created_at)
         VALUES (?, ?, ?, 'sell', 'rejected', ?, 'run', ?)`,
      ).run(
        `o-${i}`,
        `o-${i}`,
        String(TOKEN),
        NO_ID_MESSAGE,
        new Date(NOW - i * 60_000).toISOString(),
      );
    }
    active = makeHarness({ db });
    await active.start();

    expect(active.module.getSnapshot(TOKEN, NOW)?.blocked).toBe(true);
    db.close();
  });

  it("does not recover from deduped order_rejected risk events alone", async () => {
    const db = makeRecoveryDb();
    for (let i = 0; i < 10; i++) {
      db.prepare(`INSERT INTO risk_events (event_type, payload, created_at) VALUES (?, ?, ?)`).run(
        "order_rejected",
        JSON.stringify({ tokenId: String(TOKEN), side: "sell", reasonCode: NO_ID_MESSAGE }),
        new Date(NOW - i * 60_000).toISOString().slice(0, 19).replace("T", " "),
      );
    }
    active = makeHarness({ db });
    await active.start();

    const snap = active.module.getSnapshot(TOKEN, NOW);
    expect(snap === null || snap.blocked === false).toBe(true);
    db.close();
  });
});
