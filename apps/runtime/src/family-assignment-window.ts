import type { FamilyIdentity } from "@plankton/domain";

/**
 * Keep long-dated deadline threshold families out of the active live universe.
 * Research showed deadline cadence can work, but threshold families outside the
 * short recycle window are structurally weak and not part of the proven
 * Plankton recurring core.
 */
export function resolveFamilyAssignmentMaxDaysAhead(
  family: Pick<FamilyIdentity, "horizon" | "regime">,
): number | undefined {
  if (family.horizon === "deadline" && family.regime === "threshold") {
    return 7;
  }
  return undefined;
}
