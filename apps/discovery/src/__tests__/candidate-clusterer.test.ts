import { describe, it, expect } from "vitest";
import {
  normalizeSlug,
  inferRegime,
  inferHorizon,
  inferCadence,
  generateSlugPattern,
  clusterMarkets,
  IncrementalClusterer,
} from "../candidate-clusterer.js";
import type { ClobMarket } from "@plankton/domain";

// ─── normalizeSlug ──────────────────────────────────────────────────────────

describe("normalizeSlug", () => {
  it("strips trailing numbers", () => {
    expect(normalizeSlug("bitcoin-above-95000")).toBe("bitcoin-above");
    expect(normalizeSlug("bitcoin-above-100000")).toBe("bitcoin-above");
  });

  it("strips trailing k-suffixed numbers", () => {
    expect(normalizeSlug("will-bitcoin-hit-50k")).toBe("will-bitcoin-hit");
  });

  it("strips trailing dated segments", () => {
    expect(normalizeSlug("highest-temperature-in-london-march-28")).toBe(
      "highest-temperature-in-london",
    );
    expect(normalizeSlug("highest-temperature-in-london-march-28-2026")).toBe(
      "highest-temperature-in-london",
    );
  });

  it("strips on/by temporal suffixes", () => {
    expect(normalizeSlug("us-next-strikes-iran-on-march-29")).toBe("us-next-strikes-iran");
    expect(normalizeSlug("will-bitcoin-hit-by-march-14-2026")).toBe("will-bitcoin-hit");
    expect(normalizeSlug("something-by-end-of-march")).toBe("something");
  });

  it("strips trailing ISO dates", () => {
    expect(normalizeSlug("market-data-2026-03-28")).toBe("market-data");
  });

  it("strips trailing week references", () => {
    expect(normalizeSlug("nba-totals-week-13")).toBe("nba-totals");
  });

  it("leaves non-variable slugs unchanged", () => {
    expect(normalizeSlug("who-will-be-next-supreme-leader-of-iran")).toBe(
      "who-will-be-next-supreme-leader-of-iran",
    );
  });

  it("lowercases input", () => {
    expect(normalizeSlug("Bitcoin-Above-95000")).toBe("bitcoin-above");
  });
});

// ─── inferRegime ────────────────────────────────────────────────────────────

describe("inferRegime", () => {
  it("detects threshold regime from above/below keywords", () => {
    expect(inferRegime(["bitcoin-above"], ["Will Bitcoin be above 95000?"])).toBe("threshold");
  });

  it("detects directional-updown from up-or-down", () => {
    expect(inferRegime(["eth-up-or-down"], ["ETH up or down?"])).toBe("directional-updown");
  });

  it("detects weather-range from temperature", () => {
    expect(inferRegime(["temperature-london"], ["What will the temperature be?"])).toBe(
      "weather-range",
    );
  });

  it("detects succession regime", () => {
    expect(inferRegime(["supreme-leader-iran"], ["Who will be supreme-leader?"])).toBe(
      "succession",
    );
  });

  it("detects geopolitics from strike keywords", () => {
    expect(inferRegime(["us-strike-iran"], ["Will US strike Iran?"])).toBe("geopolitics");
  });

  it("defaults to generic", () => {
    expect(inferRegime(["random-event"], ["Some random question"])).toBe("generic");
  });
});

// ─── inferHorizon ───────────────────────────────────────────────────────────

describe("inferHorizon", () => {
  it("returns intraday-4h when end dates are within 8 hours", () => {
    const base = new Date("2026-03-28T12:00:00Z").getTime();
    const dates = [new Date(base).toISOString(), new Date(base + 4 * 3600000).toISOString()];
    expect(inferHorizon(dates)).toBe("intraday-4h");
  });

  it("returns daily when spread is within 3 days", () => {
    const base = new Date("2026-03-28T12:00:00Z").getTime();
    const dates = [new Date(base).toISOString(), new Date(base + 48 * 3600000).toISOString()];
    expect(inferHorizon(dates)).toBe("daily");
  });

  it("returns deadline for single future date", () => {
    expect(inferHorizon(["2026-04-15T00:00:00Z"])).toBe("deadline");
  });

  it("returns ad-hoc when no valid end dates", () => {
    expect(inferHorizon([null, null])).toBe("ad-hoc");
  });

  it("returns ad-hoc for wide spread", () => {
    const dates = ["2026-03-01T00:00:00Z", "2026-04-15T00:00:00Z"];
    expect(inferHorizon(dates)).toBe("ad-hoc");
  });
});

// ─── inferCadence ───────────────────────────────────────────────────────────

describe("inferCadence", () => {
  it("maps intraday-4h horizon to intraday-4h cadence", () => {
    expect(inferCadence([], "intraday-4h")).toBe("intraday-4h");
  });

  it("maps daily horizon to daily-dated cadence", () => {
    expect(inferCadence([], "daily")).toBe("daily-dated");
  });

  it("maps deadline horizon to deadline cadence", () => {
    expect(inferCadence([], "deadline")).toBe("deadline");
  });

  it("defaults to ad-hoc", () => {
    expect(inferCadence([], "ad-hoc")).toBe("ad-hoc");
  });
});

// ─── generateSlugPattern ────────────────────────────────────────────────────

describe("generateSlugPattern", () => {
  it("appends -* to normalized slug", () => {
    expect(generateSlugPattern("bitcoin-above")).toBe("bitcoin-above-*");
  });

  it("works for long unchanged slugs", () => {
    expect(generateSlugPattern("who-will-be-next-supreme-leader-of-iran")).toBe(
      "who-will-be-next-supreme-leader-of-iran-*",
    );
  });
});

// ─── clusterMarkets ─────────────────────────────────────────────────────────

function makeClobMarket(
  overrides: Partial<ClobMarket> & { slug: string; conditionId: string },
): ClobMarket {
  return {
    tokens: [],
    question: overrides.slug,
    endDate: "",
    active: true,
    negRisk: false,
    tickSize: 0.01,
    volume24h: null,
    ...overrides,
  };
}

describe("clusterMarkets", () => {
  it("groups markets by normalized slug", () => {
    const markets = [
      makeClobMarket({
        conditionId: "c1",
        slug: "bitcoin-above-95000",
        endDate: "2026-03-28T12:00:00Z",
      }),
      makeClobMarket({
        conditionId: "c2",
        slug: "bitcoin-above-100000",
        endDate: "2026-03-28T14:00:00Z",
      }),
      makeClobMarket({
        conditionId: "c3",
        slug: "bitcoin-above-105000",
        endDate: "2026-03-28T16:00:00Z",
      }),
    ];

    const clusters = clusterMarkets(markets);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.familyKey).toBe("bitcoin-above");
    expect(clusters[0]!.markets).toHaveLength(3);
    expect(clusters[0]!.regime).toBe("threshold");
  });

  it("assigns confidence based on market count", () => {
    const mkts = Array.from({ length: 6 }, (_, i) =>
      makeClobMarket({ conditionId: `c${i}`, slug: `btc-above-${90000 + i * 1000}` }),
    );
    const clusters = clusterMarkets(mkts);
    expect(clusters[0]!.patternConfidence).toBe("high");
  });

  it("assigns medium confidence for 2-5 markets", () => {
    const mkts = [
      makeClobMarket({ conditionId: "c1", slug: "eth-above-3000" }),
      makeClobMarket({ conditionId: "c2", slug: "eth-above-4000" }),
    ];
    const clusters = clusterMarkets(mkts);
    expect(clusters[0]!.patternConfidence).toBe("medium");
  });

  it("assigns low confidence for single market", () => {
    const clusters = clusterMarkets([
      makeClobMarket({ conditionId: "c1", slug: "unique-one-off-event" }),
    ]);
    expect(clusters[0]!.patternConfidence).toBe("low");
  });

  it("generates candidateId as familyKey:regime:horizon", () => {
    const clusters = clusterMarkets([
      makeClobMarket({
        conditionId: "c1",
        slug: "bitcoin-above-95000",
        endDate: "2026-03-28T12:00:00Z",
      }),
    ]);
    expect(clusters[0]!.candidateId).toMatch(/^bitcoin-above:/);
  });

  it("separates unrelated markets into different clusters", () => {
    const markets = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000" }),
      makeClobMarket({ conditionId: "c2", slug: "temperature-london-march-28" }),
    ];
    const clusters = clusterMarkets(markets);
    expect(clusters).toHaveLength(2);
  });
});

// ─── IncrementalClusterer dedup ──────────────────────────────────────────────

describe("IncrementalClusterer", () => {
  it("deduplicates markets with the same conditionId across batches", () => {
    const clusterer = new IncrementalClusterer();
    const market = makeClobMarket({ conditionId: "same-cond", slug: "bitcoin-above-95000" });

    clusterer.addBatch([market]);
    clusterer.addBatch([market]); // duplicate conditionId in second batch

    const clusters = clusterer.finalize();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.markets).toHaveLength(1);
  });

  it("deduplicates markets with the same conditionId within a single batch", () => {
    const clusterer = new IncrementalClusterer();
    const market = makeClobMarket({ conditionId: "same-cond", slug: "bitcoin-above-95000" });

    clusterer.addBatch([market, market]);

    const clusters = clusterer.finalize();
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.markets).toHaveLength(1);
  });

  it("preserves volume24h on clustered markets", () => {
    const clusterer = new IncrementalClusterer();
    clusterer.addBatch([
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000", volume24h: 42_000 }),
      makeClobMarket({ conditionId: "c2", slug: "bitcoin-above-100000", volume24h: 0 }),
      makeClobMarket({ conditionId: "c3", slug: "bitcoin-above-105000", volume24h: null }),
    ]);

    const clusters = clusterer.finalize();
    expect(clusters[0]!.markets[0]!.volume24h).toBe(42_000);
    expect(clusters[0]!.markets[1]!.volume24h).toBe(0);
    expect(clusters[0]!.markets[2]!.volume24h).toBeUndefined();
  });
});
