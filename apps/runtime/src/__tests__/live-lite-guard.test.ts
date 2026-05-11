import { describe, it, expect } from "vitest";
import { LiveLiteGuard } from "../live-lite-guard.js";

const LIVE_LITE_CONFIG = {
  maxOpenValueUsdc: 50,
  maxOrderUsdc: 10,
  maxActiveMarkets: 2,
};

describe("LiveLiteGuard", () => {
  describe("when config is undefined (non-live-lite mode)", () => {
    const guard = new LiveLiteGuard(undefined);

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
  });

  describe("when custom wallet settings are present", () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 50,
      maxOrderUsdc: 10,
      maxActiveMarkets: 2,
      walletMode: "relayer",
      minOrderUsdc: 2,
    });

    it("uses configured wallet mode and min order", () => {
      expect(guard.getWalletMode()).toBe("relayer");
      expect(guard.getMinOrderUsdc()).toBe(2);
      expect(guard.getMinEntryNotionalUsdc()).toBe(2);
    });
  });

  describe("when relayer mode uses the default minimum", () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 50,
      maxOrderUsdc: 10,
      maxActiveMarkets: 2,
      walletMode: "relayer",
    });

    it("defaults the relayer floor to $1", () => {
      expect(guard.getMinOrderUsdc()).toBe(1);
      expect(guard.getMinEntryNotionalUsdc()).toBe(1);
      expect(guard.isOrderAboveMin(0.99)).toBe(false);
      expect(guard.isOrderAboveMin(0.9999999999999999)).toBe(true);
      expect(guard.isOrderAboveMin(1)).toBe(true);
    });

    it("keeps the marketable entry floor at $1 when the configured relayer minimum is lower", () => {
      const lowConfiguredGuard = new LiveLiteGuard({
        maxOpenValueUsdc: 50,
        maxOrderUsdc: 10,
        maxActiveMarkets: 2,
        walletMode: "relayer",
        minOrderUsdc: 0.05,
      });

      expect(lowConfiguredGuard.getMinOrderUsdc()).toBe(0.05);
      expect(lowConfiguredGuard.getMinEntryNotionalUsdc()).toBe(1);
    });

    it("uses configured fallback relayer minimums", () => {
      const guardWithFallback = new LiveLiteGuard({
        maxOpenValueUsdc: 50,
        maxOrderUsdc: 10,
        maxActiveMarkets: 2,
        walletMode: "relayer",
        fallbackMinOrderUsdcRelayer: 0.5,
      });

      expect(guardWithFallback.getMinOrderUsdc()).toBe(0.5);
      expect(guardWithFallback.getMinEntryNotionalUsdc(0.5)).toBe(0.5);
    });
  });
});
