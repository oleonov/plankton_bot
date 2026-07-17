import { describe, it, expect } from "vitest";
import {
  DEFAULT_MARKET_SELECTION_POLICY,
  canPlaceBuyOrder,
  evaluatePreEntry,
  evaluateContinuation,
  evaluateStrikeEntryFilter,
  isAlive,
  matchesStrikePattern,
  STRIKE_MIN_HORIZON_HOURS,
  STRIKE_YES_TAIL_MAX_PRICE,
  STRIKE_YES_TAIL_MIN_RUNWAY_HOURS,
  type BuyPlacementInput,
} from "./market-selection.js";
import { SelectionRuleEngine } from "./selection-rule-engine.js";
import type {
  MarketSelectionPolicy,
  SelectionRule,
  HealthInput,
  HealthFailReason,
} from "./types.js";

const EMPTY_ENGINE = new SelectionRuleEngine([]);
const NOW_MS = Date.parse("2026-06-12T12:00:00.000Z");
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

function shortLifetimePolicy(overrides: Partial<MarketSelectionPolicy["shortLifetime"]> = {}) {
  return {
    ...DEFAULT_MARKET_SELECTION_POLICY,
    shortLifetime: {
      enabled: true,
      thresholdHours: 1,
      ...overrides,
    },
  } satisfies MarketSelectionPolicy;
}

function fromNow(hours: number): string {
  return new Date(NOW_MS + hours * 3_600_000).toISOString();
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
      rejectReason: "liquidity_too_low",
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
      rejectReason: "mid_price_too_high",
    });
  });

  it("matched_exclude when exact exclude_slug hits", () => {
    const engine = engineWith([{ ruleId: "r1", ruleType: "exclude_slug", pattern: "spam" }]);
    const r = evaluatePreEntry(engine, { ...VALID_PRE_ENTRY, slug: "spam" });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "matched_exclude",
      winningRuleId: "r1",
      rejectReason: "rule_exclude",
    });
  });

  it("excludes at mid_price >= 0.50", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { ...VALID_PRE_ENTRY, midPrice: 0.5 });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
      rejectReason: "mid_price_too_high",
    });
  });

  it("excludes below liquidity floor", () => {
    const r = evaluatePreEntry(EMPTY_ENGINE, { ...VALID_PRE_ENTRY, liquidity: 99.99 });
    expect(r).toEqual({
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
      rejectReason: "liquidity_too_low",
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
      rejectReason: "zero_coverage_category",
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

  describe("daily-strike crypto category (R52 + R64)", () => {
    // After R64 only `greater-than` / `less-than` / `above` strike slugs are
    // blocked outright by the ZERO_COVERAGE blacklist. `will-be-between`
    // slugs are admitted by the blacklist and gated separately by the
    // horizon filter below.
    const STRIKE_REGEX_BLOCKED = [
      "will-the-price-of-bitcoin-be-greater-than-84000-on-may-13",
      "ethereum-above-2295-on-april-27-2026-7am-et",
      "bitcoin-above-79200-on-april-25-2026-2pm-et",
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

    it.each(STRIKE_REGEX_BLOCKED)("excludes %s via ZERO_COVERAGE", (slug) => {
      const r = evaluatePreEntry(EMPTY_ENGINE, {
        ...VALID_PRE_ENTRY,
        eventSlug: slug,
        slug,
        question: slug.replace(/-/g, " "),
      });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.selectionStatus).toBe("fallback_exclude");
      expect(r.rejectReason).toBe("zero_coverage_category");
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

  describe("Guard B short-lifetime crypto updown", () => {
    const COMPACT_UPDOWN = "eth-updown-15m-1776889800";

    it("blocks compact crypto_updown markets with less than 1h remaining when enabled", () => {
      const r = evaluatePreEntry(
        EMPTY_ENGINE,
        {
          ...VALID_PRE_ENTRY,
          eventSlug: COMPACT_UPDOWN,
          slug: COMPACT_UPDOWN,
          question: "ETH Up or Down - 15m",
          endDate: fromNow(0.5),
        },
        shortLifetimePolicy(),
        NOW_MS,
      );

      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("buy_guard_short_lifetime");
      expect(r.horizonHours).toBeCloseTo(0.5);
    });

    it("admits compact crypto_updown markets above the configured threshold", () => {
      const r = evaluatePreEntry(
        EMPTY_ENGINE,
        {
          ...VALID_PRE_ENTRY,
          eventSlug: COMPACT_UPDOWN,
          slug: COMPACT_UPDOWN,
          question: "ETH Up or Down - 15m",
          endDate: fromNow(1.01),
        },
        shortLifetimePolicy(),
        NOW_MS,
      );

      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("does not block non-crypto_updown markets with less than 1h remaining", () => {
      const r = evaluatePreEntry(
        EMPTY_ENGINE,
        {
          ...VALID_PRE_ENTRY,
          slug: "fed-rate-cut-in-june-yes",
          eventSlug: "fed-rate-cut-in-june",
          question: "Will the Fed cut rates in June?",
          endDate: fromNow(0.5),
        },
        shortLifetimePolicy(),
        NOW_MS,
      );

      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("preserves default disabled behavior", () => {
      const r = evaluatePreEntry(
        EMPTY_ENGINE,
        {
          ...VALID_PRE_ENTRY,
          eventSlug: COMPACT_UPDOWN,
          slug: COMPACT_UPDOWN,
          question: "ETH Up or Down - 15m",
          endDate: fromNow(0.5),
        },
        DEFAULT_MARKET_SELECTION_POLICY,
        NOW_MS,
      );

      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("honors configurable thresholdHours", () => {
      const r = evaluatePreEntry(
        EMPTY_ENGINE,
        {
          ...VALID_PRE_ENTRY,
          eventSlug: COMPACT_UPDOWN,
          slug: COMPACT_UPDOWN,
          question: "ETH Up or Down - 15m",
          endDate: fromNow(0.75),
        },
        shortLifetimePolicy({ thresholdHours: 0.5 }),
        NOW_MS,
      );

      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("fails open on missing or unparseable endDate", () => {
      for (const endDate of [null, "not-a-date"]) {
        const r = evaluatePreEntry(
          EMPTY_ENGINE,
          {
            ...VALID_PRE_ENTRY,
            eventSlug: COMPACT_UPDOWN,
            slug: COMPACT_UPDOWN,
            question: "ETH Up or Down - 15m",
            endDate,
          },
          shortLifetimePolicy(),
          NOW_MS,
        );

        expect(r.finalStatus).toBe("INCLUDE");
      }
    });

    it("blocks compact crypto_updown markets with endDate in the past", () => {
      const r = evaluatePreEntry(
        EMPTY_ENGINE,
        {
          ...VALID_PRE_ENTRY,
          eventSlug: COMPACT_UPDOWN,
          slug: COMPACT_UPDOWN,
          question: "ETH Up or Down - 15m",
          endDate: fromNow(-0.1),
        },
        shortLifetimePolicy(),
        NOW_MS,
      );

      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("buy_guard_short_lifetime");
    });

    it("preserves maxMidPrice, zero-coverage, and strike reject ordering", () => {
      const policy = shortLifetimePolicy();

      expect(
        evaluatePreEntry(
          EMPTY_ENGINE,
          {
            ...VALID_PRE_ENTRY,
            eventSlug: COMPACT_UPDOWN,
            slug: COMPACT_UPDOWN,
            question: "ETH Up or Down - 15m",
            midPrice: 0.5,
            endDate: fromNow(0.5),
          },
          policy,
          NOW_MS,
        ).rejectReason,
      ).toBe("mid_price_too_high");

      expect(
        evaluatePreEntry(
          EMPTY_ENGINE,
          {
            ...VALID_PRE_ENTRY,
            eventSlug: "btc-up-or-down-5m",
            slug: "btc-up-or-down-5m",
            question: "Bitcoin up or down in the next 5m?",
            endDate: fromNow(0.5),
          },
          policy,
          NOW_MS,
        ).rejectReason,
      ).toBe("zero_coverage_category");

      expect(
        evaluatePreEntry(
          EMPTY_ENGINE,
          {
            ...VALID_PRE_ENTRY,
            eventSlug: "will-the-price-of-bitcoin-be-between-84000-85000-on-may-13",
            slug: "will-the-price-of-bitcoin-be-between-84000-85000-on-may-13",
            question: "Will BTC be between $84k and $85k on May 13?",
            endDate: fromNow(0.5),
          },
          policy,
          NOW_MS,
        ).rejectReason,
      ).toBe("strike_min_horizon");
    });
  });

  // Track B D1 strike entry filter (spec §5). Supersedes the R64 crypto-only
  // short-horizon filter: now applies to ALL strike-classified markets, plus a
  // Yes-tail (cheap + short-runway) guard. The 14 cases mirror spec §5.6.
  describe("strike entry filter (Track B D1)", () => {
    const NOW_MS = Date.parse("2026-05-12T12:00:00.000Z");
    const futureEndDate = (hoursFromNow: number) =>
      new Date(NOW_MS + hoursFromNow * 3_600_000).toISOString();
    // Crypto strike → also matched by the narrow `matchesStrikePattern` regex.
    const CRYPTO_STRIKE = "will-the-price-of-bitcoin-be-between-84000-85000-on-may-13";
    // Non-crypto strike → classified strike by slug shape, but no strikePattern.
    const WEATHER_STRIKE = "highest-temperature-in-tokyo-on-may-18-2026-25c";

    const evalStrike = (overrides: Record<string, unknown>) =>
      evaluatePreEntry(
        EMPTY_ENGINE,
        { ...VALID_PRE_ENTRY, slug: CRYPTO_STRIKE, eventSlug: CRYPTO_STRIKE, ...overrides },
        undefined,
        NOW_MS,
      );

    it("1: blocks strike at ttc 23h59m → strike_min_horizon", () => {
      const r = evalStrike({ endDate: new Date(NOW_MS + (24 * 3600 - 60) * 1000).toISOString() });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.selectionStatus).toBe("fallback_exclude");
      expect(r.rejectReason).toBe("strike_min_horizon");
    });

    it("2: admits strike at ttc 24h00m exactly (strict <)", () => {
      const r = evalStrike({ endDate: new Date(NOW_MS + 24 * 3_600_000).toISOString() });
      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("3: admits strike at ttc 24h01m", () => {
      const r = evalStrike({ endDate: new Date(NOW_MS + (24 * 3600 + 60) * 1000).toISOString() });
      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("4: blocks strike midPrice $0.04, ttc 5d → strike_yes_tail_short_runway", () => {
      const r = evalStrike({ midPrice: 0.04, endDate: futureEndDate(120) });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("strike_yes_tail_short_runway");
    });

    it("5: admits strike midPrice $0.04, ttc 8d (>168h runway)", () => {
      const r = evalStrike({ midPrice: 0.04, endDate: futureEndDate(192) });
      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("6: blocks strike midPrice $0.20, ttc 20h → strike_min_horizon (floor first)", () => {
      const r = evalStrike({ midPrice: 0.2, endDate: futureEndDate(20) });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("strike_min_horizon");
    });

    it("7: admits strike midPrice $0.20, ttc 2d", () => {
      const r = evalStrike({ midPrice: 0.2, endDate: futureEndDate(48) });
      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("8: blocks strike midPrice $0.05 exactly, ttc 5d (≤ boundary)", () => {
      const r = evalStrike({ midPrice: 0.05, endDate: futureEndDate(120) });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("strike_yes_tail_short_runway");
    });

    it("9: admits strike midPrice null, ttc 5d (Yes-tail fail-open)", () => {
      const r = evalStrike({ midPrice: null, endDate: futureEndDate(120) });
      // midPrice null → hard filter would reject mid_price_too_high, but the
      // point is the Yes-tail guard does NOT fire; assert it is not the reason.
      expect(r.rejectReason).not.toBe("strike_yes_tail_short_runway");
      expect(r.rejectReason).not.toBe("strike_min_horizon");
    });

    it("10: admits non-strike regardless of params", () => {
      const r = evaluatePreEntry(
        EMPTY_ENGINE,
        { ...VALID_PRE_ENTRY, midPrice: 0.02, endDate: futureEndDate(1) },
        undefined,
        NOW_MS,
      );
      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("11: fails open when strike endDate is null", () => {
      const r = evalStrike({ endDate: null });
      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("12: fails open when strike endDate is unparseable", () => {
      const r = evalStrike({ endDate: "not-an-iso-date" });
      expect(r.finalStatus).toBe("INCLUDE");
    });

    it("uses effective resolution for strike runway instead of nominal endDate", () => {
      const r = evalStrike({
        endDate: futureEndDate(48),
        effectiveResolutionAt: futureEndDate(10),
      });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("strike_min_horizon");
      expect(r.horizonHours).toBeCloseTo(10);
    });

    it("fails closed when a strike market needs effective resolution but calendar is missing", () => {
      const r = evalStrike({
        endDate: futureEndDate(48),
        effectiveResolutionCalendarMissing: true,
      });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("effective_resolution_calendar_missing");
    });

    it("13: crypto strike, ttc 10h → blocked with strikePattern set", () => {
      const r = evalStrike({ endDate: futureEndDate(10) });
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("strike_min_horizon");
      expect(r.strikePattern).toBe("between");
      expect(r.horizonHours).toBeCloseTo(10);
    });

    it("14: non-crypto (weather) strike, ttc 10h → blocked, strikePattern undefined", () => {
      const r = evaluatePreEntry(
        EMPTY_ENGINE,
        {
          ...VALID_PRE_ENTRY,
          slug: WEATHER_STRIKE,
          eventSlug: WEATHER_STRIKE,
          endDate: futureEndDate(10),
        },
        undefined,
        NOW_MS,
      );
      expect(r.finalStatus).toBe("EXCLUDE");
      expect(r.rejectReason).toBe("strike_min_horizon");
      expect(r.strikePattern).toBeUndefined();
    });

    it("exposes D1 thresholds as constants for callers", () => {
      expect(STRIKE_MIN_HORIZON_HOURS).toBe(24);
      expect(STRIKE_YES_TAIL_MAX_PRICE).toBe(0.05);
      expect(STRIKE_YES_TAIL_MIN_RUNWAY_HOURS).toBe(168);
    });

    it("evaluateStrikeEntryFilter short-circuits to allow on non-strike slugs", () => {
      const r = evaluateStrikeEntryFilter(
        { slug: "fed-rate-cut-yes", endDate: futureEndDate(1), midPrice: 0.02 },
        NOW_MS,
      );
      expect(r).toEqual({ blocked: false, reason: null, horizonHours: null });
    });

    it("matchesStrikePattern detects all three crypto slug shapes", () => {
      expect(matchesStrikePattern(CRYPTO_STRIKE)).toBe("between");
      expect(
        matchesStrikePattern("will-the-price-of-bitcoin-be-greater-than-84000-on-may-13"),
      ).toBe("greater_or_less_than");
      expect(matchesStrikePattern("will-the-price-of-bitcoin-be-less-than-84000-on-may-13")).toBe(
        "greater_or_less_than",
      );
      expect(matchesStrikePattern("ethereum-above-2295-on-april-27-2026-7am-et")).toBe("above");
      expect(matchesStrikePattern("bitcoin-above-66k-on-march-1")).toBe("above");
      expect(matchesStrikePattern("fed-rate-cut-yes")).toBeNull();
      expect(matchesStrikePattern(WEATHER_STRIKE)).toBeNull();
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
    expect(r.rejectReason).toBe("liquidity_too_low");
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

  // docs/plans/2026-07-17-gate-isalive-plankton-whitelist.md — GATE-whitelist override.
  describe("gateWhitelistOverride", () => {
    // Thin-book GATE market: stale metadata false, but a live bestBid is present.
    const STALE_METADATA: HealthInput = {
      acceptingOrders: false,
      enableOrderBook: false,
      bestBid: 0.05,
      bestAsk: 0.06,
    };

    it("drops accepting/orderbook reasons when override + bestBid present", () => {
      expect(isAlive(STALE_METADATA, { gateWhitelistOverride: true })).toEqual({
        healthy: true,
        reasons: [],
      });
    });

    it("default (no opts) still blocks the same market", () => {
      expect(isAlive(STALE_METADATA)).toEqual({
        healthy: false,
        reasons: ["not_accepting_orders", "order_book_disabled"],
      });
    });

    it("NEVER drops no_bid — an empty book still blocks even with override", () => {
      const r = isAlive({ ...STALE_METADATA, bestBid: null }, { gateWhitelistOverride: true });
      expect(r.healthy).toBe(false);
      expect(r.reasons).toContain("no_bid");
    });

    it("override=false is byte-identical to the default", () => {
      expect(isAlive(STALE_METADATA, { gateWhitelistOverride: false })).toEqual(
        isAlive(STALE_METADATA),
      );
    });
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

  // docs/plans/2026-07-17-gate-isalive-plankton-whitelist.md — GATE-whitelist override.
  it("GATE override relaxes market_not_alive (stale accepting/orderbook) when bestBid present", () => {
    const stale = { ...HEALTHY_LIVE, acceptingOrders: false, enableOrderBook: false };
    expect(canPlaceBuyOrder(stale, NOW).allowed).toBe(false);
    expect(canPlaceBuyOrder(stale, NOW).reasons).toContain("market_not_alive");
    expect(canPlaceBuyOrder(stale, NOW, { gateWhitelistOverride: true })).toEqual({
      allowed: true,
      reasons: [],
    });
  });

  it("GATE override does NOT relax no_bid or lifecycle blockers", () => {
    const noBid = { ...HEALTHY_LIVE, acceptingOrders: false, bestBid: null };
    expect(canPlaceBuyOrder(noBid, NOW, { gateWhitelistOverride: true }).allowed).toBe(false);
    const inactive = { ...HEALTHY_LIVE, active: false, acceptingOrders: false };
    const r = canPlaceBuyOrder(inactive, NOW, { gateWhitelistOverride: true });
    expect(r.allowed).toBe(false);
    expect(r.reasons).toContain("market_inactive");
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

  it("uses effective resolution when checking whether market has ended", () => {
    const r = canPlaceBuyOrder(
      {
        ...HEALTHY_LIVE,
        endDate: "2026-04-26T12:00:00Z",
        effectiveResolutionAt: "2026-04-25T11:00:00Z",
      },
      NOW,
    );
    expect(r.reasons).toContain("market_ended");
  });

  it("blocks US equity BUY when effective runway is below the configured floor", () => {
    const r = canPlaceBuyOrder(
      {
        ...HEALTHY_LIVE,
        effectiveResolutionAt: "2026-04-26T11:00:00Z",
        effectiveResolutionAppliesToBuy: true,
        effectiveResolutionMinRunwayHours: 24,
      },
      NOW,
    );
    expect(r.reasons).toContain("effective_resolution_short_runway");
  });

  it("does not apply the effective runway floor to nominal/non-equity markets", () => {
    const r = canPlaceBuyOrder(
      {
        ...HEALTHY_LIVE,
        effectiveResolutionAt: "2026-04-26T11:00:00Z",
        effectiveResolutionAppliesToBuy: false,
        effectiveResolutionMinRunwayHours: 24,
      },
      NOW,
    );
    expect(r.allowed).toBe(true);
  });

  it("fails closed when US equity calendar coverage is missing", () => {
    const r = canPlaceBuyOrder(
      {
        ...HEALTHY_LIVE,
        effectiveResolutionCalendarMissing: true,
      },
      NOW,
    );
    expect(r.reasons).toContain("effective_resolution_calendar_missing");
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
