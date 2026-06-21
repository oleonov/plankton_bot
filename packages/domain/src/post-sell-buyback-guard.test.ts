import { describe, expect, it } from "vitest";
import { DEFAULT_EXECUTION_PROFILE_POLICY, evaluatePostSellBuybackGuard } from "./index.js";

const DEFAULT_POLICY = DEFAULT_EXECUTION_PROFILE_POLICY.scaleIn.harvestingGuard;
const NOW = Date.parse("2026-06-21T12:00:00.000Z");

function decide(
  overrides: Partial<Parameters<typeof evaluatePostSellBuybackGuard>[0]> = {},
  policy = DEFAULT_POLICY,
) {
  return evaluatePostSellBuybackGuard(
    {
      buyPrice: 0.309,
      lastSellPrice: 0.265,
      lastSellAtMs: NOW - 4 * 60_000,
      nowMs: NOW,
      signals: {
        recovery60: 0,
        range60: 0,
        std60: 0,
        usable: true,
      },
      ...overrides,
    },
    policy,
  );
}

describe("evaluatePostSellBuybackGuard", () => {
  it("blocks the Rai regression buyback above the recent profitable sell", () => {
    expect(decide()).toMatchObject({
      action: "block",
      reason: "above_last_sell_suppressed",
      overrideStatus: "below_thresholds",
    });
  });

  it("allows buys below the last sell and within the allowed ratio", () => {
    expect(decide({ buyPrice: 0.25 }).reason).toBe("below_last_sell");
    expect(decide({ buyPrice: 0.272 }).reason).toBe("within_allowed_ratio");
  });

  it("allows buybacks outside the configured post-sell window", () => {
    expect(decide({ lastSellAtMs: NOW - 61 * 60_000 })).toMatchObject({
      action: "allow",
      reason: "outside_window",
    });
  });

  it("allows strong recovery, range, or volatility overrides at the threshold", () => {
    expect(
      decide({ signals: { recovery60: 0.1, range60: 0, std60: 0, usable: true } }),
    ).toMatchObject({
      action: "allow",
      reason: "strong_override",
      overrideStatus: "fired",
      overrideReason: "recovery60",
    });
    expect(
      decide({ signals: { recovery60: 0, range60: 0.2, std60: 0, usable: true } }),
    ).toMatchObject({
      action: "allow",
      reason: "strong_override",
      overrideReason: "range60",
    });
    expect(
      decide({ signals: { recovery60: 0, range60: 0, std60: 0.03, usable: true } }),
    ).toMatchObject({
      action: "allow",
      reason: "strong_override",
      overrideReason: "std60",
    });
  });

  it("fails closed when signal quality is unavailable", () => {
    expect(
      decide({ signals: { recovery60: null, range60: null, std60: null, usable: false } }),
    ).toMatchObject({
      action: "block",
      reason: "above_last_sell_suppressed",
      overrideStatus: "failed_closed",
    });
  });

  it("allows with explicit missing context reason when last sell context is absent", () => {
    expect(decide({ lastSellPrice: null })).toMatchObject({
      action: "allow",
      reason: "missing_last_sell_context",
      overrideStatus: "n/a",
    });
    expect(decide({ lastSellAtMs: null })).toMatchObject({
      action: "allow",
      reason: "missing_last_sell_context",
      overrideStatus: "n/a",
    });
  });

  it("returns a distinct reason when the policy is disabled", () => {
    expect(decide({}, { ...DEFAULT_POLICY, enabled: false })).toMatchObject({
      action: "allow",
      reason: "policy_disabled",
      overrideStatus: "n/a",
    });
  });
});
