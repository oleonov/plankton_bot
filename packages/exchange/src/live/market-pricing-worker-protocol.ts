import type { ParsedRecordMetrics } from "./market-pricing-ws-protocol.js";

export type MarketPricingWorkerCommand =
  | {
      readonly type: "set-token-ids";
      readonly tokenIds: readonly string[];
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

export type MarketPricingWorkerEvent =
  | {
      readonly type: "records";
      readonly records: readonly unknown[];
      readonly metrics: ParsedRecordMetrics;
      readonly queueDepth: number;
    }
  | {
      readonly type: "error";
      readonly error: SerializedWorkerError;
    }
  | {
      readonly type: "gap";
      readonly reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout";
      readonly timestamp: number;
      readonly tokenIds: readonly string[];
    }
  | {
      readonly type: "reconnect-scheduled";
    }
  | {
      readonly type: "queue-overflow";
      readonly droppedTokenIds: readonly string[];
      readonly timestamp: number;
    }
  | {
      readonly type: "lag-warning";
      readonly drainMs: number;
    }
  | {
      readonly type: "queue-depth";
      readonly depth: number;
    }
  | {
      readonly type: "breaker-state";
      readonly state: "closed" | "open" | "half-open";
      readonly tokenIds: readonly string[];
      readonly reopenAtMs: number;
    }
  | {
      readonly type: "heartbeat";
      readonly heartbeat: WorkerHeartbeatSnapshot;
    };

export interface MarketPricingWorkerData {
  readonly shardId: number;
  readonly queueMax: number;
  readonly lagWarnMs: number;
  readonly overflowPolicy: "drop-oldest" | "reconnect";
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly shardBreakerReconnectsPerMin: number;
  readonly shardBreakerOpenMs: number;
  readonly shardBreakerOpenMaxMs: number;
  readonly streamStableMs: number;
  readonly heartbeatJitterMs: number;
}
