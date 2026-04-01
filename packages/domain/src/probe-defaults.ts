/**
 * Default caps for newly materialized probe-only families.
 * Single source of truth — used by API (accept endpoint) and frontend (Accept dialog).
 */
export const PROBE_DEFAULTS = {
  maxOpenValueUsdc: 10,
  maxActiveMarkets: 3,
  maxDustPositions: 2,
} as const;
