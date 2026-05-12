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
const VALID_PRE_ENTRY = {
  eventSlug: "fed-rate-cut-in-2026",
  slug: "fed-rate-cut-yes",
  eventMarketCount: 4,
  question: "Will the Fed cut rates in 2026?",
  midPrice: 0.32,
  liquidity: 250,
};

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
  it("includes when v5.11 hard filters pass without any prefix rule", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, VALID_PRE_ENTRY);
    expect(r).toEqual({
      finalStatus: "INCLUDE",
      selectionStatus: "matched_include",
      winningRuleId: null,
    });
  });

  it("ignores include_slug attribution when hard filters pass", () => {
    const engine = engineWith([
      { ruleId: "r1", ruleType: "include_slug", pattern: "fed-rate-cut-yes" },
    ]);
    const r = evaluatePreEntry(engine, VALID_PRE_ENTRY);
    expect(r).toEqual({
      finalStatus: "INCLUDE",
      selectionStatus: "matched_include",
      winningRuleId: null,
    });
  });

  it("ignores include_slug attribution when hard filters reject the market", () => {
    const engine = engineWith([
      { ruleId: "r1", ruleType: "include_slug", pattern: "fed-rate-cut-yes" },
    ]);
    const r = evaluatePreEntry(engine, { ...VALID_PRE_ENTRY, liquidity: 20 });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
    });
  });

  it("ignores legacy include_prefix rules", () => {
    const engine = engineWith([{ ruleId: "r1", ruleType: "include_prefix", pattern: "bitcoin-" }]);
    const r = evaluatePreEntry(engine, {
      ...VALID_PRE_ENTRY,
      eventSlug: "bitcoin-price-above-100k",
      midPrice: 0.51,
    });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
    });
  });

  it("matched_exclude when exact exclude_slug hits", () => {
    const engine = engineWith([{ ruleId: "r1", ruleType: "exclude_slug", pattern: "spam" }]);
    const r = evaluatePreEntry(engine, { ...VALID_PRE_ENTRY, slug: "spam" });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "matched_exclude",
      winningRuleId: "r1",
    });
  });

  it("excludes at mid_price >= 0.50", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { ...VALID_PRE_ENTRY, midPrice: 0.5 });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
    });
  });

  it("excludes below liquidity floor", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { ...VALID_PRE_ENTRY, liquidity: 99.99 });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
    });
  });

  it("excludes zero-coverage R9 category markets", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, {
      ...VALID_PRE_ENTRY,
      eventSlug: "btc-up-or-down-5m",
      slug: "btc-up-or-down-5m",
      question: "Bitcoin up or down in the next 5m?",
    });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
    });
  });

  it("excludes hourly crypto up-or-down direction markets", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, {
      ...VALID_PRE_ENTRY,
      eventSlug: "bitcoin-up-or-down-may-8-2026-8am-et",
      slug: "bitcoin-up-or-down-may-8-2026-8am-et",
      question: "Bitcoin up or down on May 8, 2026 at 8am ET?",
    });
    expect(r.finalStatus).toBe("EXCLUDE");
  });

  it("does not exclude unrelated slugs that merely contain 5m", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, {
      ...VALID_PRE_ENTRY,
      eventSlug: "us-stock-market-5m-vix-above-20",
      slug: "us-stock-market-5m-vix-above-20",
      question: "Will the VIX be above 20 in a five minute window?",
    });
    expect(r.finalStatus).toBe("INCLUDE");
  });

  it("does not exclude unrelated hourly ET markets", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, {
      ...VALID_PRE_ENTRY,
      eventSlug: "bitcoin-price-above-100k-may-8-2026-8am-et",
      slug: "bitcoin-price-above-100k-may-8-2026-8am-et",
      question: "Will Bitcoin be above 100k at 8am ET?",
    });
    expect(r.finalStatus).toBe("INCLUDE");
  });

  it("does not exclude non-soccer lottery draw markets", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, {
      ...VALID_PRE_ENTRY,
      eventSlug: "lottery-draw-jackpot",
      slug: "lottery-draw-jackpot",
      question: "Will the lottery draw jackpot exceed $1 billion?",
    });
    expect(r.finalStatus).toBe("INCLUDE");
  });

  it("excludes soccer draw markets from the R9 zero-coverage category", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, {
      ...VALID_PRE_ENTRY,
      eventSlug: "arsenal-match-draw",
      slug: "arsenal-match-draw",
      question: "Will the Arsenal match end in a draw?",
    });
    expect(r.finalStatus).toBe("EXCLUDE");
  });

  describe("daily-strike crypto category (R52)", () => {
    const STRIKE_BLOCKED = [
      "will-the-price-of-ethereum-be-between-2500-2600-on-may-7",
      "will-the-price-of-ethereum-be-between-2400-2500-on-may-13",
      "will-the-price-of-bitcoin-be-greater-than-84000-on-may-13",
      "ethereum-above-2295-on-april-27-2026-7am-et",
      "bitcoin-above-79200-on-april-25-2026-2pm-et",
      "will-the-price-of-xrp-be-between-1pt80-1pt90-on-february-28",
      "will-the-price-of-xrp-be-greater-than-1pt90-on-february-28",
      "bitcoin-above-66k-on-march-1",
      "bitcoin-above-74k-on-march-4",
      "xrp-above-1pt3-on-march-6",
      "solana-above-72-on-march-3",
    ] as const;

    const STRIKE_ALLOWED = [
      "bitcoin-all-time-high-by-december-31-2026",
      "trump-out-as-president-before-2027",
      "will-the-us-invade-iran-before-2027",
      "democratic-vp-nominee-2028",
      "will-zelenskyy-be-removed-from-power",
    ] as const;

    it.each(STRIKE_BLOCKED)("excludes %s", (slug) => {
      const r = evaluatePreEntry(EMPTY_ENGINE, {
        ...VALID_PRE_ENTRY,
        eventSlug: slug,
        slug,
        question: slug.replace(/-/g, " "),
      });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.selectionStatus).toBe("fallback_exclude");
    });

    it.each(STRIKE_ALLOWED)("does not exclude %s", (slug) => {
      const r = evaluatePreEntry(EMPTY_ENGINE, {
        ...VALID_PRE_ENTRY,
        eventSlug: slug,
        slug,
        question: slug.replace(/-/g, " "),
      });
      expect(r.finalStatus).toBe("INCLUDE");
    });
  });

  it("does not use single-market fallback when hard filters fail", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, {
      ...VALID_PRE_ENTRY,
      eventMarketCount: 1,
      liquidity: null,
    });
    expect(r.finalStatus).toBe("EXCLUDE");
    expect(r.selectionStatus).toBe("fallback_exclude");
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
