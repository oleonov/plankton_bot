import { describe, it, expect, vi } from "vitest";
import {
  createPositionId,
  createTokenId,
  createConditionId,
  DEFAULT_BUY_CAPACITY_POLICY,
  DEFAULT_EXECUTION_POLICY,
  type Signal,
  type Order,
  type Position,
  type ExecutionPolicy,
} from "@krabs/domain";
import type { OrderRepository, PositionRepository } from "@krabs/domain";
import { AlgoRiskGateImpl } from "../algo-risk-gate.js";
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
