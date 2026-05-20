import { describe, expect, it } from "vitest";
import {
  HOT_CATS_40,
  createV4AdmissionTelemetrySnapshot,
  deriveV4SelectionCategory,
  evaluateV4Selection,
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

  it("treats missing liquidity and volume as pass, matching V4 validation policy", () => {
    expect(
      evaluateV4Selection({
        slug: "ethereum-above-3000-on-friday",
        eventSlug: null,
        liquidity: null,
        volume24h: null,
      }),
    ).toMatchObject({ admit: true, category: "crypto-eth" });
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
      { slug: "unclassified-market", liquidity: 100, volume24h: 100 },
    ]) {
      telemetry = recordV4AdmissionTelemetry(
        telemetry,
        evaluateV4Selection({ ...input, eventSlug: null }),
      );
    }

    expect(telemetry.evaluatedTotal).toBe(3);
    expect(telemetry.admitCountTotal).toBe(1);
    expect(telemetry.rejectCountTotal).toBe(2);
    expect(telemetry.admitRate).toBeCloseTo(1 / 3, 6);
    expect(telemetry.seenCountByCategory["crypto-btc"]).toBe(2);
    expect(telemetry.admitCountByCategory["crypto-btc"]).toBe(1);
    expect(telemetry.admitRateByCategory["crypto-btc"]).toBe(0.5);
    expect(telemetry.rejectCountByReason.rejected_liquidity_below_100).toBe(1);
    expect(telemetry.rejectCountByReason.rejected_category_not_in_hot_cats).toBe(1);
  });
});
