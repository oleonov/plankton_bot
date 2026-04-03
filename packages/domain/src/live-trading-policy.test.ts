import { describe, expect, it } from "vitest";
import { resolveFamilyLiveTradingPolicy } from "./live-trading-policy.js";

describe("resolveFamilyLiveTradingPolicy", () => {
  it("defaults geopolitics families to fee-free EOA trading", () => {
    expect(resolveFamilyLiveTradingPolicy({ primaryCategory: "geopolitics" })).toEqual({
      feeTier: "fee-free",
      liveWalletRequirement: "eoa-ok",
      requiresPostOnlyForLive: false,
    });
  });

  it("defaults non-geopolitics families to relayer + post-only", () => {
    expect(resolveFamilyLiveTradingPolicy({ primaryCategory: "crypto-btc" })).toEqual({
      feeTier: "fee-enabled",
      liveWalletRequirement: "relayer-required",
      requiresPostOnlyForLive: true,
    });
  });

  it("preserves explicit overrides", () => {
    expect(
      resolveFamilyLiveTradingPolicy({
        primaryCategory: "geopolitics",
        feeTier: "unknown",
        liveWalletRequirement: "relayer-required",
        requiresPostOnlyForLive: true,
      }),
    ).toEqual({
      feeTier: "unknown",
      liveWalletRequirement: "relayer-required",
      requiresPostOnlyForLive: true,
    });
  });
});
