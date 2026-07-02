import { describe, it, expect } from "vitest";
import {
  classifyMarketWrite,
  SIGNATURE_FEATURE_TTL_MS,
} from "../modules/market-scanner/market-scanner-module.js";

const base = (o = {}) =>
  ({
    tokenId: "t1",
    conditionId: "0x1",
    slug: "s",
    eventSlug: null,
    question: "Q",
    outcome: "Yes",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: "2026-12-31T00:00:00Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    eventMarketCount: 2,
    selectionStatus: "matched_include",
    selectionWinningRuleId: null,
    gammaCreatedAt: "2026-06-23T00:00:00Z",
    groupItemTitle: null,
    groupItemThreshold: null,
    tags: null,
    sigMid: 0.05,
    sigCheapMid: 0.05,
    sigLiquidity: 800,
    sigVol24h: 120,
    sigFeaturesAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-06-23T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...o,
  }) as never;

describe("classifyMarketWrite signature awareness", () => {
  const now = Date.parse("2026-07-01T00:00:00.000Z");
  it("writes when sig features change", () => {
    expect(classifyMarketWrite(base({ sigLiquidity: 900 }), base(), now)).toBe("changed");
  });
  it("writes when sig_features_at is stale (TTL exceeded)", () => {
    const stale = base({
      sigFeaturesAt: new Date(now - SIGNATURE_FEATURE_TTL_MS - 1).toISOString(),
    });
    expect(classifyMarketWrite(base(), stale, now)).toBe("changed");
  });
  it("stays unchanged when sig features equal and fresh", () => {
    expect(classifyMarketWrite(base(), base(), now)).toBe("unchanged");
  });
});
