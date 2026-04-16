import { describe, it, expect, vi } from "vitest";
import {
  createFamilyId,
  createTokenId,
  createConditionId,
  type Signal,
  type Order,
} from "@plankton/domain";
import type { OrderRepository } from "@plankton/domain";
import { AlgoRiskGateImpl } from "../algo-risk-gate.js";
import type { Logger } from "../../../logger.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

const FAM_ID = createFamilyId("btc-threshold:scalp:daily");
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
    familyId: FAM_ID,
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

function makeOpenBuyOrder(): Order {
  return {
    orderId: "ord-1" as any,
    clientOrderId: "clord-1" as any,
    tokenId: TOK_ID,
    conditionId: COND_ID,
    familyId: FAM_ID,
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
    const gate = new AlgoRiskGateImpl(makeOrderRepo(), makeLogger());
    const signal = makeSignal();
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(true);
    expect(decision.signalId).toBe(signal.signalId);
    expect(decision.familyId).toBe(signal.familyId);
    expect(decision.rejectionReasons).toHaveLength(0);
  });

  it("rejects buy when token has open buy order", async () => {
    const gate = new AlgoRiskGateImpl(makeOrderRepo([makeOpenBuyOrder()]), makeLogger());
    const signal = makeSignal({ side: "buy", reason: "probe-entry" });
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons.some((r) => r.includes("open buy order"))).toBe(true);
  });

  it("allows sell signals even with open buy order", async () => {
    const gate = new AlgoRiskGateImpl(makeOrderRepo([makeOpenBuyOrder()]), makeLogger());
    const signal = makeSignal({ side: "sell", reason: "repricing-exit" });
    const decision = await gate.evaluate(signal);

    expect(decision.approved).toBe(true);
  });

  it("rejects buy when token in-flight limit exceeded (>=1)", async () => {
    const getTokenInFlightCount = vi.fn().mockReturnValue(1);
    const gate = new AlgoRiskGateImpl(
      makeOrderRepo(),
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
    const gate = new AlgoRiskGateImpl(makeOrderRepo(), makeLogger());
    const signal = makeSignal();
    const decision = await gate.evaluate(signal);

    expect(decision.tokenId).toBe(TOK_ID);
    expect(decision.conditionId).toBe(COND_ID);
  });
});
