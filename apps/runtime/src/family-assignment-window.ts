/**
 * family-assignment-window — stub retained for Phase 6→7 bridge.
 *
 * FamilyIdentity is no longer a domain type. Phase 7 will delete this file.
 */

export function resolveFamilyAssignmentMaxDaysAhead(family: {
  horizon?: string;
  regime?: string;
}): number | undefined {
  if (family.horizon === "deadline" && family.regime === "threshold") {
    return 7;
  }
  return undefined;
}
