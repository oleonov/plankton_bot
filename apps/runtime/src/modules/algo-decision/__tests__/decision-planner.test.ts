import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  createTokenId,
  type AlgoDecisionRule,
  type AlgoSizeRule,
  type LegState,
  type NormalizedMarket,
  type Position,
} from "@krabs/domain";
import { evaluateDecisionPlan, type DecisionPlanningInput } from "../decision-planner.js";

const tokenId = createTokenId("planner-token");
const now = Date.parse("2026-05-20T00:00:00.000Z");

const rules: AlgoDecisionRule[] = [
  {
    id: 1,
    priority: 1,
    ruleId: "D8-FALLBACK-SELL",
    stateCondition: "S1",
    priceOperator: ">=",
    priceValue: 0.11,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "SELL",
  },
  {
    id: 999,
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
    action: "HOLD",
  },
];

const buySizeRules: AlgoSizeRule[] = [
  {
    id: 1,
    actionType: "BUY",
    priority: 1,
    ruleId: "BUY-SIZE",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1,
  },
];

const sellSizeRules: AlgoSizeRule[] = [
  {
    id: 2,
    actionType: "SELL",
    priority: 1,
    ruleId: "SELL-SIZE",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1,
  },
];

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId: "condition",
    slug: "planner-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Planner test?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: "2026-09-01T00:00:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.09,
    bestAsk: 0.11,
    midPrice: 0.1,
    spread: 0.02,
    liquidity: 500,
    minOrderSize: 5,
    gammaCreatedAt: "2026-05-19T00:00:00.000Z",
    snapshotTs: now,
    ...overrides,
  };
}

function leg(overrides: Partial<LegState> = {}): LegState {
  return {
    tokenId,
    buyCount: 2,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.12,
    firstTradeAt: "2026-05-19T00:00:00.000Z",
    lastTradeAt: "2026-05-19T00:10:00.000Z",
    updatedAt: "2026-05-19T00:10:00.000Z",
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 12,
    cumulativeSellSize: 0,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: "position" as Position["positionId"],
    tokenId,
    conditionId: "condition" as Position["conditionId"],
    side: "buy",
    size: 100,
    avgEntryPrice: 0.12,
    costBasisUsdc: 12,
    currentValueUsdc: 10,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: "2026-05-19T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-05-19T00:10:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<DecisionPlanningInput> = {}): DecisionPlanningInput {
  return {
    tokenId,
    now,
    selectedForEntry: true,
    hasPendingBuyOrder: false,
    legState: null,
    position: null,
    market: market(),
    prevMidPrice: null,
    decisionRules: rules,
    buySizeRules,
    sellSizeRules,
    executionPolicy: {
      ...DEFAULT_EXECUTION_POLICY,
      entryMinMarketAgeSeconds: 0,
      r23DipTrigger: { enabled: true, dropThresholdRatio: 0.683, windowMs: 86_400_000 },
      lossExit: { ...DEFAULT_EXECUTION_POLICY.lossExit, enabled: true },
      profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, holdSecondsMin: 0 },
    },
    continuationFacts: null,
    continuationMode: "leg_local",
    r23MaxMidpoint: 0.2,
    dropReferencePrice: null,
    postBuyCooldown: null,
    latestSellOrder: null,
    ...overrides,
  };
}

describe("evaluateDecisionPlan", () => {
  it("fires R23 BUY from a serializable first-entry snapshot", () => {
    const result = evaluateDecisionPlan(input({ market: market({ midPrice: 0.1 }) }));

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("R23_DIP_TRIGGER");
    expect(result.signal.side).toBe("buy");
    expect(result.metrics.r23DipChecked).toBe(1);
    expect(result.metrics.r23DipFired).toBe(1);
  });

  it("suppresses R23 when history is unavailable without producing a signal", () => {
    const result = evaluateDecisionPlan(input({ r23MaxMidpoint: null }));

    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain("r23-no-history");
    expect(result.metrics.r23NoHistory).toBe(1);
  });

  it("fires D8 SELL before static rules for profitable existing legs", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 5 }),
        position: position({ avgEntryPrice: 0.05, size: 100 }),
        market: market({ bestBid: 0.08, bestAsk: 0.09, midPrice: 0.085, spread: 0.01 }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
    expect(result.signal.side).toBe("sell");
  });

  it("does not fire D8 from midpoint profit when executable bid is below entry", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 1 }),
        position: position({ avgEntryPrice: 0.01, size: 100 }),
        market: market({ bestBid: 0.004, bestAsk: 0.006, midPrice: 0.5, spread: 0.002 }),
      }),
    );

    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain("continuation-stop");
  });

  it("fires D8 from executable bid when the bid is profitable", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 17.64, cumulativeBuyNotional: 4.41 }),
        position: position({ avgEntryPrice: 0.25, costBasisUsdc: 4.41, size: 17.64 }),
        market: market({ bestBid: 0.43, bestAsk: 0.45, midPrice: 0.44, spread: 0.02 }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
    expect(result.signal.suggestedPrice).toBe(0.43);
  });

  it("suppresses SELL signals on wide spreads even when midpoint looks profitable", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 17.64, cumulativeBuyNotional: 4.41 }),
        position: position({ avgEntryPrice: 0.25, costBasisUsdc: 4.41, size: 17.64 }),
        market: market({ bestBid: 0.43, bestAsk: 0.9, midPrice: 0.665, spread: 0.47 }),
      }),
    );

    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain("sell-spread-too-wide");
  });

  it("uses full-close sizing for small profitable residual positions", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({
          buyCount: 1,
          sellCount: 3,
          cumulativeBuySize: 17.64,
          cumulativeBuyNotional: 4.41,
          cumulativeSellSize: 0,
        }),
        position: position({ avgEntryPrice: 0.25, costBasisUsdc: 4.41, size: 17.64 }),
        market: market({
          bestBid: 0.535,
          bestAsk: 0.545,
          midPrice: 0.54,
          spread: 0.01,
          minOrderSize: 5,
        }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.side).toBe("sell");
    expect(result.signal.suggestedSize).toBeCloseTo(17.64, 8);
    expect(result.signal.suggestedSizeUsdc).toBeCloseTo(9.4374, 8);
  });

  it("records H5 guard suppression for S2 long-horizon D9 cohort", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ cumulativeBuySize: 100, cumulativeBuyNotional: 12 }),
        position: position({ avgEntryPrice: 0.12, size: 100 }),
        market: market({ midPrice: 0.06, publicTradeCount24h: 100 }),
      }),
    );

    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain("h5-wide-cohort-guard");
  });

  it("returns a side-effect request instead of mutating dust counters in the planner", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1 }),
        position: position({ size: 3 }),
        market: market({ bestBid: 0.2, bestAsk: 0.21, midPrice: 0.205, minOrderSize: 5 }),
      }),
    );

    expect(result.type).toBe("none");
    expect(result.sideEffects).toEqual([
      expect.objectContaining({ kind: "sell_residual_reject", threshold: expect.any(Number) }),
    ]);
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "sell-residual-below-min-order-size",
    );
  });

  it("does no work for unselected tokens with no existing leg", () => {
    const result = evaluateDecisionPlan(input({ selectedForEntry: false, legState: null }));

    expect(result.type).toBe("none");
    expect(result.metrics.evalTotal).toBe(0);
    expect(result.suppressions).toHaveLength(0);
  });
});
