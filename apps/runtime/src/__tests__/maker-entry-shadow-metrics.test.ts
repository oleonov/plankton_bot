/**
 * Phase 3 maker-entry shadow metrics test.
 *
 * Verifies that opening a scale-in level (level_index > 0) emits
 * maker_entry_shadow_level_opened_total with the correct label.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlgoDecisionModule } from "../modules/algo-decision/algo-decision-module.js";
import type { SelectedMarketCache } from "../modules/algo-decision/algo-decision-module.js";
import { createTokenId, DEFAULT_EXECUTION_POLICY } from "@krabs/domain";
import type {
  AlgoDecisionRule,
  AlgoRulesRepository,
  AlgoSizeRule,
  EventBus,
  LegStateRepository,
  MakerShadowOrder,
  MakerShadowOrderRepository,
  NormalizedMarket,
  RuntimeEventMap,
} from "@krabs/domain";
import type { Logger } from "../logger.js";
import type { RuntimeMetricWriter } from "../runtime-metric-writer.js";

// ─── Bus mock (same pattern as algo-decision-hard-stop.test.ts) ──────────────

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
    for (const h of list) await h(payload as any);
  });
  const emit = async <K extends keyof RuntimeEventMap>(event: K, payload: RuntimeEventMap[K]) => {
    await publish(event, payload);
  };
  return { subscribe, publish, emit } as unknown as EventBus & { emit: typeof emit };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TOKEN_ID = createTokenId("tok-scale-in-metrics");
const COND_ID = "cond-scale-in-metrics";
const LADDER_ID = "shadow-level0-ladder";

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function makeLogger(): Logger {
  const l: Record<string, unknown> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    level: "info",
    silent: vi.fn(),
  };
  l["child"] = vi.fn(() => l);
  return l as unknown as Logger;
}

/** FALLBACK rule is required by AlgoDecisionModule.start() or it throws. */
function makeAlgoRulesRepo(): AlgoRulesRepository {
  const fallback: AlgoDecisionRule = {
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
  };
  const buySizeRule: AlgoSizeRule = {
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
    sizeUsdc: 1.0,
  };
  return {
    getDecisionRules: () => [fallback],
    getSizeRules: (type: string) => (type === "BUY" ? [buySizeRule] : []),
    refresh: vi.fn(),
  } as unknown as AlgoRulesRepository;
}

function makeLegStateRepo(): LegStateRepository {
  return {
    findByTokenId: vi.fn(() => null),
    findOpen: vi.fn(() => []),
    getAll: vi.fn(() => []),
    upsert: vi.fn(),
  } as unknown as LegStateRepository;
}

function makeSelectedMarketCache(): SelectedMarketCache {
  // Not eligible → no BUY signal; scale-in runs independently of signal production.
  return {
    isEligible: vi.fn(() => false),
    getEligibleTokenIds: vi.fn(() => []),
  } as unknown as SelectedMarketCache;
}

function makeRuntimeMetrics(): RuntimeMetricWriter {
  return {
    writeCounter: vi.fn(),
    writeLatest: vi.fn(),
    writeEvent: vi.fn(),
    flush: vi.fn(),
  } as unknown as RuntimeMetricWriter;
}

/** Level 0: pending, buyPx=0.50; far-future deadline to avoid expiry during the test. */
function makeLevel0(): MakerShadowOrder {
  const postedAt = "2026-07-05T09:00:00.000Z";
  return {
    shadowOrderId: LADDER_ID,
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    buyPx: 0.5,
    harvestPx: 0.6,
    postedAt,
    fillDeadline: "2099-12-31T00:00:00.000Z",
    stage: "pending",
    fillKind: null,
    fillPx: null,
    markPx: null,
    netMark: null,
    ladderId: LADDER_ID,
    levelIndex: 0,
    filledAt: null,
    updatedAt: postedAt,
  };
}

function makeShadowRepo(level0: MakerShadowOrder): MakerShadowOrderRepository {
  return {
    findOpen: vi.fn(() => [level0]),
    findOpenByToken: vi.fn((tokenId) => (String(tokenId) === String(TOKEN_ID) ? [level0] : [])),
    findLadder: vi.fn(() => [level0]),
    upsert: vi.fn(),
    updateStage: vi.fn(),
    prune: vi.fn(),
  } as unknown as MakerShadowOrderRepository;
}

/**
 * Market with bestBid=0.43, bestAsk=0.55, tickSize=0.01.
 * Scale-in: buyPx = floor(0.43 + 0.01, 0.01) = 0.44 ≤ 0.45 (= 0.50 × 0.9) → triggers level 1.
 */
function makeMarket(): NormalizedMarket {
  return {
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    slug: "test-scale-in-metrics",
    eventSlug: null,
    question: "Scale-in metrics test?",
    outcome: "Yes",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    bestBid: 0.43,
    bestAsk: 0.55,
    lastPrice: null,
    volume24hr: 500,
    liquidity: 1000,
    sigLiquidity: 1000,
    sigVol24hr: 500,
    sigMid: null,
    sigCheapMid: null,
    sigFeaturesAt: null,
    score: null,
    scoreModelVersion: null,
    scoredAt: null,
    featuresCapuredAt: null,
  } as unknown as NormalizedMarket;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("maker shadow scale-in metrics", () => {
  let bus: ReturnType<typeof createMockBus>;
  let runtimeMetrics: RuntimeMetricWriter;
  let shadowRepo: MakerShadowOrderRepository;
  let mod: AlgoDecisionModule;

  beforeEach(() => {
    bus = createMockBus();
    runtimeMetrics = makeRuntimeMetrics();
    const level0 = makeLevel0();
    shadowRepo = makeShadowRepo(level0);

    mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics,
      makerShadowOrderRepo: shadowRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: {
          ...DEFAULT_EXECUTION_POLICY.makerEntry,
          mode: "shadow" as const,
        },
      }),
    });
  });

  it("emits maker_entry_shadow_level_opened_total when a scale-in level (index>0) opens", async () => {
    await mod.start();

    // Trigger evaluation with a price drop: bestBid=0.43, bestAsk=0.55, tickSize=0.01
    // buyPx = floor(0.43+0.01, 0.01) = 0.44 ≤ 0.45 (= 0.50×0.9) → scale-in fires
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });

    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "maker_entry_shadow_level_opened_total",
      1,
      JSON.stringify({ level_index: 1 }),
    );

    await mod.stop();
  });

  it("does NOT emit maker_entry_shadow_level_opened_total when mode is off", async () => {
    mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics,
      makerShadowOrderRepo: shadowRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: { ...DEFAULT_EXECUTION_POLICY.makerEntry, mode: "off" as const },
      }),
    });

    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });

    const calls = (runtimeMetrics.writeCounter as ReturnType<typeof vi.fn>).mock.calls;
    const levelCalls = calls.filter(([name]) => name === "maker_entry_shadow_level_opened_total");
    expect(levelCalls).toHaveLength(0);

    await mod.stop();
  });
});
