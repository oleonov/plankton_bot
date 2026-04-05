export function resolveLiveLiteMaxFamilies(
  envelope: Record<string, unknown>,
  deployedFamilyCount: number,
): number {
  const configured = envelope.maxFamilies;
  if (typeof configured === "number" && Number.isFinite(configured)) return configured;
  // Default cap aligned with discovery auto-acceptor (was max(10, deployedCount) which is unbounded)
  return 100;
}
