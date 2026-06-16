import { describe, expect, it } from "vitest";
import {
  applicableMakerRebateFraction,
  DEFAULT_FEE_SCHEDULE_CONFIG,
  selectFeeSchedulePeriod,
  validateFeeSchedulePeriods,
  type FeeScheduleConfig,
} from "./index.js";

const config: FeeScheduleConfig = {
  ...DEFAULT_FEE_SCHEDULE_CONFIG,
  enabled: true,
  periods: [
    {
      periodId: "promo",
      startsAtUtc: "2026-06-01T00:00:00Z",
      endsAtUtc: "2026-07-01T00:00:00Z",
      makerRebateFraction: 0.002,
      appliesTo: { scope: "all" },
      sourceNote: "test",
    },
    {
      periodId: "post_promo",
      startsAtUtc: "2026-07-01T00:00:00Z",
      endsAtUtc: null,
      makerRebateFraction: 0,
      appliesTo: { scope: "all" },
      sourceNote: "test",
    },
  ],
};

describe("fee schedule helpers", () => {
  it("returns no active schedule period when the default schedule is disabled", () => {
    expect(
      selectFeeSchedulePeriod(DEFAULT_FEE_SCHEDULE_CONFIG, {
        asOfMs: Date.parse("2026-06-16T00:00:00Z"),
      }),
    ).toBeNull();
  });

  it("selects the promo period before the boundary", () => {
    const period = selectFeeSchedulePeriod(config, {
      asOfMs: Date.parse("2026-06-30T23:59:59.999Z"),
    });

    expect(period?.periodId).toBe("promo");
    expect(period?.makerRebateFraction).toBe(0.002);
  });

  it("selects the post-promo period at the half-open boundary", () => {
    const period = selectFeeSchedulePeriod(config, {
      asOfMs: Date.parse("2026-07-01T00:00:00.000Z"),
    });

    expect(period?.periodId).toBe("post_promo");
    expect(period?.makerRebateFraction).toBe(0);
  });

  it("rejects overlapping periods for the same scope", () => {
    const issues = validateFeeSchedulePeriods([
      config.periods[0]!,
      {
        ...config.periods[0]!,
        periodId: "overlap",
        startsAtUtc: "2026-06-15T00:00:00Z",
      },
    ]);

    expect(issues.some((issue) => issue.includes("overlap"))).toBe(true);
  });

  it("applies maker rebate only for intended maker/post-only semantics", () => {
    expect(
      applicableMakerRebateFraction({
        makerRebateFraction: 0.002,
        intendedLiquidityRole: "maker",
        postOnly: true,
      }),
    ).toBe(0.002);
    expect(
      applicableMakerRebateFraction({
        makerRebateFraction: 0.002,
        intendedLiquidityRole: "taker",
        postOnly: false,
      }),
    ).toBe(0);
    expect(
      applicableMakerRebateFraction({
        makerRebateFraction: 0.002,
        intendedLiquidityRole: "unknown",
      }),
    ).toBe(0);
    expect(
      applicableMakerRebateFraction({
        makerRebateFraction: 0.002,
        intendedLiquidityRole: "maker",
      }),
    ).toBe(0);
  });
});
