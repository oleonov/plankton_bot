export const DISCOVERY_SCAN_INTERVAL_MS = 60 * 60 * 1000;
export const PROMOTION_EVALUATION_INTERVAL_MS = 5 * 60 * 1000;
export const DISMISSED_PROPOSAL_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Maximum time between full candidate score recomputes when no scan
 * succeeds. Normally rescoring is triggered post-scan; this is a safety
 * fallback to avoid scores going stale indefinitely if scans keep failing.
 */
export const SCORE_RECOMPUTE_FALLBACK_INTERVAL_MS = 60 * 60 * 1000;

export function recentDismissalCutoffIso(
  now: Date,
  cooldownMs: number = DISMISSED_PROPOSAL_COOLDOWN_MS,
): string {
  return new Date(now.getTime() - cooldownMs).toISOString();
}
