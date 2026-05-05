import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlgoDecisionModule } from "../algo-decision-module.js";
import type { SelectedMarketCache } from "../algo-decision-module.js";
import type {
  EventBus,
  LegStateRepository,
  AlgoRulesRepository,
  AlgoDecisionRule,
  AlgoSizeRule,
  NormalizedMarket,
  LegState,
  RuntimeEventMap,
  OrderRepository,
  DecisionSignalLogRepository,
  RiskEventRepository,
} from "@plankton/domain";
import { createTokenId, createCommandId } from "@plankton/domain";
import type { ConditionId } from "@plankton/domain";
import type { Logger } from "../../../logger.js";

// ─── Seed rules ───────────────────────────────────────────────────────────────

/** Minimal decision rules: REDEEM for S1 + S2 on low price + hold threshold, FALLBACK BUY. */
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
    sizeUsdc: 2.1,
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
    sizeUsdc: 0.44,
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

function createMockOrderRepo(openBuyNotional = 0): Pick<OrderRepository, "sumOpenBuyNotional"> {
  return {
    sumOpenBuyNotional: vi.fn().mockReturnValue(openBuyNotional),
  };
}

function createMockControlDb(walletBalance: number | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi
        .fn()
        .mockReturnValue(
          walletBalance != null ? { wallet_balance_usdc: walletBalance } : undefined,
        ),
    }),
  };
}

/**
 * ADR-016 — richer control-db mock that pattern-matches on the SQL string so
 * a single instance answers wallet-balance, continuation-mode, and
 * continuation-mode-version queries from `WalletBudgetControlDb`,
 * `readContinuationMode`, and `readContinuationModeVersion` respectively.
 *
 * Mutate via `setMode` to simulate an operator flip; the helper bumps the
 * version automatically so the runtime's hot-reload poller observes a change.
 */
function createContinuationControlDb(opts: {
  walletBalanceUsdc?: number | null;
  continuationMode?: "leg_local" | "market_wide";
  continuationModeVersion?: number;
}) {
  const state = {
    walletBalanceUsdc: opts.walletBalanceUsdc ?? null,
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
        if (sql.includes("wallet_balance_usdc")) {
          return state.walletBalanceUsdc != null
            ? { wallet_balance_usdc: state.walletBalanceUsdc }
            : undefined;
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AlgoDecisionModule", () => {
  let bus: ReturnType<typeof createMockBus>;
  let legStateRepo: LegStateRepository;
  let algoRulesRepo: AlgoRulesRepository;
  let selectedMarketCache: SelectedMarketCache;
  let orderRepo: Pick<OrderRepository, "sumOpenBuyNotional">;
  let log: Logger;

  function buildModule(
    overrides: Partial<import("../algo-decision-module.js").AlgoDecisionModuleDeps> = {},
  ) {
    return new AlgoDecisionModule({
      bus: bus as unknown as EventBus,
      legStateRepo,
      algoRulesRepo,
      orderRepo,
      selectedMarketCache,
      log,
      sweepIntervalMs: 60_000,
      ...overrides,
    });
  }

  beforeEach(() => {
    bus = createMockBus();
    legStateRepo = createMockLegStateRepo();
    algoRulesRepo = createMockAlgoRulesRepo();
    selectedMarketCache = createMockSelectedMarketCache();
    orderRepo = createMockOrderRepo();
    log = createMockLogger();
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
    const signal = signalCalls[0]![1].signal as import("@plankton/domain").Signal;
    expect(signal.side).toBe("buy");
    expect(signal.decisionRuleId).toBe("FALLBACK");
    expect(signal.reason).toBe("probe-entry");
    expect(signal.suggestedSizeUsdc).toBeCloseTo(2.1, 5);
    expect(signal.conditionId).toBe("cond-1");

    // Phase 2.A: payload embeds the NormalizedMarket snapshot observed by the
    // pre-entry hard-liveness gate so the bridge downstream can re-use it.
    expect(signalCalls[0]![1].market).toBe(market);

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
    const signal = signalCalls[0]![1].signal as import("@plankton/domain").Signal;
    expect(signal.conditionId).toBe("cond-1" as ConditionId);

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
      markets: [{ ...makeMarket(tokenId, null, 0.15, "cond-sell"), tradable: false }],
      timestamp: Date.now(),
    });

    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0]).toMatchObject({
      tokenId: createTokenId(tokenId),
      conditionId: "cond-sell",
      side: "SELL",
      decisionRuleId: "D7-SELL-S1",
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

  it("emits RedeemRequested when REDEEM conditions are met", async () => {
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

    // Price 0.03 < 0.05 + holdDuration ~1500s ≤ 3600s threshold → REDEEM-S2 fires
    const market = makeMarket(tokenId, familyId, 0.03, conditionId);
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
      timestamp: Date.now(),
    });

    const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
    const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
    const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");

    expect(redeemCalls.length).toBe(1);
    expect(
      (redeemCalls[0]![1] as import("@plankton/domain").RuntimeEventMap["RedeemRequested"])
        .conditionIds,
    ).toContain(conditionId);
    expect(signalCalls.length).toBe(0);
    expect(decisionSignalLogRepo.insert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(decisionSignalLogRepo.insert).mock.calls[0]![0]).toMatchObject({
      tokenId: createTokenId(tokenId),
      conditionId,
      side: "REDEEM",
      decisionRuleId: "REDEEM-S2",
      state: "S2",
      price: 0.03,
      buyCount: 2,
    });
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_emitted",
      payload: expect.objectContaining({
        tokenId,
        conditionId,
        side: "REDEEM",
        decisionRuleId: "REDEEM-S2",
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
    expect(riskEventRepo.insert).toHaveBeenCalledWith({
      eventType: "signal_suppressed",
      payload: expect.objectContaining({
        tokenId,
        conditionId,
        side: "REDEEM",
        decisionRuleId: "REDEEM-S2",
        reasonCode: "redeem-before-end-date",
        state: "S2",
        firstTradePrice: 0.1,
        legTradeCount: 2,
      }),
    });
    const emittedRedeem = vi
      .mocked(riskEventRepo.insert)
      .mock.calls.some(
        ([event]) => event.eventType === "signal_emitted" && event.payload.side === "REDEEM",
      );
    expect(emittedRedeem).toBe(false);

    await mod.stop();
  });

  it("emits RedeemRequested when market endDate is in the past", async () => {
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
    expect(redeemCalls.length).toBe(1);
    expect(
      (redeemCalls[0]![1] as import("@plankton/domain").RuntimeEventMap["RedeemRequested"])
        .conditionIds,
    ).toContain(conditionId);

    await mod.stop();
  });

  it("emits RedeemRequested when market endDate is null (downstream gamma-gate handles it)", async () => {
    // Missing endDate → passthrough; ResolutionModule's filterConfirmedRedeemable
    // still queries Gamma and defers if unresolved.
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
    expect(redeemCalls.length).toBe(1);

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

    it("REDEEM still fires before continuation gate", async () => {
      const tokenId = "token-cont-redeem";
      const familyId = "fam-cont";
      const conditionId = "cond-redeem-cont";
      // S1 with low trade count → STOP, but REDEEM matches first
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

      // Price 0.03 < 0.05 + holdDuration ~1800s ≤ 3600s → REDEEM
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.03, conditionId)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
      expect(redeemCalls.length).toBe(1);
      expect(redeemCalls[0]![1].conditionIds).toContain(conditionId);

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

    // REDEEM uses a separate (NegRisk-contract) pipeline that does NOT go
    // through the signal-to-order bridge, so it must still fire even when
    // the CLOB has dropped liveness.
    it("still emits RedeemRequested for an S2 legged token when market is unhealthy", async () => {
      const tokenId = "token-redeem-unhealthy";
      const conditionId = "cond-redeem-unhealthy";
      const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 2,
        sellCount: 0, // S2 + price<0.05 + holdDuration ≤ 3600s → REDEEM-S2
        lastAction: "BUY",
        firstTradePrice: 0.1,
        firstTradeAt: twentyFiveMinAgo,
        lastTradeAt: twentyFiveMinAgo,
        updatedAt: twentyFiveMinAgo,
      };
      legStateRepo = createMockLegStateRepo([legState]);

      const mod = buildModule();
      await mod.start();

      // Unhealthy market (acceptingOrders=false) — gate must still let REDEEM through.
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
      expect(redeemCalls.length).toBe(1);
      expect(
        (redeemCalls[0]![1] as import("@plankton/domain").RuntimeEventMap["RedeemRequested"])
          .conditionIds,
      ).toContain(conditionId);
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

  describe("wallet buy budget gate", () => {
    it("skips SignalProduced for new entry when wallet buy budget is exhausted", async () => {
      const tokenId = "token-wallet-blocked";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      orderRepo = createMockOrderRepo(8);

      const mod = buildModule({
        controlDb: createMockControlDb(10),
        activeProfile: "paper" as any,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(0);

      await mod.stop();
    });

    // Regression: decision_signal_log + signal_emitted used to be written
    // inside `buildSignal` (before the wallet-budget filter). When budget was
    // exhausted, we silently dropped the SignalProduced publish but still
    // booked the emission row, so signal_emitted overcounted by every dropped
    // tail-end signal. Operators reading
    //   COUNT(signal_emitted) vs COUNT(SignalProduced)
    // saw fictitious "missing" emissions and stopped trusting the ledger.
    it("does not record decision_signal_log or signal_emitted when wallet budget drops the signal", async () => {
      const tokenId = "token-wallet-no-telemetry";
      selectedMarketCache = createMockSelectedMarketCache([tokenId]);
      orderRepo = createMockOrderRepo(8);
      const decisionSignalLogRepo: DecisionSignalLogRepository = { insert: vi.fn() };
      const riskEventRepo: RiskEventRepository = { insert: vi.fn(), countSince: vi.fn() };

      const mod = buildModule({
        controlDb: createMockControlDb(10),
        activeProfile: "paper" as any,
        decisionSignalLogRepo,
        riskEventRepo,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(0);
      expect(decisionSignalLogRepo.insert).not.toHaveBeenCalled();
      const signalEmittedCalls = vi
        .mocked(riskEventRepo.insert)
        .mock.calls.filter(([event]) => event.eventType === "signal_emitted");
      expect(signalEmittedCalls).toHaveLength(0);

      await mod.stop();
    });

    it("caps BUY emissions within one sweep to available wallet budget", async () => {
      const tokenIds = ["token-wallet-1", "token-wallet-2", "token-wallet-3"];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);
      orderRepo = createMockOrderRepo(0);

      const mod = buildModule({
        controlDb: createMockControlDb(5),
        activeProfile: "paper" as any,
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

      await mod.stop();
    });

    it("carries pending BUY reservations across successive market-update batches", async () => {
      const tokenIds = ["token-wallet-a", "token-wallet-b", "token-wallet-c"];
      selectedMarketCache = createMockSelectedMarketCache(tokenIds);
      orderRepo = createMockOrderRepo(0);

      const mod = buildModule({
        controlDb: createMockControlDb(5),
        activeProfile: "paper" as any,
      });
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: tokenIds.slice(0, 2).map((tokenId) => makeMarket(tokenId, null, 0.45)),
        timestamp: Date.now(),
      });
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenIds[2]!, null, 0.45)],
        timestamp: Date.now(),
      });

      const signalCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([ev]) => ev === "SignalProduced",
      );
      expect(signalCalls.length).toBe(2);

      await mod.stop();
    });

    it("does not block SELL when wallet buy budget is exhausted", async () => {
      const tokenId = "token-wallet-sell";
      orderRepo = createMockOrderRepo(8);
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

      const mod = buildModule({
        controlDb: createMockControlDb(10),
        activeProfile: "paper" as any,
      });
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

    it("clears a signal-time reservation when risk rejects the signal", async () => {
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
      )?.[1].signal as import("@plankton/domain").Signal;
      expect(firstSignal).toBeDefined();

      await (bus as any).emit("SignalRejected", {
        signal: firstSignal,
        reason: "wallet_buy_budget_exhausted",
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
      )?.[1].signal as import("@plankton/domain").Signal;
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
    const signal = signalCalls[0]![1].signal as import("@plankton/domain").Signal;
    expect(signal.side).toBe("buy");
    expect(signal.decisionRuleId).toBe("FALLBACK");
    // B5 size rule: nth_buy=1 (first purchase) → 2.10 USDC
    expect(signal.suggestedSizeUsdc).toBeCloseTo(2.1, 5);

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
        version: 1 as const,
        entryPriceCeiling: 0.99,
        exitOrderTtlMs: 60_000,
        entryMinMarketAgeSeconds,
        deadSideGuard: { mode: "off" as const, askCeiling: 0.2, maxTimeToEndMs: 0 },
        pricing: {
          mode: "edge" as const,
          maxEntrySpreadTicks: 100,
          maxExitSpreadTicks: 100,
          maxImprovementTicks: 0,
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

    it("does NOT gate SELL on an existing leg even when gammaCreatedAt is too young", async () => {
      const tokenId = "token-sell-not-gated";
      const conditionId = "cond-sell-not-gated";
      const twentyFiveMinAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const legState: LegState = {
        tokenId: createTokenId(tokenId),
        buyCount: 2,
        sellCount: 0, // S2 + price<0.05 → REDEEM-S2
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
        // Recent createdAt (would gate a fresh BUY) — must NOT block REDEEM.
        gammaCreatedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [market],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const redeemCalls = publishCalls.filter(([ev]) => ev === "RedeemRequested");
      expect(redeemCalls.length).toBe(1);

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
});
