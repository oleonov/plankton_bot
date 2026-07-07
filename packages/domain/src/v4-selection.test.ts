import { describe, expect, it } from "vitest";
import {
  HOT_CATS_40,
  categoryQualityBucket,
  createV4AdmissionTelemetrySnapshot,
  deriveV4SelectionCategory,
  evaluateV4Selection,
  mapGammaTagsToCategory,
  recordV4AdmissionTelemetry,
} from "./v4-selection.js";

describe("V4 Plankton priority selection", () => {
  it("exports the canonical HOT_CATS_40 list", () => {
    expect(HOT_CATS_40).toEqual([
      "crypto-btc",
      "crypto-eth",
      "crypto-sol",
      "crypto-xrp",
      "entertainment",
      "esports",
      "geopolitics",
      "other",
      "politics",
      "price-binary",
      "stocks",
      "weather",
    ]);
  });

  it("admits hot categories with V4 liquidity and volume gates", () => {
    expect(
      evaluateV4Selection({
        slug: "will-bitcoin-hit-120000-by-june",
        eventSlug: null,
        liquidity: 100,
        volume24h: 5,
      }),
    ).toMatchObject({ admit: true, category: "crypto-btc" });
  });

  it("admits sparse-liquidity markets when the orderbook proxy is tight", () => {
    expect(
      evaluateV4Selection({
        slug: "ethereum-above-3000-on-friday",
        eventSlug: null,
        liquidity: null,
        volume24h: null,
        bestBid: 0.4,
        bestAsk: 0.45,
      }),
    ).toMatchObject({ admit: true, category: "crypto-eth", reason: "admit" });
  });

  it("rejects sparse-liquidity markets with a wide or missing orderbook proxy", () => {
    expect(
      evaluateV4Selection({
        slug: "ethereum-above-3000-on-friday",
        eventSlug: null,
        liquidity: null,
        volume24h: null,
        bestBid: 0.4,
        bestAsk: 0.51,
      }),
    ).toMatchObject({
      admit: false,
      category: "crypto-eth",
      reason: "orderbook_proxy_unavailable",
    });
    expect(
      evaluateV4Selection({
        slug: "ethereum-above-3000-on-friday",
        eventSlug: null,
        liquidity: null,
        volume24h: null,
      }),
    ).toMatchObject({
      admit: false,
      category: "crypto-eth",
      reason: "orderbook_proxy_unavailable",
    });
  });

  it("rejects missing category, low liquidity, and low volume", () => {
    expect(
      evaluateV4Selection({
        slug: "unclassified-market-without-taxonomy",
        eventSlug: null,
        liquidity: 1000,
        volume24h: 100,
      }),
    ).toMatchObject({ admit: false, reason: "category_not_hot" });
    expect(
      evaluateV4Selection({
        slug: "will-trump-win-the-election",
        eventSlug: null,
        liquidity: 99.99,
        volume24h: 100,
      }),
    ).toMatchObject({ admit: false, reason: "liquidity_too_low" });
    expect(
      evaluateV4Selection({
        slug: "will-trump-win-the-election",
        eventSlug: null,
        liquidity: 100,
        volume24h: 100,
      }),
    ).toMatchObject({ admit: true, reason: "admit" });
    expect(
      evaluateV4Selection({
        slug: "will-it-rain-in-nyc",
        eventSlug: null,
        liquidity: 100,
        volume24h: 4.99,
      }),
    ).toMatchObject({ admit: false, reason: "volume24h_too_low" });
  });

  it("derives V4 subcategories from runtime slug fields", () => {
    expect(deriveV4SelectionCategory("xrp-above-3", null)).toBe("crypto-xrp");
    expect(deriveV4SelectionCategory("iran-israel-ceasefire", null)).toBe("geopolitics");
    expect(deriveV4SelectionCategory("nvidia-stock-above-150", null)).toBe("stocks");
    expect(deriveV4SelectionCategory("tokyo-temperature-below-18c", null)).toBe("weather");
  });

  it("tracks V4 admission telemetry by category and reject reason", () => {
    let telemetry = createV4AdmissionTelemetrySnapshot("2026-05-20T00:00:00Z");

    for (const input of [
      { slug: "bitcoin-above-120000", liquidity: 100, volume24h: 5 },
      { slug: "bitcoin-above-130000", liquidity: 50, volume24h: 5 },
      { slug: "bitcoin-above-140000", liquidity: null, volume24h: 5 },
      { slug: "unclassified-market", liquidity: 100, volume24h: 100 },
    ]) {
      telemetry = recordV4AdmissionTelemetry(
        telemetry,
        evaluateV4Selection({ ...input, eventSlug: null }),
      );
    }

    expect(telemetry.evaluatedTotal).toBe(4);
    expect(telemetry.admitCountTotal).toBe(1);
    expect(telemetry.rejectCountTotal).toBe(3);
    expect(telemetry.admitRate).toBeCloseTo(1 / 4, 6);
    expect(telemetry.seenCountByCategory["crypto-btc"]).toBe(3);
    expect(telemetry.admitCountByCategory["crypto-btc"]).toBe(1);
    expect(telemetry.admitRateByCategory["crypto-btc"]).toBeCloseTo(1 / 3, 6);
    expect(telemetry.rejectCountByReason.rejected_liquidity_below_100).toBe(1);
    expect(telemetry.rejectCountByReason.rejected_no_orderbook_proxy).toBe(1);
    expect(telemetry.rejectCountByReason.rejected_category_not_in_hot_cats).toBe(1);
  });

  it("categoryQualityBucket covers every HOT_CATS_40 member", () => {
    for (const cat of HOT_CATS_40) {
      expect(categoryQualityBucket(cat)).toMatch(/^(PRIORITIZE|BLOCK|NEUTRAL)$/);
    }
  });

  it("categoryQualityBucket maps research buckets correctly", () => {
    expect(categoryQualityBucket("geopolitics")).toBe("PRIORITIZE");
    expect(categoryQualityBucket("crypto-btc")).toBe("PRIORITIZE");
    expect(categoryQualityBucket("politics")).toBe("PRIORITIZE");
    expect(categoryQualityBucket("esports")).toBe("BLOCK");
    expect(categoryQualityBucket("crypto-sol")).toBe("BLOCK");
    expect(categoryQualityBucket("crypto-xrp")).toBe("BLOCK");
    expect(categoryQualityBucket("entertainment")).toBe("BLOCK");
    expect(categoryQualityBucket("crypto-eth")).toBe("NEUTRAL");
    expect(categoryQualityBucket("stocks")).toBe("NEUTRAL");
    expect(categoryQualityBucket("weather")).toBe("NEUTRAL");
    expect(categoryQualityBucket("price-binary")).toBe("NEUTRAL");
    expect(categoryQualityBucket("other")).toBe("NEUTRAL");
  });

  it("mapGammaTagsToCategory resolves by priority, not input order", () => {
    expect(mapGammaTagsToCategory(["geopolitics"])).toBe("geopolitics");
    // politics+geopolitics co-occur in ~20% of live events; geopolitics must win regardless of order
    expect(mapGammaTagsToCategory(["politics", "geopolitics"])).toBe("geopolitics");
    expect(mapGammaTagsToCategory(["geopolitics", "politics"])).toBe("geopolitics");
  });

  it("mapGammaTagsToCategory returns null for coarse/unrecognized/empty tags", () => {
    // coarse crypto tag defers to slug-derived category
    expect(mapGammaTagsToCategory(["crypto"])).toBeNull();
    // fine-grained Gamma tag without a V4 match this cycle
    expect(mapGammaTagsToCategory(["us-presidential-election"])).toBeNull();
    expect(mapGammaTagsToCategory([])).toBeNull();
    expect(mapGammaTagsToCategory(null)).toBeNull();
    expect(mapGammaTagsToCategory(undefined)).toBeNull();
  });
});
