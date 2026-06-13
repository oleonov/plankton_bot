import { describe, expect, it } from "vitest";
import { allowedSpreadTicks, resolveTrackS3SpreadCap } from "./track-s3-cap.js";

const TIERS = [
  { minMargin: 3.0, maxSpreadTicks: 60, label: "tier_3x" },
  { minMargin: 2.0, maxSpreadTicks: 20, label: "tier_2x" },
  { minMargin: 1.5, maxSpreadTicks: 12, label: "tier_1.5x" },
] as const;

describe("Track S3 margin-aware spread cap", () => {
  it.each([
    { margin: 0, expected: 6 },
    { margin: 0.5, expected: 6 },
    { margin: 1.49, expected: 6 },
    { margin: 1.5, expected: 12 },
    { margin: 1.99, expected: 12 },
    { margin: 2.0, expected: 20 },
    { margin: 2.9999, expected: 20 },
    { margin: 3.0, expected: 60 },
    { margin: 5.0, expected: 60 },
    { margin: Number.POSITIVE_INFINITY, expected: 6 },
    { margin: Number.NaN, expected: 6 },
    { margin: -1, expected: 6 },
  ])("returns $expected ticks for margin $margin", ({ margin, expected }) => {
    expect(allowedSpreadTicks(margin, 6, TIERS)).toBe(expected);
  });

  it("evaluates unsorted tiers by descending minMargin", () => {
    const unsorted = [TIERS[2], TIERS[0], TIERS[1]];

    expect(allowedSpreadTicks(3.2, 6, unsorted)).toBe(60);
    expect(resolveTrackS3SpreadCap({ margin: 2.2, baseCap: 6, tiers: unsorted })).toEqual({
      allowedSpreadTicks: 20,
      dynamicCapUsed: true,
      tier: "tier_2x",
    });
  });

  it("never tightens below the base cap", () => {
    const badTier = [{ minMargin: 2.0, maxSpreadTicks: 4, label: "tier_2x" }] as const;

    expect(allowedSpreadTicks(2.5, 6, badTier)).toBe(6);
    expect(resolveTrackS3SpreadCap({ margin: 2.5, baseCap: 6, tiers: badTier })).toEqual({
      allowedSpreadTicks: 6,
      dynamicCapUsed: false,
      tier: "base",
    });
  });
});
