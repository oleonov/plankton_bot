/**
 * Gateway factory — maps runtime mode to the correct MarketDataGateway + ExchangeGateway pair.
 */

import type { MarketDataGateway, ExchangeGateway } from "@plankton/domain";
import {
  SimulationMarketDataGateway,
  SimulationExchangeGateway,
  LiveMarketDataGateway,
  LiveExchangeGateway,
  type UserEventStreamAuth,
} from "@plankton/exchange";

export interface CreateGatewaysInput {
  runtimeMode: "simulation" | "paper" | "live-lite";
  polyClient?: unknown;
  settlementClient?: unknown;
  traderAddress?: string | undefined;
  userWsAuth?: UserEventStreamAuth | null | undefined;
  /** Optional slug filter passed to live market data gateway. */
  slugFilter?: ((slug: string) => boolean) | undefined;
  /** Initial USDC balance for simulation/paper exchange gateway. Ignored in live-lite. */
  initialBalanceUsdc?: number;
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
    initialBalanceUsdc,
    onInfraAlert,
    marketDataMaxTrackedTokens,
    marketDataMaxWsShards,
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
  } = input;

  if (runtimeMode === "simulation") {
    return {
      marketDataGateway: new SimulationMarketDataGateway(),
      exchangeGateway: new SimulationExchangeGateway(
        initialBalanceUsdc !== undefined ? { initialBalanceUsdc } : undefined,
      ),
      modeLabel: "simulation",
      marketDataSource: "simulation",
      executionMode: "simulation",
    };
  }

  if (!polyClient) {
    throw new Error(`polyClient is required for ${runtimeMode} mode`);
  }

  const liveMarketDataConfig = {
    client: polyClient,
    slugFilter,
    maxTokens: marketDataMaxTrackedTokens,
    maxWsShards: marketDataMaxWsShards,
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
  };

  if (runtimeMode === "paper") {
    return {
      marketDataGateway: new LiveMarketDataGateway(liveMarketDataConfig),
      exchangeGateway: new SimulationExchangeGateway(
        initialBalanceUsdc !== undefined ? { initialBalanceUsdc } : undefined,
      ),
      modeLabel: "paper",
      marketDataSource: "live",
      executionMode: "simulation",
    };
  }

  // live-lite
  const liveExchangeConfig = {
    client: polyClient,
    settlementClient,
    ...(userWsAuth ? { userWsAuth } : {}),
    ...(traderAddress ? { traderAddress } : {}),
    ...(onInfraAlert ? { onInfraAlert } : {}),
  };
  return {
    marketDataGateway: new LiveMarketDataGateway(liveMarketDataConfig),
    exchangeGateway: new LiveExchangeGateway(liveExchangeConfig),
    modeLabel: "live-lite",
    marketDataSource: "live",
    executionMode: "live",
  };
}
