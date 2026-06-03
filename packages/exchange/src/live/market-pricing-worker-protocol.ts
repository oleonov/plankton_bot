import type { ParsedRecordMetrics } from "./market-pricing-ws-protocol.js";
import type {
  MarketPricingLifecycleEvent,
  MarketPricingRawTradeObservation,
  MarketPricingStreamUpdate,
  TradingNoopSuppressionCounts,
} from "@krabs/domain";

export type MarketPricingWorkerCommand =
  | {
      readonly type: "set-shard-token-ids";
      readonly shardId: number;
      readonly tokenIds: readonly string[];
    }
  | {
      readonly type: "set-token-ids";
      readonly tokenIds: readonly string[];
    }
  | {
      readonly type: "close-shard";
      readonly shardId: number;
    }
  | {
      readonly type: "close";
    };

export interface SerializedWorkerError {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly code?: string;
  readonly shardId?: number;
  readonly tokenCount?: number;
  readonly closeCode?: number;
  readonly closeReason?: string;
  readonly drainMs?: number;
}

export interface WorkerHeartbeatSnapshot {
  readonly pingSent: number;
  readonly pongReceived: number;
  readonly timeoutFired: number;
  readonly timeoutSuppressedByInbound: number;
  readonly lastPingSentAt: number | null;
  readonly lastPongAt: number | null;
  readonly lastInboundMessageAt: number | null;
  readonly workerEventLoopLagMaxMs: number;
}

export interface WorkerUpdateEnvelope {
  readonly updates: readonly MarketPricingStreamUpdate[];
  readonly rawTradeObservations: readonly MarketPricingRawTradeObservation[];
  readonly lifecycleEvents: readonly MarketPricingLifecycleEvent[];
  readonly metrics: ParsedRecordMetrics;
  readonly parsedUpdateCount: number;
  readonly emittedUpdateCount: number;
  readonly noopUpdateCount: number;
  readonly suppressedTradingNoopCount: number;
  readonly suppressedTradingNoopByReason: TradingNoopSuppressionCounts;
  readonly bookEventCount: number;
  readonly marketResolvedEventCount: number;
  readonly newMarketEventCount: number;
}

export interface WorkerUpdateBatchCounts {
  readonly parsedUpdateCount: number;
  readonly emittedUpdateCount: number;
  readonly noopUpdateCount: number;
  readonly suppressedTradingNoopCount: number;
  readonly suppressedTradingNoopByReason: TradingNoopSuppressionCounts;
}

export type MarketPricingWorkerEvent =
  | {
      readonly type: "records";
      readonly shardId?: number;
      readonly records: readonly unknown[];
      readonly metrics: ParsedRecordMetrics;
      readonly queueDepth: number;
    }
  | {
      readonly type: "update-batch-buffer";
      readonly shardId: number;
      readonly payload: ArrayBuffer;
      readonly queueDepth: number;
    }
  | {
      readonly type: "error";
      readonly error: SerializedWorkerError;
    }
  | {
      readonly type: "gap";
      readonly shardId: number;
      readonly reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout";
      readonly timestamp: number;
      readonly tokenIds: readonly string[];
    }
  | {
      readonly type: "reconnect-scheduled";
      readonly shardId: number;
    }
  | {
      readonly type: "queue-overflow";
      readonly shardId: number;
      readonly droppedTokenIds: readonly string[];
      readonly timestamp: number;
    }
  | {
      readonly type: "lag-warning";
      readonly shardId: number;
      readonly drainMs: number;
    }
  | {
      readonly type: "queue-depth";
      readonly shardId: number;
      readonly depth: number;
    }
  | {
      readonly type: "breaker-state";
      readonly shardId: number;
      readonly state: "closed" | "open" | "half-open";
      readonly tokenIds: readonly string[];
      readonly reopenAtMs: number;
    }
  | {
      readonly type: "heartbeat";
      readonly shardId: number;
      readonly heartbeat: WorkerHeartbeatSnapshot;
    };

export interface MarketPricingWorkerData {
  readonly workerId: number;
  readonly queueMax: number;
  readonly lagWarnMs: number;
  readonly overflowPolicy: "drop-oldest" | "reconnect";
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly shardBreakerReconnectsPerMin: number;
  readonly shardBreakerOpenMs: number;
  readonly shardBreakerOpenMaxMs: number;
  readonly streamStableMs: number;
  readonly heartbeatJitterSeedMs: number;
  readonly startDelayMs: number;
}
