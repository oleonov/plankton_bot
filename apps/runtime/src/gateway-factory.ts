/**
 * Gateway factory — maps runtime mode to the correct MarketDataGateway + ExchangeGateway pair.
 */

import {
  assertSupportedRuntimeProfile,
  type ExchangeGateway,
  type MarketDataGateway,
  type DepHealthRecorder,
} from "@krabs/domain";
import {
  LiveMarketDataGateway,
  LiveExchangeGateway,
  createCollateralResolver,
  createRpcRotator,
  type UserEventStreamAuth,
  type RetryDiagnosticLogger,
} from "@krabs/exchange";
import { resolvePolygonRpcConfig } from "@krabs/config";

const USDC_POLYGON = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const PUSD_POLYGON = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const CONDITIONAL_TOKENS_POLYGON = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

export interface CreateGatewaysInput {
  runtimeMode: string;
  polyClient?: unknown;
  settlementClient?: unknown;
  traderAddress?: string | undefined;
  userWsAuth?: UserEventStreamAuth | null | undefined;
  /** Optional slug filter passed to live market data gateway. */
  slugFilter?: ((slug: string) => boolean) | undefined;
  /** Initial USDC balance for simulation/paper exchange gateway. Ignored in live-lite. */
  initialBalanceUsdc?: number;
  /** Polygon RPC URL — required for live-lite collateral resolution (USDC vs pUSD). */
  polygonRpcUrl?: string | undefined;
  /** Polygon RPC URLs in rotation order — retries the next endpoint when one is rate-limited. */
  polygonRpcUrls?: readonly string[] | undefined;
  /** Additional Polygon RPC fallback endpoint appended after the primary rotation list. */
  polygonRpcFallbackUrl?: string | undefined;
  /** Alchemy Polygon API keys (not URLs). Mapped to primary RPC URLs in rotation order. */
  alchemyPolygonKeys?: readonly string[] | undefined;
  /** Phase-2 dependency-latency recorder, threaded into the live gateways + RPC rotator. */
  depHealthRecorder?: DepHealthRecorder | null | undefined;
  onInfraAlert?:
    | ((alert: {
        code: string;
        severity: "warning" | "error";
        source: string;
        message: string;
        details?: Record<string, unknown> | undefined;
      }) => void)
    | undefined;
  /** Target tradable-universe size. Combined with maxWsShards to derive per-shard chunk size. */
  marketDataMaxTrackedTokens?: number | undefined;
  /** Hard cap on concurrent WS shards. Reads from env config. */
  marketDataMaxWsShards?: number | undefined;
  /** Max number of market WS shards moved into worker threads. */
  wsWorkerCount?: number | undefined;
  /** Max items in the per-shard ingress queue. Reads from env config. */
  marketDataIngressQueueMax?: number | undefined;
  /** Lag-warning threshold in ms. Reads from env config. */
  marketDataIngressLagWarnMs?: number | undefined;
  /** Overflow policy on full queue. Reads from env config. */
  marketDataIngressOverflowPolicy?: "drop-oldest" | "reconnect" | undefined;
  /** Base reconnect delay ms for exponential backoff. */
  marketDataReconnectBaseMs?: number | undefined;
  /** Max reconnect delay ms cap. */
  marketDataReconnectMaxMs?: number | undefined;
  /** Per-shard breaker: max reconnects per 60s window. */
  marketDataShardBreakerReconnectsPerMin?: number | undefined;
  /** Per-shard breaker initial open window ms. */
  marketDataShardBreakerOpenMs?: number | undefined;
  /** Per-shard breaker max open window ms. */
  marketDataShardBreakerOpenMaxMs?: number | undefined;
  /** Stream-level quorum percent of open shards (0–100). */
  marketDataCircuitShardOpenPercent?: number | undefined;
  /** Stream-level quorum absolute floor of open shards. */
  marketDataCircuitOpenShardFloor?: number | undefined;
  /** Stream-level circuit open duration ms. */
  marketDataCircuitOpenMs?: number | undefined;
  /** Stable uptime ms before a breaker closes. */
  marketDataStreamStableMs?: number | undefined;
  /** Retry count for reliable reconciliation fetches (open orders / fills). #36 */
  reconciliationFetchRetries?: number | undefined;
  /** Per-retry backoff ladder (ms) for reconciliation fetches. #36 */
  reconciliationFetchBackoffMs?: readonly number[] | undefined;
  /** Diagnostic sink for `unknown`-classified live fetch errors. #36 LOW 2 */
  fetchRetryLog?: RetryDiagnosticLogger | undefined;
}

export interface CreateGatewaysResult {
  marketDataGateway: MarketDataGateway;
  exchangeGateway: ExchangeGateway;
  modeLabel: string;
  marketDataSource: "live" | "simulation";
  executionMode: "simulation" | "live";
}

export function createGateways(input: CreateGatewaysInput): CreateGatewaysResult {
  const {
    runtimeMode,
    polyClient,
    settlementClient,
    traderAddress,
    userWsAuth,
    slugFilter,
    polygonRpcUrl,
    polygonRpcUrls,
    polygonRpcFallbackUrl,
    alchemyPolygonKeys,
    depHealthRecorder,
    onInfraAlert,
    marketDataMaxTrackedTokens,
    marketDataMaxWsShards,
    wsWorkerCount,
    marketDataIngressQueueMax,
    marketDataIngressLagWarnMs,
    marketDataIngressOverflowPolicy,
    marketDataReconnectBaseMs,
    marketDataReconnectMaxMs,
    marketDataShardBreakerReconnectsPerMin,
    marketDataShardBreakerOpenMs,
    marketDataShardBreakerOpenMaxMs,
    marketDataCircuitShardOpenPercent,
    marketDataCircuitOpenShardFloor,
    marketDataCircuitOpenMs,
    marketDataStreamStableMs,
    reconciliationFetchRetries,
    reconciliationFetchBackoffMs,
    fetchRetryLog,
  } = input;

  assertSupportedRuntimeProfile(runtimeMode);

  if (!polyClient) {
    throw new Error(`polyClient is required for ${runtimeMode} mode`);
  }

  const liveMarketDataConfig = {
    client: polyClient,
    slugFilter,
    maxTokens: marketDataMaxTrackedTokens,
    maxWsShards: marketDataMaxWsShards,
    wsWorkerCount,
    useWorkerShards: wsWorkerCount !== 0,
    queueMax: marketDataIngressQueueMax,
    lagWarnMs: marketDataIngressLagWarnMs,
    overflowPolicy: marketDataIngressOverflowPolicy,
    reconnectBaseMs: marketDataReconnectBaseMs,
    reconnectMaxMs: marketDataReconnectMaxMs,
    shardBreakerReconnectsPerMin: marketDataShardBreakerReconnectsPerMin,
    shardBreakerOpenMs: marketDataShardBreakerOpenMs,
    shardBreakerOpenMaxMs: marketDataShardBreakerOpenMaxMs,
    circuitShardOpenPercent: marketDataCircuitShardOpenPercent,
    circuitOpenShardFloor: marketDataCircuitOpenShardFloor,
    circuitOpenMs: marketDataCircuitOpenMs,
    streamStableMs: marketDataStreamStableMs,
    ...(depHealthRecorder ? { depHealthRecorder } : {}),
  };

  const { primaryUrls, fallbackUrls } = resolvePolygonRpcConfig({
    alchemyPolygonKeys,
    polygonRpcUrls,
    polygonRpcUrl,
    polygonRpcFallbackUrl,
  });
  // ONE rotator per process: shared by the collateral resolver and the gateway's
  // balance reader so the round-robin cursor is global, not per-consumer.
  const rpcRotator = createRpcRotator({
    primaryUrls,
    fallbackUrls,
    ...(depHealthRecorder ? { depHealthRecorder } : {}),
  });
  const collateralResolver = createCollateralResolver({
    rotator: rpcRotator,
    conditionalTokensAddress: CONDITIONAL_TOKENS_POLYGON,
    candidates: [USDC_POLYGON, PUSD_POLYGON],
  });
  const liveExchangeConfig = {
    client: polyClient,
    settlementClient,
    ...(userWsAuth ? { userWsAuth } : {}),
    ...(traderAddress ? { traderAddress } : {}),
    ...(onInfraAlert ? { onInfraAlert } : {}),
    ...(depHealthRecorder ? { depHealthRecorder } : {}),
    collateralResolver,
    rpcRotator,
    fetchRetry: {
      ...(reconciliationFetchRetries !== undefined ? { retries: reconciliationFetchRetries } : {}),
      ...(reconciliationFetchBackoffMs !== undefined
        ? { backoffMs: [...reconciliationFetchBackoffMs] }
        : {}),
      ...(fetchRetryLog ? { log: fetchRetryLog } : {}),
    },
  };
  return {
    marketDataGateway: new LiveMarketDataGateway(liveMarketDataConfig),
    exchangeGateway: new LiveExchangeGateway(liveExchangeConfig),
    modeLabel: "live-lite",
    marketDataSource: "live",
    executionMode: "live",
  };
}
