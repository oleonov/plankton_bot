export interface FamilyCapsDefaults {
  readonly maxOpenValueUsdc: number;
  readonly maxActiveMarkets: number;
  readonly maxDustPositions: number;
  readonly tailQuarantineThresholdUsdc: number;
  readonly tailQuarantineThresholdRatio: number;
}

/**
 * Default caps for newly materialized probe-only families.
 * UI editors use the market/dust/open-value fields; server-side flows also
 * consume the tail ratio so future discovery families materialize with the
 * same policy instead of falling back to SQL defaults.
 */
export const PROBE_DEFAULTS: FamilyCapsDefaults = {
  maxOpenValueUsdc: 10,
  maxActiveMarkets: 100,
  maxDustPositions: 50,
  tailQuarantineThresholdUsdc: 1000.0,
  tailQuarantineThresholdRatio: 1000.0,
};

/**
 * Default caps for scaled (promoted) families.
 * Used by promote UI, command-poller fallback, and DB writers.
 */
export const SCALED_DEFAULTS: FamilyCapsDefaults = {
  maxOpenValueUsdc: 50,
  maxActiveMarkets: 100,
  maxDustPositions: 50,
  tailQuarantineThresholdUsdc: 1000.0,
  tailQuarantineThresholdRatio: 1000.0,
};
