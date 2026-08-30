import type {
  LadderBuilderInput,
  LadderBuilderOutput,
  LadderRung,
  ProfileLadderBand,
  ProfileLadderBandConfig,
} from "@krabs/domain";
import { ceilToTick, resolvePositiveSellFloor } from "../../executable-price.js";

export function computeProfileLadder(input: LadderBuilderInput): LadderBuilderOutput {
  if (!input.config.enabled) {
    return { ok: false, reason: "sell_ladder_disabled", band: null };
  }

  if (!hasValidCoreInputs(input)) {
    return { ok: false, reason: "invalid_input", band: null };
  }
  if (!isPositiveFinite(input.tickSize)) {
    return { ok: false, reason: "invalid_tick_size", band: null };
  }
  const band = resolveBand(input);
  if (band == null) {
    return { ok: false, reason: "invalid_input", band: null };
  }
  const bandConfig = input.config.bands[band];
  if (!bandConfig.enabled) {
    return { ok: false, reason: "band_disabled", band };
  }
  if (!isValidBbo(input.bestBid, input.bestAsk)) {
    return { ok: false, reason: "invalid_bbo", band };
  }
  if (!isPositiveFinite(input.minOrderSize)) {
    return { ok: false, reason: "invalid_input", band };
  }

  const activeRungCount = resolveActiveRungCount(input, band);
  const sizing = normalizeActiveSizing(bandConfig.sizingVector, activeRungCount);
  const modeAdjustment = input.config.modeAdjustments[input.mode];
  // Phase 2: config-driven harvest multiplier; absent harvestGainPct → +50% fallback (0.5).
  const harvestMultiplier = 1 + (input.harvestGainPct ?? 0.5);
  const initialRungs = sizing.map((sizingFraction, index): LadderRung => {
    const bandMultiplier = bandConfig.multipliers[index]!;
    // Phase 6/2: maker first rung uses the config-driven harvest multiplier.
    // Subsequent rungs and all non-maker positions keep band multipliers byte-identical.
    const isMakerFirstRung = input.entryStyle === "maker" && index === 0;
    const multiplier = isMakerFirstRung ? harvestMultiplier : bandMultiplier;
    const rawPrice = isMakerFirstRung
      ? ceilToTick(input.avgEntryPrice * harvestMultiplier, input.tickSize)
      : ceilToTick(input.avgEntryPrice * bandMultiplier * modeAdjustment, input.tickSize);
    const { positiveFloorPrice } = resolvePositiveSellFloor(input.avgEntryPrice, input.tickSize);
    const price = Math.max(rawPrice, positiveFloorPrice);
    const sizeShares = roundQuantity(input.positionSizeShares * sizingFraction);
    return {
      rungIndex: index,
      price,
      sizeShares,
      notionalUsd: roundCents(price * sizeShares),
      multiplier,
      sizingFraction,
      lifecycle: "planned",
      orderId: null,
      filledSizeShares: 0,
      ...(rawPrice < positiveFloorPrice ? { floored: true as const } : {}),
    };
  });

  const rungs = fitRungsToMinOrderSize(initialRungs, input.positionSizeShares, input.minOrderSize);
  if (rungs.length === 0) {
    return { ok: false, reason: "below_min_order_size", band };
  }

  return {
    ok: true,
    ladderId: buildProfileLadderId(input, band),
    band,
    activeRungCount: rungs.length,
    rungs,
  };
}

function hasValidCoreInputs(input: LadderBuilderInput): boolean {
  return (
    isPositiveFinite(input.avgEntryPrice) &&
    isPositiveFinite(input.costBasisUsd) &&
    isPositiveFinite(input.positionSizeShares)
  );
}

function resolveBand(input: LadderBuilderInput): ProfileLadderBand | null {
  return resolveLadderBand(input.avgEntryPrice, input.config.bands);
}

export function resolveLadderBand(
  avgEntryPrice: number,
  bands: Record<ProfileLadderBand, ProfileLadderBandConfig>,
): ProfileLadderBand | null {
  for (const band of ["cheap", "medium_low", "medium_high", "expensive"] as const) {
    const config = bands[band];
    const aboveLow = config.minAvgEntry == null || avgEntryPrice >= config.minAvgEntry;
    const belowHigh = config.maxAvgEntry == null || avgEntryPrice < config.maxAvgEntry;
    if (aboveLow && belowHigh) return band;
  }
  return null;
}

export function isValidLadderBbo(bestBid: number | null, bestAsk: number | null): boolean {
  return isValidBbo(bestBid, bestAsk);
}

export function wouldCrossProfileLadderPostOnly(price: number, bestBid: number | null): boolean {
  return isPositiveFinite(bestBid) && price <= bestBid;
}

function resolveActiveRungCount(input: LadderBuilderInput, band: ProfileLadderBand): number {
  const costBasis = input.costBasisUsd;
  if (costBasis < 5) return 1;
  if (costBasis < 15) return 2;

  const bandConfig = input.config.bands[band];
  if (bandConfig.allowFourthRung && costBasis >= bandConfig.fourthRungMinCostUsd) {
    return 4;
  }
  return 3;
}

function normalizeActiveSizing(raw: readonly number[], count: number): number[] {
  const active = raw.slice(0, Math.min(4, Math.max(1, count)));
  const sum = active.reduce((acc, value) => acc + value, 0);
  return active.map((value) => roundRatio(value / sum));
}

export function fitRungsToMinOrderSize(
  rawRungs: readonly LadderRung[],
  positionSizeShares: number,
  minOrderSize: number,
): LadderRung[] {
  let rungs = [...rawRungs];
  while (rungs.some((rung) => rung.sizeShares + 1e-9 < minOrderSize)) {
    if (rungs.length <= 1) return [];

    const violatingIndex = rungs.findIndex((rung) => rung.sizeShares + 1e-9 < minOrderSize);
    const neighborIndex = chooseLargestNeighborIndex(rungs, violatingIndex);
    const violating = rungs[violatingIndex]!;
    const neighbor = rungs[neighborIndex]!;
    const merged: LadderRung = {
      ...neighbor,
      sizeShares: roundQuantity(neighbor.sizeShares + violating.sizeShares),
    };
    merged.notionalUsd = roundCents(merged.price * merged.sizeShares);
    rungs = rungs
      .map((rung, index) => (index === neighborIndex ? merged : rung))
      .filter((_rung, index) => index !== violatingIndex);
  }

  return rungs.map((rung, index) => ({
    ...rung,
    rungIndex: index,
    sizingFraction: roundRatio(rung.sizeShares / positionSizeShares),
    notionalUsd: roundCents(rung.price * rung.sizeShares),
  }));
}

function chooseLargestNeighborIndex(rungs: readonly LadderRung[], index: number): number {
  const left = index > 0 ? index - 1 : null;
  const right = index < rungs.length - 1 ? index + 1 : null;
  if (left == null && right == null) return index;
  if (left == null) return right!;
  if (right == null) return left;
  return rungs[left]!.sizeShares >= rungs[right]!.sizeShares ? left : right;
}

function isValidBbo(bestBid: number | null, bestAsk: number | null): boolean {
  return isPositiveFinite(bestBid) && isPositiveFinite(bestAsk) && bestBid < bestAsk;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundRatio(value: number): number {
  return Number(value.toFixed(10));
}

function buildProfileLadderId(input: LadderBuilderInput, band: ProfileLadderBand): string {
  return stableHash(
    `profile-ladder|${String(input.tokenId)}|${input.openedAt}|${band}|${input.avgEntryPrice.toFixed(6)}`,
  );
}

function stableHash(raw: string): string {
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index++) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `profile_ladder_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
