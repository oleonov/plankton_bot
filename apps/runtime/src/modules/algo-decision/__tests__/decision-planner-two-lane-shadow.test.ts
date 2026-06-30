import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  createPositionId,
  createTokenId,
  type AlgoDecisionRule,
  type AlgoSizeRule,
  type ConditionId,
  type LegState,
  type NormalizedMarket,
  type Position,
} from "@krabs/domain";
import {
  evaluateDecisionPlan,
  type DecisionPlanningInput,
  type DecisionPlanSideEffect,
} from "../decision-planner.js";

const tokenId = createTokenId("two-lane-planner-token");
const now = Date.parse("2026-06-20T00:00:00.000Z");

const rules: AlgoDecisionRule[] = [
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
    conditionId: "two-lane-condition",
    slug: "two-lane-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Two lane planner?",
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
    buyCount: 1,
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
    positionId: createPositionId("two-lane-pos"),
    tokenId,
    conditionId: "two-lane-condition" as ConditionId,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.12,
    costBasisUsdc: 12,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
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
    },
    continuationFacts: null,
    continuationMode: "leg_local",
    r23MaxMidpoint: 0.2,
    dropReferencePrice: null,
    postBuyCooldown: null,
    latestSellOrder: null,
    hasActiveSellOrderForQd: false,
    sellLoopGuard: null,
    ...overrides,
  };
}

function twoLaneSideEffects(result: ReturnType<typeof evaluateDecisionPlan>) {
  return result.sideEffects.filter(
    (s): s is Extract<DecisionPlanSideEffect, { kind: "two_lane_entry_shadow" }> =>
      s.kind === "two_lane_entry_shadow",
  );
}

describe("two-lane entry shadow recorder (planner)", () => {
  it("emits a two_lane_entry_shadow side-effect for a first-entry candidate", () => {
    // mid 0.1 / max 0.2 → ratio 0.5 ≤ 0.683 (R23 fires); size 1, lifespan ~105d → gate passes.
    const result = evaluateDecisionPlan(input());
    const effects = twoLaneSideEffects(result);
    expect(effects).toHaveLength(1);
    const effect = effects[0];
    expect(effect).toBeDefined();
    if (!effect) return;
    expect(effect.kind).toBe("two_lane_entry_shadow");
    expect(effect.tokenId).toBe(tokenId);
    expect(effect.conditionId).toBe("two-lane-condition");
    expect(effect.projection.laneClass).toBe("BOTH");
    expect(effect.projection.r23Match).toBe(true);
    expect(effect.projection.gateMatch).toBe(true);
  });

  it("does not emit a two_lane_entry_shadow side-effect for an add candidate (legState present)", () => {
    const result = evaluateDecisionPlan(input({ legState: leg(), selectedForEntry: false }));
    expect(twoLaneSideEffects(result)).toHaveLength(0);
  });

  it("does not emit a two_lane_entry_shadow side-effect when an open position exists without a leg", () => {
    // Open shares but legState null is not a flat first-entry; shadow must skip it.
    const result = evaluateDecisionPlan(
      input({ legState: null, position: position(), selectedForEntry: false }),
    );
    expect(twoLaneSideEffects(result)).toHaveLength(0);
  });
});
