import { describe, expect, it } from "vitest";
import {
  createConditionId,
  createPositionId,
  createTokenId,
  type ExitTakerFallbackPolicy,
  type NormalizedMarket,
  type Position,
} from "@krabs/domain";
import { shouldFireTakerFallback } from "./exit-taker-fallback.js";

const DEFAULT_TEST_EXIT_TAKER_FALLBACK_POLICY: ExitTakerFallbackPolicy = {
  enabled: true,
  profitRatioMultiplier: 5,
  requireChainCapped: true,
  maxAttemptsPer24h: 1,
  priceAnchor: "best_bid",
};

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: createTokenId("tok-yes"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    size: 10,
    avgEntryPrice: 0.01,
    costBasisUsdc: 0.1,
    currentValueUsdc: 1.5,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: "2026-05-22T00:00:00Z",
    closedAt: null,
    updatedAt: "2026-05-22T00:00:00Z",
    ...overrides,
  };
}

function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  const bestBid = overrides.bestBid ?? 0.15;
  const bestAsk = overrides.bestAsk ?? 0.16;
  return {
    tokenId: createTokenId("tok-yes"),
    conditionId: "cond-1",
    slug: "test-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Test?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid,
    bestAsk,
    midPrice: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
    spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
    gammaCreatedAt: null,
    snapshotTs: Date.now(),
    ...overrides,
  };
}

function evaluate(overrides: Partial<Parameters<typeof shouldFireTakerFallback>[0]> = {}) {
  return shouldFireTakerFallback({
    policy: DEFAULT_TEST_EXIT_TAKER_FALLBACK_POLICY,
    runtimeMode: "live-lite",
    position: makePosition(),
    market: makeMarket(),
    chainCapped: true,
    attemptsLast24h: 0,
    ...overrides,
  });
}

describe("exit taker fallback decision", () => {
  it("fires only when profit is deep, runtime is live-lite, and chain cap is exhausted", () => {
    const decision = evaluate();

    expect(decision.fire).toBe(true);
    if (!decision.fire) throw new Error("expected fallback to fire");
    expect(decision.bestBid).toBe(0.15);
    expect(decision.qty).toBe(10);
    expect(decision.profitRatio).toBeCloseTo(15);
  });

  it("does not fire after max attempts in the last 24h", () => {
    const decision = evaluate({ attemptsLast24h: 1 });

    expect(decision).toMatchObject({ fire: false, reason: "attempt-limit" });
  });

  it("does not fire below the configured profit threshold", () => {
    const decision = evaluate({ market: makeMarket({ bestBid: 0.09 }) });

    expect(decision).toMatchObject({ fire: false, reason: "ratio-below-threshold" });
  });

  it("does not fire when the chain is not capped", () => {
    const decision = evaluate({ chainCapped: false });

    expect(decision).toMatchObject({ fire: false, reason: "not-chain-capped" });
  });

  it("does not fire with missing best bid", () => {
    const decision = evaluate({ market: makeMarket({ bestBid: null }) });

    expect(decision).toMatchObject({ fire: false, reason: "invalid-best-bid" });
  });
});
