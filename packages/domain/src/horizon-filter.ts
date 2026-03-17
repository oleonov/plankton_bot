/**
 * Checks if a market's endDate is consistent with the family's declared horizon.
 * For "daily" horizon: endDate must be within maxDaysAhead of the reference date.
 * Returns true (permissive) for unknown horizons or missing endDates.
 */
export function matchesHorizon(
  familyHorizon: string,
  endDate: string | null,
  referenceDate: Date,
  maxDaysAhead: number = 3,
): boolean {
  // Only enforce for "daily" horizon currently
  if (familyHorizon !== "daily") return true;
  if (!endDate) return true; // permissive when unknown

  const end = new Date(endDate);
  if (isNaN(end.getTime())) return true;

  const diffMs = end.getTime() - referenceDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  // Must be in the future (within -1 day tolerance) and within maxDaysAhead
  return diffDays >= -1 && diffDays <= maxDaysAhead;
}
