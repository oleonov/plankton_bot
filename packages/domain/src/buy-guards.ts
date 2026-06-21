import {
  classifyEffectiveResolutionMarket,
  type EffectiveResolutionConfidence,
  type EffectiveResolutionMarketClass,
} from "./effective-resolution.js";
import type { NormalizedMarket, BuyGuardsPolicy } from "./types.js";

export type BuyGuardAction = "allow" | "block";
export type StockCloseTailDampAction = "none" | "apply" | "telemetry";

export interface EffectiveBuyRunwayContext {
  readonly effectiveRunwayHours: number | null;
  readonly marketClass: EffectiveResolutionMarketClass;
  readonly confidence: EffectiveResolutionConfidence;
  readonly calendarMissing?: boolean;
}

export interface D3NearDeathGuardInput {
  readonly policy: BuyGuardsPolicy["d3NearDeathGuard"];
  readonly addPrice: number | null;
  readonly avgEntryPrice: number | null;
  readonly runway: EffectiveBuyRunwayContext | null;
}

export interface D3NearDeathGuardDecision {
  readonly action: BuyGuardAction;
  readonly reason: string;
  readonly dropVsRunningAvg: number | null;
  readonly thresholdBucket: string;
  readonly marketClass: EffectiveResolutionMarketClass | "unknown";
  readonly confidence: EffectiveResolutionConfidence | "unknown";
}

export interface StockCloseTailSizeDampInput {
  readonly policy: BuyGuardsPolicy["stockCloseTailSizeDamp"];
  readonly market: Pick<
    NormalizedMarket,
    "slug" | "eventSlug" | "question" | "endDate" | "groupItemTitle" | "tags" | "outcome"
  >;
  readonly baseSizeUsdc: number;
  readonly target: "probe" | "scale_in";
}

export interface StockCloseTailSizeDampDecision {
  readonly action: StockCloseTailDampAction;
  readonly reason: string;
  readonly baseSizeUsdc: number;
  readonly dampedSizeUsdc: number;
  readonly factor: number;
  readonly rangePct: number | null;
  readonly rangeLow: number | null;
  readonly rangeHigh: number | null;
  readonly marketClass: EffectiveResolutionMarketClass;
  readonly confidence: EffectiveResolutionConfidence;
  readonly thresholdBucket: string;
}

export function evaluateD3NearDeathGuard(input: D3NearDeathGuardInput): D3NearDeathGuardDecision {
  const runway = input.runway;
  const marketClass = runway?.marketClass ?? "unknown";
  const confidence = runway?.confidence ?? "unknown";
  const dropVsRunningAvg = computeDropVsRunningAvg(input.addPrice, input.avgEntryPrice);
  const thresholdBucket = bucketRunwayHours(runway?.effectiveRunwayHours ?? null);
  if (!input.policy.enabled) {
    return {
      action: "allow",
      reason: "disabled",
      dropVsRunningAvg,
      thresholdBucket,
      marketClass,
      confidence,
    };
  }
  if (
    runway?.calendarMissing === true &&
    runway.marketClass === "US_EQUITY_CLOSE" &&
    runway.confidence === "low"
  ) {
    return {
      action: "block",
      reason: "calendar_missing",
      dropVsRunningAvg,
      thresholdBucket,
      marketClass,
      confidence,
    };
  }
  if (!isFinitePositive(input.addPrice) || runway?.effectiveRunwayHours == null) {
    return {
      action: "allow",
      reason: "insufficient_data",
      dropVsRunningAvg,
      thresholdBucket,
      marketClass,
      confidence,
    };
  }
  if (runway.effectiveRunwayHours > input.policy.maxRunwayHours) {
    return {
      action: "allow",
      reason: "runway_above_threshold",
      dropVsRunningAvg,
      thresholdBucket,
      marketClass,
      confidence,
    };
  }
  if (
    runway.marketClass === "US_EQUITY_CLOSE" &&
    runway.confidence === "high" &&
    input.addPrice <= input.policy.stockClosePennyMaxAddPrice
  ) {
    return {
      action: "block",
      reason: "stock_close_penny_add",
      dropVsRunningAvg,
      thresholdBucket,
      marketClass,
      confidence,
    };
  }
  if (
    isFinitePositive(input.avgEntryPrice) &&
    input.addPrice <= input.policy.maxAddPrice &&
    dropVsRunningAvg != null &&
    dropVsRunningAvg <= input.policy.maxDropVsAvgPct
  ) {
    return {
      action: "block",
      reason: "near_death_add",
      dropVsRunningAvg,
      thresholdBucket,
      marketClass,
      confidence,
    };
  }
  return {
    action: "allow",
    reason: "not_near_death",
    dropVsRunningAvg,
    thresholdBucket,
    marketClass,
    confidence,
  };
}

export function applyStockCloseTailSizeDamp(
  input: StockCloseTailSizeDampInput,
): StockCloseTailSizeDampDecision {
  const marketClass = classifyEffectiveResolutionMarket(input.market);
  const parsedRange = parseCloseRange(input.market);
  const rangePct = parsedRange == null ? null : computeRangePct(parsedRange.low, parsedRange.high);
  const thresholdBucket = bucketRangePct(rangePct, input.policy.maxRangePct);
  const baseDecision = {
    baseSizeUsdc: input.baseSizeUsdc,
    dampedSizeUsdc: input.baseSizeUsdc,
    factor: input.policy.factor,
    rangePct,
    rangeLow: parsedRange?.low ?? null,
    rangeHigh: parsedRange?.high ?? null,
    marketClass,
    thresholdBucket,
  };
  if (!input.policy.enabled) {
    return { ...baseDecision, action: "none", reason: "disabled", confidence: "low" };
  }
  if (input.target === "probe" && !input.policy.applyToProbe) {
    return { ...baseDecision, action: "none", reason: "probe_damp_disabled", confidence: "low" };
  }
  if (input.target === "scale_in" && !input.policy.applyToScaleIn) {
    return {
      ...baseDecision,
      action: "none",
      reason: "scale_in_damp_disabled",
      confidence: "low",
    };
  }
  if (marketClass !== "US_EQUITY_CLOSE") {
    return { ...baseDecision, action: "none", reason: "not_us_equity_close", confidence: "low" };
  }
  if (rangePct == null) {
    return { ...baseDecision, action: "none", reason: "range_not_parsed", confidence: "low" };
  }
  if (rangePct > input.policy.maxRangePct) {
    return { ...baseDecision, action: "none", reason: "range_too_wide", confidence: "low" };
  }
  const outcome = normalizeOutcome(input.market.outcome);
  if (outcome === "yes") {
    return {
      ...baseDecision,
      action: "apply",
      reason: "stock_close_narrow_yes_tail",
      dampedSizeUsdc: input.baseSizeUsdc * input.policy.factor,
      confidence: "high",
    };
  }
  if (outcome === "unknown") {
    return {
      ...baseDecision,
      action: "telemetry",
      reason: "stock_close_narrow_outcome_uncertain",
      confidence: "medium",
    };
  }
  return {
    ...baseDecision,
    action: "none",
    reason: "outcome_not_yes",
    confidence: "low",
  };
}

export function computeDropVsRunningAvg(
  addPrice: number | null,
  avgEntryPrice: number | null,
): number | null {
  if (!isFinitePositive(addPrice) || !isFinitePositive(avgEntryPrice)) return null;
  return (addPrice - avgEntryPrice) / avgEntryPrice;
}

function parseCloseRange(
  market: Pick<NormalizedMarket, "slug" | "eventSlug" | "question" | "groupItemTitle">,
): { low: number; high: number } | null {
  const text = `${market.question ?? ""} ${market.groupItemTitle ?? ""} ${market.slug} ${
    market.eventSlug ?? ""
  }`;
  const patterns = [
    /\bclose(?:s)?\s+at\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(?:-|–|—|to)\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)/i,
    /\$\s*([0-9][0-9,]*(?:\.\d+)?)\s*(?:-|–|—|to)\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)/i,
    /\bbetween\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?)\s+(?:and|to)\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match == null) continue;
    const first = parseMarketNumber(match[1]);
    const second = parseMarketNumber(match[2]);
    if (!isFinitePositive(first) || !isFinitePositive(second) || first === second) continue;
    return { low: Math.min(first, second), high: Math.max(first, second) };
  }
  return null;
}

function computeRangePct(low: number, high: number): number | null {
  if (!isFinitePositive(low) || !isFinitePositive(high) || high <= low) return null;
  const midpoint = (low + high) / 2;
  if (!isFinitePositive(midpoint)) return null;
  return (high - low) / midpoint;
}

function normalizeOutcome(outcome: string | null | undefined): "yes" | "no" | "unknown" {
  const normalized = outcome?.trim().toLowerCase();
  if (normalized === "yes") return "yes";
  if (normalized === "no") return "no";
  return "unknown";
}

function parseMarketNumber(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function bucketRunwayHours(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return "missing";
  if (hours <= 1) return "<=1h";
  if (hours <= 3) return "<=3h";
  if (hours <= 6) return "<=6h";
  if (hours <= 12) return "<=12h";
  if (hours <= 24) return "<=24h";
  if (hours <= 72) return "<=72h";
  return ">72h";
}

function bucketRangePct(rangePct: number | null, threshold: number): string {
  if (rangePct == null || !Number.isFinite(rangePct)) return "missing";
  if (rangePct <= threshold) return `<=${Math.round(threshold * 100)}pct`;
  return `>${Math.round(threshold * 100)}pct`;
}
