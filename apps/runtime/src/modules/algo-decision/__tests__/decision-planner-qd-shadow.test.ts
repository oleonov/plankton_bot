import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  createTokenId,
  type ExecutionPolicy,
  type LegState,
  type NormalizedMarket,
  type Position,
} from "@krabs/domain";
import {
  evaluateDecisionPlan,
  type DecisionPlanResult,
  type DecisionPlanSideEffect,
  type DecisionPlanningInput,
  type QdShadowProjection,
} from "../decision-planner.js";

// Sub-Track Q.D shadow (observe-only): the planner emits a `track_q_d` side
// effect for cheap-longshot legs inside the pre-resolution TTC window — the
// cohort classified spread suppression can leave unresolved — WITHOUT changing
// the placed order, the suppression, D8/D9, or the signal. See
// research_plankton/track_q_d_spec_2026-06-12.md.

const tokenId = createTokenId("qd-token");
const now = Date.parse("2026-06-11T00:00:00.000Z");

const rules = [
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
] satisfies DecisionPlanningInput["decisionRules"];

const buySizeRules = [
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
] satisfies DecisionPlanningInput["buySizeRules"];

const sellSizeRules = [
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
] satisfies DecisionPlanningInput["sellSizeRules"];

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId: "condition",
    slug: "qd-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Q.D?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    // Default: cheap longshot 1h before close → inside the 2h TTC window.
    endDate: "2026-06-11T01:00:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.03,
    bestAsk: 0.04,
    midPrice: 0.035,
    spread: 0.01,
    liquidity: 500,
    minOrderSize: 5,
    publicTradeCount24h: 5, // illiquid → D9's liquidity gate excludes the cohort
    gammaCreatedAt: "2026-01-01T00:00:00.000Z", // long lifetime → not a short market
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
    firstTradePrice: 0.03,
    firstTradeAt: "2026-06-01T00:00:00.000Z", // ~10 days held → D8 hold gate met
    lastTradeAt: "2026-06-01T00:10:00.000Z",
    updatedAt: "2026-06-01T00:10:00.000Z",
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 3, // avg buy 0.03
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
    avgEntryPrice: 0.03, // cheap longshot < 0.05 tier ceiling
    costBasisUsdc: 3,
    currentValueUsdc: 3,
    realizedPnl: 0,
    status: "open",
    entryStyle: "probe",
    openedAt: "2026-06-01T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-01T00:10:00.000Z",
    ...overrides,
  };
}

function policy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    entryMinMarketAgeSeconds: 0,
    lossExit: { ...DEFAULT_EXECUTION_POLICY.lossExit, enabled: true },
    profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, holdSecondsMin: 0 },
    ...overrides,
  };
}

function input(overrides: Partial<DecisionPlanningInput> = {}): DecisionPlanningInput {
  return {
    tokenId,
    now,
    selectedForEntry: false,
    hasPendingBuyOrder: false,
    legState: leg(),
    position: position(),
    market: market(),
    prevMidPrice: null,
    decisionRules: rules,
    buySizeRules,
    sellSizeRules,
    executionPolicy: policy(),
    continuationFacts: null,
    continuationMode: "leg_local",
    r23MaxMidpoint: null,
    dropReferencePrice: null,
    postBuyCooldown: null,
    latestSellOrder: null,
    hasActiveSellOrderForQd: false,
    ...overrides,
  };
}

function qdSideEffect(result: DecisionPlanResult): QdShadowProjection | null {
  const found = result.sideEffects.find(
    (s: DecisionPlanSideEffect): s is Extract<DecisionPlanSideEffect, { kind: "track_q_d" }> =>
      s.kind === "track_q_d",
  );
  return found ? found.projection : null;
}

describe("evaluateDecisionPlan — Sub-Track Q.D shadow", () => {
  it("emits a Mode A track_q_d side effect for an eligible cheap longshot near resolution", () => {
    const result = evaluateDecisionPlan(input());

    const projection = qdSideEffect(result);
    expect(projection).not.toBeNull();
    expect(projection!.qdWouldActivate).toBe(true);
    expect(projection!.activationMode).toBe("mode_a");
    expect(projection!.reason).toBe("would_fire");
    expect(projection!.avgEntry).toBeCloseTo(0.03, 9);
    expect(projection!.withinTtc).toBe(true);
    expect(projection!.qualifyingBid).toBe(true);
    expect(projection!.modeAApplies).toBe(true);
    expect(projection!.d8Fired).toBe(false);
    expect(projection!.d9Fired).toBe(false);
    expect(projection!.anchorTicks).toBe(4); // moderate TTC → maker F1
  });

  it("records Mode B applicability at imminent TTC while salvage stays OFF", () => {
    // TTC 20m < salvageTtc 30m → imminent. bestBid 0.02 ∈ [0.5×0.03, 0.03) →
    // Mode B WOULD apply, Mode A does not. salvageEnabled OFF → no activation.
    const result = evaluateDecisionPlan(
      input({
        market: market({
          endDate: "2026-06-11T00:20:00.000Z",
          bestBid: 0.02,
          bestAsk: 0.03,
          midPrice: 0.025,
          spread: 0.01,
        }),
      }),
    );

    const projection = qdSideEffect(result);
    expect(projection).not.toBeNull();
    expect(projection!.imminentTtc).toBe(true);
    expect(projection!.modeBApplies).toBe(true);
    expect(projection!.modeAApplies).toBe(false);
    expect(projection!.qdWouldActivate).toBe(false);
    expect(projection!.activationMode).toBe("not_activated");
    expect(projection!.reason).toBe("below_entry_hold");
    expect(projection!.anchorTicks).toBe(0); // imminent TTC → taker at bestBid
  });

  it("keeps D8 predicate telemetry without yielding to predicate truth alone", () => {
    // mid 0.045 / avg buy 0.03 → ratio 1.5 ≥ 1.2412 → D8 fires; bid 0.04 ≥ entry.
    const result = evaluateDecisionPlan(
      input({
        market: market({ bestBid: 0.04, bestAsk: 0.05, midPrice: 0.045, spread: 0.01 }),
      }),
    );

    // Production D8 behavior preserved: the SELL signal is still emitted.
    expect(result.type).toBe("signal");
    if (result.type === "signal") {
      expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
      expect(result.signal.side).toBe("sell");
    }

    const projection = qdSideEffect(result);
    expect(projection).not.toBeNull();
    expect(projection!.d8Fired).toBe(true);
    expect(projection!.reason).toBe("would_fire");
    expect(projection!.qdWouldActivate).toBe(true);
    expect(projection!.activationMode).toBe("mode_a");
  });

  it("CRITICAL: placed order is byte-identical whether Q.D is enabled or disabled (observe-only)", () => {
    const base = input();
    const enabled = evaluateDecisionPlan({
      ...base,
      executionPolicy: policy({
        preResolutionExit: { ...DEFAULT_EXECUTION_POLICY.preResolutionExit, enabled: true },
      }),
    });
    const disabled = evaluateDecisionPlan({
      ...base,
      executionPolicy: policy({
        preResolutionExit: { ...DEFAULT_EXECUTION_POLICY.preResolutionExit, enabled: false },
      }),
    });

    // Q.D records when enabled, stays silent when disabled…
    expect(qdSideEffect(enabled)).not.toBeNull();
    expect(qdSideEffect(disabled)).toBeNull();

    // …but the production decision (type, signal, suppressions, metrics) is identical.
    expect(enabled.type).toBe(disabled.type);
    const stripSideEffects = (r: DecisionPlanResult): unknown => {
      const { sideEffects: _ignored, ...rest } = r;
      return rest;
    };
    expect(stripSideEffects(enabled)).toStrictEqual(stripSideEffects(disabled));
  });

  it("does not emit for a leg outside the Q.D cohort (wrong tier)", () => {
    const result = evaluateDecisionPlan(input({ position: position({ avgEntryPrice: 0.5 }) }));
    expect(qdSideEffect(result)).toBeNull();
  });

  it("does not emit for a cheap longshot whose TTC is far from resolution", () => {
    const result = evaluateDecisionPlan(
      input({ market: market({ endDate: "2026-12-01T00:00:00.000Z" }) }),
    );
    expect(qdSideEffect(result)).toBeNull();
  });

  it("composes with Track Q shadow: both side effects fire on a wide-book cheap longshot", () => {
    // Wide book (spread/mid 1.636) → Track Q shadow fires; bestBid 0.005 < bid
    // floor 0.01 → Q.D records a `no_qualifying_bid` shadow (still in cohort).
    const result = evaluateDecisionPlan(
      input({
        market: market({ bestBid: 0.005, bestAsk: 0.05, midPrice: 0.0275, spread: 0.045 }),
      }),
    );

    const kinds = result.sideEffects.map((s) => s.kind);
    expect(kinds).toContain("track_q_shadow");
    expect(kinds).toContain("track_q_d");

    const projection = qdSideEffect(result);
    expect(projection!.qualifyingBid).toBe(false);
    expect(projection!.reason).toBe("no_qualifying_bid");
  });

  it("does not emit when there is no leg state", () => {
    const result = evaluateDecisionPlan(input({ legState: null, selectedForEntry: true }));
    expect(qdSideEffect(result)).toBeNull();
  });
});
