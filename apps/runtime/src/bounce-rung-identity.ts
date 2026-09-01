import type { BounceRungMetadata } from "@krabs/domain";

type BounceRungIdentity = Partial<
  Pick<BounceRungMetadata, "ladderId" | "rungIndex" | "rungIndicesCovered" | "isCleanupRung">
>;

function rungIndices(rung: BounceRungIdentity): readonly number[] {
  if (rung.rungIndicesCovered?.length) return rung.rungIndicesCovered;
  return typeof rung.rungIndex === "number" ? [rung.rungIndex] : [];
}

export function bounceRungsConflict(
  candidate: BounceRungIdentity,
  existing: BounceRungIdentity,
  existingWorking: boolean,
): boolean {
  if (candidate.ladderId !== existing.ladderId) return false;
  if (candidate.isCleanupRung === true) {
    return existing.isCleanupRung === true && existingWorking;
  }
  if (existing.isCleanupRung === true) return false;
  const candidateIndices = new Set(rungIndices(candidate));
  return rungIndices(existing).some((index) => candidateIndices.has(index));
}
