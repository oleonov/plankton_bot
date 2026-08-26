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
  const fullUpsertChanges = {
    conditionId: "0x2",
    slug: "s2",
    eventSlug: "event-2",
    question: "Q2",
    outcome: "No",
    outcomeIndex: 1,
    regime: "threshold",
    horizon: "weekly",
    endDate: null,
    active: false,
    tradable: false,
    tickSize: 0.01,
    negRisk: true,
    eventMarketCount: 3,
    selectionStatus: "matched_exclude",
    selectionWinningRuleId: "rule-2",
    groupItemTitle: "Spain",
    groupItemThreshold: "21",
    tags: ["sports"],
  };

  it.each(Object.entries(fullUpsertChanges))("routes %s changes to full upsert", (field, value) => {
    expect(classifyMarketWrite(base({ [field]: value }), base(), now)).toBe("full_upsert");
  });
  it("routes new rows to full upsert", () => {
    expect(classifyMarketWrite(base(), null, now)).toBe("full_upsert");
    expect(classifyMarketWrite(base(), base({ gammaCreatedAt: null }), now)).toBe("full_upsert");
  });
  it.each(["sigMid", "sigCheapMid", "sigLiquidity", "sigVol24h"])(
    "routes %s changes to a narrow signature update",
    (field) => {
      expect(classifyMarketWrite(base({ [field]: 999 }), base(), now)).toBe("signature_update");
    },
  );
  it("preserves coalesced metadata while routing a signature update", () => {
    expect(
      classifyMarketWrite(
        base({ eventSlug: null, sigLiquidity: 900 }),
        base({ eventSlug: "e" }),
        now,
      ),
    ).toBe("signature_update");
  });
  it("routes stale sig_features_at to a narrow signature update", () => {
    const stale = base({
      sigFeaturesAt: new Date(now - SIGNATURE_FEATURE_TTL_MS - 1).toISOString(),
    });
    expect(classifyMarketWrite(base(), stale, now)).toBe("signature_update");
  });
  it("stays unchanged when sig features equal and fresh", () => {
    expect(classifyMarketWrite(base(), base(), now)).toBe("unchanged");
  });
  it.each(["eventSlug", "gammaCreatedAt"])("keeps coalesced null %s as a no-op", (field) => {
    expect(classifyMarketWrite(base({ [field]: null }), base({ [field]: "e" }), now)).toBe(
      "coalesce_noop",
    );
  });
});
