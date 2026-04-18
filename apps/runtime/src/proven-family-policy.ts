/**
 * proven-family-policy — stubs retained for Phase 6→7 bridge.
 *
 * Family evidence is no longer loaded at runtime; all functions return
 * the safe/conservative default. Phase 7 will delete this file.
 */

export function isProvenNonThresholdFamily(_bundle: unknown): boolean {
  return false;
}

export function shouldRelaxNegativeTailProbeOnly(_bundle: unknown): boolean {
  return false;
}

export function shouldPromoteFallbackMarketability(
  _bundle: unknown,
  _tickSize: number | null | undefined,
): boolean {
  return false;
}
