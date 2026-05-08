import { describe, it, expect, vi } from "vitest";
import {
  createPositionId,
  createTokenId,
  createConditionId,
  DEFAULT_BUY_CAPACITY_POLICY,
  type Signal,
  type Order,
  type Position,
} from "@plankton/domain";
import type { OrderRepository, PositionRepository } from "@plankton/domain";
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
}) {
  return {
    ...DEFAULT_BUY_CAPACITY_POLICY,
    ...overrides,
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

function makeOpenBuyOrder(): Order {
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
  };
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

  it("rejects buy when token has open buy order", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo([makeOpenBuyOrder()]),
      makePositionRepo(),
      makeLogger(),
    );
    const signal = makeSignal({ side: "buy", reason: "probe-entry" });
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons.some((r) => r.includes("open buy order"))).toBe(true);
  });

  it("allows sell signals even with open buy order", async () => {
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo([makeOpenBuyOrder()]),
      makePositionRepo(makeOpenPosition()),
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
      () => makeBuyCapacityPolicy(),
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
      () => makeBuyCapacityPolicy(),
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
      () => makeBuyCapacityPolicy(),
    );

    const decision = await gate.evaluate(makeSignal({ tokenId: createTokenId("other-token") }));

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("wallet_buy_capacity_exhausted");
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
