/**
 * Maps raw risk-gate rejection strings to canonical reason codes.
 * Used for deduplication and DB persistence of risk events.
 *
 * Static reasons are matched exactly. Dynamic reasons (containing numbers,
 * family IDs) are matched by prefix.
 */

const STATIC_CODES: Record<string, string> = {
  "family-in-flight-limit": "family_in_flight_limit",
  "live-lite-open-value-cap-exceeded": "live_lite_open_value_cap",
  "live-lite-active-markets-cap-exceeded": "live_lite_active_markets_cap",
  "live-lite-allowlist-rejected": "live_lite_allowlist",
  "family in quarantine mode": "operator_quarantine",
};

const PREFIX_CODES: [string, string][] = [
  ["open value would be", "max_open_value"],
  ["active markets", "max_active_markets"],
  ["dust positions", "max_dust_positions"],
  ["entry blocked — family in derived reduce-only", "derived_reduce_only"],
  ["family in derived reduce-only", "derived_reduce_only"],
  ["family in reduce-only mode", "operator_reduce_only"],
  ["family in probe-only mode", "operator_probe_only"],
  ["requirePositiveRecycleHistoryForScale", "require_positive_recycle"],
  ["family in derived probe-only", "derived_probe_only"],
  ["not found in rules", "family_not_found"],
  ["is disabled", "family_disabled"],
];

export function normalizeReasonCode(rawReason: string): string {
  const staticMatch = STATIC_CODES[rawReason];
  if (staticMatch) return staticMatch;

  for (const [prefix, code] of PREFIX_CODES) {
    if (rawReason.includes(prefix)) return code;
  }

  return "unknown_rejection";
}
