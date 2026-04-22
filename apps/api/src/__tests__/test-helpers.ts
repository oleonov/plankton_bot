import { LedgerPool } from "../ledger-pool.js";

/** Creates a LedgerPool that returns null for all profiles (no ledger files on disk). */
export function stubLedgerPool(): LedgerPool {
  return new LedgerPool("/nonexistent/control.db");
}

// Defaults for the market-data / axios / ingress / breaker / fallback env fields
// introduced by the 2026-04-22 socket-leak plan. Kept in one place so
// individual testConfig() helpers don't have to duplicate ~20 numeric fields.
export const MARKET_DATA_TEST_DEFAULTS = {
  marketDataMaxTrackedTokens: 1_000,
  marketDataMaxWsShards: 2,
  marketDataDiscoveryPollIntervalMs: 60_000,
  marketDataDiscoveryBatchSize: 200,
  clobAxiosMaxSockets: 8,
  clobAxiosMaxFreeSockets: 2,
  clobAxiosIdleTimeoutMs: 30_000,
  marketDataIngressQueueMax: 256,
  marketDataIngressLagWarnMs: 2_000,
  marketDataIngressOverflowPolicy: "drop-oldest" as const,
  marketDataReconnectBaseMs: 1_000,
  marketDataReconnectMaxMs: 30_000,
  marketDataShardBreakerReconnectsPerMin: 10,
  marketDataShardBreakerOpenMs: 120_000,
  marketDataShardBreakerOpenMaxMs: 600_000,
  marketDataCircuitShardOpenPercent: 50,
  marketDataCircuitOpenShardFloor: 3,
  marketDataCircuitOpenMs: 120_000,
  marketDataStreamStableMs: 30_000,
  marketDataFallbackBatchSize: 500,
};
