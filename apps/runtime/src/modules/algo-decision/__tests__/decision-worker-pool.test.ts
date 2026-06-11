import { describe, expect, it, vi } from "vitest";
import { createTokenId, type NormalizedMarket } from "@krabs/domain";
import { DecisionWorkerPool } from "../decision-worker-pool.js";
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
});
