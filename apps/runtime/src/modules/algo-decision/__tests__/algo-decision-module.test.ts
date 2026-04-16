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
} from "@plankton/domain";
import { createTokenId, createFamilyId, createCommandId, createOrderId } from "@plankton/domain";
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

function makeMarket(
  tokenId: string,
  familyId: string | null,
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
    familyId: familyId !== null ? createFamilyId(familyId) : null,
    familyKey: null,
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tickSize: 0.01,
    negRisk: false,
    bestBid: midPrice !== null ? midPrice - 0.01 : null,
    bestAsk: midPrice !== null ? midPrice + 0.01 : null,
    midPrice,
    spread: 0.02,
    snapshotTs: Date.now(),
  };
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
    expect(signal.familyId).toBeNull();
    expect(signal.conditionId).toBe("cond-1" as ConditionId);

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

    const mod = buildModule();
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

    await mod.stop();
  });

  it("skips tokens with pending entries", async () => {
    const tokenId = "token-pending";
    const familyId = "fam-3";
    selectedMarketCache = createMockSelectedMarketCache([tokenId]);

    const mod = buildModule();
    await mod.start();

    // Simulate a buy order placed for this token
    await (bus as any).emit("OrderPlaced", {
      commandId: createCommandId("cmd-1"),
      clientOrderId: "clt-1" as any,
      orderId: createOrderId("ord-1"),
      tokenId: createTokenId(tokenId),
      side: "buy" as const,
      price: 0.45,
      size: 4.67,
      orderType: "limit" as const,
      familyId: createFamilyId(familyId),
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });

    // Reset publish mock so we only see calls from market update
    (bus.publish as ReturnType<typeof vi.fn>).mockClear();

    // Now market update arrives — should NOT emit SignalProduced for this token
    const market = makeMarket(tokenId, familyId, 0.45);
    await (bus as any).emit("NormalizedMarketUpdated", {
      markets: [market],
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

      const mod = buildModule();
      await mod.start();

      await (bus as any).emit("NormalizedMarketUpdated", {
        markets: [makeMarket(tokenId, familyId, 0.45)],
        timestamp: Date.now(),
      });

      const publishCalls = (bus.publish as ReturnType<typeof vi.fn>).mock.calls;
      const signalCalls = publishCalls.filter(([ev]) => ev === "SignalProduced");
      expect(signalCalls.length).toBe(0);

      await mod.stop();
    });

    it("emits SELL on STOP path when SELL rule matches", async () => {
      const tokenId = "token-cont-sell";
      const familyId = "fam-cont";
      // legState: S1 (buyCount=1), sellCount=0 → tradeCount = 1
      // firstTradePrice = 0.03 < 0.05 → STOP
      // S1 + price >= 0.10 → D7-SELL-S1 matches
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

      const mod = buildModule();
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
});
