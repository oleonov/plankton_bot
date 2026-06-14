import { LedgerPool } from "../ledger-pool.js";

/** Creates a LedgerPool that returns null for all profiles (no ledger files on disk). */
export function stubLedgerPool(): LedgerPool {
  return new LedgerPool("/nonexistent/control.db");
}

// Defaults for the market-data / axios / ingress / breaker / fallback env fields
// introduced by the 2026-04-22 socket-leak plan. Kept in one place so
// individual testConfig() helpers don't have to duplicate ~20 numeric fields.
export const MARKET_DATA_TEST_DEFAULTS = {
  marketScanHintMinIntervalMs: 900_000,
  reconciliationIntervalMs: 15_000,
  // Reconciliation hardening (#36) — reliable-fetch + phantom-gate defaults.
  reconciliationFetchRetries: 3,
  reconciliationFetchBackoffMs: [100, 500, 2000],
  reconciliationSuspiciousEmptyThreshold: 3,
  reconciliationConsecutiveMissThreshold: 3,
  reconciliationFillCompletionTolerance: 0.005,
  plannerSuppressionRollupWindowMs: 300_000,
  marketDataMaxTrackedTokens: 1_000,
  marketDataMaxWsShards: 2,
  wsWorkerCount: 0,
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
  marketDataFallbackPollConcurrency: 50,
  marketDataFallbackPollRatePerSec: 5,
  marketDataStaleTokenAgeMs: 30_000,
  universeFunnelLogIntervalMs: 60_000,
  // v063 — guard disabled in tests: in-memory test DBs are tiny and must never trip it.
  dbSizeGuard: {
    enabled: false,
    thresholdBytes: 30_000_000_000,
    checkIntervalMs: 60_000,
  },
};
