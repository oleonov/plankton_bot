export function resolveLiveLiteMaxFamilies(
  envelope: Record<string, unknown>,
  _deployedFamilyCount: number,
): number {
  const configured = envelope.maxFamilies;
  if (typeof configured === "number" && Number.isFinite(configured)) return configured;
  return 100;
}
