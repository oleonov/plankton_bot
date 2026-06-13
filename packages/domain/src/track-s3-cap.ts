import type { TrackS3SpreadTierPolicy } from "./types.js";

export interface TrackS3SpreadCapResult {
  allowedSpreadTicks: number;
  dynamicCapUsed: boolean;
  tier: string;
}

export const DEFAULT_TRACK_S3_BASE_CAP = 6;

export const DEFAULT_TRACK_S3_TIERS: readonly TrackS3SpreadTierPolicy[] = [
  { minMargin: 3.0, maxSpreadTicks: 60, label: "tier_3x" },
  { minMargin: 2.0, maxSpreadTicks: 20, label: "tier_2x" },
  { minMargin: 1.5, maxSpreadTicks: 12, label: "tier_1.5x" },
];

const TRACK_S3_MARGIN_EPSILON = 1e-12;

export function allowedSpreadTicks(
  margin: number,
  baseCap: number,
  tiers: readonly TrackS3SpreadTierPolicy[],
): number {
  return resolveTrackS3SpreadCap({ margin, baseCap, tiers }).allowedSpreadTicks;
}

export function resolveTrackS3SpreadCap(input: {
  margin: number;
  baseCap: number;
  tiers: readonly TrackS3SpreadTierPolicy[];
}): TrackS3SpreadCapResult {
  const baseCap = normalizeBaseCap(input.baseCap);
  if (!Number.isFinite(input.margin) || input.margin <= 0) {
    return { allowedSpreadTicks: baseCap, dynamicCapUsed: false, tier: "base" };
  }

  const tier = [...input.tiers]
    .filter(
      (candidate) =>
        Number.isFinite(candidate.minMargin) &&
        candidate.minMargin > 0 &&
        Number.isFinite(candidate.maxSpreadTicks) &&
        candidate.maxSpreadTicks > 0,
    )
    .sort((a, b) => b.minMargin - a.minMargin)
    .find((candidate) => input.margin + TRACK_S3_MARGIN_EPSILON >= candidate.minMargin);

  if (!tier) {
    return { allowedSpreadTicks: baseCap, dynamicCapUsed: false, tier: "base" };
  }

  const allowedSpreadTicks = Math.max(baseCap, Math.trunc(tier.maxSpreadTicks));
  return {
    allowedSpreadTicks,
    dynamicCapUsed: allowedSpreadTicks > baseCap,
    tier: allowedSpreadTicks > baseCap ? tier.label : "base",
  };
}

function normalizeBaseCap(baseCap: number): number {
  return Number.isFinite(baseCap) && baseCap > 0 ? Math.trunc(baseCap) : DEFAULT_TRACK_S3_BASE_CAP;
}
