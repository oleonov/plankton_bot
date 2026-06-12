import { describe, expect, it } from "vitest";
import {
  CATEGORICAL_FALLBACK_RATES,
  computeTrackRMinGrossExitRatio,
  POLYMARKET_CRYPTO_TAKER_FEE_RATE,
  UNIVERSAL_FALLBACK_RATE,
} from "./polymarket-fees.js";

describe("Track R fee-aware taker margin", () => {
  it("R3 threshold matches breakeven table", () => {
    const cases = [
      { price: 0.046, rate: 0.07, expected: 1.0766 },
      { price: 0.1, rate: 0.07, expected: 1.0722 },
      { price: 0.1, rate: 0.04, expected: 1.0423 },
      { price: 0.5, rate: 0.07, expected: 1.0413 },
      { price: 0.5, rate: 0.04, expected: 1.0254 },
      { price: 0.046, rate: 0, expected: 1.005 },
      { price: 0.5, rate: 0, expected: 1.005 },
    ];

    for (const testCase of cases) {
      expect(
        computeTrackRMinGrossExitRatio({
          effectiveFillPrice: testCase.price,
          rate: testCase.rate,
          exponent: 1,
          safetyMargin: 0.005,
        }),
      ).toBeCloseTo(testCase.expected, 4);
    }
  });

  it("uses fee divided by revenue, not raw per-share platform fee", () => {
    const correct = computeTrackRMinGrossExitRatio({
      effectiveFillPrice: 0.046,
      rate: 0.07,
      exponent: 1,
      safetyMargin: 0.005,
    });

    expect(correct).toBeCloseTo(1.0766, 4);
    expect(correct).toBeGreaterThan(1.05);
  });

  it("exposes updated Track R fallback defaults", () => {
    expect(POLYMARKET_CRYPTO_TAKER_FEE_RATE).toBe(0.07);
    expect(CATEGORICAL_FALLBACK_RATES).toMatchObject({
      crypto: 0.07,
      finance: 0.04,
      sports: 0.03,
      culture: 0.05,
      geopolitics: 0,
    });
    expect(UNIVERSAL_FALLBACK_RATE).toBe(0.05);
  });
});
