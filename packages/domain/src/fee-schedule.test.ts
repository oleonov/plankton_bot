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
      makerRebateFraction: 0,
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
    expect(period?.makerRebateFraction).toBe(0);
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

  it("rejects non-zero maker rebate fractions in v1", () => {
    const issues = validateFeeSchedulePeriods([
      {
        ...config.periods[0]!,
        makerRebateFraction: 0.2,
        sourceNote: "Polymarket docs category percentage is not a notional fraction",
      },
      {
        ...config.periods[1]!,
        periodId: "post_promo",
        makerRebateFraction: 0,
      },
    ]);

    expect(issues.some((issue) => issue.includes("makerRebateFraction non-zero disabled"))).toBe(
      true,
    );
  });

  it("rejects Polymarket category percentages as notional rebate fractions", () => {
    const issues = validateFeeSchedulePeriods([
      {
        ...config.periods[0]!,
        makerRebateFraction: 0.25,
        sourceNote: "Polymarket docs category percentage is not a notional fraction",
      },
    ]);

    expect(
      issues.some(
        (issue) =>
          issue.includes("makerRebateFraction non-zero disabled") &&
          issue.includes("fee-equivalent/rebate-pool"),
      ),
    ).toBe(true);
  });

  it("rejects periods missing makerRebateFraction instead of defaulting to zero", () => {
    const { makerRebateFraction: _makerRebateFraction, ...periodWithoutRebate } =
      config.periods[0]!;
    const issues = validateFeeSchedulePeriods([periodWithoutRebate as any]);

    expect(issues).toContain("feeSchedule.periods[0].makerRebateFraction out of range [0, 1]");
  });

  it("does not expose maker rebate EV until a fee-equivalent model exists", () => {
    expect(
      applicableMakerRebateFraction({
        makerRebateFraction: 0.25,
        intendedLiquidityRole: "maker",
        postOnly: true,
      }),
    ).toBe(0);
    expect(
      applicableMakerRebateFraction({
        makerRebateFraction: 0.25,
        intendedLiquidityRole: "taker",
        postOnly: false,
      }),
    ).toBe(0);
    expect(
      applicableMakerRebateFraction({
        makerRebateFraction: 0.25,
        intendedLiquidityRole: "unknown",
      }),
    ).toBe(0);
    expect(
      applicableMakerRebateFraction({
        makerRebateFraction: 0.25,
        intendedLiquidityRole: "maker",
      }),
    ).toBe(0);
  });
});
