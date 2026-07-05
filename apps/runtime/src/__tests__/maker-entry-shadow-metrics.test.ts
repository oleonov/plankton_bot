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

// ─── BBO snapshot fallback tests ─────────────────────────────────────────────

describe("maker shadow scale-in: BBO snapshot fallback", () => {
  /**
   * When a token is evicted from marketCache (TrackedMarketsChanged removes it),
   * advanceMakerShadows must fall back to the snapshot repo for BBO data.
   * If the snapshot shows bestBid=0.43 (≥10% below level-0 buyPx=0.50),
   * scale-in should open level 1.
   */
  it("opens scale-in level 1 using snapshot BBO when token is absent from marketCache", async () => {
    const bus = createMockBus();
    const runtimeMetrics = makeRuntimeMetrics();
    const level0 = makeLevel0();
    const shadowRepo = makeShadowRepo(level0);

    // Snapshot repo returns the BBO that qualifies for scale-in:
    // bestBid=0.43 → buyPx = floor(0.43+0.01, 0.01) = 0.44 ≤ 0.45 (= 0.50×0.9)
    const snapshotBbo = new Map([
      [String(TOKEN_ID), { bestBid: 0.43, bestAsk: 0.55, tickSize: 0.01 }],
    ]);
    const marketSnapshotRepo = {
      findLatestBboByTokens: vi.fn(() => snapshotBbo),
    };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics,
      makerShadowOrderRepo: shadowRepo,
      marketSnapshotRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: {
          ...DEFAULT_EXECUTION_POLICY.makerEntry,
          mode: "shadow" as const,
        },
      }),
    });

    await mod.start();

    // Fire NormalizedMarketUpdated with an EMPTY markets array to trigger evaluation
    // WITHOUT populating marketCache for TOKEN_ID. The scale-in must use the snapshot.
    await bus.publish("NormalizedMarketUpdated", {
      markets: [],
      timestamp: Date.now(),
    });

    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "maker_entry_shadow_level_opened_total",
      1,
      JSON.stringify({ level_index: 1 }),
    );
    expect(marketSnapshotRepo.findLatestBboByTokens).toHaveBeenCalledWith(
      expect.arrayContaining([TOKEN_ID]),
    );

    await mod.stop();
  });

  it("still fires scale-in when marketCache has valid BBO (existing path unchanged)", async () => {
    const bus = createMockBus();
    const runtimeMetrics = makeRuntimeMetrics();
    const level0 = makeLevel0();
    const shadowRepo = makeShadowRepo(level0);

    // Snapshot repo is never called when live market is present
    const marketSnapshotRepo = {
      findLatestBboByTokens: vi.fn(() => new Map()),
    };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics,
      makerShadowOrderRepo: shadowRepo,
      marketSnapshotRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: {
          ...DEFAULT_EXECUTION_POLICY.makerEntry,
          mode: "shadow" as const,
        },
      }),
    });

    await mod.start();

    // Fire with a real market update (bestBid=0.43 → scale-in fires via live cache)
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket()],
      timestamp: Date.now(),
    });

    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "maker_entry_shadow_level_opened_total",
      1,
      JSON.stringify({ level_index: 1 }),
    );
    // findLatestBboByTokens must NOT be called: TOKEN_ID is in the live cache
    expect(marketSnapshotRepo.findLatestBboByTokens).not.toHaveBeenCalled();

    await mod.stop();
  });
});

// ─── Finding 1 + 2 + 3: unusable live BBO → snapshot fallback ────────────────

describe("maker shadow scale-in: unusable live BBO triggers snapshot fallback", () => {
  /**
   * Finding 1: A token that IS in marketCache but with null bestBid was previously
   * skipped (only cache-miss tokens were sent to the snapshot). After the fix,
   * a null/NaN/∞ live BBO also qualifies for snapshot lookup so scale-in can fire.
   */
  it("opens scale-in level 1 when token in marketCache has null bestBid (Finding 1)", async () => {
    const bus = createMockBus();
    const runtimeMetrics = makeRuntimeMetrics();
    const level0 = makeLevel0();
    const shadowRepo = makeShadowRepo(level0);

    const snapshotBbo = new Map([
      [String(TOKEN_ID), { bestBid: 0.43, bestAsk: 0.55, tickSize: 0.01 }],
    ]);
    const marketSnapshotRepo = { findLatestBboByTokens: vi.fn(() => snapshotBbo) };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics,
      makerShadowOrderRepo: shadowRepo,
      marketSnapshotRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: { ...DEFAULT_EXECUTION_POLICY.makerEntry, mode: "shadow" as const },
      }),
    });
    await mod.start();

    // Token IS in cache (active=true fires marketCache.set) but bestBid is null —
    // this is the "stale cache entry" scenario (live BBO not yet received).
    await bus.publish("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(), bestBid: null } as unknown as NormalizedMarket],
      timestamp: Date.now(),
    });

    // snapshot fallback must be queried because live BBO is unusable
    expect(marketSnapshotRepo.findLatestBboByTokens).toHaveBeenCalledWith(
      expect.arrayContaining([TOKEN_ID]),
    );
    // scale-in must still fire using the snapshot BBO
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "maker_entry_shadow_level_opened_total",
      1,
      JSON.stringify({ level_index: 1 }),
    );

    await mod.stop();
  });

  /**
   * Finding 2: NaN live BBO was previously accepted (NaN <= 0 is false) and would
   * produce NaN marks. After the fix, Number.isFinite() rejects NaN and the
   * snapshot fallback is used instead.
   */
  it("NaN live BBO is treated as invalid — snapshot fallback is queried (Finding 2)", async () => {
    const bus = createMockBus();
    const runtimeMetrics = makeRuntimeMetrics();
    const level0 = makeLevel0();
    const shadowRepo = makeShadowRepo(level0);

    const snapshotBbo = new Map([
      [String(TOKEN_ID), { bestBid: 0.43, bestAsk: 0.55, tickSize: 0.01 }],
    ]);
    const marketSnapshotRepo = { findLatestBboByTokens: vi.fn(() => snapshotBbo) };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics,
      makerShadowOrderRepo: shadowRepo,
      marketSnapshotRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: { ...DEFAULT_EXECUTION_POLICY.makerEntry, mode: "shadow" as const },
      }),
    });
    await mod.start();

    // bestBid=NaN in live cache → isLiveBboUsable returns false → snapshot queried
    await bus.publish("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(), bestBid: NaN } as unknown as NormalizedMarket],
      timestamp: Date.now(),
    });

    expect(marketSnapshotRepo.findLatestBboByTokens).toHaveBeenCalledWith(
      expect.arrayContaining([TOKEN_ID]),
    );
    // scale-in fires via snapshot — no NaN propagated into upsert
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "maker_entry_shadow_level_opened_total",
      1,
      JSON.stringify({ level_index: 1 }),
    );
    // Verify upsert received a finite buyPx — NaN must not propagate
    const upsertCalls = (shadowRepo.upsert as ReturnType<typeof vi.fn>).mock.calls;
    const openedLevel = upsertCalls.find(([o]) => o.levelIndex === 1)?.[0];
    expect(openedLevel).toBeDefined();
    expect(Number.isFinite(openedLevel.buyPx)).toBe(true);

    await mod.stop();
  });

  /**
   * Finding 3: The fallback book previously hardcoded tickSize=0.01. Maker tokens
   * often use tick=0.001; the wrong tick shifts buyPx and may prevent valid scale-in.
   * After the fix, the snapshot JOIN returns the real tick and it is used here.
   *
   * Setup: token evicted from cache, snapshot returns tick=0.001.
   * buyPx = floorToTick(0.43 + 1×0.001, 0.001) = 0.431
   * NOT 0.44 (which floorToTick(0.43+0.01, 0.01) would produce with tick=0.01).
   */
  it("uses snapshot tickSize=0.001 for buyPx computation instead of hardcoded 0.01 (Finding 3)", async () => {
    const bus = createMockBus();
    const runtimeMetrics = makeRuntimeMetrics();
    const level0 = makeLevel0();
    const shadowRepo = makeShadowRepo(level0);

    // Snapshot returns tick=0.001 — the actual maker-universe tick
    const snapshotBbo = new Map([
      [String(TOKEN_ID), { bestBid: 0.43, bestAsk: 0.55, tickSize: 0.001 }],
    ]);
    const marketSnapshotRepo = { findLatestBboByTokens: vi.fn(() => snapshotBbo) };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics,
      makerShadowOrderRepo: shadowRepo,
      marketSnapshotRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: { ...DEFAULT_EXECUTION_POLICY.makerEntry, mode: "shadow" as const },
      }),
    });
    await mod.start();

    // Empty markets array → token NOT in live cache → snapshot fallback used
    await bus.publish("NormalizedMarketUpdated", {
      markets: [],
      timestamp: Date.now(),
    });

    // Confirm scale-in fired
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "maker_entry_shadow_level_opened_total",
      1,
      JSON.stringify({ level_index: 1 }),
    );

    // buyPx must reflect tick=0.001: floorToTick(0.43 + 0.001, 0.001) = 0.431
    // NOT 0.44 = floorToTick(0.43 + 0.01, 0.01) which the hardcoded tick=0.01 would give
    const upsertCalls = (shadowRepo.upsert as ReturnType<typeof vi.fn>).mock.calls;
    const openedLevel = upsertCalls.find(([o]) => o.levelIndex === 1)?.[0];
    expect(openedLevel).toBeDefined();
    expect(openedLevel.buyPx).toBeCloseTo(0.431, 3);

    await mod.stop();
  });
});

// ─── Advance-loop BBO-overlay regression (IN-PLAN finding) ───────────────────

describe("maker shadow advance loop: BBO overlay on unusable live cache", () => {
  /**
   * Regression: the advance loop used `live ?? stand-in` which passes the raw
   * live market (with null/NaN bestBid) to advanceShadowOrder when the token IS
   * in marketCache. The fix overlays the resolved BBO values regardless of
   * whether live is present.
   */

  /** A filled shadow whose harvest target (harvestPx=0.6) the snapshot can reach. */
  function makeFilledShadow(): MakerShadowOrder {
    const postedAt = "2026-07-05T09:00:00.000Z";
    return {
      shadowOrderId: LADDER_ID,
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      buyPx: 0.5,
      harvestPx: 0.6,
      postedAt,
      fillDeadline: "2099-12-31T00:00:00.000Z",
      stage: "filled",
      fillKind: "touch",
      fillPx: 0.5,
      markPx: null,
      netMark: null,
      ladderId: LADDER_ID,
      levelIndex: 0,
      filledAt: "2026-07-05T09:01:00.000Z",
      updatedAt: "2026-07-05T09:01:00.000Z",
    } as unknown as MakerShadowOrder;
  }

  function makeFilledShadowRepo(shadow: MakerShadowOrder): MakerShadowOrderRepository {
    return {
      findOpen: vi.fn(() => [shadow]),
      findOpenByToken: vi.fn(() => [shadow]),
      findLadder: vi.fn(() => [shadow]),
      upsert: vi.fn(),
      updateStage: vi.fn(),
      prune: vi.fn(),
    } as unknown as MakerShadowOrderRepository;
  }

  it("harvests a filled shadow via snapshot BBO when live cache has null bestBid", async () => {
    // Regression: previously the advance loop passed live (with null bestBid) to
    // advanceShadowOrder, so bestBid >= harvestPx was never true and harvest was skipped.
    const bus = createMockBus();
    const shadow = makeFilledShadow();
    const shadowRepo = makeFilledShadowRepo(shadow);

    // Snapshot has bestBid=0.65 which is >= harvestPx=0.6 → should trigger harvest
    const snapshotBbo = new Map([
      [String(TOKEN_ID), { bestBid: 0.65, bestAsk: 0.75, tickSize: 0.01 }],
    ]);
    const marketSnapshotRepo = { findLatestBboByTokens: vi.fn(() => snapshotBbo) };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics: makeRuntimeMetrics(),
      makerShadowOrderRepo: shadowRepo,
      marketSnapshotRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: { ...DEFAULT_EXECUTION_POLICY.makerEntry, mode: "shadow" as const },
      }),
    });

    await mod.start();

    // Token IS in marketCache (active=true populates it) but bestBid is null — the
    // "in cache but unusable BBO" case the fallback was meant to fix.
    await bus.publish("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(), bestBid: null } as unknown as NormalizedMarket],
      timestamp: Date.now(),
    });

    // Snapshot must have been consulted because live BBO is unusable
    expect(marketSnapshotRepo.findLatestBboByTokens).toHaveBeenCalledWith(
      expect.arrayContaining([TOKEN_ID]),
    );

    // The advance loop must have applied the snapshot BBO and detected harvest
    const updateCalls = (shadowRepo.updateStage as ReturnType<typeof vi.fn>).mock.calls;
    const harvestCall = updateCalls.find(([, update]) => update?.stage === "harvested");
    expect(harvestCall).toBeDefined();
    // markPx must equal the resolved bestBid=0.65 (not null or NaN)
    expect(harvestCall![1].markPx).toBeCloseTo(0.65, 5);

    await mod.stop();
  });

  it("skips advance when no valid BBO from either source — no crash, no NaN mark", async () => {
    // When resolveBbo returns null the advance loop must continue (skip) gracefully.
    const bus = createMockBus();
    const shadow = makeFilledShadow();
    const shadowRepo = makeFilledShadowRepo(shadow);

    // Snapshot returns nothing for this token
    const marketSnapshotRepo = { findLatestBboByTokens: vi.fn(() => new Map()) };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics: makeRuntimeMetrics(),
      makerShadowOrderRepo: shadowRepo,
      marketSnapshotRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: { ...DEFAULT_EXECUTION_POLICY.makerEntry, mode: "shadow" as const },
      }),
    });

    await mod.start();

    // null bestBid in live cache + no snapshot → resolveBbo returns null → skip
    await bus.publish("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(), bestBid: null } as unknown as NormalizedMarket],
      timestamp: Date.now(),
    });

    // Advance loop must not persist any stage update (no harvest, no NaN mark)
    expect(shadowRepo.updateStage).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("expires a pending order past its fill deadline even when no BBO resolves (dead market)", async () => {
    // Root cause of the shadow "freeze": time-based expiry was gated behind a
    // resolvable BBO (`if (!bbo) continue`), so pending orders on dead/churned
    // markets (no live BBO, snapshot past the 30-min cutoff) lingered forever.
    // Expiry needs no book — a pending order past its deadline never filled — so
    // it must still fire when resolveBbo returns null.
    const bus = createMockBus();
    const shadow = {
      ...makeFilledShadow(),
      stage: "pending" as const,
      fillKind: null,
      fillPx: null,
      filledAt: null,
      fillDeadline: "2020-01-01T00:00:00.000Z", // long past
    } as unknown as MakerShadowOrder;
    const shadowRepo = makeFilledShadowRepo(shadow);

    // No snapshot for this token → resolveBbo returns null (true dead market)
    const marketSnapshotRepo = { findLatestBboByTokens: vi.fn(() => new Map()) };

    const mod = new AlgoDecisionModule({
      bus,
      legStateRepo: makeLegStateRepo(),
      algoRulesRepo: makeAlgoRulesRepo(),
      selectedMarketCache: makeSelectedMarketCache(),
      log: makeLogger(),
      sweepIntervalMs: 60_000,
      runtimeMetrics: makeRuntimeMetrics(),
      makerShadowOrderRepo: shadowRepo,
      marketSnapshotRepo,
      executionPolicy: () => ({
        ...DEFAULT_EXECUTION_POLICY,
        makerEntry: { ...DEFAULT_EXECUTION_POLICY.makerEntry, mode: "shadow" as const },
      }),
    });

    await mod.start();

    // Drive a tick. Token in cache with null bestBid + no snapshot → resolveBbo null.
    await bus.publish("NormalizedMarketUpdated", {
      markets: [{ ...makeMarket(), bestBid: null } as unknown as NormalizedMarket],
      timestamp: Date.now(),
    });

    // The pending order must have been expired despite the unresolvable BBO.
    const updateCalls = (shadowRepo.updateStage as ReturnType<typeof vi.fn>).mock.calls;
    const expiredCall = updateCalls.find(([, update]) => update?.stage === "expired");
    expect(expiredCall).toBeDefined();

    await mod.stop();
  });
});
