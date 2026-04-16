import { describe, it, expect } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import { createTokenId, type NormalizedMarket, type TokenId } from "@plankton/domain";
import { MarketSelectionCache } from "../market-selection-cache.js";

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
const TOK_C = createTokenId("tok-c");

describe("MarketSelectionCache", () => {
  it("starts empty — no tokens eligible", () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.getEligibleTokenIds()).toEqual([]);

    cache.dispose();
  });

  // ── Pre-entry: slug prefix ──────────────────────────────────────────────

  it("marks token eligible when eventSlug matches prefix", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          outcome: "Yes",
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("marks token eligible when eventSlug matches elon-musk- prefix", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-elon",
          eventSlug: "elon-musk-foo-2025",
          outcome: "Yes",
        }),
        makeMarket({
          tokenId: TOK_B,
          conditionId: "cond-elon",
          eventSlug: "elon-musk-foo-2025",
          outcome: "No",
        }),
      ],
      timestamp: Date.now(),
    });

    // distinct_outcomes=2 but slug prefix matches → both eligible
    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(true);

    cache.dispose();
  });

  it("marks token eligible when eventSlug matches ethereum- prefix", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-eth",
          eventSlug: "ethereum-price-2025",
          outcome: "Yes",
        }),
        makeMarket({
          tokenId: TOK_B,
          conditionId: "cond-eth",
          eventSlug: "ethereum-price-2025",
          outcome: "No",
        }),
      ],
      timestamp: Date.now(),
    });

    // distinct_outcomes=2 but slug prefix matches → both eligible
    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(true);

    cache.dispose();
  });

  it("counts only active tokens when computing distinct outcomes", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    // TOK_A active "Yes", TOK_B inactive "Yes" — same label, only active counted
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenId: TOK_A, conditionId: "cond-x", outcome: "Yes", active: true }),
        makeMarket({ tokenId: TOK_B, conditionId: "cond-x", outcome: "Yes", active: false }),
      ],
      timestamp: Date.now(),
    });

    // distinctOutcomes = 1 (only active "Yes") → TOK_A eligible
    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(false); // inactive → never eligible

    cache.dispose();
  });

  // ── Pre-entry: distinct_outcomes = 1 ───────────────────────────────────

  it("marks token eligible when it is the only outcome in its condition", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-single",
          outcome: "Yes",
        }),
      ],
      timestamp: Date.now(),
    });

    // distinct_outcomes = 1 ("yes") → eligible
    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("removes eligibility when a second distinct outcome appears", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    // First token in condition → distinct_outcomes = 1
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-1",
          outcome: "Yes",
        }),
      ],
      timestamp: Date.now(),
    });
    expect(cache.isEligible(TOK_A)).toBe(true);

    // Second token with different outcome → distinct_outcomes = 2
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_B,
          conditionId: "cond-1",
          outcome: "No",
        }),
      ],
      timestamp: Date.now(),
    });

    // Both tokens re-evaluated: distinct_outcomes=2, no slug → excluded
    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.isEligible(TOK_B)).toBe(false);

    cache.dispose();
  });

  // ── Condition-wide recalculation ───────────────────────────────────────

  it("re-evaluates ALL tokens in a condition when distinctOutcomes changes", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    // TOK_A: outcome "Yes", eligible (distinct=1)
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_A, conditionId: "cond-1", outcome: "Yes" })],
      timestamp: Date.now(),
    });
    expect(cache.isEligible(TOK_A)).toBe(true);

    // TOK_B: outcome "No" → distinct=2, both lose eligibility
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_B, conditionId: "cond-1", outcome: "No" })],
      timestamp: Date.now(),
    });
    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.isEligible(TOK_B)).toBe(false);

    // TOK_B goes inactive → distinct=1 again, TOK_A becomes eligible
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenId: TOK_B, conditionId: "cond-1", outcome: "No", active: false }),
      ],
      timestamp: Date.now(),
    });
    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(false); // inactive → never eligible

    cache.dispose();
  });

  // ── Outcome case normalization ─────────────────────────────────────────

  it("treats 'Yes' and 'YES' as the same outcome", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_A, conditionId: "cond-1", outcome: "Yes" })],
      timestamp: Date.now(),
    });

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_B, conditionId: "cond-1", outcome: "YES" })],
      timestamp: Date.now(),
    });

    // "Yes" and "YES" normalize to "yes" → distinct_outcomes = 1
    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(true);

    cache.dispose();
  });

  // ── Inactive tokens ────────────────────────────────────────────────────

  it("removes inactive token from eligible set", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_A, conditionId: "cond-1", outcome: "Yes" })],
      timestamp: Date.now(),
    });
    expect(cache.isEligible(TOK_A)).toBe(true);

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenId: TOK_A, conditionId: "cond-1", outcome: "Yes", active: false }),
      ],
      timestamp: Date.now(),
    });
    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  // ── Slug prefix + multi-outcome ────────────────────────────────────────

  it("slug prefix keeps token eligible even with multiple outcomes", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

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

    // distinct_outcomes=2 but slug prefix matches → both eligible
    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(true);

    cache.dispose();
  });

  // ── getEligibleTokenIds ────────────────────────────────────────────────

  it("getEligibleTokenIds returns all currently eligible tokens", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenId: TOK_A, conditionId: "cond-1", outcome: "Yes" }),
        makeMarket({ tokenId: TOK_B, conditionId: "cond-2", outcome: "Only" }),
      ],
      timestamp: Date.now(),
    });

    const ids = cache.getEligibleTokenIds().map(String).sort();
    expect(ids).toEqual(["tok-a", "tok-b"]);

    cache.dispose();
  });

  // ── Cross-condition isolation ──────────────────────────────────────────

  it("conditions are isolated — adding outcome to one does not affect another", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    // cond-1: single outcome
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_A, conditionId: "cond-1", outcome: "Yes" })],
      timestamp: Date.now(),
    });

    // cond-2: two outcomes
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({ tokenId: TOK_B, conditionId: "cond-2", outcome: "Yes" }),
        makeMarket({ tokenId: TOK_C, conditionId: "cond-2", outcome: "No" }),
      ],
      timestamp: Date.now(),
    });

    // cond-1 still has distinct=1
    expect(cache.isEligible(TOK_A)).toBe(true);
    // cond-2 has distinct=2
    expect(cache.isEligible(TOK_B)).toBe(false);
    expect(cache.isEligible(TOK_C)).toBe(false);

    cache.dispose();
  });

  // ── Historical Universe Filter (intentionally omitted) ─────────────────
  //
  // Spec §0 defines a Historical Universe Filter: `trade_count > 0 → INCLUDE;
  // Fallback → EXCLUDE`. Per design specs 2026-04-14 and 2026-04-16 the runtime
  // intentionally omits this gate — Gamma does not provide `trade_count` on
  // ClobMarket, and dropping it was a conscious rollout decision. Zero-trade
  // tokens must still reach the pre-entry filter.

  it("admits tokens with no trading activity when pre-entry filter passes (historical filter omitted)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-fresh",
          eventSlug: "bitcoin-freshly-listed",
          outcome: "Yes",
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

  // ── Dispose ────────────────────────────────────────────────────────────────────

  it("dispose unsubscribes — further events are ignored", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus);
    cache.subscribe();
    cache.dispose();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ tokenId: TOK_A, conditionId: "cond-1", outcome: "Yes" })],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);
  });
});
