/**
 * Checks if a market's endDate is consistent with the family's declared horizon.
 * Returns true for missing/invalid endDates because market metadata can be incomplete.
 */

export function matchesHorizon(
  horizon: string,
  endDate: string | null,
  referenceDate: Date,
  maxDaysAhead?: number,
): boolean {
  return isWithinAssignmentWindow(horizon, endDate, referenceDate, maxDaysAhead);
}

type HorizonWindow = { minHours: number; maxDays: number };

const HORIZON_WINDOWS: Record<string, HorizonWindow> = {
  "intraday-4h": { minHours: 0.5, maxDays: 0.33 },
  daily: { minHours: 1, maxDays: 3 },
  deadline: { minHours: 24, maxDays: 30 },
  "ad-hoc": { minHours: 1, maxDays: 14 },
};
const FALLBACK_WINDOW = { minHours: 1, maxDays: 7 };
const ASSIGNMENT_PAST_TOLERANCE_HOURS = 24;

export function isWithinHealthWindow(
  horizon: string,
  endDate: string | null,
  referenceDate: Date,
): boolean {
  return isWithinWindow(horizon, endDate, referenceDate);
}

function isWithinWindow(
  horizon: string,
  endDate: string | null,
  referenceDate: Date,
  maxDaysOverride?: number,
): boolean {
  const diffHours = getDiffHours(endDate, referenceDate);
  if (diffHours === null) return true;
  const window = resolveWindow(horizon, maxDaysOverride);
  return diffHours >= window.minHours && diffHours <= window.maxDays * 24;
}

function isWithinAssignmentWindow(
  horizon: string,
  endDate: string | null,
  referenceDate: Date,
  maxDaysOverride?: number,
): boolean {
  const diffHours = getDiffHours(endDate, referenceDate);
  if (diffHours === null) return true;
  const window = resolveWindow(horizon, maxDaysOverride);
  // Family assignment should keep near-expiry markets; health checks handle tradability.
  return diffHours >= -ASSIGNMENT_PAST_TOLERANCE_HOURS && diffHours <= window.maxDays * 24;
}

function getDiffHours(endDate: string | null, referenceDate: Date): number | null {
  if (!endDate) return null;
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return null;
  const diffMs = end.getTime() - referenceDate.getTime();
  return diffMs / (1000 * 60 * 60);
}

function resolveWindow(horizon: string, maxDaysOverride?: number): HorizonWindow {
  const baseWindow = HORIZON_WINDOWS[horizon] ?? FALLBACK_WINDOW;
  return maxDaysOverride === undefined ? baseWindow : { ...baseWindow, maxDays: maxDaysOverride };
}
