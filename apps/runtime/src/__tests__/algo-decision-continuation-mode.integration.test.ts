/**
 * ADR-016 integration coverage for the continuation-mode hot-reload path.
 *
 * Unit tests in `algo-decision-module.test.ts` mock `controlDb.prepare(sql).get()`
 * with SQL-string pattern matching. This suite instead boots a real
 * better-sqlite3 control DB from `control.sql` and drives mode flips through
 * the production `setContinuationMode` SQL helper, so the version bump, the
 * CHECK constraint, and the `readContinuation*` round-trip all run end-to-end
 * against schema. legState/algoRules/etc. stay as in-memory mocks because the
 * contract under test is the gate flip, not the wider event pipeline.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

import { setContinuationMode } from "@plankton/db";
import {
  createTokenId,
  type AlgoDecisionRule,
  type AlgoRulesRepository,
  type AlgoSizeRule,
  type ConditionId,
  type EventBus,
  type LegState,
  type LegStateRepository,
  type NormalizedMarket,
  type OrderRepository,
  type RiskEventRepository,
  type RuntimeEventMap,
} from "@plankton/domain";

import { AlgoDecisionModule } from "../modules/algo-decision/algo-decision-module.js";
import type { SelectedMarketCache } from "../modules/algo-decision/algo-decision-module.js";
import type { Logger } from "../logger.js";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

const SHARED_CONDITION_ID = "cond-mw-int" as ConditionId;
const TOKEN_ID = "token-mw-int";

// ─── Seed rules ────────────────────────────────────────────────────────────────

const SEED_DECISION_RULES: AlgoDecisionRule[] = [
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

const SEED_SIZE_RULES_BUY: AlgoSizeRule[] = [
  {
    id: 1,
    actionType: "BUY",
    priority: 99,
    ruleId: "FALLBACK-BUY",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1.0,
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
    sizeUsdc: 1.0,
  },
];

// ─── Mocks (focused: only what's NOT under test) ──────────────────────────────

type BusHandler<K extends keyof RuntimeEventMap> = (payload: RuntimeEventMap[K]) => Promise<void>;

function createMockBus() {
  const handlers = new Map<string, BusHandler<keyof RuntimeEventMap>[]>();
  const subscribe = vi.fn((event: string, handler: BusHandler<keyof RuntimeEventMap>) => {
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
    for (const h of list) await h(payload as never);
  });
  const emit = async <K extends keyof RuntimeEventMap>(
    event: K,
    payload: RuntimeEventMap[K],
  ): Promise<void> => {
    await publish(event, payload);
  };
  return { subscribe, publish, emit } as unknown as EventBus & {
    publish: typeof publish;
    emit: typeof emit;
  };
}

function createMockLegStateRepo(states: LegState[]): LegStateRepository {
  const map = new Map(states.map((s) => [String(s.tokenId), s]));
  return {
    get: vi.fn((tokenId) => map.get(String(tokenId)) ?? null),
    upsert: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(() => [...map.values()]),
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

function createMockSelectedMarketCache(): SelectedMarketCache {
  return {
    isEligible: vi.fn(() => false),
    getEligibleTokenIds: vi.fn(() => []),
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

function createMockOrderRepo(): Pick<OrderRepository, "sumOpenBuyNotional"> {
  return { sumOpenBuyNotional: vi.fn().mockReturnValue(0) };
}

function createTradeCountProvider(initial: number | null) {
  let nextValue: number | null = initial;
  const calls: Array<{ conditionId: string; cap: number }> = [];
  const prefetchCalls: Array<{ conditionIds: readonly string[]; cap: number }> = [];
  return {
    countTrades: vi.fn(async (conditionId: string, cap: number) => {
      calls.push({ conditionId, cap });
      return nextValue;
    }),
    prefetch: vi.fn(async (conditionIds: readonly string[], cap: number) => {
      prefetchCalls.push({ conditionIds: [...conditionIds], cap });
    }),
    setReturnValue(v: number | null) {
      nextValue = v;
    },
    calls,
    prefetchCalls,
  };
}

function legAtBuy1(): LegState {
  const now = new Date();
  return {
    tokenId: createTokenId(TOKEN_ID),
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.03,
    firstTradeAt: new Date(now.getTime() - 60_000).toISOString(),
    lastTradeAt: new Date(now.getTime() - 60_000).toISOString(),
    updatedAt: now.toISOString(),
  };
}

function makeMarket(midPrice: number): NormalizedMarket {
  return {
    tokenId: createTokenId(TOKEN_ID),
    conditionId: SHARED_CONDITION_ID,
    slug: "mw-int-test",
    eventSlug: null,
    question: "?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: midPrice - 0.01,
    bestAsk: midPrice + 0.01,
    midPrice,
    spread: 0.02,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("AlgoDecisionModule × continuation_mode (real control DB)", () => {
  let db: Database.Database;
  let bus: ReturnType<typeof createMockBus>;
  let legStateRepo: LegStateRepository;
  let algoRulesRepo: AlgoRulesRepository;
  let selectedMarketCache: SelectedMarketCache;
  let orderRepo: Pick<OrderRepository, "sumOpenBuyNotional">;
  let log: Logger;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(CONTROL_SQL);
    db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();

    bus = createMockBus();
    legStateRepo = createMockLegStateRepo([legAtBuy1()]);
    algoRulesRepo = createMockAlgoRulesRepo();
    selectedMarketCache = createMockSelectedMarketCache();
    orderRepo = createMockOrderRepo();
    log = createMockLogger();
  });

  afterEach(() => {
    db.close();
  });

  it("default DB row is leg_local v0; provider is never consulted", async () => {
    const provider = createTradeCountProvider(6);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo,
      algoRulesRepo,
      orderRepo,
      selectedMarketCache,
      controlDb: db,
      tradeCountProvider: provider,
      riskEventRepo,
      log,
      sweepIntervalMs: 60_000,
    });
    await mod.start();

    await bus.emit("NormalizedMarketUpdated", {
      markets: [makeMarket(0.15)],
      timestamp: Date.now(),
    });

    expect(provider.calls.length).toBe(0);
    expect(provider.prefetchCalls.length).toBe(0);
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_suppressed",
      payload: expect.objectContaining({
        reasonCode: "continuation-stop",
        tradeCountSource: "leg_local",
        continuationMode: "leg_local",
      }),
    });

    await mod.stop();
  });

  it("setContinuationMode('market_wide') → next sweep consults provider; SQL CHECK accepts the value", async () => {
    const provider = createTradeCountProvider(6);

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo,
      algoRulesRepo,
      orderRepo,
      selectedMarketCache,
      controlDb: db,
      tradeCountProvider: provider,
      log,
      sweepIntervalMs: 60_000,
    });
    await mod.start();

    // Tick 1 — leg_local (default). Provider untouched.
    await bus.emit("NormalizedMarketUpdated", {
      markets: [makeMarket(0.15)],
      timestamp: Date.now(),
    });
    expect(provider.calls.length + provider.prefetchCalls.length).toBe(0);

    // Operator flips via the production SQL helper.
    const flip = setContinuationMode(db, "market_wide");
    expect(flip).toEqual({ changed: true, version: 1 });

    // Tick 2 — refreshContinuationMode picks up v=1, switches to market_wide.
    await bus.emit("NormalizedMarketUpdated", {
      markets: [makeMarket(0.15)],
      timestamp: Date.now(),
    });
    expect(provider.calls.length + provider.prefetchCalls.length).toBeGreaterThanOrEqual(1);

    await mod.stop();
  });

  it("market_wide + provider returns 6 → continuation passes; SignalProduced fires", async () => {
    setContinuationMode(db, "market_wide");
    const provider = createTradeCountProvider(6);

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo,
      algoRulesRepo,
      orderRepo,
      selectedMarketCache,
      controlDb: db,
      tradeCountProvider: provider,
      log,
      sweepIntervalMs: 60_000,
    });
    await mod.start();

    await bus.emit("NormalizedMarketUpdated", {
      markets: [makeMarket(0.15)],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
    expect(signalCalls.length).toBe(1);

    await mod.stop();
  });

  it("market_wide + provider returns 1 → STOP; suppression payload tags source=market_wide", async () => {
    setContinuationMode(db, "market_wide");
    const provider = createTradeCountProvider(1);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo,
      algoRulesRepo,
      orderRepo,
      selectedMarketCache,
      controlDb: db,
      tradeCountProvider: provider,
      riskEventRepo,
      log,
      sweepIntervalMs: 60_000,
    });
    await mod.start();

    await bus.emit("NormalizedMarketUpdated", {
      markets: [makeMarket(0.15)],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    expect(publishCalls.filter(([ev]) => ev === "SignalProduced").length).toBe(0);
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_suppressed",
      payload: expect.objectContaining({
        reasonCode: "continuation-stop",
        tradeCount: 1,
        tradeCountSource: "market_wide",
        continuationMode: "market_wide",
      }),
    });

    await mod.stop();
  });

  it("market_wide + provider returns null → fallback to leg-local; suppression source=leg_local_fallback", async () => {
    setContinuationMode(db, "market_wide");
    const provider = createTradeCountProvider(null);
    const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo,
      algoRulesRepo,
      orderRepo,
      selectedMarketCache,
      controlDb: db,
      tradeCountProvider: provider,
      riskEventRepo,
      log,
      sweepIntervalMs: 60_000,
    });
    await mod.start();

    await bus.emit("NormalizedMarketUpdated", {
      markets: [makeMarket(0.15)],
      timestamp: Date.now(),
    });

    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_suppressed",
      payload: expect.objectContaining({
        reasonCode: "continuation-stop",
        tradeCountSource: "leg_local_fallback",
        continuationMode: "market_wide",
      }),
    });

    await mod.stop();
  });

  it("flipping back to leg_local (idempotent + version bump) restores the legacy gate", async () => {
    setContinuationMode(db, "market_wide");
    const provider = createTradeCountProvider(6);

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo,
      algoRulesRepo,
      orderRepo,
      selectedMarketCache,
      controlDb: db,
      tradeCountProvider: provider,
      log,
      sweepIntervalMs: 60_000,
    });
    await mod.start();

    await bus.emit("NormalizedMarketUpdated", {
      markets: [makeMarket(0.15)],
      timestamp: Date.now(),
    });
    const consultedFirst = provider.calls.length + provider.prefetchCalls.length;
    expect(consultedFirst).toBeGreaterThanOrEqual(1);

    // Flip back via SQL helper. version bumps to 2; idempotent re-flip is a no-op.
    const back = setContinuationMode(db, "leg_local");
    expect(back).toEqual({ changed: true, version: 2 });
    const second = setContinuationMode(db, "leg_local");
    expect(second).toEqual({ changed: false, version: 2 });

    await bus.emit("NormalizedMarketUpdated", {
      markets: [makeMarket(0.15)],
      timestamp: Date.now(),
    });

    // Provider must not be consulted again on the second tick.
    expect(provider.calls.length + provider.prefetchCalls.length).toBe(consultedFirst);

    await mod.stop();
  });
});
