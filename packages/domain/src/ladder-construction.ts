import type { TokenId } from "./ids.js";
import type { TrackS1WalkingLadderPolicy } from "./types.js";

export const S1_LADDER_RULE_ID = "S1_LADDER";

export const DEFAULT_TRACK_S1_WALKING_LADDER_POLICY: TrackS1WalkingLadderPolicy = {
  enabled: false,
  numTiers: 4,
  bottomTierMarkup: 1.05,
  volumeDistribution: [0.1, 0.2, 0.3, 0.4],
  markupCeilings: { cheapMax: 6, midRange: 2.25 },
  handoffTimeToResolutionSeconds: 3600,
  handoffTimeoutSeconds: 300,
  maxOpenLadderTokens: 20,
  s1MaxOrdersPerToken: 4,
  maxLadderReplacementsPerHour: 6,
  cheapLongshotMaxAvgEntry: 0.05,
  thinSpreadTicks: 10,
  bestBidDepthRatio: 0.1,
  bottomRepriceBidMovePct: 0.05,
  minBestBid: 0.001,
};

export type S1LadderSkipReason =
  | "below_min_tier_size"
  | "bottom_above_top"
  | "dead_market"
  | "insufficient_price_band"
  | "invalid_input";

export interface S1Tier {
  tierIndex: number;
  price: number;
  size: number;
  role: "probe" | "middle" | "target";
}

export interface BuildLadderInput {
  tokenId: TokenId;
  openedAt: string;
  avgEntryPrice: number;
  positionSize: number;
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number;
  minOrderSize: number;
  policy: TrackS1WalkingLadderPolicy;
}

export type S1LadderBuildResult =
  | {
      ok: true;
      ladderId: string;
      tiers: S1Tier[];
      bottomPrice: number;
      topPrice: number;
      volumeDistribution: readonly number[];
    }
  | { ok: false; reason: S1LadderSkipReason };

export function buildLadder(input: BuildLadderInput): S1LadderBuildResult {
  const tick = normalizePositive(input.tickSize, 0.001);
  const minOrderSize = normalizePositive(input.minOrderSize, 1);
  const bestBid = finitePositive(input.bestBid);
  const bestAsk = finitePositive(input.bestAsk);
  if (bestBid == null || bestAsk == null || bestBid < input.policy.minBestBid || bestAsk > 0.97) {
    return { ok: false, reason: "dead_market" };
  }
  if (!Number.isFinite(input.avgEntryPrice) || input.avgEntryPrice <= 0) {
    return { ok: false, reason: "invalid_input" };
  }
  const fractions = normalizeDistribution(input.policy.volumeDistribution, input.policy.numTiers);
  if (!satisfiesSmallestTier(input.positionSize, minOrderSize, fractions)) {
    return { ok: false, reason: "below_min_tier_size" };
  }
  const bottom = Math.max(
    ceilToTick(bestBid + tick, tick),
    ceilToTick(bestBid * input.policy.bottomTierMarkup, tick),
  );
  const top = floorToTick(
    Math.min(
      input.avgEntryPrice * resolveMarkupCeiling(input.avgEntryPrice, input.policy),
      bestAsk - tick,
      0.97,
    ),
    tick,
  );
  if (!(top > bottom)) return { ok: false, reason: "bottom_above_top" };
  if (top - bottom + 1e-12 < (fractions.length - 1) * tick) {
    return { ok: false, reason: "insufficient_price_band" };
  }

  const prices = buildPrices(bottom, top, fractions.length, tick);
  const tiers: S1Tier[] = prices.map((price, index) => ({
    tierIndex: index,
    price,
    size: roundSize(input.positionSize * fractions[index]!, minOrderSize),
    role: index === 0 ? "probe" : index === prices.length - 1 ? "target" : "middle",
  }));
  if (tiers.some((tier) => tier.size < minOrderSize)) {
    return { ok: false, reason: "below_min_tier_size" };
  }
  return {
    ok: true,
    ladderId: buildS1LadderId({
      tokenId: input.tokenId,
      openedAt: input.openedAt,
      avgEntryPrice: input.avgEntryPrice,
    }),
    tiers,
    bottomPrice: bottom,
    topPrice: top,
    volumeDistribution: fractions,
  };
}

export function buildS1LadderId(input: {
  tokenId: TokenId;
  openedAt: string;
  avgEntryPrice: number;
}): string {
  return stableHash(
    `s1|${String(input.tokenId)}|${input.openedAt}|${input.avgEntryPrice.toFixed(6)}`,
  );
}

export function buildS1SignalId(tokenId: TokenId, ladderId: string, tierIndex: number): string {
  return `s1_${String(tokenId)}_${ladderId}_${tierIndex}`;
}

export function normalizeDistribution(raw: readonly number[], numTiers: number): number[] {
  const tierCount = Math.max(2, Math.min(8, Math.trunc(numTiers)));
  const source = raw.length >= tierCount ? raw.slice(0, tierCount) : raw;
  if (source.length === 0 || source.some((value) => !Number.isFinite(value) || value <= 0)) {
    return DEFAULT_TRACK_S1_WALKING_LADDER_POLICY.volumeDistribution.slice(0, tierCount);
  }
  const sum = source.reduce((acc, value) => acc + value, 0);
  return source.map((value) => value / sum);
}

export function satisfiesSmallestTier(
  positionSize: number,
  minOrderSize: number,
  distribution: readonly number[],
): boolean {
  const smallest = Math.min(...distribution);
  return Number.isFinite(positionSize) && positionSize * smallest + 1e-9 >= minOrderSize;
}

export function resolveMarkupCeiling(
  avgEntryPrice: number,
  policy: TrackS1WalkingLadderPolicy,
): number {
  return avgEntryPrice < 0.02 ? policy.markupCeilings.cheapMax : policy.markupCeilings.midRange;
}

function buildPrices(bottom: number, top: number, count: number, tick: number): number[] {
  if (count === 1) return [bottom];
  const ratio = top / bottom;
  const prices: number[] = [];
  for (let index = 0; index < count; index++) {
    const t = index / (count - 1);
    const raw = ratio >= 2 ? bottom * Math.pow(ratio, t) : bottom + (top - bottom) * t;
    const snapped = index === count - 1 ? floorToTick(raw, tick) : ceilToTick(raw, tick);
    const previous = prices.at(-1);
    prices.push(previous == null ? snapped : Math.max(snapped, ceilToTick(previous + tick, tick)));
  }
  prices[prices.length - 1] = top;
  return prices;
}

function ceilToTick(value: number, tick: number): number {
  return normalizePrice(Math.ceil((value - 1e-12) / tick) * tick);
}

function floorToTick(value: number, tick: number): number {
  return normalizePrice(Math.floor((value + 1e-12) / tick) * tick);
}

function normalizePrice(value: number): number {
  return Number(value.toFixed(6));
}

function roundSize(value: number, minOrderSize: number): number {
  const truncated = Number((Math.floor((value + 1e-12) * 1_000_000) / 1_000_000).toFixed(6));
  return truncated < minOrderSize ? 0 : truncated;
}

function normalizePositive(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finitePositive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function stableHash(raw: string): string {
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
