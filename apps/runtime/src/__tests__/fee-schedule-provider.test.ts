import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FEE_SCHEDULE_CONFIG, type FeeScheduleConfig } from "@krabs/domain";
import { createHybridFeeScheduleProvider } from "../fee-schedule-provider.js";

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
  ],
};

describe("createHybridFeeScheduleProvider", () => {
  it("combines CLOB fd taker metadata with a zero-rebate local schedule", async () => {
    const metrics = { writeCounter: vi.fn(), writeEvent: vi.fn() };
    const provider = createHybridFeeScheduleProvider({
      feeGateway: {
        getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.04, exponent: 1, takerOnly: true }),
      },
      runtimeMetrics: metrics,
      nowMs: () => Date.parse("2026-06-16T00:00:00Z"),
    });

    await expect(
      provider.resolve({
        asOfMs: Date.parse("2026-06-16T00:00:00Z"),
        conditionId: "condition",
        tokenId: "token",
        intendedLiquidityRole: "maker",
        config,
      }),
    ).resolves.toMatchObject({
      baseRate: 0.04,
      exponent: 1,
      takerOnly: true,
      makerRebateFraction: 0,
      source: "mixed",
      periodId: "promo",
      confidence: "high",
    });
    expect(metrics.writeCounter).toHaveBeenCalledWith("fee_schedule_provider_api_success", 1);
  });

  it("does not emit unknown-role rebate telemetry while maker rebate EV is disabled", async () => {
    const metrics = { writeCounter: vi.fn(), writeEvent: vi.fn() };
    const provider = createHybridFeeScheduleProvider({
      feeGateway: {
        getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.04, exponent: 1, takerOnly: true }),
      },
      runtimeMetrics: metrics,
      nowMs: () => Date.parse("2026-06-16T00:00:00Z"),
    });

    await provider.resolve({
      asOfMs: Date.parse("2026-06-16T00:00:00Z"),
      conditionId: "condition",
      tokenId: "token",
      intendedLiquidityRole: "unknown",
      config,
    });

    expect(metrics.writeCounter).not.toHaveBeenCalledWith(
      "fee_schedule_unknown_role_conservative",
      expect.any(Number),
    );
  });

  it("ignores direct non-zero maker rebate schedules until a fee-equivalent model exists", async () => {
    const provider = createHybridFeeScheduleProvider({
      feeGateway: {
        getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.04, exponent: 1, takerOnly: true }),
      },
      nowMs: () => Date.parse("2026-06-16T00:00:00Z"),
    });

    await expect(
      provider.resolve({
        asOfMs: Date.parse("2026-06-16T00:00:00Z"),
        conditionId: "condition",
        tokenId: "token",
        intendedLiquidityRole: "maker",
        config: {
          ...config,
          periods: [{ ...config.periods[0]!, makerRebateFraction: 0.25 }],
        },
      }),
    ).resolves.toMatchObject({
      baseRate: 0.04,
      exponent: 1,
      makerRebateFraction: 0,
      source: "mixed",
      warnings: [],
    });
  });

  it("can resolve taker metadata with no active rebate schedule", async () => {
    const provider = createHybridFeeScheduleProvider({
      feeGateway: {
        getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.04, exponent: 1, takerOnly: true }),
      },
      nowMs: () => Date.parse("2026-06-16T00:00:00Z"),
    });

    await expect(
      provider.resolve({
        asOfMs: Date.parse("2026-06-16T00:00:00Z"),
        conditionId: "condition",
        tokenId: "token",
        intendedLiquidityRole: "taker",
        config: { ...config, periods: [] },
      }),
    ).resolves.toMatchObject({
      baseRate: 0.04,
      exponent: 1,
      makerRebateFraction: 0,
      source: "api",
      periodId: "api_fd_no_schedule",
      warnings: ["no_active_fee_schedule_period"],
    });
  });

  it("falls back to schedule and rate-limits degraded events when API fd is unavailable", async () => {
    const metrics = { writeCounter: vi.fn(), writeEvent: vi.fn() };
    let now = Date.parse("2026-06-16T00:00:00Z");
    const provider = createHybridFeeScheduleProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue(null) },
      runtimeMetrics: metrics,
      nowMs: () => now,
    });

    await provider.resolve({
      asOfMs: now,
      conditionId: "condition",
      tokenId: "token",
      config,
    });
    now += 1_000;
    await provider.resolve({
      asOfMs: now,
      conditionId: "condition",
      tokenId: "token",
      config,
    });

    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "fee_schedule_provider_api_failure",
      1,
      JSON.stringify({ reason: "api_missing_fee_info" }),
    );
    expect(metrics.writeCounter).toHaveBeenCalledWith("fee_schedule_provider_schedule_fallback", 1);
    const degradedEvents = metrics.writeEvent.mock.calls.filter(
      (call) => call[0] === "fee_schedule_provider_degraded",
    );
    expect(degradedEvents).toHaveLength(1);
  });

  it("does not use schedule fallback when scheduleFallbackEnabled is false", async () => {
    const metrics = { writeCounter: vi.fn(), writeEvent: vi.fn() };
    const provider = createHybridFeeScheduleProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue(null) },
      runtimeMetrics: metrics,
      nowMs: () => Date.parse("2026-06-16T00:00:00Z"),
    });

    await expect(
      provider.resolve({
        asOfMs: Date.parse("2026-06-16T00:00:00Z"),
        conditionId: "condition",
        tokenId: "token",
        config: { ...config, scheduleFallbackEnabled: false },
      }),
    ).resolves.toMatchObject({
      baseRate: 0,
      exponent: 1,
      makerRebateFraction: 0,
      source: "fallback",
      periodId: "fallback_schedule_disabled",
      warnings: ["schedule_fallback_disabled", "api_fee_info_unavailable"],
    });
    expect(metrics.writeCounter).not.toHaveBeenCalledWith(
      "fee_schedule_provider_schedule_fallback",
      expect.any(Number),
    );
  });
});
