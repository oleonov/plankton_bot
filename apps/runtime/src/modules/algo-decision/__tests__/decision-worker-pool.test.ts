import { describe, expect, it, vi } from "vitest";
import { createTokenId, type NormalizedMarket } from "@krabs/domain";
import { DecisionWorkerPool, validateWorkerEvaluations } from "../decision-worker-pool.js";
import { evaluateDecisionPlan } from "../decision-planner.js";
import type { DecisionPlanningInput } from "../decision-planner.js";

const log = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as any;

function market(token: string, midpoint: number): NormalizedMarket {
  return {
    tokenId: createTokenId(token),
    conditionId: `condition-${token}`,
    slug: `market-${token}`,
    eventSlug: null,
    eventMarketCount: 1,
    question: "Worker pool test?",
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
    bestBid: midpoint - 0.01,
    bestAsk: midpoint + 0.01,
    midPrice: midpoint,
    spread: 0.02,
    liquidity: 500,
    minOrderSize: 5,
    gammaCreatedAt: "2026-05-19T00:00:00.000Z",
    snapshotTs: Date.parse("2026-05-20T00:00:00.000Z"),
  };
}

function input(token: string): DecisionPlanningInput {
  return {
    tokenId: createTokenId(token),
    now: Date.parse("2026-05-20T00:00:00.000Z"),
    selectedForEntry: true,
    hasPendingBuyOrder: false,
    legState: null,
    position: null,
    market: market(token, 0.1),
    prevMidPrice: null,
    decisionRules: [
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
    ],
    buySizeRules: [],
    sellSizeRules: [],
    executionPolicy: null,
    continuationFacts: null,
    continuationMode: "leg_local",
    r23MaxMidpoint: null,
    dropReferencePrice: null,
    postBuyCooldown: null,
    latestSellOrder: null,
    hasActiveSellOrderForQd: false,
    sellLoopGuard: null,
  };
}

describe("DecisionWorkerPool", () => {
  it("uses local planning fallback when worker count is zero", async () => {
    const pool = new DecisionWorkerPool({ workerCount: 0, batchSize: 2, log });

    const results = await pool.evaluate([input("a"), input("b"), input("c")]);

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.type === "none")).toBe(true);
    expect(pool.getStats()).toMatchObject({
      workerCount: 0,
      localFallbacks: 3,
      workerDispatches: 0,
    });
  });

  it("preserves result ordering across local batches", async () => {
    const pool = new DecisionWorkerPool({ workerCount: 0, batchSize: 1, log });

    const results = await pool.evaluate([input("first"), input("second")]);

    expect(results.map((result) => String(result.suppressions[0]?.tokenId ?? ""))).toEqual([
      "first",
      "second",
    ]);
    expect(pool.getStats().localFallbacks).toBe(2);
  });

  it("rejects missing, reordered, or cross-token worker results instead of blind zipping", () => {
    const inputs = [input("first"), { ...input("second"), market: null }];
    const valid = inputs.map((value, index) => ({
      inputIndex: index,
      tokenId: value.tokenId,
      result: evaluateDecisionPlan(value),
    }));

    expect(validateWorkerEvaluations(inputs, valid)).toHaveLength(2);
    expect(validateWorkerEvaluations(inputs, valid.slice(0, 1))).toBeNull();
    expect(validateWorkerEvaluations(inputs, [valid[1], valid[0]])).toBeNull();
    expect(
      validateWorkerEvaluations(inputs, [
        { ...valid[0], tokenId: createTokenId("wrong") },
        valid[1],
      ]),
    ).toBeNull();
  });

  it("falls back locally without throwing for malformed worker result shapes", () => {
    const pool = new DecisionWorkerPool({ workerCount: 0, log });
    const source = input("malformed");
    const metrics = evaluateDecisionPlan(source).metrics;
    const signal = {
      ...{ market: source.market, side: "buy" },
      ...{ suggestedPrice: 0.1, suggestedSize: 10, suggestedSizeUsdc: 1 },
      ...{ reason: "test", decisionRuleId: "rule", sizingRuleId: "size" },
      ...{ logDraft: {}, emissionFacts: {}, triggerTelemetry: {} },
    };
    const signalResult = (value: unknown) => ({
      type: "signal",
      metrics,
      suppressions: [],
      sideEffects: [],
      signal: value,
    });
    const malformed = [
      { type: "none" },
      { type: "none", metrics: [], suppressions: [], sideEffects: [] },
      { type: "none", metrics, suppressions: {}, sideEffects: [] },
      { type: "none", metrics, suppressions: [], sideEffects: null },
      signalResult({ market: { tokenId: source.tokenId } }),
      signalResult({ ...signal, market: { ...source.market!, eventMarketCount: "1" } }),
      signalResult({ ...signal, positionId: {} }),
      { ...evaluateDecisionPlan(source), sideEffects: [{ tokenId: source.tokenId }] },
    ];
    for (const result of malformed)
      expect(
        validateWorkerEvaluations([source], [{ inputIndex: 0, tokenId: source.tokenId, result }]),
      ).toBeNull();

    const resolved = vi.fn();
    (pool as any).pending.set(1, { inputs: [source], resolve: resolved, reject: vi.fn() });
    (pool as any).handleWorkerMessage(
      { inFlight: 1 },
      {
        requestId: 1,
        results: [{ inputIndex: 0, tokenId: source.tokenId, result: malformed.at(-1) }],
      },
    );
    expect(resolved.mock.calls[0]![0][0].type).toBe("none");
  });
});
