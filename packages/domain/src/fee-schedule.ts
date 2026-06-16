import type {
  FeeScheduleConfig,
  FeeScheduleLiquidityRole,
  FeeSchedulePeriodConfig,
  FeeScheduleRequest,
  FeeScheduleScope,
} from "./types.js";

export const DEFAULT_FEE_SCHEDULE_CONFIG: FeeScheduleConfig = {
  enabled: false,
  apiPrimaryEnabled: true,
  scheduleFallbackEnabled: true,
  apiTtlMs: 300_000,
  apiMissTtlMs: 30_000,
  degradedEventCooldownMs: 300_000,
  periods: [],
};

export function selectFeeSchedulePeriod(
  config: FeeScheduleConfig,
  request: FeeScheduleRequest,
): FeeSchedulePeriodConfig | null {
  if (!config.enabled && config.periods.length === 0) return null;
  const asOfMs = normalizeAsOfMs(request.asOfMs);
  const candidates = config.periods.filter((period) => periodMatches(period, request, asOfMs));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => scopeRank(right.appliesTo) - scopeRank(left.appliesTo));
  return candidates[0] ?? null;
}

export function applicableMakerRebateFraction(input: {
  makerRebateFraction: number;
  intendedLiquidityRole: FeeScheduleLiquidityRole | undefined;
  postOnly?: boolean;
}): number {
  if (input.intendedLiquidityRole !== "maker") return 0;
  if (input.postOnly !== true) return 0;
  return positiveFiniteOrZero(input.makerRebateFraction);
}

export function validateFeeSchedulePeriods(periods: readonly FeeSchedulePeriodConfig[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const [index, period] of periods.entries()) {
    if (seen.has(period.periodId)) {
      issues.push(`feeSchedule.periods[${index}].periodId duplicate`);
    }
    seen.add(period.periodId);
    if (!isValidUtcTimestamp(period.startsAtUtc)) {
      issues.push(`feeSchedule.periods[${index}].startsAtUtc must be a valid UTC timestamp`);
    }
    if (period.endsAtUtc !== null && !isValidUtcTimestamp(period.endsAtUtc)) {
      issues.push(`feeSchedule.periods[${index}].endsAtUtc must be null or a valid UTC timestamp`);
    }
    const starts = Date.parse(period.startsAtUtc);
    const ends = period.endsAtUtc === null ? null : Date.parse(period.endsAtUtc);
    if (Number.isFinite(starts) && ends !== null && Number.isFinite(ends) && ends <= starts) {
      issues.push(`feeSchedule.periods[${index}] endsAtUtc must be after startsAtUtc`);
    }
    if (
      !Number.isFinite(period.makerRebateFraction) ||
      period.makerRebateFraction < 0 ||
      period.makerRebateFraction > 1
    ) {
      issues.push(`feeSchedule.periods[${index}].makerRebateFraction out of range [0, 1]`);
    }
  }
  issues.push(...findOverlaps(periods));
  return issues;
}

function periodMatches(
  period: FeeSchedulePeriodConfig,
  request: FeeScheduleRequest,
  asOfMs: number,
): boolean {
  const startsAtMs = Date.parse(period.startsAtUtc);
  if (!Number.isFinite(startsAtMs) || asOfMs < startsAtMs) return false;
  if (period.endsAtUtc !== null) {
    const endsAtMs = Date.parse(period.endsAtUtc);
    if (!Number.isFinite(endsAtMs) || asOfMs >= endsAtMs) return false;
  }
  return scopeMatches(period.appliesTo, request);
}

function scopeMatches(scope: FeeScheduleScope, request: FeeScheduleRequest): boolean {
  switch (scope.scope) {
    case "all":
      return true;
    case "category":
      return normalize(scope.value) === normalize(request.category ?? request.regime ?? null);
    case "condition":
      return scope.value === request.conditionId;
    case "token":
      return scope.value === request.tokenId;
  }
}

function scopeRank(scope: FeeScheduleScope): number {
  switch (scope.scope) {
    case "token":
      return 4;
    case "condition":
      return 3;
    case "category":
      return 2;
    case "all":
      return 1;
  }
}

function findOverlaps(periods: readonly FeeSchedulePeriodConfig[]): string[] {
  const issues: string[] = [];
  for (let leftIndex = 0; leftIndex < periods.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < periods.length; rightIndex += 1) {
      const left = periods[leftIndex]!;
      const right = periods[rightIndex]!;
      if (!sameScope(left.appliesTo, right.appliesTo)) continue;
      if (windowsOverlap(left, right)) {
        issues.push(`feeSchedule.periods overlap for scope ${scopeKey(left.appliesTo)}`);
      }
    }
  }
  return issues;
}

function windowsOverlap(left: FeeSchedulePeriodConfig, right: FeeSchedulePeriodConfig): boolean {
  const leftStart = Date.parse(left.startsAtUtc);
  const rightStart = Date.parse(right.startsAtUtc);
  const leftEnd = left.endsAtUtc === null ? Number.POSITIVE_INFINITY : Date.parse(left.endsAtUtc);
  const rightEnd =
    right.endsAtUtc === null ? Number.POSITIVE_INFINITY : Date.parse(right.endsAtUtc);
  if (![leftStart, rightStart].every(Number.isFinite)) return false;
  if (!Number.isFinite(leftEnd) && leftEnd !== Number.POSITIVE_INFINITY) return false;
  if (!Number.isFinite(rightEnd) && rightEnd !== Number.POSITIVE_INFINITY) return false;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function sameScope(left: FeeScheduleScope, right: FeeScheduleScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

function scopeKey(scope: FeeScheduleScope): string {
  return scope.scope === "all" ? "all" : `${scope.scope}:${normalize(scope.value)}`;
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeAsOfMs(asOfMs: number): number {
  return Number.isFinite(asOfMs) ? asOfMs : Date.now();
}

function isValidUtcTimestamp(value: string): boolean {
  if (typeof value !== "string" || !value.endsWith("Z")) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function positiveFiniteOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
