import { describe, it, expect, vi } from "vitest";
import {
  createPositionId,
  createTokenId,
  createConditionId,
  BOUNCE_EXIT_BACKSTOP_RULE_ID,
  BOUNCE_EXIT_TARGET_RULE_ID,
  bounceExitTierGain,
  computeHarvestTarget,
  DEFAULT_BUY_CAPACITY_POLICY,
  DEFAULT_EXECUTION_POLICY,
  type Signal,
  type Order,
  type Position,
  type ExecutionPolicy,
} from "@krabs/domain";
import type {
  FillRepository,
  MarketRepository,
  OrderRepository,
  PositionRepository,
} from "@krabs/domain";
import { AlgoRiskGateImpl, CONDITION_REDEEM_IN_FLIGHT_REASON } from "../algo-risk-gate.js";
import type { Logger } from "../../../logger.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const TOK_ID = createTokenId("tok-yes");
const COND_ID = createConditionId("cond-abc");

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => makeLogger()),
    trace: vi.fn(),
    level: "info",
    silent: vi.fn(),
  } as unknown as Logger;
}

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    signalId: "sig-1",
    tokenId: TOK_ID,
    conditionId: COND_ID,
    side: "buy",
    suggestedPrice: 0.5,
    suggestedSize: 10,
    suggestedSizeUsdc: 5,
    reason: "probe-entry",
    strategyTick: Date.now(),
    sequenceInTick: 0,
    decisionRuleId: "FALLBACK",
    sizingRuleId: "FALLBACK",
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOrderRepo(orders: Order[] = []): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi
      .fn()
      .mockReturnValue(
        orders.filter((order) => ["pending", "open", "partially-filled"].includes(order.status)),
      ),
    findByTokenId: vi
      .fn()
      .mockImplementation((tokenId) => orders.filter((order) => order.tokenId === tokenId)),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

function makeBuyCapacityPolicy(overrides?: {
  enabled?: boolean;
  minNewEntryWalletHeadroomUsdc?: number;
  minAddWalletHeadroomUsdc?: number;
  maxOpenBuyOrders?: number;
  maxOpenBuyOrdersPerToken?: number;
}) {
  return {
    ...DEFAULT_BUY_CAPACITY_POLICY,
    ...overrides,
  };
}

function makeExecutionPolicy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    ...overrides,
    buyCapacity: {
      ...DEFAULT_EXECUTION_POLICY.buyCapacity,
      ...overrides?.buyCapacity,
    },
    sellCapacity: {
      ...DEFAULT_EXECUTION_POLICY.sellCapacity,
      ...overrides?.sellCapacity,
    },
    orderCapacity: {
      ...DEFAULT_EXECUTION_POLICY.orderCapacity,
      ...overrides?.orderCapacity,
    },
  };
}

function makePositionRepo(position: Position | null = null): PositionRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(position),
    findOpen: vi.fn().mockReturnValue([]),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    findById: vi.fn(() => null),
    findActiveByTokenId: vi.fn(() => []),
  };
}

function makeMarketRepo(conditionId = COND_ID): Pick<MarketRepository, "findByTokenId"> {
  return {
    findByTokenId: vi.fn(() => ({
      tokenId: TOK_ID,
      conditionId,
      tickSize: 0.01,
    })) as unknown as MarketRepository["findByTokenId"],
  };
}

type FillReader = Partial<Pick<FillRepository, "findByOrderId" | "findByOrderIds">>;
type FindByOrderIds = NonNullable<FillRepository["findByOrderIds"]>;

function makeFillReader(
  fills: Array<{ orderId: Order["orderId"]; size: number }> = [],
  bulk = true,
): FillReader {
  const findByOrderId = vi.fn((orderId: Order["orderId"]) =>
    fills.filter((fill) => fill.orderId === orderId),
  );
  return {
    findByOrderId: findByOrderId as unknown as FillRepository["findByOrderId"],
    ...(bulk
      ? {
          findByOrderIds: vi.fn((orderIds: Order["orderId"][]) =>
            fills.filter((fill) => orderIds.includes(fill.orderId)),
          ) as unknown as FindByOrderIds,
        }
      : {}),
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

function makeOpenPosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: TOK_ID,
    conditionId: COND_ID,
    side: "buy",
    size: 10,
    avgEntryPrice: 0.2,
    costBasisUsdc: 2,
    currentValueUsdc: 2,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOpenBuyOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: "ord-1" as any,
    clientOrderId: "clord-1" as any,
    tokenId: TOK_ID,
    conditionId: COND_ID,
    side: "buy",
    orderType: "GTC",
    price: 0.5,
    size: 10,
    sizeUsdc: 5,
    status: "open",
    exchangeOrderId: null,
    signalId: null,
    signalReason: null,
    botRunId: "run-1" as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeOpenSellOrder(overrides?: Partial<Order>): Order {
  return makeOpenBuyOrder({
    orderId: "sell-ord-1" as any,
    clientOrderId: "sell-clord-1" as any,
    side: "sell",
    ...overrides,
  });
}

function makeBounceSupplementalFixture() {
  const policy = makeExecutionPolicy();
  const position = makeOpenPosition({ size: 120, exitOwner: "bounce" });
  const ladderId = "prod-bounce-supplemental";
  const anchorPrice = 0.002;
  const price = (rungIndex: number) =>
    computeHarvestTarget(
      anchorPrice,
      (1 + bounceExitTierGain(policy.bounceExit, anchorPrice)) *
        Math.pow(1 + policy.bounceExit.ladderStepPct, rungIndex) -
        1,
      0.001,
    );
  const rung = (rungIndex: number, size: number, cleanup = false) =>
    makeOpenSellOrder({
      orderId: `supplemental-${rungIndex}-${cleanup}` as any,
      clientOrderId: `supplemental-cl-${rungIndex}-${cleanup}` as any,
      conditionId: position.conditionId,
      positionId: position.positionId,
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      signalReason: "repricing-exit",
      postOnly: true,
      exchangeOrderId: `exchange-${rungIndex}-${cleanup}`,
      fillProgressShares: null,
      price: price(rungIndex),
      size,
      metadata: {
        bounceRung: {
          ladderId,
          rungIndex,
          anchorPrice,
          fraction: cleanup ? 3 : policy.bounceExit.ladderFractions[rungIndex],
          originalPositionSize: 30,
          remainingPositionSize: cleanup ? 120 : 30,
          uncommittedRemainder: cleanup ? 90 : 120 - 90 - 9 - 12,
          ...(cleanup ? { isCleanupRung: true } : {}),
        },
      },
    });
  const orders = [rung(0, 9), rung(1, 12), rung(2, 90, true)];
  orders[0] = { ...orders[0]!, postOnly: false };
  const signal = makeSignal({
    side: "sell",
    reason: "repricing-exit",
    decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
    positionId: position.positionId,
    suggestedPrice: price(2),
    suggestedSize: 9,
    suggestedSizeUsdc: price(2) * 9,
    bounceRung: {
      ladderId,
      rungIndex: 2,
      anchorPrice,
      fraction: 0.3,
      originalPositionSize: 30,
      remainingPositionSize: 120,
      uncommittedRemainder: 9,
    },
  });
  return { policy, position, orders, signal };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AlgoRiskGateImpl", () => {
  it("approves a basic buy signal", async () => {
    const gate = new AlgoRiskGateImpl(makeOrderRepo(), makePositionRepo(), makeLogger());
    const signal = makeSignal();
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(true);
    expect(decision.signalId).toBe(signal.signalId);
    expect(decision.rejectionReasons).toHaveLength(0);
  });

  it("rejects BUY when the signal condition has an in-flight redeem", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
      undefined,
      makeMarketRepo(),
      () => true,
    );
    const decision = await gate.evaluate(makeSignal({ side: "buy" }));

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain(CONDITION_REDEEM_IN_FLIGHT_REASON);
  });

  it("rejects SELL when the signal condition has an in-flight redeem", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
      undefined,
      makeMarketRepo(),
      () => true,
    );
    const decision = await gate.evaluate(makeSignal({ side: "sell" }));

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain(CONDITION_REDEEM_IN_FLIGHT_REASON);
  });

  it("allows unrelated conditions when redeem guard returns false", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
      undefined,
      makeMarketRepo(createConditionId("cond-unrelated")),
      (conditionId) => conditionId === "cond-other",
    );
    const decision = await gate.evaluate(makeSignal({ side: "buy" }));

    expect(decision.approved).toBe(true);
  });

  it("allows signals after successful redeem clears the in-flight condition", async () => {
    let inFlight = true;
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
      undefined,
      makeMarketRepo(),
      () => inFlight,
    );

    expect((await gate.evaluate(makeSignal({ side: "buy" }))).approved).toBe(false);
    inFlight = false;
    expect((await gate.evaluate(makeSignal({ side: "buy" }))).approved).toBe(true);
  });

  it("emits a redeem-in-flight rejection metric for every rejected signal", async () => {
    const metrics = vi.fn();
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
      undefined,
      makeMarketRepo(),
      () => true,
      metrics,
    );

    await gate.evaluate(makeSignal({ side: "buy" }));
    await gate.evaluate(makeSignal({ signalId: "sig-2", side: "sell" }));

    expect(metrics).toHaveBeenCalledTimes(2);
    expect(metrics).toHaveBeenCalledWith({ side: "buy", conditionId: String(COND_ID) });
    expect(metrics).toHaveBeenCalledWith({ side: "sell", conditionId: String(COND_ID) });
  });

  it("allows second buy when token has one open buy order and per-token cap is two", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo([makeOpenBuyOrder()]),
      makePositionRepo(),
      makeLogger(),
    );
    const signal = makeSignal({ side: "buy", reason: "probe-entry" });
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(true);
  });

  it("rejects buy when token has two open buy orders and per-token cap is two", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo([
        makeOpenBuyOrder(),
        makeOpenBuyOrder({ orderId: "ord-2" as any, clientOrderId: "clord-2" as any }),
      ]),
      makePositionRepo(),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
    );
    const decision = await gate.evaluate(makeSignal({ side: "buy", reason: "probe-entry" }));

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("per_token_buy_limit");
  });

  it("allows sell signals even with open buy order", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo([makeOpenBuyOrder()]),
      makePositionRepo(null),
      makeLogger(),
    );
    const signal = makeSignal({ side: "sell", reason: "repricing-exit" });
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(true);
  });

  it("rejects buy when order size is below the per-token minimum", async () => {
    const resolveMinOrderSize = vi.fn().mockReturnValue(5);
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      resolveMinOrderSize,
    );
    const signal = makeSignal({ suggestedSize: 1 });
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons.some((r) => r.includes("below min"))).toBe(true);
  });

  it("approves buy when order size meets the per-token minimum", async () => {
    const resolveMinOrderSize = vi.fn().mockReturnValue(5);
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      resolveMinOrderSize,
    );
    const signal = makeSignal({ suggestedSize: 10 });
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(true);
  });

  it("includes tokenId and conditionId in RiskDecision", async () => {
    const gate = new AlgoRiskGateImpl(makeOrderRepo(), makePositionRepo(), makeLogger());
    const signal = makeSignal();
    const decision = await gate.evaluate(signal);

    expect(decision.tokenId).toBe(TOK_ID);
    expect(decision.conditionId).toBe(COND_ID);
  });

  it("rejects buy when wallet buy budget is exhausted", async () => {
    const orderRepo = makeOrderRepo();
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(8);
    const gate = new AlgoRiskGateImpl(
      orderRepo,
      makePositionRepo(),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(10),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy({ enabled: false }),
    );

    const decision = await gate.evaluate(makeSignal({ suggestedSizeUsdc: 2 }));

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("wallet_buy_budget_exhausted");
  });

  it("approves buy when wallet buy budget can cover the signal", async () => {
    const orderRepo = makeOrderRepo();
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(2);
    const gate = new AlgoRiskGateImpl(
      orderRepo,
      makePositionRepo(),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(10),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy({ enabled: false }),
    );

    const decision = await gate.evaluate(makeSignal({ suggestedSizeUsdc: 2 }));

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("wallet_buy_budget_ok");
  });

  it("rejects new-entry BUY when capacity headroom would be at the threshold", async () => {
    const orderRepo = makeOrderRepo();
    const gate = new AlgoRiskGateImpl(
      orderRepo,
      makePositionRepo(),
      makeLogger(),
      undefined,
      {
        // balance - 3% wallet buffer - $2 order = $7.00 required new-entry headroom.
        controlDb: createMockControlDb(9 / 0.97),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy({ maxOpenBuyOrders: 2 }),
    );

    const decision = await gate.evaluate(
      makeSignal({ suggestedSizeUsdc: 2, reason: "probe-entry" }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("wallet_buy_capacity_exhausted");
  });

  it("rejects add-buy when capacity headroom would be below the add reserve", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(makeOpenPosition()),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(6.5),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy({ maxOpenBuyOrders: 2 }),
    );

    const decision = await gate.evaluate(makeSignal({ suggestedSizeUsdc: 2, reason: "scale-in" }));

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("wallet_buy_capacity_exhausted");
  });

  it("rejects BUY when max open BUY order count is reached", async () => {
    const orderRepo = makeOrderRepo([
      makeOpenBuyOrder(),
      { ...makeOpenBuyOrder(), orderId: "ord-2" as any, clientOrderId: "clord-2" as any },
    ]);
    const gate = new AlgoRiskGateImpl(
      orderRepo,
      makePositionRepo(),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(100),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy({ maxOpenBuyOrders: 2 }),
    );

    const decision = await gate.evaluate(makeSignal({ tokenId: createTokenId("other-token") }));

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("wallet_buy_capacity_exhausted");
  });

  it("reserves the final shared order slot for the exact active R23 capture", async () => {
    const now = Date.now();
    const orders = Array.from({ length: 24 }, (_, index) =>
      makeOpenBuyOrder({
        orderId: `reserve-buy-${index}` as any,
        clientOrderId: `reserve-client-${index}` as any,
        tokenId: createTokenId(`reserve-token-${index}`),
      }),
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(),
      makeLogger(),
      undefined,
      { controlDb: createMockControlDb(100), activeProfile: "paper" as any },
      () => makeBuyCapacityPolicy({ maxOpenBuyOrders: 100 }),
      () =>
        makeExecutionPolicy({
          orderCapacity: {
            ...DEFAULT_EXECUTION_POLICY.orderCapacity,
            maxOpenOrdersTotal: 25,
          },
          makerEntry: {
            ...DEFAULT_EXECUTION_POLICY.makerEntry,
            mode: "micro_live",
            microLiveWindow: {
              activatedAtUtc: new Date(now - 60_000).toISOString(),
              expiresAtUtc: new Date(now + 60_000).toISOString(),
              maxCumulativeAcceptedPendingUsdc: 44,
              maxCumulativeAcceptedPendingUsdcPerCondition: 1,
              maxDistinctAcceptedConditions: 44,
              maxCumulativeFilledUsdc: 5,
              captureNextR23: true,
            },
          },
        }),
    );

    const ordinary = await gate.evaluate(makeSignal({ generatedAt: new Date(now).toISOString() }));
    const capture = await gate.evaluate(
      makeSignal({
        decisionRuleId: "R23_DIP_TRIGGER",
        generatedAt: new Date(now).toISOString(),
      }),
    );

    expect(ordinary.rejectionReasons).toContain("total_orders_capacity_exhausted");
    expect(capture.approved).toBe(true);
  });

  it.each([
    [1, true],
    [2, false],
    [3, false],
  ])("evaluates per-token BUY cap at count %i", async (count, approved) => {
    const orders = Array.from({ length: count }, (_, index) =>
      makeOpenBuyOrder({
        orderId: `buy-${index}` as any,
        clientOrderId: `buy-cl-${index}` as any,
      }),
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(100),
        activeProfile: "paper" as any,
      },
      undefined,
      () => makeExecutionPolicy(),
    );

    const decision = await gate.evaluate(makeSignal({ reason: "scale-in" }));

    expect(decision.approved).toBe(approved);
    if (!approved) expect(decision.rejectionReasons).toContain("per_token_buy_limit");
  });

  it("dedupes same-token near-price BUY before per-token capacity rejection", async () => {
    const existing = makeOpenBuyOrder({
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
      price: 0.5,
      metadata: { source: "strategy" },
    });
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo([existing]),
      makePositionRepo(),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(100),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy({ maxOpenBuyOrdersPerToken: 1 }),
      () => makeExecutionPolicy(),
      undefined,
      {
        findByTokenId: vi.fn(() => ({ tokenId: TOK_ID, conditionId: COND_ID, tickSize: 0.01 })),
      } as unknown as Pick<MarketRepository, "findByTokenId">,
    );

    const decision = await gate.evaluate(
      makeSignal({
        suggestedPrice: 0.51,
        reason: "probe-entry",
        decisionRuleId: "R23_DIP_TRIGGER",
      }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("buy_duplicate_deduped");
    expect(decision.rejectionReasons).not.toContain("per_token_buy_limit");
  });

  it("allows same-token BUY at materially different price up to the per-token cap", async () => {
    const existing = makeOpenBuyOrder({
      signalReason: "scale-in",
      decisionRuleId: "D3",
      price: 0.5,
    });
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo([existing]),
      makePositionRepo(makeOpenPosition()),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(100),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy({ maxOpenBuyOrdersPerToken: 2 }),
      () => makeExecutionPolicy(),
      undefined,
      {
        findByTokenId: vi.fn(() => ({ tokenId: TOK_ID, conditionId: COND_ID, tickSize: 0.01 })),
      } as unknown as Pick<MarketRepository, "findByTokenId">,
    );

    const decision = await gate.evaluate(
      makeSignal({
        suggestedPrice: 0.53,
        reason: "scale-in",
        decisionRuleId: "D3",
      }),
    );

    expect(decision.approved).toBe(true);
    expect(decision.rejectionReasons).toHaveLength(0);
  });

  it.each([
    [1, true],
    [2, true],
    [3, false],
  ])("evaluates replacement-aware per-token SELL cap at count %i", async (count, approved) => {
    const orders = Array.from({ length: count }, (_, index) =>
      makeOpenSellOrder({
        orderId: `sell-${index}` as any,
        clientOrderId: `sell-cl-${index}` as any,
      }),
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(null),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
    );

    const decision = await gate.evaluate(makeSignal({ side: "sell", reason: "repricing-exit" }));

    expect(decision.approved).toBe(approved);
    if (!approved) expect(decision.rejectionReasons).toContain("per_token_sell_limit");
  });

  it.each([
    [1, true],
    [2, true],
    [3, false],
    [4, false],
  ])(
    "enforces a strict (undiscounted) per-token SELL ceiling of ladderFractions.length for new bounce-exit rungs at count %i (Phase 3 Codex FIX 4)",
    async (count, approved) => {
      const orders = Array.from({ length: count }, (_, index) =>
        makeOpenSellOrder({
          orderId: `bounce-rung-${index}` as any,
          clientOrderId: `bounce-rung-cl-${index}` as any,
          decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
        }),
      );
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(orders),
        makePositionRepo(null),
        makeLogger(),
        undefined,
        undefined,
        undefined,
        () => makeExecutionPolicy(),
      );

      // DEFAULT_EXECUTION_POLICY.bounceExit.ladderFractions has 3 entries, so the
      // carve-out ceiling is max(sellCapacity.maxOpenSellOrdersPerToken=2, 3) = 3.
      // Unlike a genuine same-source replacement, a new BOUNCE_EXIT_TARGET rung
      // gets NO -1 "replacement-aware" discount (getReplacementAwareSellCounts
      // exempts it) — ladder rungs coexist rather than replace one another, so
      // 3 already-resting rungs must reject a would-be 4th, consistent with
      // execution-module.ts's own undiscounted per-token cap enforcement.
      const decision = await gate.evaluate(
        makeSignal({
          side: "sell",
          reason: "repricing-exit",
          decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
        }),
      );

      expect(decision.approved).toBe(approved);
      if (!approved) expect(decision.rejectionReasons).toContain("per_token_sell_limit");
    },
  );

  it("allows only an exact bounce residual cleanup to use the one extra ladder slot", async () => {
    const position = makeOpenPosition({ size: 120, exitOwner: "bounce" });
    const orders = Array.from({ length: 3 }, () =>
      makeOpenSellOrder({
        decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      }),
    );
    const policy = makeExecutionPolicy();
    const lastRungIndex = policy.bounceExit.ladderFractions.length - 1;
    const anchorPrice = 0.1;
    const suggestedPrice = computeHarvestTarget(
      anchorPrice,
      (1 + bounceExitTierGain(policy.bounceExit, anchorPrice)) *
        Math.pow(1 + policy.bounceExit.ladderStepPct, lastRungIndex) -
        1,
      0.01,
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(position),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => policy,
      undefined,
      makeMarketRepo(),
    );
    const exact = makeSignal({
      side: "sell",
      reason: "repricing-exit",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      positionId: position.positionId,
      suggestedPrice,
      suggestedSize: 90,
      suggestedSizeUsdc: suggestedPrice * 90,
      bounceRung: {
        ladderId: "bounce-cleanup-ladder",
        rungIndex: lastRungIndex,
        anchorPrice,
        fraction: 3,
        originalPositionSize: 30,
        remainingPositionSize: 120,
        uncommittedRemainder: 90,
        isCleanupRung: true,
      },
    });

    const approved = await gate.evaluate(exact);
    const malformed = await gate.evaluate({
      ...exact,
      bounceRung: { ...exact.bounceRung!, rungIndex: lastRungIndex - 1 },
    });

    expect(approved.approved).toBe(true);
    expect(malformed.rejectionReasons).toContain("per_token_sell_limit");
  });

  it("admits only the exact missing ordinary rung beside a working cleanup", async () => {
    const fixture = makeBounceSupplementalFixture();
    const evaluate = (
      orders: Order[],
      signal = fixture.signal,
      position = fixture.position,
      fillReader: FillReader | null = makeFillReader(),
    ) => {
      const positions = makePositionRepo(position);
      positions.findActiveByTokenId = vi.fn(() => [position]);
      return new AlgoRiskGateImpl(
        makeOrderRepo(orders),
        positions,
        makeLogger(),
        undefined,
        undefined,
        undefined,
        () => fixture.policy,
        undefined,
        { findByTokenId: vi.fn(() => ({ tickSize: 0.001 })) } as any,
        undefined,
        undefined,
        undefined,
        fillReader ?? undefined,
      ).evaluate(signal);
    };

    expect((await evaluate(fixture.orders)).approved).toBe(true);
    const wrongCycle = { ...fixture.orders[0]!, positionId: createPositionId("old-cycle") };
    const conflict = makeOpenSellOrder({ orderId: "conflict" as any, conditionId: COND_ID });
    const missingPostOnly = { ...fixture.orders[0]! };
    delete missingPostOnly.postOnly;
    for (const decision of await Promise.all([
      evaluate(fixture.orders, { ...fixture.signal, suggestedSize: 8 }),
      evaluate([wrongCycle, ...fixture.orders.slice(1)]),
      evaluate([...fixture.orders, conflict]),
      evaluate(fixture.orders, fixture.signal, { ...fixture.position, size: 111 }),
      evaluate(fixture.orders, { ...fixture.signal, suggestedSize: 4, suggestedSizeUsdc: 0.02 }),
      evaluate([{ ...fixture.orders[0]!, orderType: "GTD" }, ...fixture.orders.slice(1)]),
      evaluate([missingPostOnly, ...fixture.orders.slice(1)]),
    ])) {
      expect(decision.approved).toBe(false);
    }

    const actualFill = makeFillReader([{ orderId: fixture.orders[0]!.orderId, size: 1 }]);
    const zeroTelemetry = fixture.orders.map((order) => ({ ...order, fillProgressShares: 0 }));
    const throwingReader: FillReader = {
      findByOrderId: vi.fn(() => {
        throw new Error("fill lookup unavailable");
      }),
    };
    expect(
      (await evaluate(zeroTelemetry, fixture.signal, fixture.position, actualFill)).approved,
    ).toBe(false);
    expect((await evaluate(fixture.orders, fixture.signal, fixture.position, null)).approved).toBe(
      false,
    );
    expect(
      (await evaluate(fixture.orders, fixture.signal, fixture.position, throwingReader)).approved,
    ).toBe(false);
    const malformedReaders: FillReader[] = [
      makeFillReader([{ orderId: fixture.orders[0]!.orderId, size: 0 }]),
      makeFillReader([{ orderId: fixture.orders[0]!.orderId, size: Number.NaN }]),
      {
        findByOrderId: vi.fn(() => []),
        findByOrderIds: vi.fn(() => [
          { orderId: "unrequested-order", size: 1 },
        ]) as unknown as FindByOrderIds,
      },
      {
        findByOrderId: vi.fn(() => []),
        findByOrderIds: vi.fn(() => null) as unknown as FindByOrderIds,
      },
    ];
    for (const reader of malformedReaders) {
      expect(
        (await evaluate(fixture.orders, fixture.signal, fixture.position, reader)).approved,
      ).toBe(false);
    }
    const perOrderReader = makeFillReader([], false);
    expect(
      (await evaluate(fixture.orders, fixture.signal, fixture.position, perOrderReader)).approved,
    ).toBe(true);
    expect(perOrderReader.findByOrderId).toHaveBeenCalledTimes(3);
  });

  it("also grants the BOUNCE_EXIT_BACKSTOP taker signal the same ladder-sized carve-out (N rungs + backstop coexist)", async () => {
    const orders = Array.from({ length: 3 }, (_, index) =>
      makeOpenSellOrder({
        orderId: `bounce-rung-${index}` as any,
        clientOrderId: `bounce-rung-cl-${index}` as any,
        decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      }),
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(null),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
    );

    const decision = await gate.evaluate(
      makeSignal({
        side: "sell",
        reason: "repricing-exit",
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      }),
    );

    expect(decision.approved).toBe(true);
    expect(decision.rejectionReasons).toHaveLength(0);
  });

  it("does not extend the ladder carve-out to a non-bounce SELL signal, even with 3 bounce rungs already resting for the same token", async () => {
    const orders = Array.from({ length: 3 }, (_, index) =>
      makeOpenSellOrder({
        orderId: `bounce-rung-${index}` as any,
        clientOrderId: `bounce-rung-cl-${index}` as any,
        decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      }),
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(null),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
    );

    // A generic/non-bounce SELL (e.g. a Track D8 exit) does not inherit the
    // ladder's carve-out — it stays capped at the generic per-token limit (2),
    // so it is rejected here despite the same 3 resting orders that the
    // bounce-classified signal above was approved against.
    const decision = await gate.evaluate(
      makeSignal({ side: "sell", reason: "repricing-exit", decisionRuleId: "D8" }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("per_token_sell_limit");
  });

  it("admits a BOUNCE_EXIT_BACKSTOP signal even when wallet/per-token/total sell capacity are all already exhausted (final Codex fix)", async () => {
    // 4 resting non-bounce SELLs on the same token: exceeds not just the tiny
    // policy caps below but also the pre-existing bounce ladder-count
    // carve-out (max(policy, ladderFractions.length=3) = 3), so only the NEW
    // unconditional bypass — not the older per-token carve-out — can admit
    // the backstop here.
    const orders = Array.from({ length: 4 }, (_, index) =>
      makeOpenSellOrder({
        orderId: `saturate-${index}` as any,
        clientOrderId: `saturate-cl-${index}` as any,
        decisionRuleId: "D8",
      }),
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(null),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () =>
        makeExecutionPolicy({
          sellCapacity: {
            ...DEFAULT_EXECUTION_POLICY.sellCapacity,
            maxOpenSellOrders: 1,
            maxOpenSellOrdersPerToken: 1,
          },
          orderCapacity: { ...DEFAULT_EXECUTION_POLICY.orderCapacity, maxOpenOrdersTotal: 1 },
        }),
    );

    const backstopDecision = await gate.evaluate(
      makeSignal({
        side: "sell",
        reason: "repricing-exit",
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      }),
    );

    expect(backstopDecision.approved).toBe(true);
    expect(backstopDecision.rejectionReasons).toHaveLength(0);

    // Same exhausted conditions, same token — a normal SELL is still rejected;
    // the bypass is bounce-backstop-only.
    const normalDecision = await gate.evaluate(
      makeSignal({ side: "sell", reason: "repricing-exit", decisionRuleId: "D8" }),
    );

    expect(normalDecision.approved).toBe(false);
    expect(normalDecision.rejectionReasons).toContain("wallet_sell_capacity_exhausted");
  });

  it("rejects new BUY and SELL when total open-order cap is reached", async () => {
    const orders = [
      ...Array.from({ length: 12 }, (_, index) =>
        makeOpenBuyOrder({
          orderId: `buy-total-${index}` as any,
          clientOrderId: `buy-total-cl-${index}` as any,
          tokenId: createTokenId(`buy-total-token-${index}`),
        }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        makeOpenSellOrder({
          orderId: `sell-total-${index}` as any,
          clientOrderId: `sell-total-cl-${index}` as any,
          tokenId: createTokenId(`sell-total-token-${index}`),
        }),
      ),
    ];
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(null),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(100),
        activeProfile: "paper" as any,
      },
      undefined,
      () =>
        makeExecutionPolicy({
          sellCapacity: { ...DEFAULT_EXECUTION_POLICY.sellCapacity, maxOpenSellOrders: 11 },
        }),
    );

    const buyDecision = await gate.evaluate(makeSignal({ tokenId: createTokenId("new-buy") }));
    const sellDecision = await gate.evaluate(
      makeSignal({ tokenId: createTokenId("new-sell"), side: "sell", reason: "repricing-exit" }),
    );

    expect(buyDecision.approved).toBe(false);
    expect(buyDecision.rejectionReasons).toContain("total_orders_capacity_exhausted");
    expect(sellDecision.approved).toBe(false);
    expect(sellDecision.rejectionReasons).toContain("total_orders_capacity_exhausted");
  });

  it("allows same-token SELL replacement when global and per-token caps are full", async () => {
    const orders = [
      ...Array.from({ length: 12 }, (_, index) =>
        makeOpenBuyOrder({
          orderId: `buy-replace-cap-${index}` as any,
          clientOrderId: `buy-replace-cap-cl-${index}` as any,
          tokenId: createTokenId(`buy-replace-cap-token-${index}`),
        }),
      ),
      makeOpenSellOrder({
        orderId: "sell-replace-cap-1" as any,
        clientOrderId: "sell-replace-cap-cl-1" as any,
        tokenId: TOK_ID,
      }),
      makeOpenSellOrder({
        orderId: "sell-replace-cap-2" as any,
        clientOrderId: "sell-replace-cap-cl-2" as any,
        tokenId: TOK_ID,
      }),
      ...Array.from({ length: 8 }, (_, index) =>
        makeOpenSellOrder({
          orderId: `sell-replace-cap-other-${index}` as any,
          clientOrderId: `sell-replace-cap-other-cl-${index}` as any,
          tokenId: createTokenId(`sell-replace-cap-token-${index}`),
        }),
      ),
    ];
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(null),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
    );

    const decision = await gate.evaluate(makeSignal({ side: "sell", reason: "repricing-exit" }));

    expect(decision.approved).toBe(true);
  });

  it("blocks profile_ladder SELLs after the dynamic profile-ladder cap", async () => {
    const orders = Array.from({ length: 150 }, (_, index) =>
      makeOpenSellOrder({
        orderId: `profile-ladder-cap-${index}` as any,
        clientOrderId: `profile-ladder-cap-cl-${index}` as any,
        tokenId: createTokenId(`profile-ladder-cap-token-${index}`),
        decisionRuleId: "PROFILE_LADDER",
        metadata: { source: "profile_ladder" },
      }),
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(makeOpenPosition()),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () =>
        makeExecutionPolicy({
          sellCapacity: {
            ...DEFAULT_EXECUTION_POLICY.sellCapacity,
            mode: "source_aware_dynamic",
            profileLadderLiveRungsPerPosition: 2,
            minNonLadderReserve: 10,
            nonLadderReserveRatio: 0.25,
            hardMaxOpenSellOrders: 200,
          },
        }),
      undefined,
      undefined,
      undefined,
      undefined,
      () => 100,
    );

    const decision = await gate.evaluate(
      makeSignal({ side: "sell", reason: "repricing-exit", decisionRuleId: "PROFILE_LADDER" }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("wallet_sell_capacity_exhausted");
  });

  it("allows D8 when profile_ladder is at its dynamic cap but reserve remains", async () => {
    const orders = Array.from({ length: 150 }, (_, index) =>
      makeOpenSellOrder({
        orderId: `profile-ladder-reserve-${index}` as any,
        clientOrderId: `profile-ladder-reserve-cl-${index}` as any,
        tokenId: createTokenId(`profile-ladder-reserve-token-${index}`),
        decisionRuleId: "PROFILE_LADDER",
        metadata: { source: "profile_ladder" },
      }),
    );
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(orders),
      makePositionRepo(makeOpenPosition()),
      makeLogger(),
      undefined,
      undefined,
      undefined,
      () =>
        makeExecutionPolicy({
          sellCapacity: {
            ...DEFAULT_EXECUTION_POLICY.sellCapacity,
            mode: "source_aware_dynamic",
            profileLadderLiveRungsPerPosition: 2,
            minNonLadderReserve: 10,
            nonLadderReserveRatio: 0.25,
            hardMaxOpenSellOrders: 200,
          },
          orderCapacity: {
            ...DEFAULT_EXECUTION_POLICY.orderCapacity,
            maxOpenOrdersTotal: 250,
          },
        }),
      undefined,
      undefined,
      undefined,
      undefined,
      () => 100,
    );

    const decision = await gate.evaluate(
      makeSignal({ side: "sell", reason: "repricing-exit", decisionRuleId: "D8_PROFIT_RATIO" }),
    );

    expect(decision.approved).toBe(true);
  });

  it("allows SELL when BUY capacity is exhausted", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo([makeOpenBuyOrder(), { ...makeOpenBuyOrder(), orderId: "ord-2" as any }]),
      makePositionRepo(makeOpenPosition()),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(1),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy(),
    );

    const decision = await gate.evaluate(makeSignal({ side: "sell", reason: "repricing-exit" }));

    expect(decision.approved).toBe(true);
  });

  it("rejects SELL when the position residual is below exchange min order size", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(makeOpenPosition({ size: 2, currentValueUsdc: 0.6 })),
      makeLogger(),
      () => 5,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
    );

    const decision = await gate.evaluate(
      makeSignal({ side: "sell", reason: "repricing-exit", suggestedSize: 10 }),
    );

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("sell-residual-below-min-order-size");
  });

  it("allows SELL min-size guard when the position can satisfy exchange minimum", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(makeOpenPosition({ size: 5, currentValueUsdc: 1.5 })),
      makeLogger(),
      () => 5,
      undefined,
      undefined,
      () => makeExecutionPolicy(),
    );

    const decision = await gate.evaluate(
      makeSignal({ side: "sell", reason: "repricing-exit", suggestedSize: 10 }),
    );

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("sell_residual_min_size_ok");
  });

  it("falls back to flat wallet budget when buy-capacity policy is disabled", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      undefined,
      {
        controlDb: createMockControlDb(9),
        activeProfile: "paper" as any,
      },
      () => makeBuyCapacityPolicy({ enabled: false }),
    );

    const decision = await gate.evaluate(
      makeSignal({ suggestedSizeUsdc: 2, reason: "probe-entry" }),
    );

    expect(decision.approved).toBe(true);
    expect(decision.checksPassed).toContain("wallet_buy_budget_ok");
  });

  describe("open-position defense (restart double-entry guard)", () => {
    it("rejects probe-entry when open position exists for token", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(makeOpenPosition()),
        makeLogger(),
      );
      const signal = makeSignal({ reason: "probe-entry" });
      const decision = await gate.evaluate(signal);

      expect(decision.approved).toBe(false);
      expect(decision.rejectionReasons).toContain("open_position_exists");
    });

    it("rejects probe-entry when a dust position exists (not closed)", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(makeOpenPosition({ status: "dust" })),
        makeLogger(),
      );
      const signal = makeSignal({ reason: "probe-entry" });
      const decision = await gate.evaluate(signal);

      expect(decision.approved).toBe(false);
      expect(decision.rejectionReasons).toContain("open_position_exists");
    });

    it("approves confirm-scale when open position exists", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(makeOpenPosition()),
        makeLogger(),
      );
      const decision = await gate.evaluate(makeSignal({ reason: "confirm-scale" }));
      expect(decision.approved).toBe(true);
    });

    it("approves scale-in when open position exists", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(makeOpenPosition()),
        makeLogger(),
      );
      const decision = await gate.evaluate(makeSignal({ reason: "scale-in" }));
      expect(decision.approved).toBe(true);
    });

    it("approves heavy-scale when open position exists", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(makeOpenPosition()),
        makeLogger(),
      );
      const decision = await gate.evaluate(makeSignal({ reason: "heavy-scale" }));
      expect(decision.approved).toBe(true);
    });

    it("approves probe-entry when position is closed (not treated as open)", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(
          makeOpenPosition({ status: "closed", closedAt: new Date().toISOString() }),
        ),
        makeLogger(),
      );
      const decision = await gate.evaluate(makeSignal({ reason: "probe-entry" }));
      expect(decision.approved).toBe(true);
    });

    it("approves probe-entry when no open position exists", async () => {
      const gate = new AlgoRiskGateImpl(makeOrderRepo(), makePositionRepo(null), makeLogger());
      const decision = await gate.evaluate(makeSignal({ reason: "probe-entry" }));
      expect(decision.approved).toBe(true);
    });
  });
});
