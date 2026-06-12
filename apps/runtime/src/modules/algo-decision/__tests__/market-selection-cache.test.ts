import { describe, it, expect, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  SelectionRuleEngine,
  createTokenId,
  type NormalizedMarket,
  type SelectionRule,
  type TokenId,
} from "@krabs/domain";
import { MarketSelectionCache } from "../market-selection-cache.js";
import type { RefreshableSelectionRuleEngine } from "../../../selection-rule-engine-factory.js";

function makeRule(
  partial: Partial<SelectionRule> & Pick<SelectionRule, "ruleId" | "ruleType" | "pattern">,
): SelectionRule {
  return {
    profileId: "simulation",
    enabled: true,
    note: null,
    createdAt: "2026-04-18T00:00:00Z",
    updatedAt: "2026-04-18T00:00:00Z",
    ...partial,
  };
}

function makeEngine(rules: SelectionRule[] = []): RefreshableSelectionRuleEngine {
  const engine = new SelectionRuleEngine(rules);
  return {
    refreshIfStale: () => {},
    resolve: (eventSlug: string | null, marketSlug: string) =>
      engine.resolve(eventSlug, marketSlug),
    get current() {
      return engine;
    },
  } as unknown as RefreshableSelectionRuleEngine;
}

const EMPTY_ENGINE = makeEngine();
const LEGACY_PREFIX_ENGINE = makeEngine([
  makeRule({ ruleId: "r-btc", ruleType: "include_prefix", pattern: "bitcoin-" }),
  makeRule({ ruleId: "r-elon", ruleType: "include_prefix", pattern: "elon-musk-" }),
  makeRule({ ruleId: "r-eth", ruleType: "include_prefix", pattern: "ethereum-" }),
]);

const TOK_A = createTokenId("tok-a");
const TOK_B = createTokenId("tok-b");

function shortLifetimePolicy() {
  return {
    maxMidPrice: 0.5,
    minLiquidity: 100,
    shortLifetime: { enabled: true, thresholdHours: 1 },
  };
}

function makeMarket(overrides: Partial<NormalizedMarket> & { tokenId: TokenId }): NormalizedMarket {
  return {
    conditionId: "cond-1",
    slug: "fed-rate-cut-yes",
    eventSlug: "fed-rate-cut-in-2026",
    question: "Will the Fed cut rates in 2026?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.31,
    bestAsk: 0.33,
    midPrice: 0.32,
    spread: 0.02,
    liquidity: 250,
    volume24h: 0,
    snapshotTs: Date.now(),
    eventMarketCount: 4,
    ...overrides,
  };
}

function makeCache(engine: RefreshableSelectionRuleEngine = EMPTY_ENGINE): {
  bus: InProcessEventBus;
  cache: MarketSelectionCache;
} {
  const bus = new InProcessEventBus();
  const cache = new MarketSelectionCache(bus, engine);
  cache.subscribe();
  return { bus, cache };
}

async function updateMarket(bus: InProcessEventBus, market: NormalizedMarket): Promise<void> {
  await bus.publish("NormalizedMarketUpdated", {
    markets: [market],
    timestamp: Date.now(),
  });
}

describe("MarketSelectionCache", () => {
  it("starts empty", () => {
    const { cache } = makeCache();

    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.getEligibleTokenIds()).toEqual([]);

    cache.dispose();
  });

  it("admits a token when v5.11 hard filters pass, without prefix rules", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(bus, makeMarket({ tokenId: TOK_A }));

    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.getUniverseFilterSnapshot()).toMatchObject({
      seen: 1,
      volumeZeroDropped: 0,
      volumePositiveEvaluated: 1,
      selectionRuleAdmitted: 1,
      selectionRuleRejected: 0,
    });

    cache.dispose();
  });

  it("reads market selection policy once per normalized market batch", async () => {
    const bus = new InProcessEventBus();
    const policy = vi.fn().mockReturnValue({
      maxMidPrice: 0.5,
      minLiquidity: 100,
      zeroCoverageCategories: [],
      blockDailyCryptoStrikes: false,
    });
    const cache = new MarketSelectionCache(bus, EMPTY_ENGINE, policy);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_A }), makeMarket({ tokenId: TOK_B })],
      timestamp: Date.now(),
    });

    expect(policy).toHaveBeenCalledTimes(1);
    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(true);
    cache.dispose();
  });

  it("ignores legacy include_prefix rules when hard filters fail", async () => {
    const { bus, cache } = makeCache(LEGACY_PREFIX_ENGINE);

    await updateMarket(
      bus,
      makeMarket({
        tokenId: TOK_A,
        eventSlug: "bitcoin-price-above-100k",
        slug: "bitcoin-up",
        midPrice: 0.51,
      }),
    );

    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.getUniverseFilterSnapshot()).toMatchObject({
      selectionRuleAdmitted: 0,
      selectionRuleRejected: 1,
    });

    cache.dispose();
  });

  it("does not use single-market fallback when hard filters fail", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(
      bus,
      makeMarket({
        tokenId: TOK_A,
        eventMarketCount: 1,
        liquidity: null,
      }),
    );

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("excludes mid_price >= 0.50", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(bus, makeMarket({ tokenId: TOK_A, midPrice: 0.5 }));

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("excludes liquidity below the R11 floor", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(bus, makeMarket({ tokenId: TOK_A, liquidity: 99.99 }));

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("excludes R9 zero-coverage category markets", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(
      bus,
      makeMarket({
        tokenId: TOK_A,
        eventSlug: "btc-up-or-down-5m",
        slug: "btc-up-or-down-5m",
        question: "Bitcoin up or down in the next 5m?",
      }),
    );

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("excludes short-horizon crypto strike markets in the live cache path", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(
      bus,
      makeMarket({
        tokenId: TOK_A,
        eventSlug: "will-the-price-of-bitcoin-be-between-84000-85000-on-may-13",
        slug: "will-the-price-of-bitcoin-be-between-84000-85000-on-may-13",
        question: "Will the price of Bitcoin be between $84,000 and $85,000 on May 13?",
        endDate: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      }),
    );

    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.getUniverseFilterSnapshot()).toMatchObject({
      selectionRuleAdmitted: 0,
      selectionRuleRejected: 1,
      selectionRejectReasons: {
        rejected_strike_min_horizon: 1,
      },
    });

    cache.dispose();
  });

  it("records rejected_buy_guard_short_lifetime for compact crypto_updown markets", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, EMPTY_ENGINE, shortLifetimePolicy);
    cache.subscribe();

    await updateMarket(
      bus,
      makeMarket({
        tokenId: TOK_A,
        eventSlug: "eth-updown-15m-1776889800",
        slug: "eth-updown-15m-1776889800",
        question: "ETH Up or Down - 15m",
        endDate: new Date(Date.now() + 30 * 60_000).toISOString(),
      }),
    );

    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.getUniverseFilterSnapshot()).toMatchObject({
      selectionRuleAdmitted: 0,
      selectionRuleRejected: 1,
      selectionRejectReasons: {
        rejected_buy_guard_short_lifetime: 1,
      },
    });

    cache.dispose();
  });

  it("admits non-strike markets with a distant endDate in the live cache path", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(
      bus,
      makeMarket({
        tokenId: TOK_A,
        endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    );

    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.getUniverseFilterSnapshot()).toMatchObject({
      selectionRuleAdmitted: 1,
      selectionRuleRejected: 0,
    });

    cache.dispose();
  });

  it("removes non-tradable tokens from the eligible set", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(bus, makeMarket({ tokenId: TOK_A }));
    expect(cache.isEligible(TOK_A)).toBe(true);

    await updateMarket(bus, makeMarket({ tokenId: TOK_A, tradable: false }));
    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("does not block on zero lifetime volume anymore", async () => {
    const { bus, cache } = makeCache();

    await updateMarket(bus, makeMarket({ tokenId: TOK_A, volume24h: 0, liquidity: 250 }));

    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.getUniverseFilterSnapshot()).toMatchObject({
      volumeZeroDropped: 0,
      volumePositiveEvaluated: 1,
      selectionRuleAdmitted: 1,
    });

    cache.dispose();
  });

  it("tracks currently eligible token ids and evicts removed tracked tokens", async () => {
    const { bus, cache } = makeCache();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_A }), makeMarket({ tokenId: TOK_B })],
      timestamp: Date.now(),
    });

    expect(cache.getEligibleTokenIds().map(String).sort()).toEqual(["tok-a", "tok-b"]);

    await bus.publish("TrackedMarketsChanged", {
      addedTokenIds: [],
      removedTokenIds: [TOK_A],
      activeTokenIds: [TOK_B],
      timestamp: Date.now(),
    });

    expect(cache.getEligibleTokenIds().map(String)).toEqual(["tok-b"]);

    cache.dispose();
  });

  it("funnel invariants hold across admitted and rejected events", async () => {
    const { bus, cache } = makeCache();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenId: createTokenId("t-in"), volume24h: null }),
        makeMarket({ tokenId: createTokenId("t-out"), midPrice: 0.5, volume24h: 100 }),
        makeMarket({ tokenId: createTokenId("t-non-tradable"), tradable: false }),
      ],
      timestamp: Date.now(),
    });

    const s = cache.getUniverseFilterSnapshot();
    expect(s.seen).toBe(2);
    expect(s.seen).toBe(s.volumeZeroDropped + s.volumeNullEvaluated + s.volumePositiveEvaluated);
    expect(s.volumeNullEvaluated + s.volumePositiveEvaluated).toBe(
      s.selectionRuleAdmitted + s.selectionRuleRejected,
    );
    expect(s).toMatchObject({
      volumeZeroDropped: 0,
      volumeNullEvaluated: 1,
      volumePositiveEvaluated: 1,
      selectionRuleAdmitted: 1,
      selectionRuleRejected: 1,
    });

    cache.dispose();
  });

  it("records granular selection rejection reasons", async () => {
    const { bus, cache } = makeCache();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenId: createTokenId("t-no-mid"), midPrice: null }),
        makeMarket({ tokenId: createTokenId("t-no-liq"), liquidity: null }),
        makeMarket({
          tokenId: createTokenId("t-stale"),
          featuresCapturedTs: Date.now() - 5 * 60 * 60 * 1000,
          liquidity: 50,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.getUniverseFilterSnapshot().selectionRejectReasons).toMatchObject({
      rejected_no_midprice: 1,
      rejected_missing_feature_liquidity: 1,
      rejected_stale_snapshot: 1,
    });

    cache.dispose();
  });

  it("dispose unsubscribes", async () => {
    const { bus, cache } = makeCache();
    cache.dispose();

    await updateMarket(bus, makeMarket({ tokenId: TOK_A }));

    expect(cache.isEligible(TOK_A)).toBe(false);
  });

  // Track B §5.4 / §9.2 — durable strike-reject persistence into risk_events.
  describe("strike-reject persistence (Track B §5.4)", () => {
    function makeSinkCache(): {
      bus: InProcessEventBus;
      cache: MarketSelectionCache;
      insert: ReturnType<typeof vi.fn>;
    } {
      const bus = new InProcessEventBus();
      const insert = vi.fn();
      const cache = new MarketSelectionCache(bus, EMPTY_ENGINE, undefined, { insert });
      cache.subscribe();
      return { bus, cache, insert };
    }

    const STRIKE_SLUG = "will-the-price-of-bitcoin-be-between-84000-85000-on-may-13";

    it("persists a strike_min_horizon reject once and dedups repeats", async () => {
      const { bus, cache, insert } = makeSinkCache();
      const strikeMarket = makeMarket({
        tokenId: TOK_A,
        eventSlug: STRIKE_SLUG,
        slug: STRIKE_SLUG,
        question: "Will BTC be between $84k and $85k on May 13?",
        endDate: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      });

      await updateMarket(bus, strikeMarket);

      expect(cache.isEligible(TOK_A)).toBe(false);
      expect(cache.getUniverseFilterSnapshot().selectionRejectReasons).toMatchObject({
        rejected_strike_min_horizon: 1,
      });
      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledWith({
        eventType: "selection_reject",
        payload: expect.objectContaining({
          reason: "strike_min_horizon",
          tokenId: "tok-a",
          slug: STRIKE_SLUG,
          regime: "strike",
        }),
      });

      // A chatty re-emit of the same token must not write a second row.
      await updateMarket(bus, strikeMarket);
      expect(insert).toHaveBeenCalledTimes(1);

      cache.dispose();
    });

    it("persists a strike_yes_tail_short_runway reject", async () => {
      const { bus, cache, insert } = makeSinkCache();

      await updateMarket(
        bus,
        makeMarket({
          tokenId: TOK_A,
          eventSlug: STRIKE_SLUG,
          slug: STRIKE_SLUG,
          question: "Will BTC be between $84k and $85k on May 13?",
          // ttc in [24h, 168h) and YES tail price ≤ $0.05 → short-runway reject.
          endDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          midPrice: 0.04,
        }),
      );

      expect(cache.isEligible(TOK_A)).toBe(false);
      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert.mock.calls[0]?.[0].payload).toMatchObject({
        reason: "strike_yes_tail_short_runway",
        regime: "strike",
      });

      cache.dispose();
    });

    it("does not persist non-strike rejects", async () => {
      const { bus, cache, insert } = makeSinkCache();

      await updateMarket(bus, makeMarket({ tokenId: TOK_A, midPrice: 0.6 }));

      expect(cache.isEligible(TOK_A)).toBe(false);
      expect(insert).not.toHaveBeenCalled();

      cache.dispose();
    });

    it("re-persists after the token leaves and re-enters the tracked universe", async () => {
      const { bus, cache, insert } = makeSinkCache();
      const strikeMarket = makeMarket({
        tokenId: TOK_A,
        eventSlug: STRIKE_SLUG,
        slug: STRIKE_SLUG,
        question: "Will BTC be between $84k and $85k on May 13?",
        endDate: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      });

      await updateMarket(bus, strikeMarket);
      expect(insert).toHaveBeenCalledTimes(1);

      await bus.publish("TrackedMarketsChanged", {
        addedTokenIds: [],
        removedTokenIds: [TOK_A],
        activeTokenIds: [],
        timestamp: Date.now(),
      });

      await updateMarket(bus, strikeMarket);
      expect(insert).toHaveBeenCalledTimes(2);

      cache.dispose();
    });
  });
});
