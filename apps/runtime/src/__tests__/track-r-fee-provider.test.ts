import { describe, expect, it, vi } from "vitest";
import {
  createConditionId,
  createTokenId,
  DEFAULT_EXECUTION_POLICY,
  type FeeScheduleConfig,
} from "@krabs/domain";
import { createTrackRFeeProvider } from "../track-r-fee-provider.js";

const conditionId = createConditionId("cond-track-r");
const tokenId = createTokenId("tok-track-r");
const policy = DEFAULT_EXECUTION_POLICY.trackR;
const feeSchedule: FeeScheduleConfig = {
  ...DEFAULT_EXECUTION_POLICY.feeSchedule,
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
  ],
};

describe("createTrackRFeeProvider", () => {
  it("skips L1 live fee metadata when exponent is zero and falls through to L2", async () => {
    const metrics = { writeCounter: vi.fn() };
    const provider = createTrackRFeeProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.07, exponent: 0 }) },
      fillRepo: { findRecentTakerFeeRate: vi.fn().mockReturnValue(0.04) },
      runtimeMetrics: metrics,
    });

    await expect(
      provider.resolveFeeQuote({
        conditionId,
        tokenId,
        category: "crypto",
        policy,
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({ rate: 0.04, exponent: 1, source: "fill" });
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "track_r_l1_skipped_invalid_exponent",
      1,
      JSON.stringify({ reason: "invalid_exponent" }),
    );
  });

  it("skips L1 live fee metadata when exponent is NaN", async () => {
    const provider = createTrackRFeeProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.07, exponent: NaN }) },
      fillRepo: { findRecentTakerFeeRate: vi.fn().mockReturnValue(0.04) },
    });

    await expect(
      provider.resolveFeeQuote({
        conditionId,
        tokenId,
        category: "crypto",
        policy,
        nowMs: Date.now(),
      }),
    ).resolves.toMatchObject({ rate: 0.04, source: "fill" });
  });

  it("accepts L1 live fee metadata when exponent is positive", async () => {
    const fillRepo = { findRecentTakerFeeRate: vi.fn().mockReturnValue(0.04) };
    const provider = createTrackRFeeProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.07, exponent: 1 }) },
      fillRepo,
    });

    await expect(
      provider.resolveFeeQuote({
        conditionId,
        tokenId,
        category: "crypto",
        policy,
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({ rate: 0.07, exponent: 1, source: "live" });
    expect(fillRepo.findRecentTakerFeeRate).not.toHaveBeenCalled();
  });

  it("routes through FeeScheduleProvider when enabled and preserves live Track R quote shape", async () => {
    const fillRepo = { findRecentTakerFeeRate: vi.fn().mockReturnValue(0.04) };
    const provider = createTrackRFeeProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.03, exponent: 1 }) },
      feeScheduleProvider: {
        resolve: vi.fn().mockResolvedValue({
          baseRate: 0.07,
          exponent: 1,
          takerOnly: true,
          makerRebateFraction: 0.002,
          source: "mixed",
          periodId: "promo",
          effectiveAtMs: 0,
          validUntilMs: null,
          ttlMs: 300_000,
          confidence: "high",
          warnings: [],
        }),
      },
      fillRepo,
    });

    await expect(
      provider.resolveFeeQuote({
        conditionId,
        tokenId,
        category: "crypto",
        feeSchedule,
        policy,
        nowMs: Date.parse("2026-06-16T00:00:00Z"),
      }),
    ).resolves.toEqual({ rate: 0.07, exponent: 1, source: "live" });
    expect(fillRepo.findRecentTakerFeeRate).not.toHaveBeenCalled();
  });

  it("preserves invalid exponent fallback when provider fd exponent is zero", async () => {
    const metrics = { writeCounter: vi.fn() };
    const provider = createTrackRFeeProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue({ rate: 0.03, exponent: 1 }) },
      feeScheduleProvider: {
        resolve: vi.fn().mockResolvedValue({
          baseRate: 0.07,
          exponent: 0,
          takerOnly: true,
          makerRebateFraction: 0.002,
          source: "mixed",
          periodId: "promo",
          effectiveAtMs: 0,
          validUntilMs: null,
          ttlMs: 300_000,
          confidence: "high",
          warnings: [],
        }),
      },
      fillRepo: { findRecentTakerFeeRate: vi.fn().mockReturnValue(0.04) },
      runtimeMetrics: metrics,
    });

    await expect(
      provider.resolveFeeQuote({
        conditionId,
        tokenId,
        category: "crypto",
        feeSchedule,
        policy,
        nowMs: Date.parse("2026-06-16T00:00:00Z"),
      }),
    ).resolves.toEqual({ rate: 0.04, exponent: 1, source: "fill" });
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "track_r_l1_skipped_invalid_exponent",
      1,
      JSON.stringify({ reason: "invalid_exponent" }),
    );
  });

  it("uses geopolitics category override before universal fallback", async () => {
    const provider = createTrackRFeeProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue(null) },
      fillRepo: { findRecentTakerFeeRate: vi.fn().mockReturnValue(null) },
    });

    await expect(
      provider.resolveFeeQuote({
        conditionId,
        tokenId,
        category: "geopolitics",
        policy,
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({
      rate: 0,
      exponent: 1,
      source: "fallback_category",
      category: "geopolitics",
    });
  });

  it("never returns a zero universal fallback for unknown non-geopolitics categories", async () => {
    const provider = createTrackRFeeProvider({
      feeGateway: { getMarketFeeInfo: vi.fn().mockResolvedValue(null) },
      fillRepo: { findRecentTakerFeeRate: vi.fn().mockReturnValue(null) },
    });

    await expect(
      provider.resolveFeeQuote({
        conditionId,
        tokenId,
        category: "unknown",
        policy: { ...policy, universalFallbackRate: 0 },
        nowMs: Date.now(),
      }),
    ).resolves.toEqual({ rate: 0.05, exponent: 1, source: "fallback_universal" });
  });
});
