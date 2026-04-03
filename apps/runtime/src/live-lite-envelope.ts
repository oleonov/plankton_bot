export function resolveLiveLiteMaxFamilies(
  envelope: Record<string, unknown>,
  deployedFamilyCount: number,
): number {
  const configured = envelope.maxFamilies;
  if (typeof configured === "number" && Number.isFinite(configured)) return configured;
  return Math.max(10, deployedFamilyCount);
}
