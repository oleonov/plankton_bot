export const DISCOVERY_SCAN_INTERVAL_MS = 60 * 60 * 1000;
export const PROMOTION_EVALUATION_INTERVAL_MS = 5 * 60 * 1000;
export const DISMISSED_PROPOSAL_COOLDOWN_MS = 60 * 60 * 1000;

export function recentDismissalCutoffIso(
  now: Date,
  cooldownMs: number = DISMISSED_PROPOSAL_COOLDOWN_MS,
): string {
  return new Date(now.getTime() - cooldownMs).toISOString();
}
