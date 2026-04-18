import { describe, expect, it } from "vitest";
import {
  shouldPromoteFallbackMarketability,
  shouldRelaxNegativeTailProbeOnly,
} from "../proven-family-policy.js";

// Phase 6: proven-family-policy functions are stubs returning the safe/conservative
// default (false). Family evidence is no longer loaded at runtime.
// Phase 7 will delete proven-family-policy.ts entirely.

describe("proven-family-policy (Phase 6 stubs)", () => {
  it("returns false for shouldRelaxNegativeTailProbeOnly regardless of bundle", () => {
    expect(shouldRelaxNegativeTailProbeOnly({})).toBe(false);
    expect(shouldRelaxNegativeTailProbeOnly(null)).toBe(false);
  });

  it("returns false for shouldPromoteFallbackMarketability regardless of bundle", () => {
    expect(shouldPromoteFallbackMarketability({}, 0.01)).toBe(false);
    expect(shouldPromoteFallbackMarketability(null, null)).toBe(false);
  });
});
