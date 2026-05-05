import { describe, it, expect } from "vitest";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  SelectionRuleEngine,
  createTokenId,
  type NormalizedMarket,
  type TokenId,
  type SelectionRule,
} from "@plankton/domain";
import { MarketSelectionCache } from "../market-selection-cache.js";
import type { RefreshableSelectionRuleEngine } from "../../../selection-rule-engine-factory.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Build a lightweight RefreshableSelectionRuleEngine stub around a real engine. */
function makeEngine(rules: SelectionRule[]): RefreshableSelectionRuleEngine {
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

/** The seeded 06-spec prefix rules — bitcoin-, elon-musk-, ethereum- */
const SEEDED_ENGINE = makeEngine([
  makeRule({ ruleId: "r-btc", ruleType: "include_prefix", pattern: "bitcoin-" }),
  makeRule({ ruleId: "r-elon", ruleType: "include_prefix", pattern: "elon-musk-" }),
  makeRule({ ruleId: "r-eth", ruleType: "include_prefix", pattern: "ethereum-" }),
]);

/** Engine with no rules — relies on STEP 2 fallback (eventMarketCount===1 ⇒ INCLUDE). */
const EMPTY_ENGINE = makeEngine([]);

function makeMarket(overrides: Partial<NormalizedMarket> & { tokenId: TokenId }): NormalizedMarket {
  return {
    conditionId: "cond-1",
    slug: "test-slug",
    eventSlug: null,
    question: "Q",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.5,
    bestAsk: 0.51,
    midPrice: 0.505,
    spread: 0.01,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...overrides,
  };
}

const TOK_A = createTokenId("tok-a");
const TOK_B = createTokenId("tok-b");

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MarketSelectionCache", () => {
  it("starts empty — no tokens eligible", () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    expect(cache.isEligible(TOK_A)).toBe(false);
    expect(cache.getEligibleTokenIds()).toEqual([]);

    cache.dispose();
  });

  // ── Pre-entry: prefix include rules ──────────────────────────────────────

  it("includes token matching bitcoin- prefix rule", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          slug: "bitcoin-up",
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("includes token matching elon-musk- prefix rule", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-elon",
          eventSlug: "elon-musk-tweet-count",
          slug: "elon-musk-tweets-today",
          eventMarketCount: 2,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("includes token matching ethereum- prefix rule", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-eth",
          eventSlug: "ethereum-merge-date",
          slug: "ethereum-merge-yes",
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("keeps ALL tokens in a matching condition eligible regardless of outcome count", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          slug: "bitcoin-up",
          outcome: "Yes",
          eventMarketCount: 2,
        }),
        makeMarket({
          tokenId: TOK_B,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          slug: "bitcoin-up",
          outcome: "No",
          eventMarketCount: 2,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);
    expect(cache.isEligible(TOK_B)).toBe(true);

    cache.dispose();
  });

  // ── Pre-entry: STEP 2 fallback ────────────────────────────────────────────

  it("includes single-market event via STEP 2 fallback when no rules match", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, EMPTY_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          eventSlug: "us-election-winner",
          slug: "trump-wins",
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    // no_match + eventMarketCount===1 → STEP 2 → INCLUDE
    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("excludes multi-market event via fallback_exclude when no rules match", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, EMPTY_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          eventSlug: "super-bowl-winner",
          slug: "chiefs-win",
          eventMarketCount: 30,
        }),
      ],
      timestamp: Date.now(),
    });

    // no_match + eventMarketCount>1 → fallback_exclude
    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  // ── Pre-entry: exclude rule ───────────────────────────────────────────────

  it("excludes token when an exclude_slug rule matches", async () => {
    const excludeEngine = makeEngine([
      makeRule({ ruleId: "r-btc", ruleType: "include_prefix", pattern: "bitcoin-" }),
      makeRule({ ruleId: "r-ex", ruleType: "exclude_slug", pattern: "bitcoin-spam" }),
    ]);
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, excludeEngine);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          eventSlug: "bitcoin-price",
          slug: "bitcoin-spam",
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  // ── Pre-entry: EXCLUDE when no prefix match ───────────────────────────────

  it("excludes token when eventSlug does not match any prefix rule (multi-market)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-election",
          eventSlug: "us-election-winner",
          slug: "us-election-trump",
          eventMarketCount: 5,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  // ── Tradable lifecycle ──────────────────────────────────────────────────
  // Pre-entry eligibility gates on `tradable`, not `active`.

  it("removes non-tradable token from eligible set", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          slug: "bitcoin-up",
          eventMarketCount: 1,
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
          slug: "bitcoin-up",
          active: false,
          tradable: false,
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("preserved-for-lifecycle market (active=true, tradable=false) is not eligible for new entries", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-price-above-100k",
          slug: "bitcoin-up",
          active: true,
          tradable: false,
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("re-activates previously non-tradable token when prefix still matches", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-x",
          slug: "bitcoin-up",
          active: false,
          tradable: false,
          eventMarketCount: 1,
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
          slug: "bitcoin-up",
          active: true,
          tradable: true,
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  // ── Historical Universe Filter (spec §0 R1, ADR-007) ──────────────────
  //
  // Spec §0 R1: `trade_count > 0 → INCLUDE; Fallback EXCLUDE`. Gamma exposes
  // no `trade_count`; ADR-007 uses lifetime volume (`volumeNum`) as a proxy,
  // surfaced on `NormalizedMarket.volume24h` (legacy field name). The cache
  // blocks on `volume24h === 0` and treats `null` as unknown (not blocking).

  it("excludes zero-lifetime-volume token even when a prefix rule matches (ADR-007)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-fresh",
          eventSlug: "bitcoin-freshly-listed",
          slug: "bitcoin-fresh-yes",
          volume24h: 0,
          liquidity: 0,
          lastTradePrice: null,
          lastTradeAt: null,
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);

    cache.dispose();
  });

  it("includes non-zero-lifetime-volume single-market event via STEP 2 fallback (ADR-007)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, EMPTY_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-lifetime",
          eventSlug: "us-election-winner",
          slug: "trump-wins",
          volume24h: 100,
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(true);

    cache.dispose();
  });

  it("includes token when lifetime volume is unknown (null) — unknown ≠ zero (ADR-007)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, EMPTY_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-clob",
          eventSlug: "us-election-winner",
          slug: "trump-wins",
          volume24h: null,
          eventMarketCount: 1,
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
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-x",
          slug: "bitcoin-up",
          eventMarketCount: 1,
        }),
        makeMarket({
          tokenId: TOK_B,
          conditionId: "cond-eth",
          eventSlug: "ethereum-x",
          slug: "ethereum-up",
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    const ids = cache.getEligibleTokenIds().map(String).sort();
    expect(ids).toEqual(["tok-a", "tok-b"]);

    cache.dispose();
  });

  // ── ADR-018 §D2 — Universe-filter funnel telemetry ───────────────────────
  //
  // Counters are cumulative since process start (monotonic), updated per
  // processed `NormalizedMarketUpdated` event (not per unique token). Two
  // partitions:
  //   volume:    seen == volumeZeroDropped + volumeNullEvaluated + volumePositiveEvaluated
  //   selection: volumeNullEvaluated + volumePositiveEvaluated
  //              == selectionRuleAdmitted + selectionRuleRejected

  it("getUniverseFilterSnapshot — initial snapshot is all zeros", () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    expect(cache.getUniverseFilterSnapshot()).toEqual({
      seen: 0,
      volumeZeroDropped: 0,
      volumeNullEvaluated: 0,
      volumePositiveEvaluated: 0,
      selectionRuleAdmitted: 0,
      selectionRuleRejected: 0,
    });

    cache.dispose();
  });

  it("getUniverseFilterSnapshot — non-tradable events do not increment seen", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          tradable: false,
          eventSlug: "bitcoin-x",
          slug: "bitcoin-up",
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.getUniverseFilterSnapshot().seen).toBe(0);
    cache.dispose();
  });

  it("getUniverseFilterSnapshot — volume=0 increments volumeZeroDropped, not selection counters", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          eventSlug: "bitcoin-fresh",
          slug: "bitcoin-fresh-yes",
          volume24h: 0,
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    const snap = cache.getUniverseFilterSnapshot();
    expect(snap.seen).toBe(1);
    expect(snap.volumeZeroDropped).toBe(1);
    expect(snap.volumeNullEvaluated).toBe(0);
    expect(snap.volumePositiveEvaluated).toBe(0);
    expect(snap.selectionRuleAdmitted).toBe(0);
    expect(snap.selectionRuleRejected).toBe(0);

    cache.dispose();
  });

  it("getUniverseFilterSnapshot — volume=null + INCLUDE rule → volumeNullEvaluated + selectionRuleAdmitted", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, EMPTY_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          eventSlug: "us-election",
          slug: "trump-wins",
          volume24h: null,
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    const snap = cache.getUniverseFilterSnapshot();
    expect(snap.seen).toBe(1);
    expect(snap.volumeNullEvaluated).toBe(1);
    expect(snap.volumePositiveEvaluated).toBe(0);
    expect(snap.selectionRuleAdmitted).toBe(1);
    expect(snap.selectionRuleRejected).toBe(0);

    cache.dispose();
  });

  it("getUniverseFilterSnapshot — volume>0 + INCLUDE rule → volumePositiveEvaluated + selectionRuleAdmitted", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          eventSlug: "bitcoin-rally",
          slug: "bitcoin-up",
          volume24h: 100,
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    const snap = cache.getUniverseFilterSnapshot();
    expect(snap.seen).toBe(1);
    expect(snap.volumePositiveEvaluated).toBe(1);
    expect(snap.volumeNullEvaluated).toBe(0);
    expect(snap.selectionRuleAdmitted).toBe(1);
    expect(snap.selectionRuleRejected).toBe(0);

    cache.dispose();
  });

  it("getUniverseFilterSnapshot — volume>0 + EXCLUDE rule → volumePositiveEvaluated + selectionRuleRejected", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    // No matching prefix rule → fallback EXCLUDE for multi-market events
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          eventSlug: "random-event",
          slug: "no-match-yes",
          volume24h: 100,
          eventMarketCount: 5,
        }),
      ],
      timestamp: Date.now(),
    });

    const snap = cache.getUniverseFilterSnapshot();
    expect(snap.seen).toBe(1);
    expect(snap.volumePositiveEvaluated).toBe(1);
    expect(snap.selectionRuleRejected).toBe(1);
    expect(snap.selectionRuleAdmitted).toBe(0);

    cache.dispose();
  });

  it("getUniverseFilterSnapshot — invariants hold across mixed sequence", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        // volume=0 → dropped
        makeMarket({
          tokenId: createTokenId("t-zero"),
          eventSlug: "bitcoin-fresh",
          slug: "bitcoin-fresh",
          volume24h: 0,
          eventMarketCount: 1,
        }),
        // volume=null + INCLUDE
        makeMarket({
          tokenId: createTokenId("t-null"),
          eventSlug: "bitcoin-x",
          slug: "bitcoin-up",
          volume24h: null,
          eventMarketCount: 1,
        }),
        // volume=100 + INCLUDE
        makeMarket({
          tokenId: createTokenId("t-pos-in"),
          eventSlug: "ethereum-x",
          slug: "ethereum-up",
          volume24h: 100,
          eventMarketCount: 1,
        }),
        // volume=100 + EXCLUDE (no matching rule, multi-market event)
        makeMarket({
          tokenId: createTokenId("t-pos-out"),
          eventSlug: "random-x",
          slug: "random-y",
          volume24h: 100,
          eventMarketCount: 5,
        }),
      ],
      timestamp: Date.now(),
    });

    const s = cache.getUniverseFilterSnapshot();
    // Volume-partition invariant: seen == sum of three volume buckets
    expect(s.seen).toBe(s.volumeZeroDropped + s.volumeNullEvaluated + s.volumePositiveEvaluated);
    // Selection-partition invariant: evaluated == admit + reject
    expect(s.volumeNullEvaluated + s.volumePositiveEvaluated).toBe(
      s.selectionRuleAdmitted + s.selectionRuleRejected,
    );
    // Concrete values
    expect(s).toEqual({
      seen: 4,
      volumeZeroDropped: 1,
      volumeNullEvaluated: 1,
      volumePositiveEvaluated: 2,
      selectionRuleAdmitted: 2,
      selectionRuleRejected: 1,
    });

    cache.dispose();
  });

  it("getUniverseFilterSnapshot — counters are cumulative across events (per-event, not per-token)", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();

    // Same token, three updates: null → 0 → 100. Counter must reflect three
    // increments to seen, not deduplicate to one unique token.
    for (const v of [null, 0, 100] as const) {
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          makeMarket({
            tokenId: TOK_A,
            eventSlug: "bitcoin-x",
            slug: "bitcoin-up",
            volume24h: v,
            eventMarketCount: 1,
          }),
        ],
        timestamp: Date.now(),
      });
    }

    const s = cache.getUniverseFilterSnapshot();
    expect(s.seen).toBe(3);
    expect(s.volumeZeroDropped).toBe(1);
    expect(s.volumeNullEvaluated).toBe(1);
    expect(s.volumePositiveEvaluated).toBe(1);

    cache.dispose();
  });

  // ── Dispose ───────────────────────────────────────────────────────────────

  it("dispose unsubscribes — further events are ignored", async () => {
    const bus = new InProcessEventBus();
    const cache = new MarketSelectionCache(bus, SEEDED_ENGINE);
    cache.subscribe();
    cache.dispose();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeMarket({
          tokenId: TOK_A,
          conditionId: "cond-btc",
          eventSlug: "bitcoin-x",
          slug: "bitcoin-up",
          eventMarketCount: 1,
        }),
      ],
      timestamp: Date.now(),
    });

    expect(cache.isEligible(TOK_A)).toBe(false);
  });
});
