import { describe, expect, it } from "vitest";
import { isGammaFallbackDustEligible } from "../modules/strategy/book-quality-policy.js";

describe("isGammaFallbackDustEligible", () => {
  it("allows fresh gamma fallback dust snapshots", () => {
    const nowMs = Date.parse("2026-04-12T08:00:00Z");

    const eligible = isGammaFallbackDustEligible({
      market: {
        bookSource: "gamma-fallback",
        lastTradePrice: 0.04,
        lastTradeAt: new Date(nowMs - 30_000).toISOString(),
        snapshotTs: nowMs - 30_000,
      },
      nowMs,
      entryMode: "spray-first",
      suggestedSizeUsdc: 0.15,
    });

    expect(eligible).toBe(true);
  });

  it("rejects stale gamma fallback snapshots even when last trade is still fresh", () => {
    const nowMs = Date.parse("2026-04-12T08:00:00Z");

    const eligible = isGammaFallbackDustEligible({
      market: {
        bookSource: "gamma-fallback",
        lastTradePrice: 0.04,
        lastTradeAt: new Date(nowMs - 45_000).toISOString(),
        snapshotTs: nowMs - 61_000,
      },
      nowMs,
      entryMode: "spray-first",
      suggestedSizeUsdc: 0.15,
    });

    expect(eligible).toBe(false);
  });
});
