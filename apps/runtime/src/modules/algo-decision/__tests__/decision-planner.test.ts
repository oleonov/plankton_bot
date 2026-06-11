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
import {
  evaluateDecisionPlan,
  resolveSellExecutablePrice,
  type DecisionPlanningInput,
} from "../decision-planner.js";

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
    hasActiveSellOrderForQd: false,
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

  it("suppresses the D8 SELL via the below-entry guard when the executable bid is below entry", () => {
    // Sub-Track Q.A (Option B): D8 now triggers on the decoupled midPrice (0.5
    // → ratio 50 ≫ 2.0) regardless of the executable bid, but the new
    // below-entry guard refuses to place a SELL at the executable bid (0.004)
    // when it sits below avg entry (0.01) — mirroring the D9 below-entry guard.
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 1 }),
        position: position({ avgEntryPrice: 0.01, size: 100 }),
        market: market({ bestBid: 0.004, bestAsk: 0.006, midPrice: 0.5, spread: 0.002 }),
      }),
    );

    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "d8_profit_below_avg_entry_guard",
    );
  });

  it("fires D8 from the decoupled midpoint on a narrow book even when the executable bid alone would not, provided the bid is above entry", () => {
    // Sub-Track Q.A: D8 trigger is decoupled to midPrice. Narrow book — bid
    // 0.06 alone (ratio 1.2 < 1.228) would not fire, but mid 0.075 (ratio 1.5)
    // does. Executable bid 0.06 ≥ avg entry 0.05, so the below-entry guard
    // passes and the SELL signal is emitted.
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 5 }),
        position: position({ avgEntryPrice: 0.05, costBasisUsdc: 5, size: 100 }),
        market: market({ bestBid: 0.06, bestAsk: 0.09, midPrice: 0.075, spread: 0.03 }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
    expect(result.signal.side).toBe("sell");
  });

  it("does not fire D8 when midPrice is zero even if the executable bid is profitable", () => {
    // Sub-Track Q.A edge case: midPrice 0 passes the null/undefined guard but is
    // inert for D8 (ratio 0 < threshold). Pre-decouple the bid (0.01, ratio 2.5)
    // fired D8; the decouple makes the zero mid the trigger price, so D8 stays
    // silent.
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 0.4 }),
        position: position({ avgEntryPrice: 0.004, costBasisUsdc: 0.4, size: 100 }),
        market: market({ bestBid: 0.01, bestAsk: 0.02, midPrice: 0, spread: 0.01 }),
      }),
    );

    if (result.type === "signal") {
      expect(result.signal.decisionRuleId).not.toBe("D8_PROFIT_RATIO");
    }
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

  it("allows a profitable wide-spread SELL at exact bestBid", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 17.64, cumulativeBuyNotional: 4.41 }),
        position: position({ avgEntryPrice: 0.25, costBasisUsdc: 4.41, size: 17.64 }),
        market: market({ bestBid: 0.43, bestAsk: 0.9, midPrice: 0.665, spread: 0.47 }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
    expect(result.signal.side).toBe("sell");
    // Regression for both resolveActionPrice call sites: the final
    // buildSignalDraft path must emit the exact bid, not silently recompute null.
    expect(result.signal.suggestedPrice).toBe(0.43);
  });

  it("suppresses a below-entry wide-spread SELL with the classified spread reason", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 25 }),
        position: position({ avgEntryPrice: 0.25, costBasisUsdc: 25, size: 100 }),
        market: market({ bestBid: 0.1, bestAsk: 0.9, midPrice: 0.5, spread: 0.8 }),
        executionPolicy: {
          ...DEFAULT_EXECUTION_POLICY,
          entryMinMarketAgeSeconds: 0,
          profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, enabled: false },
          lossExit: { ...DEFAULT_EXECUTION_POLICY.lossExit, enabled: false },
        },
      }),
    );

    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "sell-spread-too-wide-below-avg-entry",
    );
  });

  it("keeps below-entry D9 SELL blocked on a wide spread", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 25 }),
        position: position({ avgEntryPrice: 0.25, costBasisUsdc: 25, size: 100 }),
        market: market({
          bestBid: 0.1,
          bestAsk: 0.9,
          midPrice: 0.12,
          spread: 0.8,
          publicTradeCount24h: 50,
        }),
        executionPolicy: {
          ...DEFAULT_EXECUTION_POLICY,
          entryMinMarketAgeSeconds: 0,
          profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, enabled: false },
          lossExit: { ...DEFAULT_EXECUTION_POLICY.lossExit, enabled: true },
        },
      }),
    );

    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "sell-spread-too-wide-below-avg-entry",
    );
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

  it("suppresses D9 loss exit when executable exit price is below avg entry", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({
          buyCount: 1,
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 12,
        }),
        position: position({ avgEntryPrice: 0.12, size: 100 }),
        market: market({
          bestBid: 0.07,
          bestAsk: 0.08,
          midPrice: 0.075,
          spread: 0.01,
          publicTradeCount24h: 100,
        }),
      }),
    );

    expect(result.type).toBe("none");
    expect(result.suppressions).toContainEqual(
      expect.objectContaining({
        reasonCode: "d9_loss_exit_below_avg_entry_guard",
        side: "SELL",
        decisionRuleId: "D9_LOSS_EXIT",
        price: 0.07,
      }),
    );
    expect(result.suppressions[0]).toEqual(
      expect.objectContaining({
        extra: expect.objectContaining({
          avgEntryPrice: 0.12,
          proposedExitPrice: 0.07,
          exitToAvgEntryRatio: expect.closeTo(0.5833333333, 8),
          originalD9Reason: "d9-loss-exit-fired",
          suppressionReason: "d9_loss_exit_below_avg_entry_guard",
        }),
      }),
    );
  });

  it("allows D9 loss exit when position avg entry is unavailable", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({
          buyCount: 1,
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 12,
        }),
        position: null,
        market: market({
          bestBid: 0.07,
          bestAsk: 0.08,
          midPrice: 0.075,
          spread: 0.01,
          publicTradeCount24h: 100,
        }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D9_LOSS_EXIT");
    expect(result.signal.suggestedPrice).toBe(0.07);
  });

  it("allows D9 loss exit when position avg entry is invalid and records fail-open telemetry", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({
          buyCount: 1,
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 12,
        }),
        position: position({ avgEntryPrice: 0, size: 100 }),
        market: market({
          bestBid: 0.07,
          bestAsk: 0.08,
          midPrice: 0.075,
          spread: 0.01,
          publicTradeCount24h: 100,
        }),
      }),
    );

    expect(result.type).toBe("signal");
    expect(result.suppressions).toContainEqual(
      expect.objectContaining({
        reasonCode: "d9_loss_exit_avg_entry_unavailable_guard_bypass",
        side: "SELL",
        decisionRuleId: "D9_LOSS_EXIT",
        extra: expect.objectContaining({
          avgEntrySource: "invalid_avg_entry",
          guardMode: "fail_open",
          proposedExitPrice: 0.07,
          originalD9Reason: "d9-loss-exit-fired",
        }),
      }),
    );
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D9_LOSS_EXIT");
    expect(result.signal.suggestedPrice).toBe(0.07);
  });

  it("allows D9 loss exit when executable exit price is at or above position avg entry", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({
          buyCount: 1,
          cumulativeBuySize: 100,
          cumulativeBuyNotional: 12,
        }),
        position: position({ avgEntryPrice: 0.06, size: 100 }),
        market: market({
          bestBid: 0.07,
          bestAsk: 0.08,
          midPrice: 0.075,
          spread: 0.01,
          publicTradeCount24h: 100,
        }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D9_LOSS_EXIT");
    expect(result.signal.suggestedPrice).toBe(0.07);
  });

  it("leaves static D-rules able to emit below avg entry", () => {
    const staticSellRules: AlgoDecisionRule[] = [
      {
        id: 10,
        priority: 1,
        ruleId: "D7_STATIC_EXIT",
        stateCondition: "S1",
        priceOperator: ">=",
        priceValue: 0.05,
        timeSinceLastOperator: null,
        timeSinceLastSeconds: null,
        buyCountMin: null,
        buyCountMax: null,
        holdDurationOperator: null,
        holdDurationSeconds: null,
        action: "SELL",
      },
      rules[1]!,
    ];
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        decisionRules: staticSellRules,
        executionPolicy: {
          ...DEFAULT_EXECUTION_POLICY,
          entryMinMarketAgeSeconds: 0,
          lossExit: { ...DEFAULT_EXECUTION_POLICY.lossExit, enabled: false },
          r23DipTrigger: { ...DEFAULT_EXECUTION_POLICY.r23DipTrigger, enabled: false },
        },
        legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 12 }),
        position: position({ avgEntryPrice: 0.12, size: 100 }),
        market: market({ bestBid: 0.07, bestAsk: 0.08, midPrice: 0.075, spread: 0.01 }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D7_STATIC_EXIT");
    expect(result.signal.suggestedPrice).toBe(0.07);
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

  // Track Q shadow (observe-only): emits a side effect on wide books the
  // spread guard suppresses, without altering price/suppressions/D8/D9.
  it("emits a Track Q shadow side effect on a wide book without changing the SELL suppression", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        legState: leg({ buyCount: 1, cumulativeBuySize: 17.64, cumulativeBuyNotional: 4.41 }),
        position: position({ avgEntryPrice: 0.25, costBasisUsdc: 4.41, size: 17.64 }),
        market: market({ bestBid: 0.43, bestAsk: 0.9, midPrice: 0.665, spread: 0.47 }),
      }),
    );

    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedPrice).toBe(0.43);

    const shadow = result.sideEffects.find((s) => s.kind === "track_q_shadow");
    expect(shadow).toBeDefined();
    if (shadow?.kind !== "track_q_shadow") return;
    expect(shadow.projection.currentGuardWouldSuppress).toBe(true);
    expect(shadow.projection.bidAnchoredPrice).toBeCloseTo(0.47, 9);
    // avgEntry 0.25 → tier 0.2925 < F1 0.47 → no activation.
    expect(shadow.projection.p3WouldActivate).toBe(false);
    expect(shadow.projection.reason).toBe("f1_already_above_tier");
  });

  it("does not emit a Track Q shadow side effect on a narrow book and leaves the SELL price unchanged", () => {
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
    expect(result.sideEffects.some((s) => s.kind === "track_q_shadow")).toBe(false);
  });
});

describe("resolveSellExecutablePrice", () => {
  const wideMarket = market({ bestBid: 0.2, bestAsk: 0.8, midPrice: 0.5, spread: 0.6 });

  it("blocks wide-spread SELL when bestBid is below avg entry", () => {
    expect(resolveSellExecutablePrice(wideMarket, { avgEntryPrice: 0.21 })).toMatchObject({
      price: null,
      reasonCode: "sell-spread-too-wide-below-avg-entry",
    });
  });

  it("allows wide-spread SELL at bestBid when bestBid equals avg entry", () => {
    expect(resolveSellExecutablePrice(wideMarket, { avgEntryPrice: 0.2 })).toMatchObject({
      price: 0.2,
      reasonCode: null,
    });
  });

  it("allows wide-spread SELL at bestBid when bestBid is above avg entry", () => {
    expect(resolveSellExecutablePrice(wideMarket, { avgEntryPrice: 0.19 })).toMatchObject({
      price: 0.2,
      reasonCode: null,
    });
  });

  it("fails safe on missing or invalid avg entry", () => {
    for (const avgEntryPrice of [null, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveSellExecutablePrice(wideMarket, { avgEntryPrice })).toMatchObject({
        price: null,
        reasonCode: "sell-spread-too-wide-avg-entry-unavailable",
      });
    }
  });

  it("keeps bestBid availability guard unchanged", () => {
    for (const bestBid of [null, 0]) {
      expect(
        resolveSellExecutablePrice(market({ bestBid, bestAsk: 0.8, midPrice: 0.5, spread: 0.6 }), {
          avgEntryPrice: 0.1,
        }),
      ).toMatchObject({
        price: null,
        reasonCode: "sell-best-bid-unavailable",
      });
    }
  });

  it("keeps narrow-spread behavior unchanged", () => {
    expect(
      resolveSellExecutablePrice(
        market({ bestBid: 0.2, bestAsk: 0.24, midPrice: 0.22, spread: 0.04 }),
        { avgEntryPrice: 0.4 },
      ),
    ).toMatchObject({
      price: 0.2,
      reasonCode: null,
    });
  });
});
