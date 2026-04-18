import { describe, it, expect, vi } from "vitest";
import {
  createPositionId,
  createTokenId,
  createConditionId,
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
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue(orders),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
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

  it("rejects buy when token in-flight limit exceeded (>=1)", async () => {
    const getTokenInFlightCount = vi.fn().mockReturnValue(1);
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
      makePositionRepo(),
      makeLogger(),
      undefined,
      getTokenInFlightCount,
    );
    const signal = makeSignal({ side: "buy", reason: "probe-entry" });
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("token-in-flight-limit");
  });

  it("includes tokenId and conditionId in RiskDecision", async () => {
    const gate = new AlgoRiskGateImpl(makeOrderRepo(), makePositionRepo(), makeLogger());
    const signal = makeSignal();
    const decision = await gate.evaluate(signal);

    expect(decision.tokenId).toBe(TOK_ID);
    expect(decision.conditionId).toBe(COND_ID);
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

    it("rejects spray-entry when open position exists for token", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(makeOpenPosition()),
        makeLogger(),
      );
      const signal = makeSignal({ reason: "spray-entry" });
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

    it("approves two-sided-entry targeting opposite token (no position on that token)", async () => {
      // two-sided-entry signal targets the OPPOSITE token; findByTokenId for
      // signal.tokenId returns null because the open position is on the YES
      // leg but the signal targets the NO token.
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(null),
        makeLogger(),
      );
      const decision = await gate.evaluate(makeSignal({ reason: "two-sided-entry" }));
      expect(decision.approved).toBe(true);
    });

    it("approves probe-entry when position is closed (not treated as open)", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(makeOpenPosition({ status: "closed", closedAt: new Date().toISOString() })),
        makeLogger(),
      );
      const decision = await gate.evaluate(makeSignal({ reason: "probe-entry" }));
      expect(decision.approved).toBe(true);
    });

    it("approves probe-entry when no open position exists", async () => {
      const gate = new AlgoRiskGateImpl(
        makeOrderRepo(),
        makePositionRepo(null),
        makeLogger(),
      );
      const decision = await gate.evaluate(makeSignal({ reason: "probe-entry" }));
      expect(decision.approved).toBe(true);
    });
  });
});
