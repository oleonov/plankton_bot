import { describe, expect, it } from "vitest";
import { computeRepriceThreshold, type RepriceContext } from "../reprice-threshold.js";
import { createTokenId } from "../ids.js";

const NOW_MS = Date.parse("2026-06-02T00:00:00Z");
const ASSET_ID = createTokenId("asset-reprice");

function ctx(overrides: Partial<RepriceContext> = {}): RepriceContext {
  return {
    assetId: ASSET_ID,
    subtype: "strike",
    currentSpread: 0.02,
    currentMid: 0.2,
    livenessVerdict: "live",
    capturedAt: NOW_MS,
    ts: NOW_MS,
    ...overrides,
  };
}

describe("computeRepriceThreshold", () => {
  it("returns fixed_3 when liveness is live and subtype is strike", () => {
    expect(computeRepriceThreshold(ctx())).toEqual({
      shouldReprice: true,
      tickThreshold: 3,
      reason: "fixed_3_live_strike",
    });
  });

  it("requires branded asset ids at compile time", () => {
    const brandedContext: RepriceContext = ctx({ assetId: ASSET_ID });
    expect(brandedContext.assetId).toBe(ASSET_ID);

    // @ts-expect-error assetId must be TokenId, not a plain string.
    const plainContext: RepriceContext = { ...brandedContext, assetId: "plain-asset" };
    expect(plainContext.assetId).toBe("plain-asset");
  });

  it("gates reprice when liveness is dead", () => {
    expect(computeRepriceThreshold(ctx({ livenessVerdict: "dead" }))).toEqual({
      shouldReprice: false,
      tickThreshold: null,
      reason: "liveness_dead",
    });
  });

  it("gates reprice when captured market data is stale", () => {
    expect(computeRepriceThreshold(ctx({ capturedAt: NOW_MS - 10 * 60_000 - 1 }))).toEqual({
      shouldReprice: false,
      tickThreshold: null,
      reason: "stale_market_data_fallback",
    });
  });

  it("keeps Phase 1 subtype mapping binary and leaves non-strike on fallback", () => {
    expect(computeRepriceThreshold(ctx({ subtype: "non-strike" }))).toEqual({
      shouldReprice: false,
      tickThreshold: null,
      reason: "non_strike_static_fallback",
    });
  });
});
