import { describe, it, expect } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import { createTokenId, type NormalizedMarket, type TokenId } from "@plankton/domain";
import { MarketSelectionCache } from "../market-selection-cache.js";

// Spec v2.2 §0 Live Pre-Entry Filter is slug-prefix only:
//   event_slug prefix in (elon-musk-, bitcoin-, ethereum-) → INCLUDE; else EXCLUDE.
// The prior STEP 2 `distinct_outcomes=1` rule was removed in v2.2.

function makeMarket(overrides: Partial<NormalizedMarket> & { tokenId: TokenId }): NormalizedMarket {
  return {
    conditionId: "cond-1",
    slug: "test-slug",
    eventSlug: null,
    question: "Q",
    outcome: "Yes",
    familyId: null,
    familyKey: null,
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    bestBid: 0.5,
    bestAsk: 0.51,
    midPrice: 0.505,
    spread: 0.01,
    snapshotTs: Date.now(),
    ...overrides,
  };
}

const TOK_A = createTokenId("tok-a");
const TOK_B = createTokenId("tok-b");

describe("MarketSelectionCache", () => {
  it("starts empty — no tokens eligible", () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.getEligibleTokenIds()).toEqual([]);

    cache.dispose();
  });

  // ── Pre-entry: slug prefix (INCLUDE) ─────────────────────────────────────

  it("includes token with bitcoin- prefix", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("includes token with elon-musk- prefix", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-elon",
          eventSlug: "elon-musk-tweet-count",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("includes token with ethereum- prefix", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-eth",
          eventSlug: "ethereum-merge-date",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("keeps ALL tokens in a matching condition eligible regardless of outcome count", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    // Multiple outcomes under one condition — all share the same event_slug,
    // so all are eligible (distinct_outcomes no longer affects selection).
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          outcome: "Yes",
        }),
        makeMarket({
          tokenId: TOK_B,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          outcome: "No",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(true);

    cache.dispose();
  });

  // ── Pre-entry: no matching prefix (EXCLUDE) ──────────────────────────────

  it("excludes token when eventSlug is null (no match)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-unknown",
          eventSlug: null,
          outcome: "Yes",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("excludes token when eventSlug does not match any prefix", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-election",
          eventSlug: "us-election-winner",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("excludes single-outcome market without a matching slug prefix (v2.2 removed distinct_outcomes rule)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-single",
          eventSlug: "generic-single-outcome",
          outcome: "Yes",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  // ── Tradable lifecycle ──────────────────────────────────────────────────
  // Pre-entry eligibility gates on `tradable` (CLOB-entry-eligible), not
  // `active` (which also flags preserved-for-lifecycle markets).

  it("removes non-tradable token from eligible set", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
        }),
      ],
      timestamp: Date.now(),
    });
    expect(cache.isEligible(TOK_A)).toBe(true);

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          active: false,
          tradable: false,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("preserved-for-lifecycle market (active=true, tradable=false) is not eligible for new entries", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          active: true,
          tradable: false,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("re-activates previously non-tradable token when prefix still matches", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-x",
          active: false,
          tradable: false,
        }),
      ],
      timestamp: Date.now(),
    });
    expect(cache.isEligible(TOK_A)).toBe(false);

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-x",
          active: true,
          tradable: true,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  // ── Historical Universe Filter (intentionally omitted) ─────────────────
  //
  // Spec §0 defines `trade_count > 0 → INCLUDE; Fallback EXCLUDE`. Runtime
  // intentionally drops this gate per the market-selection-layer-design doc
  // §1.1 — Gamma does not provide trade_count and the design forbids proxies.

  it("admits zero-activity tokens when pre-entry filter passes (historical filter omitted)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-fresh",
          eventSlug: "bitcoin-freshly-listed",
          volume24h: 0,
          liquidity: 0,
          lastTradePrice: null,
          lastTradeAt: null,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  // ── getEligibleTokenIds ───────────────────────────────────────────────────

  it("getEligibleTokenIds returns currently eligible tokens across conditions", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-x",
        }),
        makeMarket({
          tokenId: TOK_B,
          conditionId: "cond-eth",
          eventSlug: "ethereum-x",
        }),
      ],
      timestamp: Date.now(),
    });

    const ids = cache.getEligibleTokenIds().map(String).sort();
    expect(ids).toEqual(["tok-a", "tok-b"]);

    cache.dispose();
  });

  // ── Dispose ───────────────────────────────────────────────────────────────

  it("dispose unsubscribes — further events are ignored", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();
    cache.dispose();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-x",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);
  });
});
