import { describe, it, expect } from "vitest";
import { evaluatePreEntry, evaluateContinuation, isAlive } from "./market-selection.js";
import { SelectionRuleEngine } from "./selection-rule-engine.js";
import type { SelectionRule, HealthInput, HealthThresholds, HealthFailReason } from "./types.js";

const EMPTY_ENGINE = new SelectionRuleEngine([]);

function engineWith(
  rules: Array<Partial<SelectionRule> & Pick<SelectionRule, "ruleId" | "ruleType" | "pattern">>,
) {
  return new SelectionRuleEngine(
    rules.map((r) => ({
      profileId: "simulation",
      enabled: true,
      note: null,
      createdAt: "2026-04-18T00:00:00Z",
      updatedAt: "2026-04-18T00:00:00Z",
      ...r,
    })),
  );
}

describe("evaluatePreEntry", () => {
  it("matched_include when rule admits", () => {
    const engine = engineWith([{ ruleId: "r1", ruleType: "include_prefix", pattern: "bitcoin-" }]);
    const r = evaluatePreEntry(engine, { eventSlug: "bitcoin-x", slug: "a", eventMarketCount: 3 });
    expect(r.finalStatus).toBe("INCLUDE");
    expect(r.selectionStatus).toBe("matched_include");
    expect(r.winningRuleId).toBe("r1");
  });

  it("matched_exclude when exclude rule hits", () => {
    const engine = engineWith([{ ruleId: "r1", ruleType: "exclude_slug", pattern: "spam" }]);
    const r = evaluatePreEntry(engine, { eventSlug: "any", slug: "spam", eventMarketCount: 1 });
    expect(r.finalStatus).toBe("EXCLUDE");
    expect(r.selectionStatus).toBe("matched_exclude");
    expect(r.winningRuleId).toBe("r1");
  });

  it("step2_fallback_include when no_match and single-market event", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { eventSlug: "any", slug: "a", eventMarketCount: 1 });
    expect(r.finalStatus).toBe("INCLUDE");
    expect(r.selectionStatus).toBe("step2_fallback_include");
    expect(r.winningRuleId).toBeNull();
  });

  it("fallback_exclude when no_match and multi-market event", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { eventSlug: "any", slug: "a", eventMarketCount: 3 });
    expect(r.finalStatus).toBe("EXCLUDE");
    expect(r.selectionStatus).toBe("fallback_exclude");
  });

  it("null eventSlug + step2 fallback", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { eventSlug: null, slug: "a", eventMarketCount: 1 });
    expect(r.finalStatus).toBe("INCLUDE");
    expect(r.selectionStatus).toBe("step2_fallback_include");
  });
});

describe("evaluateContinuation", () => {
  // R1: tradeCount >= 6 → CONTINUE
  it("continues when tradeCount >= 6 regardless of firstEntryFillPrice", () => {
    expect(evaluateContinuation(6, 0.01)).toBe(true);
    expect(evaluateContinuation(10, 0.03)).toBe(true);
  });

  // R2: firstEntryFillPrice >= 0.05 AND tradeCount >= 2 → CONTINUE
  it("continues when firstEntryFillPrice >= 0.05 and tradeCount >= 2", () => {
    expect(evaluateContinuation(2, 0.05)).toBe(true);
    expect(evaluateContinuation(3, 0.1)).toBe(true);
  });

  // R3/Fallback: STOP
  it("stops when tradeCount < 6 and firstEntryFillPrice < 0.05", () => {
    expect(evaluateContinuation(5, 0.04)).toBe(false);
    expect(evaluateContinuation(1, 0.01)).toBe(false);
  });

  it("stops when firstEntryFillPrice >= 0.05 but tradeCount < 2", () => {
    expect(evaluateContinuation(1, 0.05)).toBe(false);
    expect(evaluateContinuation(0, 0.1)).toBe(false);
  });

  it("stops when tradeCount is 0", () => {
    expect(evaluateContinuation(0, 0.03)).toBe(false);
  });

  // Boundaries
  it("continues at exactly tradeCount=6 with low price", () => {
    expect(evaluateContinuation(6, 0.01)).toBe(true);
  });

  it("continues at exactly firstEntryFillPrice=0.05 and tradeCount=2", () => {
    expect(evaluateContinuation(2, 0.05)).toBe(true);
  });

  it("stops at firstEntryFillPrice=0.049 and tradeCount=2", () => {
    expect(evaluateContinuation(2, 0.049)).toBe(false);
  });
});

const T: HealthThresholds = { minLiquidityClob: 100, minCompetitive: 0.01, maxSpread: 0.10 };
const HEALTHY: HealthInput = {
  acceptingOrders: true,
  enableOrderBook: true,
  bestBid: 0.45,
  bestAsk: 0.47,
  liquidityClob: 500,
  competitive: 0.8,
  spread: 0.02,
};

describe("isAlive", () => {
  it("healthy when all signals pass", () => {
    expect(isAlive(HEALTHY, T)).toEqual({ healthy: true, reasons: [] });
  });

  it.each<[string, Partial<HealthInput>, HealthFailReason]>([
    ["acceptingOrders false", { acceptingOrders: false }, "not_accepting_orders"],
    ["acceptingOrders null", { acceptingOrders: null }, "not_accepting_orders"],
    ["enableOrderBook false", { enableOrderBook: false }, "order_book_disabled"],
    ["enableOrderBook null", { enableOrderBook: null }, "order_book_disabled"],
    ["no bestBid", { bestBid: null }, "no_bid"],
    ["no bestAsk", { bestAsk: null }, "no_ask"],
    ["liquidityClob below min", { liquidityClob: 50 }, "low_liquidity_clob"],
    ["competitive below min", { competitive: 0.005 }, "low_competitive"],
    ["spread above max", { spread: 0.15 }, "wide_spread"],
  ])("%s → unhealthy with reason %s", (_label, patch, reason) => {
    const result = isAlive({ ...HEALTHY, ...patch }, T);
    expect(result.healthy).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("null liquidityClob is tolerated (healthy)", () => {
    expect(isAlive({ ...HEALTHY, liquidityClob: null }, T).healthy).toBe(true);
  });

  it("null competitive is tolerated (healthy)", () => {
    expect(isAlive({ ...HEALTHY, competitive: null }, T).healthy).toBe(true);
  });

  it("null spread is tolerated (healthy)", () => {
    expect(isAlive({ ...HEALTHY, spread: null }, T).healthy).toBe(true);
  });

  it("reasons are ordered hard→soft deterministically", () => {
    const all: HealthInput = {
      acceptingOrders: false,
      enableOrderBook: false,
      bestBid: null,
      bestAsk: null,
      liquidityClob: 50,
      competitive: 0.005,
      spread: 0.15,
    };
    expect(isAlive(all, T).reasons).toEqual([
      "not_accepting_orders",
      "order_book_disabled",
      "no_bid",
      "no_ask",
      "low_liquidity_clob",
      "low_competitive",
      "wide_spread",
    ]);
  });
});
