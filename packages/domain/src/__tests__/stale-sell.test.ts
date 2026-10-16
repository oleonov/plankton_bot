import { describe, expect, it } from "vitest";
import { createTokenId } from "../ids.js";
import { isStaleSell, type StaleSellContext } from "../stale-sell.js";

const NOW_MS = Date.parse("2026-06-02T00:00:00Z");
const ASSET_ID = createTokenId("asset-stale-sell");

function ctx(overrides: Partial<StaleSellContext> = {}): StaleSellContext {
  return {
    assetId: ASSET_ID,
    sellPrice: 0.1,
    currentBid: 0.08,
    currentAsk: 0.1,
    sellPostedAt: NOW_MS - 10 * 60_000,
    repriceChainCount24h: 0,
    sellCount: 1,
    positionAgeMs: 10 * 60_000,
    livenessVerdict: "dead",
    ts: NOW_MS,
    ...overrides,
  };
}

describe("isStaleSell", () => {
  it("returns price_only for the price branch only", () => {
    expect(
      isStaleSell(ctx({ sellPrice: 0.101, currentAsk: 0.1, sellPostedAt: NOW_MS - 31 * 60_000 })),
    ).toEqual({ stale: true, reason: "price_only" });
  });

  it("requires branded asset ids at compile time", () => {
    const brandedContext: StaleSellContext = ctx({ assetId: ASSET_ID });
    expect(brandedContext.assetId).toBe(ASSET_ID);

    // @ts-expect-error assetId must be TokenId, not a plain string.
    const plainContext: StaleSellContext = { ...brandedContext, assetId: "plain-asset" };
    expect(plainContext.assetId).toBe("plain-asset");
  });

  it("returns chain for the chain branch only", () => {
    expect(
      isStaleSell(
        ctx({
          sellPrice: 0.1,
          currentAsk: 0.1,
          repriceChainCount24h: 13,
          sellCount: 0,
          positionAgeMs: 12 * 60 * 60_000 + 1,
        }),
      ),
    ).toEqual({ stale: true, reason: "chain" });
  });

  it("returns chain+price when both branches fire", () => {
    expect(
      isStaleSell(
        ctx({
          sellPrice: 0.101,
          currentAsk: 0.1,
          sellPostedAt: NOW_MS - 31 * 60_000,
          repriceChainCount24h: 13,
          sellCount: 0,
          positionAgeMs: 12 * 60 * 60_000 + 1,
        }),
      ),
    ).toEqual({ stale: true, reason: "chain+price" });
  });

  it("returns none when neither branch fires", () => {
    expect(isStaleSell(ctx())).toEqual({ stale: false, reason: "none" });
  });
});
