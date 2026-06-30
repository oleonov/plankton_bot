/**
 * Status-screen health — shared pure types + rules used by the API
 * (system-health route + StatusHistorySampler) and the web severity model, so
 * recorded history and the live screen can never disagree on the rank rule or
 * the set of tracked series.
 *
 * Pure by contract: no runtime/api/fs/db imports. The severity *computation*
 * (which depends on live DB signals) lives in the API; only the rank rule, the
 * worst-of-many reducer, and the closed series enum are shared here.
 */

export type StatusSev = "ok" | "warn" | "crit";

/** Ordinal severity: higher = worse. The single source of the rank order. */
export const STATUS_SEV_RANK: Record<StatusSev, number> = { ok: 0, warn: 1, crit: 2 };

/** Worst (highest-rank) severity in a list; "ok" for an empty list. */
export function worstStatusSev(severities: readonly StatusSev[]): StatusSev {
  return severities.reduce<StatusSev>(
    (acc, s) => (STATUS_SEV_RANK[s] > STATUS_SEV_RANK[acc] ? s : acc),
    "ok",
  );
}

/**
 * Closed set of history series. The writer, API and tests accept only these —
 * no dynamic labels. `uptime` is the overall roll-up; `module:*` mirror the
 * eight system modules surfaced on the Status screen.
 */
export const STATUS_SERIES = [
  "uptime",
  "module:scanner",
  "module:market_data",
  "module:strategy",
  "module:risk",
  "module:execution",
  "module:reconciliation",
  "module:redeem",
  "module:manager_api",
] as const;

export type StatusSeries = (typeof STATUS_SERIES)[number];
