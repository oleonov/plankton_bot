/**
 * Default caps for newly materialized probe-only families.
 * Single source of truth — used by API (accept endpoint) and frontend (Accept dialog).
 */
export const PROBE_DEFAULTS = {
  maxOpenValueUsdc: 10,
  maxActiveMarkets: 3,
  maxDustPositions: 2,
} as const;

/**
 * Default caps for scaled (promoted) families.
 * Single source of truth — used by API (promote endpoint), command-poller, and frontend (Promote dialog).
 */
export const SCALED_DEFAULTS = {
  maxOpenValueUsdc: 50,
  maxActiveMarkets: 5,
  maxDustPositions: 3,
} as const;
