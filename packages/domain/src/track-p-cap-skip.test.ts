import { describe, expect, it } from "vitest";
import { shouldSkipSellPriceCap } from "./track-p-cap-skip.js";

const CONTEXT = {
  trackS3BehaviorChanged: false,
  takerCapSkip: false,
  safetyMargin: 0.005,
};

describe("Track P sell-price cap skip helper (P0b)", () => {
  it("never skips when the order is not priced as a taker", () => {
    expect(
      shouldSkipSellPriceCap({
        pricedMode: "edge",
        bestBid: 0.16,
        cap: 0.0529,
        context: { ...CONTEXT, takerCapSkip: true },
      }),
    ).toBe(false);
  });

  it("preserves the existing S3 behaviorChanged taker carve-out regardless of the P0b flag", () => {
    expect(
      shouldSkipSellPriceCap({
        pricedMode: "taker",
        bestBid: 0.01,
        cap: 0.5,
        context: { ...CONTEXT, trackS3BehaviorChanged: true, takerCapSkip: false },
      }),
    ).toBe(true);
  });

  it("skips a taker SELL when the flag is on and the live bid covers the cap threshold", () => {
    // cap 0.0529, threshold = cap × 0.995 = 0.0526, bestBid 0.16 ≫ threshold
    expect(
      shouldSkipSellPriceCap({
        pricedMode: "taker",
        bestBid: 0.16,
        cap: 0.0529,
        context: { ...CONTEXT, takerCapSkip: true },
      }),
    ).toBe(true);
  });

  it("applies the cap for a taker SELL when the flag is on but the bid is below the threshold", () => {
    // cap 0.0529, threshold 0.0526, bestBid 0.05 < threshold → cap still applies
    expect(
      shouldSkipSellPriceCap({
        pricedMode: "taker",
        bestBid: 0.05,
        cap: 0.0529,
        context: { ...CONTEXT, takerCapSkip: true },
      }),
    ).toBe(false);
  });

  it("does not skip a taker SELL when the P0b flag is off", () => {
    expect(
      shouldSkipSellPriceCap({
        pricedMode: "taker",
        bestBid: 0.16,
        cap: 0.0529,
        context: { ...CONTEXT, takerCapSkip: false },
      }),
    ).toBe(false);
  });

  it("treats the threshold boundary inclusively (bestBid === cap × (1 − safetyMargin) skips)", () => {
    const cap = 0.2;
    const threshold = cap * (1 - CONTEXT.safetyMargin);
    expect(
      shouldSkipSellPriceCap({
        pricedMode: "taker",
        bestBid: threshold,
        cap,
        context: { ...CONTEXT, takerCapSkip: true },
      }),
    ).toBe(true);
  });

  it("applies the cap on non-finite numeric inputs (safe default)", () => {
    expect(
      shouldSkipSellPriceCap({
        pricedMode: "taker",
        bestBid: Number.NaN,
        cap: 0.0529,
        context: { ...CONTEXT, takerCapSkip: true },
      }),
    ).toBe(false);
  });
});
