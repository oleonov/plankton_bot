import type {
  ExecutionProfileSellLadderConfig,
  LadderRung,
  ProfileLadderMode,
  ProfileLadderShadowEntryBand,
  ProfileLadderShadowVariant,
} from "@krabs/domain";

import { ceilToTick, resolvePositiveSellFloor } from "../../executable-price.js";
import {
  fitRungsToMinOrderSize,
  wouldCrossProfileLadderPostOnly,
} from "./profile-ladder-builder.js";

export const PROFILE_LADDER_SHADOW_ENTRY_BANDS: readonly ProfileLadderShadowEntryBand[] = [
  "lt_0_005",
  "gte_0_005_lt_0_01",
  "gte_0_01_lt_0_02",
  "gte_0_02_lt_0_05",
  "gte_0_05_lt_0_10",
  "gte_0_10",
];

export const PROFILE_LADDER_SHADOW_VARIANTS: readonly ProfileLadderShadowVariant[] = [
  "p25",
  "median",
  "p75",
  "cheap_tail",
];

export type ProfileLadderShadowResultLabel =
  | "candidate_executable"
  | "candidate_not_executable"
  | "same_as_current"
  | "collapsed_by_min_order"
  | "crossing_post_only"
  | "invalid_input"
  | "below_floor";

export type ProfileLadderShadowReasonLabel =
  | "ok"
  | "invalid_input"
  | "invalid_tick_size"
  | "invalid_bbo"
  | "below_min_order"
  | "collapsed_due_min_order"
  | "post_only_crossing"
  | "positive_floor_applied"
  | "same_as_current"
  | "current_below_p25"
  | "current_below_median"
  | "low_full_exit_le_110"
  | "higher_exposure_available"
  | "pr2_conflict"
  | "disabled";

export type ProfileLadderShadowCollapseReason = "none" | "min_order" | "min_order_to_single_rung";

export type ProfileLadderShadowVariantCollapseType =
  | "same_effective_price_after_tick"
  | "same_effective_price_after_floor"
  | "same_effective_price_after_tick_and_floor";

export interface ProfileLadderShadowCandidateRung {
  rungIndex: number;
  targetKind: "p25" | "median" | "p75";
  targetMultiple: number;
  rawPrice: number;
  roundedPrice: number;
  positiveFloorPrice: number;
  price: number;
  sizeShares: number;
  sizingFraction: number;
  notionalUsd: number;
  executable: boolean;
  skipReason?: ProfileLadderShadowReasonLabel;
}

export interface ProfileLadderShadowCandidateResult {
  variant: ProfileLadderShadowVariant;
  band: ProfileLadderShadowEntryBand;
  result: ProfileLadderShadowResultLabel;
  reason: ProfileLadderShadowReasonLabel;
  avgEntry: number;
  candidateRungs: readonly ProfileLadderShadowCandidateRung[];
  firstTargetMultiple: number | null;
  effectiveFirstTargetMultiple: number | null;
  firstSizeFraction: number | null;
  currentFirstTargetMultiple: number | null;
  currentFirstSizeFraction: number | null;
  currentVsCandidatePriceDeltaPct: number | null;
  deltaBucket: ProfileLadderShadowDeltaBucket;
  currentFirstFractionBucket: ProfileLadderShadowFractionBucket;
  candidateFirstFractionBucket: ProfileLadderShadowFractionBucket;
  rungCountBucket: ProfileLadderShadowRungCountBucket;
  collapseReason: ProfileLadderShadowCollapseReason;
  beforeCollapseRungCount: number;
  afterCollapseRungCount: number;
  singleExecutableRung: boolean;
  collapsedDueMinOrder: boolean;
  wouldAvoidLowFullExitLe110: boolean;
  hasHigherExposureCandidate: boolean;
  pr2ProtectedExposureConflict: boolean;
}

export interface ProfileLadderShadowVariantCollapse {
  collapseType: ProfileLadderShadowVariantCollapseType;
  variants: readonly ProfileLadderShadowVariant[];
  effectivePrice: number;
}

export interface ProfileLadderShadowEvaluation {
  band: ProfileLadderShadowEntryBand;
  results: readonly ProfileLadderShadowCandidateResult[];
  variantCollapse: ProfileLadderShadowVariantCollapse | null;
}

export interface ProfileLadderShadowEvaluationInput {
  avgEntryPrice: number;
  costBasisUsd: number;
  positionSizeShares: number;
  mode: ProfileLadderMode;
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number;
  minOrderSize: number;
  config: ExecutionProfileSellLadderConfig["shadowPlanktonPolicy"];
  currentRungs: readonly LadderRung[];
}

export type ProfileLadderShadowDeltaBucket =
  | "candidate_lower"
  | "same_0_2pct"
  | "higher_2_10pct"
  | "higher_10_25pct"
  | "higher_25_50pct"
  | "higher_gt_50pct";

export type ProfileLadderShadowFractionBucket = "0_25" | "25_50" | "50_75" | "75_99" | "full";

export type ProfileLadderShadowRungCountBucket = "0" | "1" | "2" | "3_plus";

type ShadowTargetKind = "p25" | "median" | "p75";

interface CandidatePlan {
  variant: ProfileLadderShadowVariant;
  targets: readonly ShadowTargetKind[];
  fractions: readonly number[];
}

export function resolveProfileLadderShadowEntryBand(
  avgEntryPrice: number,
): ProfileLadderShadowEntryBand | null {
  if (!isPositiveFinite(avgEntryPrice)) return null;
  if (avgEntryPrice < 0.005) return "lt_0_005";
  if (avgEntryPrice < 0.01) return "gte_0_005_lt_0_01";
  if (avgEntryPrice < 0.02) return "gte_0_01_lt_0_02";
  if (avgEntryPrice < 0.05) return "gte_0_02_lt_0_05";
  if (avgEntryPrice < 0.1) return "gte_0_05_lt_0_10";
  return "gte_0_10";
}

export function computeProfileLadderShadowEvaluation(
  input: ProfileLadderShadowEvaluationInput,
): ProfileLadderShadowEvaluation | null {
  if (!input.config.enabled) return null;
  const band = resolveProfileLadderShadowEntryBand(input.avgEntryPrice);
  if (band == null || !hasValidCoreInputs(input) || !isValidBbo(input.bestBid, input.bestAsk)) {
    return null;
  }
  const plans = buildCandidatePlans(input, band);
  const results = plans.map((plan) => computeCandidateResult(input, band, plan));
  return {
    band,
    results,
    variantCollapse: resolveVariantCollapse(results),
  };
}

function buildCandidatePlans(
  input: ProfileLadderShadowEvaluationInput,
  band: ProfileLadderShadowEntryBand,
): CandidatePlan[] {
  const plans: CandidatePlan[] = [];
  for (const variant of input.config.variants) {
    if (variant === "cheap_tail" && !isCheapTailBand(band)) continue;
    if (variant === "cheap_tail") {
      const fractions = resolveCheapTailFractions(input, band);
      plans.push({ variant, targets: ["median", "p75"], fractions });
      continue;
    }
    plans.push({ variant, targets: [variant], fractions: [1] });
  }
  return plans;
}

function computeCandidateResult(
  input: ProfileLadderShadowEvaluationInput,
  band: ProfileLadderShadowEntryBand,
  plan: CandidatePlan,
): ProfileLadderShadowCandidateResult {
  const targetConfig = input.config.bands[band];
  const positiveFloor = resolvePositiveSellFloor(
    input.avgEntryPrice,
    input.tickSize,
  ).positiveFloorPrice;
  const rawRungs = plan.targets.flatMap((targetKind, index): LadderRung[] => {
    const sizingFraction = plan.fractions[index] ?? 0;
    if (sizingFraction <= 0) return [];
    const targetMultiple = targetConfig[targetKind];
    const rawPrice = input.avgEntryPrice * targetMultiple;
    const roundedPrice = ceilToTick(rawPrice, input.tickSize);
    const price = Math.max(roundedPrice, positiveFloor);
    const sizeShares = roundQuantity(input.positionSizeShares * sizingFraction);
    if (sizeShares <= 0) return [];
    return [
      {
        rungIndex: index,
        price,
        sizeShares,
        notionalUsd: roundCents(price * sizeShares),
        multiplier: targetMultiple,
        sizingFraction,
        lifecycle: "planned",
        orderId: null,
        filledSizeShares: 0,
        ...(roundedPrice < positiveFloor ? { floored: true as const } : {}),
      },
    ];
  });
  const collapsed = fitRungsToMinOrderSize(rawRungs, input.positionSizeShares, input.minOrderSize);
  const candidateRungs = collapsed.map((rung): ProfileLadderShadowCandidateRung => {
    const targetKind = resolveTargetKindForMultiplier(
      rung.multiplier,
      targetConfig,
      plan.targets[Math.min(rung.rungIndex, plan.targets.length - 1)] ?? "median",
    );
    const targetMultiple = targetConfig[targetKind];
    const rawPrice = input.avgEntryPrice * targetMultiple;
    const roundedPrice = ceilToTick(rawPrice, input.tickSize);
    const executable = !wouldCrossProfileLadderPostOnly(rung.price, input.bestBid);
    return {
      rungIndex: rung.rungIndex,
      targetKind,
      targetMultiple,
      rawPrice,
      roundedPrice,
      positiveFloorPrice: positiveFloor,
      price: rung.price,
      sizeShares: rung.sizeShares,
      sizingFraction: rung.sizingFraction,
      notionalUsd: rung.notionalUsd,
      executable,
      ...(executable ? {} : { skipReason: "post_only_crossing" as const }),
    };
  });
  const firstCandidate = candidateRungs[0] ?? null;
  const currentFirst = input.currentRungs[0] ?? null;
  const currentFirstTargetMultiple = currentFirst?.price
    ? roundRatio(currentFirst.price / input.avgEntryPrice)
    : null;
  const effectiveFirstTargetMultiple = firstCandidate?.price
    ? roundRatio(firstCandidate.price / input.avgEntryPrice)
    : null;
  const deltaPct =
    currentFirst?.price != null && firstCandidate?.price != null
      ? (firstCandidate.price - currentFirst.price) / currentFirst.price
      : null;
  const collapsedDueMinOrder = rawRungs.length > collapsed.length;
  const singleExecutableRung = collapsed.length === 1;
  const crossing = candidateRungs.some((rung) => !rung.executable);
  const positiveFloorApplied = candidateRungs.some(
    (rung) => rung.roundedPrice + 1e-12 < rung.positiveFloorPrice,
  );
  const sameAsCurrent =
    currentFirst?.price != null &&
    firstCandidate?.price != null &&
    Math.abs(currentFirst.price - firstCandidate.price) <= 1e-9;
  const hasHigherExposureCandidate =
    candidateRungs.length > 1 &&
    candidateRungs.some((rung) => rung.price > candidateRungs[0]!.price);
  const wouldAvoidLowFullExitLe110 =
    isCheapTailBand(band) &&
    (currentFirst?.sizingFraction ?? 0) >= 0.99 &&
    (currentFirstTargetMultiple ?? Number.POSITIVE_INFINITY) <= 1.1 &&
    (effectiveFirstTargetMultiple ?? 0) > (currentFirstTargetMultiple ?? 0) + 1e-9;
  const pr2Conflict = hasPr2ProtectedExposureConflict(input.currentRungs, candidateRungs);
  const { result, reason } = resolveResultReason({
    candidateRungs,
    crossing,
    collapsedDueMinOrder,
    singleExecutableRung,
    positiveFloorApplied,
    sameAsCurrent,
    wouldAvoidLowFullExitLe110,
    hasHigherExposureCandidate,
    pr2Conflict,
  });
  return {
    variant: plan.variant,
    band,
    result,
    reason,
    avgEntry: input.avgEntryPrice,
    candidateRungs,
    firstTargetMultiple: firstCandidate?.targetMultiple ?? null,
    effectiveFirstTargetMultiple,
    firstSizeFraction: firstCandidate?.sizingFraction ?? null,
    currentFirstTargetMultiple,
    currentFirstSizeFraction: currentFirst?.sizingFraction ?? null,
    currentVsCandidatePriceDeltaPct: deltaPct,
    deltaBucket: deltaBucket(deltaPct),
    currentFirstFractionBucket: fractionBucket(currentFirst?.sizingFraction ?? null),
    candidateFirstFractionBucket: fractionBucket(firstCandidate?.sizingFraction ?? null),
    rungCountBucket: rungCountBucket(candidateRungs.length),
    collapseReason: collapseReason(collapsedDueMinOrder, singleExecutableRung),
    beforeCollapseRungCount: rawRungs.length,
    afterCollapseRungCount: collapsed.length,
    singleExecutableRung,
    collapsedDueMinOrder,
    wouldAvoidLowFullExitLe110,
    hasHigherExposureCandidate,
    pr2ProtectedExposureConflict: pr2Conflict,
  };
}

function resolveTargetKindForMultiplier(
  multiplier: number,
  targetConfig: ProfileLadderShadowEvaluationInput["config"]["bands"][ProfileLadderShadowEntryBand],
  fallback: ShadowTargetKind,
): ShadowTargetKind {
  if (Math.abs(multiplier - targetConfig.p25) <= 1e-9) return "p25";
  if (Math.abs(multiplier - targetConfig.median) <= 1e-9) return "median";
  if (Math.abs(multiplier - targetConfig.p75) <= 1e-9) return "p75";
  return fallback;
}

function resolveCheapTailFractions(
  input: ProfileLadderShadowEvaluationInput,
  band: ProfileLadderShadowEntryBand,
): readonly number[] {
  const currentFractions = input.currentRungs
    .map((rung) => rung.sizingFraction)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (currentFractions.length >= 2) {
    const firstTwo = currentFractions.slice(0, 2);
    const sum = firstTwo.reduce((acc, value) => acc + value, 0);
    if (sum > 0) return firstTwo.map((value) => roundRatio(value / sum));
  }
  const observedFirst = input.config.bands[band].observedMedianFirstFraction;
  if (observedFirst > 0 && observedFirst < 0.99) {
    return [roundRatio(observedFirst), roundRatio(1 - observedFirst)];
  }
  return [1, 0];
}

function resolveVariantCollapse(
  results: readonly ProfileLadderShadowCandidateResult[],
): ProfileLadderShadowVariantCollapse | null {
  const grouped = new Map<string, ProfileLadderShadowCandidateResult[]>();
  for (const result of results) {
    const first = result.candidateRungs[0];
    if (first == null) continue;
    const key = first.price.toFixed(6);
    grouped.set(key, [...(grouped.get(key) ?? []), result]);
  }
  const collapsed = [...grouped.entries()].find(([, group]) => group.length >= 2);
  if (collapsed == null) return null;
  const [price, group] = collapsed;
  const floorContributed = group.some((result) =>
    result.candidateRungs.some((rung) => rung.roundedPrice + 1e-12 < rung.positiveFloorPrice),
  );
  const tickContributed = group.some((result) =>
    result.candidateRungs.some((rung) => Math.abs(rung.rawPrice - rung.roundedPrice) > 1e-12),
  );
  const collapseType =
    floorContributed && tickContributed
      ? "same_effective_price_after_tick_and_floor"
      : floorContributed
        ? "same_effective_price_after_floor"
        : "same_effective_price_after_tick";
  return {
    collapseType,
    variants: group.map((result) => result.variant),
    effectivePrice: Number(price),
  };
}

function resolveResultReason(input: {
  candidateRungs: readonly ProfileLadderShadowCandidateRung[];
  crossing: boolean;
  collapsedDueMinOrder: boolean;
  singleExecutableRung: boolean;
  positiveFloorApplied: boolean;
  sameAsCurrent: boolean;
  wouldAvoidLowFullExitLe110: boolean;
  hasHigherExposureCandidate: boolean;
  pr2Conflict: boolean;
}): { result: ProfileLadderShadowResultLabel; reason: ProfileLadderShadowReasonLabel } {
  if (input.candidateRungs.length === 0) {
    return { result: "candidate_not_executable", reason: "below_min_order" };
  }
  if (input.crossing) return { result: "crossing_post_only", reason: "post_only_crossing" };
  if (input.pr2Conflict) return { result: "candidate_executable", reason: "pr2_conflict" };
  if (input.wouldAvoidLowFullExitLe110) {
    return { result: "candidate_executable", reason: "low_full_exit_le_110" };
  }
  if (input.hasHigherExposureCandidate) {
    return { result: "candidate_executable", reason: "higher_exposure_available" };
  }
  if (input.collapsedDueMinOrder) {
    return {
      result: "collapsed_by_min_order",
      reason: "collapsed_due_min_order",
    };
  }
  if (input.sameAsCurrent) return { result: "same_as_current", reason: "same_as_current" };
  if (input.positiveFloorApplied) {
    return { result: "candidate_executable", reason: "positive_floor_applied" };
  }
  return { result: "candidate_executable", reason: "ok" };
}

function hasPr2ProtectedExposureConflict(
  currentRungs: readonly LadderRung[],
  candidateRungs: readonly ProfileLadderShadowCandidateRung[],
): boolean {
  if (candidateRungs.length < 2) return false;
  const first = candidateRungs[0];
  if (first == null) return false;
  const higherCandidatePrices = candidateRungs.slice(1).map((rung) => rung.price);
  return currentRungs
    .filter((rung) => rung.lifecycle === "placed" || rung.lifecycle === "partially_filled")
    .some(
      (liveRung) =>
        liveRung.price > first.price &&
        higherCandidatePrices.some(
          (candidatePrice) => Math.abs(candidatePrice - liveRung.price) <= 1e-9,
        ),
    );
}

function isCheapTailBand(band: ProfileLadderShadowEntryBand): boolean {
  return band === "lt_0_005" || band === "gte_0_005_lt_0_01" || band === "gte_0_01_lt_0_02";
}

function hasValidCoreInputs(input: ProfileLadderShadowEvaluationInput): boolean {
  return (
    isPositiveFinite(input.avgEntryPrice) &&
    isPositiveFinite(input.costBasisUsd) &&
    isPositiveFinite(input.positionSizeShares) &&
    isPositiveFinite(input.tickSize) &&
    isPositiveFinite(input.minOrderSize)
  );
}

function isValidBbo(bestBid: number | null, bestAsk: number | null): boolean {
  return isPositiveFinite(bestBid) && isPositiveFinite(bestAsk) && bestBid < bestAsk;
}

function deltaBucket(deltaPct: number | null): ProfileLadderShadowDeltaBucket {
  if (deltaPct == null || Math.abs(deltaPct) <= 0.02) return "same_0_2pct";
  if (deltaPct < 0) return "candidate_lower";
  if (deltaPct <= 0.1) return "higher_2_10pct";
  if (deltaPct <= 0.25) return "higher_10_25pct";
  if (deltaPct <= 0.5) return "higher_25_50pct";
  return "higher_gt_50pct";
}

function fractionBucket(value: number | null): ProfileLadderShadowFractionBucket {
  if (value == null || value < 0.25) return "0_25";
  if (value < 0.5) return "25_50";
  if (value < 0.75) return "50_75";
  if (value < 0.99) return "75_99";
  return "full";
}

function rungCountBucket(count: number): ProfileLadderShadowRungCountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count === 2) return "2";
  return "3_plus";
}

function collapseReason(
  collapsedDueMinOrder: boolean,
  singleExecutableRung: boolean,
): ProfileLadderShadowCollapseReason {
  if (!collapsedDueMinOrder) return "none";
  return singleExecutableRung ? "min_order_to_single_rung" : "min_order";
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
