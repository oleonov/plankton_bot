import { describe, it, expect } from "vitest";
import {
  canPlaceBuyOrder,
  evaluatePreEntry,
  evaluateContinuation,
  isAlive,
  type BuyPlacementInput,
} from "./market-selection.js";
import { SelectionRuleEngine } from "./selection-rule-engine.js";
import type { SelectionRule, HealthInput, HealthFailReason } from "./types.js";

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
    expect(r).toEqual({
      finalStatus: "INCLUDE",
      selectionStatus: "matched_include",
      winningRuleId: "r1",
    });
  });

  it("matched_exclude when exclude rule hits", () => {
    const engine = engineWith([{ ruleId: "r1", ruleType: "exclude_slug", pattern: "spam" }]);
    const r = evaluatePreEntry(engine, { eventSlug: "any", slug: "spam", eventMarketCount: 1 });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "matched_exclude",
      winningRuleId: "r1",
    });
  });

  it("step2_fallback_include when no_match and single-market event", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { eventSlug: "any", slug: "a", eventMarketCount: 1 });
    expect(r).toEqual({
      finalStatus: "INCLUDE",
      selectionStatus: "step2_fallback_include",
      winningRuleId: null,
    });
  });

  it("fallback_exclude when no_match and multi-market event", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { eventSlug: "any", slug: "a", eventMarketCount: 3 });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
    });
  });

  it("null eventSlug + step2 fallback", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { eventSlug: null, slug: "a", eventMarketCount: 1 });
    expect(r.finalStatus).toBe("INCLUDE");
    expect(r.selectionStatus).toBe("step2_fallback_include");
  });
});

describe("evaluateContinuation", () => {
  it("continues when tradeCount >= 6 regardless of firstTradePrice", () => {
    expect(evaluateContinuation(6, 0.01)).toBe(true);
    expect(evaluateContinuation(10, 0.03)).toBe(true);
  });

  it("continues when firstTradePrice >= 0.05 and tradeCount >= 2", () => {
    expect(evaluateContinuation(2, 0.05)).toBe(true);
    expect(evaluateContinuation(3, 0.1)).toBe(true);
  });

  it("stops when tradeCount < 6 and firstTradePrice < 0.05", () => {
    expect(evaluateContinuation(5, 0.04)).toBe(false);
    expect(evaluateContinuation(1, 0.01)).toBe(false);
  });

  it("stops when firstTradePrice >= 0.05 but tradeCount < 2", () => {
    expect(evaluateContinuation(1, 0.05)).toBe(false);
    expect(evaluateContinuation(0, 0.1)).toBe(false);
  });

  it("stops when tradeCount is 0", () => {
    expect(evaluateContinuation(0, 0.03)).toBe(false);
  });

  it("continues at exactly tradeCount=6 with low price", () => {
    expect(evaluateContinuation(6, 0.01)).toBe(true);
  });

  it("continues at exactly firstTradePrice=0.05 and tradeCount=2", () => {
    expect(evaluateContinuation(2, 0.05)).toBe(true);
  });

  it("stops at firstTradePrice=0.049 and tradeCount=2", () => {
    expect(evaluateContinuation(2, 0.049)).toBe(false);
  });
});

const HEALTHY: HealthInput = {
  acceptingOrders: true,
  enableOrderBook: true,
  bestBid: 0.45,
  bestAsk: 0.47,
};

describe("isAlive", () => {
  it("healthy when all three hard signals pass", () => {
    expect(isAlive(HEALTHY)).toEqual({ healthy: true, reasons: [] });
  });

  it.each<[string, Partial<HealthInput>, HealthFailReason]>([
    ["acceptingOrders false", { acceptingOrders: false }, "not_accepting_orders"],
    ["acceptingOrders null", { acceptingOrders: null }, "not_accepting_orders"],
    ["enableOrderBook false", { enableOrderBook: false }, "order_book_disabled"],
    ["enableOrderBook null", { enableOrderBook: null }, "order_book_disabled"],
    ["no bestBid", { bestBid: null }, "no_bid"],
  ])("%s → unhealthy with reason %s", (_label, patch, reason) => {
    const result = isAlive({ ...HEALTHY, ...patch });
    expect(result.healthy).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("healthy with bestAsk=null (one-sided book — SELL skipped at bridge stage)", () => {
    expect(isAlive({ ...HEALTHY, bestAsk: null })).toEqual({ healthy: true, reasons: [] });
  });

  it("reasons are ordered hard-only deterministically", () => {
    const all: HealthInput = {
      acceptingOrders: false,
      enableOrderBook: false,
      bestBid: null,
      bestAsk: null,
    };
    expect(isAlive(all).reasons).toEqual(["not_accepting_orders", "order_book_disabled", "no_bid"]);
  });
});

describe("canPlaceBuyOrder", () => {
  const NOW = Date.parse("2026-04-25T12:00:00Z");
  const HEALTHY_LIVE: BuyPlacementInput = {
    active: true,
    tradable: true,
    endDate: "2026-05-01T00:00:00Z",
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.5,
    bestAsk: 0.52,
  };

  it("allows BUY on a fully eligible market", () => {
    const r = canPlaceBuyOrder(HEALTHY_LIVE, NOW);
    expect(r).toEqual({ allowed: true, reasons: [] });
  });

  it("allows BUY when endDate is null (no expiry)", () => {
    const r = canPlaceBuyOrder({ ...HEALTHY_LIVE, endDate: null }, NOW);
    expect(r.allowed).toBe(true);
  });

  it("blocks BUY when endDate is in the past", () => {
    const r = canPlaceBuyOrder({ ...HEALTHY_LIVE, endDate: "2026-04-25T11:00:00Z" }, NOW);
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain("market_ended");
  });

  it("blocks BUY exactly at endDate (boundary inclusive)", () => {
    const r = canPlaceBuyOrder({ ...HEALTHY_LIVE, endDate: "2026-04-25T12:00:00Z" }, NOW);
    expect(r.reasons).toContain("market_ended");
  });

  it("blocks BUY when active=false", () => {
    const r = canPlaceBuyOrder({ ...HEALTHY_LIVE, active: false }, NOW);
    expect(r.reasons).toContain("market_inactive");
  });

  it("blocks BUY when tradable=false", () => {
    const r = canPlaceBuyOrder({ ...HEALTHY_LIVE, tradable: false }, NOW);
    expect(r.reasons).toContain("market_not_tradable");
  });

  it("blocks BUY when isAlive returns unhealthy", () => {
    const r = canPlaceBuyOrder({ ...HEALTHY_LIVE, bestBid: null }, NOW);
    expect(r.reasons).toContain("market_not_alive");
  });

  it("aggregates multiple block reasons in fixed order", () => {
    const r = canPlaceBuyOrder(
      {
        ...HEALTHY_LIVE,
        active: false,
        tradable: false,
        endDate: "2026-04-25T11:00:00Z",
        bestBid: null,
      },
      NOW,
    );
    expect(r.reasons).toEqual([
      "market_inactive",
      "market_not_tradable",
      "market_ended",
      "market_not_alive",
    ]);
  });

  it("treats malformed endDate as no expiry rather than parse-as-NaN block", () => {
    const r = canPlaceBuyOrder({ ...HEALTHY_LIVE, endDate: "not-a-date" }, NOW);
    expect(r.allowed).toBe(true);
  });
});
