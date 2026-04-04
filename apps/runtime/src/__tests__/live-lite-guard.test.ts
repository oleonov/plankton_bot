import { describe, it, expect } from "vitest";
import { LiveLiteGuard } from "../live-lite-guard.js";

const LIVE_LITE_CONFIG = {
  familyAllowlist: ["fam-a", "fam-b"],
  maxFamilies: 2,
  maxOpenValueUsdc: 50,
  maxOrderUsdc: 10,
  maxActiveMarkets: 2,
};

describe("LiveLiteGuard", () => {
  describe("when config is undefined (non-live-lite mode)", () => {
    const guard = new LiveLiteGuard(undefined);

    it("allows any family", () => {
      expect(guard.isFamilyAllowed("fam-anything")).toBe(true);
    });

    it("allows any order size", () => {
      expect(guard.isOrderWithinCap(9999)).toBe(true);
    });

    it("never exceeds open value cap", () => {
      expect(guard.wouldExceedOpenValueCap(9999, 9999)).toBe(false);
    });

    it("never exceeds active markets cap", () => {
      expect(guard.wouldExceedActiveMarketsCap(9999, 1)).toBe(false);
    });

    it("isActive returns false", () => {
      expect(guard.isActive).toBe(false);
    });

    it("has no wallet mode or min order", () => {
      expect(guard.getWalletMode()).toBeNull();
      expect(guard.getMinOrderUsdc()).toBeNull();
    });
  });

  describe("when config is present (live-lite mode)", () => {
    const guard = new LiveLiteGuard(LIVE_LITE_CONFIG);

    it("isActive returns true", () => {
      expect(guard.isActive).toBe(true);
    });

    it("allows allowlisted family", () => {
      expect(guard.isFamilyAllowed("fam-a")).toBe(true);
    });

    it("rejects non-allowlisted family", () => {
      expect(guard.isFamilyAllowed("fam-c")).toBe(false);
    });

    it("allows order within cap", () => {
      expect(guard.isOrderWithinCap(10)).toBe(true); // exactly at cap is allowed
    });

    it("rejects order above cap (strict inequality)", () => {
      expect(guard.isOrderWithinCap(10.01)).toBe(false);
    });

    it("detects open value cap exceeded", () => {
      expect(guard.wouldExceedOpenValueCap(45, 6)).toBe(true); // 45+6=51 > 50
    });

    it("allows open value within cap", () => {
      expect(guard.wouldExceedOpenValueCap(40, 10)).toBe(false); // 40+10=50, exactly at cap
    });

    it("detects active markets cap exceeded", () => {
      expect(guard.wouldExceedActiveMarketsCap(2, 1)).toBe(true); // 2+1=3 > 2
    });

    it("allows active markets within cap", () => {
      expect(guard.wouldExceedActiveMarketsCap(1, 1)).toBe(false); // 1+1=2, at cap
    });

    it("defaults wallet mode to EOA with a $3 minimum order", () => {
      expect(guard.getWalletMode()).toBe("eoa");
      expect(guard.getMinOrderUsdc()).toBe(3);
      expect(guard.isOrderAboveMin(2.99)).toBe(false);
      expect(guard.isOrderAboveMin(3)).toBe(true);
    });

    it("rejects fee-enabled entry families in EOA mode", () => {
      expect(
        guard.getFamilyPolicyRejections({
          identity: {
            primaryCategory: "crypto",
            feeTier: null,
            liveWalletRequirement: null,
            requiresPostOnlyForLive: null,
          },
          isEntry: true,
          orderNotionalUsdc: 5,
        }),
      ).toEqual(["live-post-only-required", "live-eoa-fee-enabled-family-rejected"]);
    });

    it("does not apply live policy rejections to exits", () => {
      expect(
        guard.getFamilyPolicyRejections({
          identity: {
            primaryCategory: "crypto",
            feeTier: null,
            liveWalletRequirement: null,
            requiresPostOnlyForLive: null,
          },
          isEntry: false,
          orderNotionalUsdc: 1,
        }),
      ).toEqual([]);
    });
  });

  describe("when custom wallet settings are present", () => {
    const guard = new LiveLiteGuard({
      familyAllowlist: ["fam-a"],
      maxFamilies: 2,
      maxOpenValueUsdc: 50,
      maxOrderUsdc: 10,
      maxActiveMarkets: 2,
      walletMode: "relayer",
      minOrderUsdc: 2,
    });

    it("uses configured wallet mode and min order", () => {
      expect(guard.getWalletMode()).toBe("relayer");
      expect(guard.getMinOrderUsdc()).toBe(2);
      expect(guard.supportsPostOnlyFamilies()).toBe(true);
    });

    it("allows post-only-required families when execution confirms post-only support", () => {
      expect(
        guard.getFamilyPolicyRejections({
          identity: {
            primaryCategory: "crypto",
            feeTier: null,
            liveWalletRequirement: null,
            requiresPostOnlyForLive: null,
          },
          isEntry: true,
          orderNotionalUsdc: 2.5,
          hasPostOnlySupport: true,
        }),
      ).toEqual([]);
    });

    it("rejects buy orders below the configured minimum", () => {
      expect(
        guard.getFamilyPolicyRejections({
          identity: {
            primaryCategory: "geopolitics",
            feeTier: null,
            liveWalletRequirement: null,
            requiresPostOnlyForLive: null,
          },
          isEntry: true,
          orderNotionalUsdc: 1.5,
        }),
      ).toEqual(["live-min-order-usdc-rejected"]);
    });

    it("bypasses minOrderUsdc for spray-entry signals", () => {
      expect(
        guard.getFamilyPolicyRejections({
          identity: {
            primaryCategory: "geopolitics",
            feeTier: null,
            liveWalletRequirement: null,
            requiresPostOnlyForLive: null,
          },
          isEntry: true,
          orderNotionalUsdc: 0.15,
          hasPostOnlySupport: true,
          signalReason: "spray-entry",
        }),
      ).toEqual([]);
    });

    it("still rejects probe-entry below the configured minimum", () => {
      expect(
        guard.getFamilyPolicyRejections({
          identity: {
            primaryCategory: "geopolitics",
            feeTier: null,
            liveWalletRequirement: null,
            requiresPostOnlyForLive: null,
          },
          isEntry: true,
          orderNotionalUsdc: 0.15,
          hasPostOnlySupport: true,
          signalReason: "probe-entry",
        }),
      ).toEqual(["live-min-order-usdc-rejected"]);
    });
  });

  describe("when relayer mode uses the default minimum", () => {
    const guard = new LiveLiteGuard({
      familyAllowlist: ["fam-a"],
      maxFamilies: 2,
      maxOpenValueUsdc: 50,
      maxOrderUsdc: 10,
      maxActiveMarkets: 2,
      walletMode: "relayer",
    });

    it("defaults the relayer floor to $1", () => {
      expect(guard.getMinOrderUsdc()).toBe(1);
      expect(guard.isOrderAboveMin(0.99)).toBe(false);
      expect(guard.isOrderAboveMin(1)).toBe(true);
    });
  });

  describe("when a dynamic family allowlist is active", () => {
    const guard = new LiveLiteGuard(LIVE_LITE_CONFIG);

    it("prefers the dynamic allowlist over the configured one", () => {
      guard.setDynamicFamilyAllowlist(["fam-b"]);

      expect(guard.getConfiguredFamilyAllowlist()).toEqual(["fam-a", "fam-b"]);
      expect(guard.getEffectiveFamilyAllowlist()).toEqual(["fam-b"]);
      expect(guard.isFamilyAllowed("fam-a")).toBe(false);
      expect(guard.isFamilyAllowed("fam-b")).toBe(true);
    });

    it("falls back to the configured allowlist when cleared", () => {
      guard.setDynamicFamilyAllowlist(["fam-b"]);
      guard.setDynamicFamilyAllowlist(null);

      expect(guard.getEffectiveFamilyAllowlist()).toEqual(["fam-a", "fam-b"]);
      expect(guard.isFamilyAllowed("fam-a")).toBe(true);
    });
  });
});
