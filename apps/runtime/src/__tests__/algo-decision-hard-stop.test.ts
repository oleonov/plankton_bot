/**
 * Scenario: continuation-filter STOP on post-entry decisions.
 *
 * evaluateContinuation(legTradeCount, firstTradePrice) returns false when:
 *   R1: legTradeCount < 6 AND firstTradePrice < 0.05
 *   R2: legTradeCount < 2 (regardless of price)
 *
 * On fail → AlgoDecisionModule.evaluateToken() must suppress BUY/scale-in.
 * Existing-leg SELL exits remain reachable through the same SELL rules.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlgoDecisionModule } from "../modules/algo-decision/algo-decision-module.js";
import type { SelectedMarketCache } from "../modules/algo-decision/algo-decision-module.js";
import type {
  EventBus,
  LegStateRepository,
  AlgoRulesRepository,
  AlgoDecisionRule,
  AlgoSizeRule,
  NormalizedMarket,
  LegState,
  RuntimeEventMap,
} from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import type { ConditionId } from "@plankton/domain";
import type { Logger } from "../logger.js";

// ─── Seed rules ───────────────────────────────────────────────────────────────

/** Decision rules: FALLBACK BUY + a SELL rule that would fire on S1 + high price. */
const DECISION_RULES: AlgoDecisionRule[] = [
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

const BUY_SIZE_RULES: AlgoSizeRule[] = [
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
    sizeUsdc: 2.1,
  },
];

const SELL_SIZE_RULES: AlgoSizeRule[] = [
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
    sizeUsdc: 1.62,
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
  };
}

function createMockAlgoRulesRepo(): AlgoRulesRepository {
  return {
    getDecisionRules: vi.fn(() => DECISION_RULES),
    getSizeRules: vi.fn((actionType: "BUY" | "SELL") =>
      actionType === "BUY" ? BUY_SIZE_RULES : SELL_SIZE_RULES,
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

function makeMarket(
  tokenId: string,
  midPrice: number,
  conditionId: string = "cond-1",
  tradable = true,
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
    tradable,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
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

function makeLegState(
  tokenId: string,
  buyCount: number,
  sellCount: number,
  firstTradePrice: number,
): LegState {
  const ts = new Date(Date.now() - 60_000).toISOString();
  return {
    tokenId: createTokenId(tokenId),
    buyCount,
    sellCount,
    lastAction: "BUY",
    firstTradePrice,
    firstTradeAt: ts,
    lastTradeAt: ts,
    updatedAt: ts,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Continuation STOP after post-entry filter fail", () => {
  let bus: ReturnType<typeof createMockBus>;
  let algoRulesRepo: AlgoRulesRepository;
  let log: Logger;

  function buildModule(legStateRepo: LegStateRepository, selectedMarketCache: SelectedMarketCache) {
    return new AlgoDecisionModule({
      bus: bus as unknown as EventBus,
      legStateRepo,
      algoRulesRepo,
      selectedMarketCache,
      log,
      sweepIntervalMs: 60_000,
    });
  }

  beforeEach(() => {
    bus = createMockBus();
    algoRulesRepo = createMockAlgoRulesRepo();
    log = createMockLogger();
  });

  it("case 1: buyCount=1, sellCount=0, firstTradePrice=0.03 → STOP, no signal published", async () => {
    // tradeCount = 1 < 6 AND firstTradePrice 0.03 < 0.05 → evaluateContinuation = false → null
    const tokenId = "token-stop-basic";
    const legState = makeLegState(tokenId, 1, 0, 0.03);
    const legStateRepo = createMockLegStateRepo([legState]);
    // Token is in eligible cache — ensures the STOP is due to continuation, not eligibility
    const selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule(legStateRepo, selectedMarketCache);
    await mod.start();

    // Use a price below the SELL rule so we can confirm STOP blocks the
    // matching FALLBACK BUY without testing the SELL bypass path.
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, 0.05)],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
    const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");

    expect(signalCalls.length).toBe(0);
    expect(redeemCalls.length).toBe(0);

    await mod.stop();
  });

  it("case 2: same token re-evaluated on later sweep still returns null — deterministic STOP", async () => {
    // No operator override exists (removed in Phase 3.2). Every sweep recalculates
    // evaluateContinuation from legState fields → result is always the same.
    const tokenId = "token-stop-repeat";
    const legState = makeLegState(tokenId, 1, 0, 0.03);
    const legStateRepo = createMockLegStateRepo([legState]);
    const selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule(legStateRepo, selectedMarketCache);
    await mod.start();

    const market = makeMarket(tokenId, 0.05);

    // First sweep
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    // Second sweep — simulate a later market update with the same legState
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now() + 10_000,
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    // Both sweeps must produce zero signals — STOP is deterministic
    expect(signalCalls.length).toBe(0);

    await mod.stop();
  });

  it("case 3 (differential guard): buyCount=2, firstTradePrice=0.05 → continuation passes, evaluation proceeds", async () => {
    // evaluateContinuation(2, 0.05):
    //   R1: tradeCount=2 < 6 → R1 not satisfied by count alone
    //   R2: firstTradePrice=0.05 >= 0.05 AND legTradeCount=2 >= 2 → true
    // Result: continuation PASSES → normal decision flow → signal expected
    const tokenId = "token-stop-boundary";
    const legState = makeLegState(tokenId, 2, 0, 0.05);
    const legStateRepo = createMockLegStateRepo([legState]);
    const selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule(legStateRepo, selectedMarketCache);
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, 0.45)],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    // Continuation passes → at least one signal must have been produced
    expect(signalCalls.length).toBeGreaterThanOrEqual(1);

    await mod.stop();
  });

  it("case 4: buyCount=6+, low price → tradeCount >= 6 branch passes, evaluation proceeds", async () => {
    // evaluateContinuation(7, 0.01):
    //   R1: legTradeCount=7 >= 6 → true immediately
    // Result: continuation PASSES despite price well below 0.05
    const tokenId = "token-stop-highcount";
    // buyCount=6, sellCount=1 → tradeCount=7
    const legState = makeLegState(tokenId, 6, 1, 0.01);
    const legStateRepo = createMockLegStateRepo([legState]);
    const selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule(legStateRepo, selectedMarketCache);
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, 0.45)],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    // Continuation passes → signal produced
    expect(signalCalls.length).toBeGreaterThanOrEqual(1);

    await mod.stop();
  });

  it("STOP does not block SELL when an existing-leg SELL rule matches", async () => {
    // buyCount=1, sellCount=0, firstTradePrice=0.03 → STOP
    // Price 0.15 >= 0.1 → D7-SELL-S1 would normally fire for S1 state
    // STOP suppresses BUY/scale-in, but exit SELL remains reachable.
    const tokenId = "token-stop-sell-blocked";
    const legState = makeLegState(tokenId, 1, 0, 0.03);
    const legStateRepo = createMockLegStateRepo([legState]);
    // Token NOT in eligible cache — legState presence is what matters here
    const selectedMarketCache = createMockSelectedMarketCache([]);

    const mod = buildModule(legStateRepo, selectedMarketCache);
    await mod.start();

    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [makeMarket(tokenId, 0.15)],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    expect(signalCalls.length).toBe(1);
    expect(signalCalls[0]![1].signal.side).toBe("sell");
    expect(signalCalls[0]![1].signal.decisionRuleId).toBe("D7-SELL-S1");

    await mod.stop();
  });
});
