import { describe, expect, it, vi } from "vitest";

import type { HotSample, OhlcBucket } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

import {
  computeRange60,
  computeRecovery60,
  computeStd60,
  computeTradeCount3h,
  selectHotSamples,
} from "../signal-feed-computations.js";

const NOW = 1_000_000;
const TOKEN = createTokenId("signal-feed-token");

function sample(midPrice: number, ageMs: number): HotSample {
  return { tsMs: NOW - ageMs, midPrice };
}

function samples(mids: number[], startAgeMs = 10_000): HotSample[] {
  return mids.map((mid, index) => sample(mid, startAgeMs - index));
}

function bucket(
  tradeCount: number,
  bucketStartMs: number,
  overrides: Partial<OhlcBucket> = {},
): OhlcBucket {
  return {
    tokenId: TOKEN,
    bucketStartMs,
    bucketGranularityMs: 60_000,
    openMid: 0.1,
    highMid: 0.1,
    lowMid: 0.1,
    closeMid: 0.1,
    sampleCount: 1,
    tradeCount,
    notionalSum: 0,
    persisted: false,
    ...overrides,
  };
}

describe("signal feed computations", () => {
  it("selects inclusive hot samples in timestamp order", () => {
    const selected = selectHotSamples(
      [sample(0.1, 3_600_001), sample(0.2, 3_600_000), sample(0.3, 0)],
      NOW,
      3_600_000,
    );

    expect(selected.map((item) => item.midPrice)).toEqual([0.2, 0.3]);
  });

  it("computes recovery60 and reports insufficient sample coverage", () => {
    const insufficient = computeRecovery60(samples([0.1, 0.05, 0.12]), NOW);
    const sufficient = computeRecovery60(samples([0.1, 0.05, 0.12]), NOW, {
      minSamples: 3,
    });

    expect(insufficient).toMatchObject({ value: 0, insufficient: true, sampleCount: 3 });
    expect(sufficient.value).toBeCloseTo(1.4, 8);
    expect(sufficient).toMatchObject({
      insufficient: false,
      midNow: 0.12,
      midMin: 0.05,
      midMax: 0.12,
    });
  });

  it("defensively returns zero recovery when the minimum mid is invalid", () => {
    const result = computeRecovery60(samples([0, 0.05, 0.12]), NOW, { minSamples: 3 });

    expect(result).toMatchObject({ value: 0, insufficient: false, midMin: 0 });
  });

  it("computes range60 with the calibrated min-denominator formula", () => {
    const insufficient = computeRange60(samples([0.05, 0.1, 0.15]), NOW);
    const sufficient = computeRange60(samples([0.05, 0.1, 0.15]), NOW, {
      minSamples: 3,
    });

    expect(insufficient).toMatchObject({ value: 0, insufficient: true, sampleCount: 3 });
    expect(sufficient.value).toBeCloseTo(2, 8);
  });

  it("computes std60 as coefficient of variation", () => {
    const result = computeStd60(samples([1, 2, 3]), NOW, { minSamples: 3 });
    const expected = Math.sqrt(((1 - 2) ** 2 + (2 - 2) ** 2 + (3 - 2) ** 2) / 3) / 2;

    expect(result.value).toBeCloseTo(expected, 8);
    expect(result.insufficient).toBe(false);
    expect(result.midMean).toBe(2);
  });

  it("sums trade counts from 3h buckets only", () => {
    const result = computeTradeCount3h(
      [
        bucket(2, NOW - 10_000),
        bucket(3, NOW - 3 * 60 * 60_000),
        bucket(100, NOW - 3 * 60 * 60_000 - 1),
      ],
      NOW,
    );

    expect(result).toEqual({ value: 5, bucketCount: 2 });
  });

  it("is pure and does not call Date.now", () => {
    const spy = vi.spyOn(Date, "now");

    computeRecovery60(samples([0.1, 0.05, 0.12]), NOW, { minSamples: 3 });
    computeRange60(samples([0.05, 0.1, 0.15]), NOW, { minSamples: 3 });
    computeStd60(samples([1, 2, 3]), NOW, { minSamples: 3 });

    expect(spy).not.toHaveBeenCalled();
  });
});
