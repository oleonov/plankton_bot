import { describe, it, expect } from "vitest";
import {
  deriveState,
  matchRule,
  evaluateDecision,
  evaluateRedeem,
  evaluateSize,
  resolveSignalReason,
} from "./algo-engine.js";
import type { LegState, AlgoDecisionRule, AlgoSizeRule } from "./types.js";
import { createTokenId } from "./ids.js";

const TOKEN = createTokenId("tok-test");

function makeLegState(overrides: Partial<LegState>): LegState {
  return {
    tokenId: TOKEN,
    buyCount: 0,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.03,
    firstTradeAt: "2026-01-01T00:00:00Z",
    lastTradeAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    cumulativeBuySize: 0,
    cumulativeBuyNotional: 0,
    cumulativeSellSize: 0,
    ...overrides,
  };
}

describe("deriveState", () => {
  it("returns OTHER when legState is null", () => {
    expect(deriveState(null)).toBe("OTHER");
  });
  it("returns S1 when buyCount=1 and lastAction=BUY", () => {
    expect(deriveState(makeLegState({ buyCount: 1, lastAction: "BUY" }))).toBe("S1");
  });
  it("returns S2 when buyCount=2 and lastAction=BUY", () => {
    expect(deriveState(makeLegState({ buyCount: 2, lastAction: "BUY" }))).toBe("S2");
  });
  it("returns S2 when buyCount=5 and lastAction=BUY", () => {
    expect(deriveState(makeLegState({ buyCount: 5, lastAction: "BUY" }))).toBe("S2");
  });
  it("returns S3 when sellCount>=1 and lastAction=SELL", () => {
    expect(deriveState(makeLegState({ buyCount: 2, sellCount: 1, lastAction: "SELL" }))).toBe("S3");
  });
  it("returns S3 when sellCount=3 and lastAction=SELL", () => {
    expect(deriveState(makeLegState({ buyCount: 4, sellCount: 3, lastAction: "SELL" }))).toBe("S3");
  });
  it("returns OTHER when buyCount=0 regardless of lastAction", () => {
    expect(deriveState(makeLegState({ buyCount: 0, lastAction: "BUY" }))).toBe("OTHER");
  });

  // ─── Batch B: state re-entry after S3 ──────────────────────────────────────
  it("returns S2 when sellCount=1, buyCount=3, lastAction=BUY (back-transition from S3)", () => {
    expect(deriveState(makeLegState({ buyCount: 3, sellCount: 1, lastAction: "BUY" }))).toBe("S2");
  });
  it("returns S1 when sellCount=1, buyCount=1, lastAction=BUY (back-transition from S3)", () => {
    expect(deriveState(makeLegState({ buyCount: 1, sellCount: 1, lastAction: "BUY" }))).toBe("S1");
  });
  it("returns S1 when sellCount=2, buyCount=1, lastAction=BUY (back-transition from S3)", () => {
    expect(deriveState(makeLegState({ buyCount: 1, sellCount: 2, lastAction: "BUY" }))).toBe("S1");
  });
});

// ─── Rule fixtures ────────────────────────────────────────────────────────────

const DECISION_RULES: AlgoDecisionRule[] = [
  {
    id: 1,
    priority: 10,
    ruleId: "REDEEM",
    stateCondition: "S1",
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
    id: 2,
    priority: 11,
    ruleId: "REDEEM",
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
    id: 3,
    priority: 20,
    ruleId: "D1",
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
    id: 4,
    priority: 30,
    ruleId: "D2",
    stateCondition: "S3",
    priceOperator: "<",
    priceValue: 0.05,
    timeSinceLastOperator: "<=",
    timeSinceLastSeconds: 60,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "SELL",
  },
  {
    id: 5,
    priority: 40,
    ruleId: "D3",
    stateCondition: "S1",
    priceOperator: "<",
    priceValue: 0.05,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "BUY",
  },
  {
    id: 6,
    priority: 50,
    ruleId: "D4",
    stateCondition: "S2",
    priceOperator: ">=",
    priceValue: 0.2,
    timeSinceLastOperator: ">",
    timeSinceLastSeconds: 60,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "SELL",
  },
  {
    id: 7,
    priority: 60,
    ruleId: "D5",
    stateCondition: "S1",
    priceOperator: ">=",
    priceValue: 0.2,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "SELL",
  },
  {
    id: 8,
    priority: 70,
    ruleId: "D6",
    stateCondition: "S2",
    priceOperator: null,
    priceValue: null,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: 4,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "HOLD",
  },
  {
    id: 9,
    priority: 80,
    ruleId: "D7",
    stateCondition: "S3",
    priceOperator: null,
    priceValue: null,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "SELL",
  },
  {
    id: 10,
    priority: 999,
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

describe("matchRule", () => {
  const BUY_SELL = new Set(["BUY", "SELL"]);
  const BUY_SELL_HOLD = new Set(["BUY", "SELL", "HOLD"]);
  const REDEEM_ONLY = new Set(["REDEEM"]);

  it("matches D1: S2 + price<0.05 + timeSinceLast<=60 → BUY", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.03,
      timeSinceLastSeconds: 30,
      buyCount: 3,
      holdDurationSeconds: 7200,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "D1" });
  });
  it("matches D2: S3 + price<0.05 + timeSinceLast<=60 → SELL", () => {
    const ctx = {
      state: "S3" as const,
      price: 0.04,
      timeSinceLastSeconds: 55,
      buyCount: 2,
      holdDurationSeconds: 5000,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "SELL", ruleId: "D2" });
  });
  it("matches D3: S1 + price<0.05 → BUY", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.02,
      timeSinceLastSeconds: 500,
      buyCount: 1,
      holdDurationSeconds: 1000,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "D3" });
  });
  it("matches D4: S2 + price>=0.20 + timeSinceLast>60 → SELL", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.25,
      timeSinceLastSeconds: 120,
      buyCount: 2,
      holdDurationSeconds: 3000,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "SELL", ruleId: "D4" });
  });
  it("matches D5: S1 + price>=0.20 → SELL", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.3,
      timeSinceLastSeconds: 10,
      buyCount: 1,
      holdDurationSeconds: 500,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "SELL", ruleId: "D5" });
  });
  it("matches D6: S2 + buyCount>=4 → HOLD when HOLD is allowed", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.1,
      timeSinceLastSeconds: 200,
      buyCount: 5,
      holdDurationSeconds: 4000,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL_HOLD)).toEqual({
      action: "HOLD",
      ruleId: "D6",
    });
  });
  it("matches D7: S3 → SELL", () => {
    const ctx = {
      state: "S3" as const,
      price: 0.15,
      timeSinceLastSeconds: 200,
      buyCount: 3,
      holdDurationSeconds: 5000,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "SELL", ruleId: "D7" });
  });
  it("matches FALLBACK: OTHER state → BUY", () => {
    const ctx = {
      state: "OTHER" as const,
      price: 0.03,
      timeSinceLastSeconds: null,
      buyCount: 0,
      holdDurationSeconds: null,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "FALLBACK" });
  });
  it("null timeSinceLastSeconds skips rules with time operator", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.03,
      timeSinceLastSeconds: null,
      buyCount: 2,
      holdDurationSeconds: null,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "FALLBACK" });
  });
  it("REDEEM matches S1 + price<0.05 + holdDuration<=3600", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.03,
      timeSinceLastSeconds: 100,
      buyCount: 1,
      holdDurationSeconds: 1800,
    };
    expect(matchRule(ctx, DECISION_RULES, REDEEM_ONLY)).toEqual({
      action: "REDEEM",
      ruleId: "REDEEM",
    });
  });
  it("REDEEM matches S2 + price<0.05 + holdDuration<=3600", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.04,
      timeSinceLastSeconds: 30,
      buyCount: 3,
      holdDurationSeconds: 3600,
    };
    expect(matchRule(ctx, DECISION_RULES, REDEEM_ONLY)).toEqual({
      action: "REDEEM",
      ruleId: "REDEEM",
    });
  });
  it("REDEEM does not match when holdDuration>3600", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.03,
      timeSinceLastSeconds: 100,
      buyCount: 1,
      holdDurationSeconds: 7200,
    };
    expect(matchRule(ctx, DECISION_RULES, REDEEM_ONLY)).toBeNull();
  });
  it("REDEEM does not match when holdDuration is null", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.03,
      timeSinceLastSeconds: 100,
      buyCount: 1,
      holdDurationSeconds: null,
    };
    expect(matchRule(ctx, DECISION_RULES, REDEEM_ONLY)).toBeNull();
  });
  it("REDEEM does not match S3", () => {
    const ctx = {
      state: "S3" as const,
      price: 0.03,
      timeSinceLastSeconds: 100,
      buyCount: 2,
      holdDurationSeconds: 1800,
    };
    expect(matchRule(ctx, DECISION_RULES, REDEEM_ONLY)).toBeNull();
  });
  it("REDEEM does not match S1 when price >= 0.05 (boundary)", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.05,
      timeSinceLastSeconds: 100,
      buyCount: 1,
      holdDurationSeconds: 1800,
    };
    expect(matchRule(ctx, DECISION_RULES, REDEEM_ONLY)).toBeNull();
  });
  it("REDEEM does not match S2 when price >= 0.05 (boundary)", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.05,
      timeSinceLastSeconds: 30,
      buyCount: 3,
      holdDurationSeconds: 1800,
    };
    expect(matchRule(ctx, DECISION_RULES, REDEEM_ONLY)).toBeNull();
  });
  it("REDEEM does not match S1 when price > 0.05", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.15,
      timeSinceLastSeconds: 100,
      buyCount: 1,
      holdDurationSeconds: 1800,
    };
    expect(matchRule(ctx, DECISION_RULES, REDEEM_ONLY)).toBeNull();
  });
  it("buyCountMin/buyCountMax range matching", () => {
    const ctx3 = {
      state: "S2" as const,
      price: 0.1,
      timeSinceLastSeconds: 200,
      buyCount: 3,
      holdDurationSeconds: 4000,
    };
    expect(matchRule(ctx3, DECISION_RULES, BUY_SELL)?.ruleId).not.toBe("D6");
    const ctx4 = {
      state: "S2" as const,
      price: 0.1,
      timeSinceLastSeconds: 200,
      buyCount: 4,
      holdDurationSeconds: 4000,
    };
    expect(matchRule(ctx4, DECISION_RULES, BUY_SELL_HOLD)).toEqual({
      action: "HOLD",
      ruleId: "D6",
    });
  });
});

describe("decision rule boundaries", () => {
  const BUY_SELL = new Set(["BUY", "SELL"]);
  const BUY_SELL_HOLD = new Set(["BUY", "SELL", "HOLD"]);

  // D1: S2, price < 0.05, timeSinceLast <= 60 → BUY
  it("D1: price=0.05 (exactly on boundary) does NOT match D1 (strict <)", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.05,
      timeSinceLastSeconds: 30,
      buyCount: 3,
      holdDurationSeconds: 7200,
    };
    // price is not < 0.05; buyCount=3 < 4 so D6 skipped; falls through to FALLBACK
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "FALLBACK" });
  });
  it("D1: price=0.0499 matches D1 (strict <)", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.0499,
      timeSinceLastSeconds: 30,
      buyCount: 3,
      holdDurationSeconds: 7200,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "D1" });
  });
  it("D1: timeSinceLast=60 matches D1 (inclusive <=)", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.03,
      timeSinceLastSeconds: 60,
      buyCount: 3,
      holdDurationSeconds: 7200,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "D1" });
  });
  it("D1: timeSinceLast=61 does NOT match D1; falls to FALLBACK (buyCount=3)", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.03,
      timeSinceLastSeconds: 61,
      buyCount: 3,
      holdDurationSeconds: 7200,
    };
    // D1 requires timeSinceLast <= 60; D4 requires price >= 0.20; D6 requires buyCount >= 4
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "FALLBACK" });
  });
  it("D1: timeSinceLast=61 with buyCount>=4 falls to D6 HOLD, not D1", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.03,
      timeSinceLastSeconds: 61,
      buyCount: 4,
      holdDurationSeconds: 7200,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL_HOLD)).toEqual({
      action: "HOLD",
      ruleId: "D6",
    });
  });

  // D4: S2, price >= 0.20, timeSinceLast > 60 → SELL
  it("D4: timeSinceLast=60 does NOT match D4 (strict >); falls to FALLBACK (buyCount=3)", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.25,
      timeSinceLastSeconds: 60,
      buyCount: 3,
      holdDurationSeconds: 7200,
    };
    // D1 needs price < 0.05; D4 needs timeSinceLast > 60; D6 needs buyCount >= 4
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "FALLBACK" });
  });
  it("D4: timeSinceLast=61 matches D4 (strict >)", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.25,
      timeSinceLastSeconds: 61,
      buyCount: 3,
      holdDurationSeconds: 7200,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "SELL", ruleId: "D4" });
  });

  // D5: S1, price >= 0.20 → SELL
  it("D5: price=0.20 matches D5 (inclusive >=)", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.2,
      timeSinceLastSeconds: 30,
      buyCount: 1,
      holdDurationSeconds: 1000,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "SELL", ruleId: "D5" });
  });
  it("D5: price=0.1999 does NOT match D5; falls to FALLBACK (no other S1 rule matches)", () => {
    const ctx = {
      state: "S1" as const,
      price: 0.1999,
      timeSinceLastSeconds: 30,
      buyCount: 1,
      holdDurationSeconds: 1000,
    };
    // D3 needs price < 0.05; D5 needs price >= 0.20
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "BUY", ruleId: "FALLBACK" });
  });

  // D2 mirror: S3, price < 0.05, timeSinceLast <= 60 → SELL
  it("D2: price=0.05 does NOT match D2 (strict <); falls through to D7 (S3 → SELL)", () => {
    const ctx = {
      state: "S3" as const,
      price: 0.05,
      timeSinceLastSeconds: 30,
      buyCount: 2,
      holdDurationSeconds: 5000,
    };
    expect(matchRule(ctx, DECISION_RULES, BUY_SELL)).toEqual({ action: "SELL", ruleId: "D7" });
  });
});

describe("evaluateDecision", () => {
  it("returns BUY/SELL result (never null due to FALLBACK)", () => {
    const ctx = {
      state: "OTHER" as const,
      price: 0.5,
      timeSinceLastSeconds: null,
      buyCount: 0,
      holdDurationSeconds: null,
    };
    expect(evaluateDecision(ctx, DECISION_RULES)).toEqual({ action: "BUY", ruleId: "FALLBACK" });
  });

  it("returns HOLD when a DB decision rule explicitly suppresses trading", () => {
    const ctx = {
      state: "S2" as const,
      price: 0.1,
      timeSinceLastSeconds: 120,
      buyCount: 4,
      holdDurationSeconds: 7200,
    };
    expect(evaluateDecision(ctx, DECISION_RULES)).toEqual({ action: "HOLD", ruleId: "D6" });
  });

  it("throws if FALLBACK rule is missing", () => {
    const noFallback = DECISION_RULES.filter((r) => r.ruleId !== "FALLBACK");
    const ctx = {
      state: "OTHER" as const,
      price: 0.5,
      timeSinceLastSeconds: null,
      buyCount: 0,
      holdDurationSeconds: null,
    };
    expect(() => evaluateDecision(ctx, noFallback)).toThrow("FALLBACK rule missing");
  });
});

describe("evaluateRedeem", () => {
  it("returns REDEEM match or null", () => {
    const match = {
      state: "S1" as const,
      price: 0.03,
      timeSinceLastSeconds: 100,
      buyCount: 1,
      holdDurationSeconds: 1000,
    };
    expect(evaluateRedeem(match, DECISION_RULES)).toEqual({ action: "REDEEM", ruleId: "REDEEM" });
    const noMatch = {
      state: "S3" as const,
      price: 0.03,
      timeSinceLastSeconds: 100,
      buyCount: 2,
      holdDurationSeconds: 1000,
    };
    expect(evaluateRedeem(noMatch, DECISION_RULES)).toBeNull();
  });
});

// ─── Size rule fixtures ───────────────────────────────────────────────────────

// Spec v2.2 §2: state+price rules (B1–B4) override nth_buy rules (B5–B7).
const BUY_SIZE_RULES: AlgoSizeRule[] = [
  {
    id: 1,
    actionType: "BUY",
    priority: 10,
    ruleId: "B1",
    stateCondition: "OTHER",
    priceOperator: ">=",
    priceValue: 0.2,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 8.41,
  },
  {
    id: 2,
    actionType: "BUY",
    priority: 20,
    ruleId: "B2",
    stateCondition: "S1",
    priceOperator: ">=",
    priceValue: 0.2,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 4.29,
  },
  {
    id: 3,
    actionType: "BUY",
    priority: 30,
    ruleId: "B3",
    stateCondition: "S3",
    priceOperator: "<",
    priceValue: 0.05,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 0.88,
  },
  {
    id: 4,
    actionType: "BUY",
    priority: 40,
    ruleId: "B4",
    stateCondition: "S2",
    priceOperator: "<",
    priceValue: 0.05,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 0.14,
  },
  {
    id: 5,
    actionType: "BUY",
    priority: 50,
    ruleId: "B5",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: 1,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 0.99,
  },
  {
    id: 6,
    actionType: "BUY",
    priority: 60,
    ruleId: "B6",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: 2,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1.04,
  },
  {
    id: 7,
    actionType: "BUY",
    priority: 70,
    ruleId: "B7",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: 3,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 3.85,
  },
  {
    id: 8,
    actionType: "BUY",
    priority: 999,
    ruleId: "FALLBACK",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 2.73,
  },
];

const SELL_SIZE_RULES: AlgoSizeRule[] = [
  {
    id: 9,
    actionType: "SELL",
    priority: 10,
    ruleId: "S1",
    stateCondition: "S2",
    priceOperator: ">=",
    priceValue: 0.2,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 5.81,
  },
  {
    id: 10,
    actionType: "SELL",
    priority: 20,
    ruleId: "S2",
    stateCondition: "S1",
    priceOperator: ">=",
    priceValue: 0.2,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 5.73,
  },
  {
    id: 11,
    actionType: "SELL",
    priority: 30,
    ruleId: "S3",
    stateCondition: "OTHER",
    priceOperator: ">=",
    priceValue: 0.2,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 5.0,
  },
  {
    id: 12,
    actionType: "SELL",
    priority: 40,
    ruleId: "S4",
    stateCondition: "S2",
    priceOperator: "<",
    priceValue: 0.05,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1.05,
  },
  {
    id: 13,
    actionType: "SELL",
    priority: 50,
    ruleId: "S5",
    stateCondition: "S3",
    priceOperator: "<",
    priceValue: 0.05,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 0.71,
  },
  {
    id: 14,
    actionType: "SELL",
    priority: 60,
    ruleId: "S6",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: 1,
    buyCountMax: 1,
    sizeUsdc: 1.54,
  },
  {
    id: 15,
    actionType: "SELL",
    priority: 70,
    ruleId: "S7",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: 2,
    buyCountMax: 3,
    sizeUsdc: 2.33,
  },
  {
    id: 16,
    actionType: "SELL",
    priority: 999,
    ruleId: "FALLBACK",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 2.63,
  },
];

describe("evaluateSize", () => {
  // Spec v2.2 §2 Size Flow — state+price rules (B1–B4) override nth_buy rules (B5–B7).
  // nth_buy rules apply only when state+price conditions are not matched.
  describe("BUY sizing — state+price precedence (spec v2.2)", () => {
    it("B1 wins over B5: nth_buy=1 + state=OTHER + price>=0.20 → 8.41", () => {
      expect(
        evaluateSize(
          "BUY",
          { state: "OTHER", price: 0.25, nthBuy: 1, buyCount: 0 },
          BUY_SIZE_RULES,
        ),
      ).toEqual({ sizeUsdc: 8.41, ruleId: "B1" });
    });
    it("B2 wins over B5: nth_buy=1 + state=S1 + price>=0.20 → 4.29", () => {
      expect(
        evaluateSize("BUY", { state: "S1", price: 0.25, nthBuy: 1, buyCount: 1 }, BUY_SIZE_RULES),
      ).toEqual({ sizeUsdc: 4.29, ruleId: "B2" });
    });
    it("B3 wins over B7: nth_buy=3 + state=S3 + price<0.05 → 0.88", () => {
      expect(
        evaluateSize("BUY", { state: "S3", price: 0.03, nthBuy: 3, buyCount: 2 }, BUY_SIZE_RULES),
      ).toEqual({ sizeUsdc: 0.88, ruleId: "B3" });
    });
    it("B4 wins over B6: nth_buy=2 + state=S2 + price<0.05 → 0.14", () => {
      expect(
        evaluateSize("BUY", { state: "S2", price: 0.03, nthBuy: 2, buyCount: 2 }, BUY_SIZE_RULES),
      ).toEqual({ sizeUsdc: 0.14, ruleId: "B4" });
    });

    it("B5 used only when no B1–B4 match: nth_buy=1 + state=OTHER + price=0.10 → 0.99", () => {
      expect(
        evaluateSize("BUY", { state: "OTHER", price: 0.1, nthBuy: 1, buyCount: 0 }, BUY_SIZE_RULES),
      ).toEqual({ sizeUsdc: 0.99, ruleId: "B5" });
    });
    it("B5 used for 1st buy at low price in OTHER state → 0.99", () => {
      expect(
        evaluateSize(
          "BUY",
          { state: "OTHER", price: 0.03, nthBuy: 1, buyCount: 0 },
          BUY_SIZE_RULES,
        ),
      ).toEqual({ sizeUsdc: 0.99, ruleId: "B5" });
    });
    it("B6 used only when no B1–B4 match: nth_buy=2 + state=S1 + price=0.10 → 1.04", () => {
      expect(
        evaluateSize("BUY", { state: "S1", price: 0.1, nthBuy: 2, buyCount: 1 }, BUY_SIZE_RULES),
      ).toEqual({ sizeUsdc: 1.04, ruleId: "B6" });
    });
    it("B7 used only when no B1–B4 match: nth_buy=3 + state=S2 + price=0.10 → 3.85", () => {
      expect(
        evaluateSize("BUY", { state: "S2", price: 0.1, nthBuy: 3, buyCount: 2 }, BUY_SIZE_RULES),
      ).toEqual({ sizeUsdc: 3.85, ruleId: "B7" });
    });

    it("B3 boundary: price=0.05 does NOT match (< strict), falls through to B5 for nth_buy=1", () => {
      expect(
        evaluateSize("BUY", { state: "S3", price: 0.05, nthBuy: 1, buyCount: 2 }, BUY_SIZE_RULES),
      ).toEqual({ sizeUsdc: 0.99, ruleId: "B5" });
    });
    it("FALLBACK: nth_buy=5 with no state+price match → 2.73", () => {
      expect(
        evaluateSize("BUY", { state: "S2", price: 0.1, nthBuy: 5, buyCount: 4 }, BUY_SIZE_RULES),
      ).toEqual({ sizeUsdc: 2.73, ruleId: "FALLBACK" });
    });
  });

  describe("SELL sizing — sell context", () => {
    it("S2 + price>=0.20 uses S1 rule (5.81)", () => {
      expect(
        evaluateSize("SELL", { state: "S2", price: 0.25, nthBuy: 0, buyCount: 3 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 5.81, ruleId: "S1" });
    });
    it("S1 + price>=0.20 uses S2 rule (5.73)", () => {
      expect(
        evaluateSize("SELL", { state: "S1", price: 0.3, nthBuy: 0, buyCount: 1 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 5.73, ruleId: "S2" });
    });
    it("OTHER + price>=0.20 uses S3 rule (3.40)", () => {
      expect(
        evaluateSize(
          "SELL",
          { state: "OTHER", price: 0.3, nthBuy: 0, buyCount: 0 },
          SELL_SIZE_RULES,
        ),
      ).toEqual({ sizeUsdc: 5.0, ruleId: "S3" });
    });
    it("S2 + price<0.05 uses S4 rule (1.05)", () => {
      expect(
        evaluateSize("SELL", { state: "S2", price: 0.03, nthBuy: 0, buyCount: 2 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 1.05, ruleId: "S4" });
    });
    it("S3 + price<0.05 uses S5 rule (0.71)", () => {
      expect(
        evaluateSize("SELL", { state: "S3", price: 0.03, nthBuy: 0, buyCount: 2 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 0.71, ruleId: "S5" });
    });
    it("S7 upper boundary: after 3 buys at mid price uses S7 (2.33)", () => {
      expect(
        evaluateSize("SELL", { state: "S2", price: 0.1, nthBuy: 0, buyCount: 3 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 2.33, ruleId: "S7" });
    });
    it("after 1 buy at mid price uses S6 (1.54)", () => {
      expect(
        evaluateSize("SELL", { state: "S1", price: 0.1, nthBuy: 0, buyCount: 1 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 1.54, ruleId: "S6" });
    });
    it("after 2 buys at mid price uses S7 (2.33)", () => {
      expect(
        evaluateSize("SELL", { state: "S2", price: 0.1, nthBuy: 0, buyCount: 2 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 2.33, ruleId: "S7" });
    });
    it("after 4+ buys at mid price uses FALLBACK (2.63)", () => {
      expect(
        evaluateSize("SELL", { state: "S2", price: 0.1, nthBuy: 0, buyCount: 4 }, SELL_SIZE_RULES),
      ).toEqual({ sizeUsdc: 2.63, ruleId: "FALLBACK" });
    });
  });
});

describe("resolveSignalReason", () => {
  it("sell → repricing-exit", () => {
    expect(resolveSignalReason("sell", 3)).toBe("repricing-exit");
  });
  it("buy with buyCount=0 → probe-entry", () => {
    expect(resolveSignalReason("buy", 0)).toBe("probe-entry");
  });
  it("buy with buyCount=1 → confirm-scale", () => {
    expect(resolveSignalReason("buy", 1)).toBe("confirm-scale");
  });
  it("buy with buyCount=2 → scale-in", () => {
    expect(resolveSignalReason("buy", 2)).toBe("scale-in");
  });
  it("buy with buyCount=3 → scale-in", () => {
    expect(resolveSignalReason("buy", 3)).toBe("scale-in");
  });
  it("buy with buyCount=4 → heavy-scale", () => {
    expect(resolveSignalReason("buy", 4)).toBe("heavy-scale");
  });
  it("buy with buyCount=10 → heavy-scale", () => {
    expect(resolveSignalReason("buy", 10)).toBe("heavy-scale");
  });
});
