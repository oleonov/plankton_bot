import {
  type MarketPricingLifecycleEvent,
  type MarketPricingFullBookReason,
  type MarketPricingSnapshot,
  type MarketPricingStream,
  type MarketPricingStreamMetricsSnapshot,
  type MarketPricingStreamUpdate,
} from "@krabs/domain";
import { Worker } from "node:worker_threads";
import {
  normalizeWebSocketPayload,
  summarizeLatencySamples,
  type MarketDataWebSocketLike,
} from "./market-data-stream-shared.js";
import { BoundedQueue } from "./bounded-queue.js";
import { collectStreamUpdates } from "./market-pricing-record-parser.js";
import type {
  MarketPricingWorkerCommand,
  MarketPricingWorkerData,
  MarketPricingWorkerEvent,
  WorkerMemorySnapshot,
  WorkerUpdateEnvelope,
  WorkerHeartbeatSnapshot,
} from "./market-pricing-worker-protocol.js";
import {
  arraysEqual,
  buildMarketSubscriptionPayload,
  buildMarketSubscriptionUpdatePayload,
  chunkItems,
  CLOB_MARKET_WS_URL,
  collectStreamUpdatesMetricsOnly,
  extractTokenIdsFromRecords,
  HEARTBEAT_PING,
  isPongPayload,
  normalizeTokenIds,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  type ParsedRecordMetrics,
} from "./market-pricing-ws-protocol.js";
import { computeReconnectDelayMs } from "./reconnect-backoff.js";

const DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION = 500;
const METRICS_WINDOW_MS = 10 * 60 * 1000;
const STREAM_TELEMETRY_WINDOW_MS = 60_000;
// Cap per-window latency samples. Each reconnect can burst thousands of samples
// (one per WS event × ~500 tokens/shard × 20 shards). Under a reconnect storm
// the window doesn't rotate (still <10 min) so samples accumulate into tens of
// MB before rotation. The cap keeps p50/p95 accuracy while bounding memory.
const MAX_LATENCY_SAMPLES_PER_WINDOW = 10_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_SHARD_BREAKER_RECONNECTS_PER_MIN = 10;
const DEFAULT_SHARD_BREAKER_OPEN_MS = 120_000;
const DEFAULT_SHARD_BREAKER_OPEN_MAX_MS = 600_000;
const DEFAULT_CIRCUIT_SHARD_OPEN_PERCENT = 50;
const DEFAULT_CIRCUIT_OPEN_SHARD_FLOOR = 3;
const DEFAULT_CIRCUIT_OPEN_MS = 120_000;
const DEFAULT_STREAM_STABLE_MS = 30_000;
const DEFAULT_QUEUE_MAX = 256;
const DEFAULT_LAG_WARN_MS = 2_000;
const DEFAULT_OVERFLOW_POLICY: OverflowPolicy = "drop-oldest";
const DEFAULT_WORKER_OLD_SPACE_MB = 200;
const DEFAULT_WORKER_YOUNG_SPACE_MB = 32;
const DEFAULT_WORKER_MEMORY_SAMPLE_MS = 10_000;
const DEFAULT_WORKER_MEMORY_WARN_RSS_MB = 250;
const DEFAULT_WORKER_START_STAGGER_MS = 750;
// Minimum interval between lag warnings per shard to avoid log spam.
const LAG_WARN_COOLDOWN_MS = 30_000;

type OverflowPolicy = "drop-oldest" | "reconnect";

interface StreamWindow {
  windowStartMs: number;
  wsEventsReceived: number;
  wsUpdatesApplied: number;
  latencySamples: LatencySampleRingBuffer;
  reconnectCount: number;
  wsEventGapDetected: number;
  wsGapsByShard: Record<string, number>;
  bookEventsReceived: number;
  marketResolvedEvents: number;
  newMarketEvents: number;
}

interface StreamTelemetryWindow {
  windowStartMs: number;
  rawWsRecords: number;
  parsedUpdates: number;
  noopUpdates: number;
}

export class LatencySampleRingBuffer {
  private readonly samples: Float64Array;
  private writeIdx = 0;
  private filled = false;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("latency sample capacity must be a positive integer");
    }
    this.samples = new Float64Array(capacity);
  }

  push(value: number): void {
    this.samples[this.writeIdx] = value;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.writeIdx === 0) this.filled = true;
  }

  pushMany(values: readonly number[]): void {
    for (const value of values) this.push(value);
  }

  toArray(): number[] {
    if (!this.filled) {
      return Array.from(this.samples.slice(0, this.writeIdx));
    }
    return [
      ...Array.from(this.samples.slice(this.writeIdx)),
      ...Array.from(this.samples.slice(0, this.writeIdx)),
    ];
  }
}

interface WorkerHeartbeatAggregate {
  pingSent: number;
  pongReceived: number;
  timeoutFired: number;
  timeoutSuppressedByInbound: number;
  workerEventLoopLagMaxMs: number;
  byShard: Record<string, WorkerHeartbeatSnapshot>;
}

interface WorkerMemoryAggregate {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  maxRssMb: number;
  byWorker: Record<string, WorkerMemorySnapshot>;
}

interface LiveMarketPricingStreamDeps {
  createWebSocket: (url: string) => MarketDataWebSocketLike;
  handlers: Readonly<{
    onUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
    onLifecycleEvents?: (events: readonly MarketPricingLifecycleEvent[]) => Promise<void> | void;
    onError?: (error: unknown) => Promise<void> | void;
    onGapDetected?: (
      info: Readonly<{
        reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout";
        timestamp: number;
        tokenIds?: readonly string[];
      }>,
    ) => Promise<void> | void;
  }>;
  maxSubscriptionsPerConnection?: number;
  now?: () => number;
  /** Max items in the per-shard ingress queue. Default: 256. */
  queueMax?: number;
  /** Emit a structured warning when drain-to-empty takes longer than this. Default: 2000 ms. */
  lagWarnMs?: number;
  /** Policy on queue overflow: drop oldest item or force reconnect. Default: "drop-oldest". */
  overflowPolicy?: OverflowPolicy;
  /** Base reconnect delay (ms) for exponential backoff. Default: 1000. */
  reconnectBaseMs?: number;
  /** Max reconnect delay (ms) cap. Default: 30000. */
  reconnectMaxMs?: number;
  /** Per-shard breaker: max reconnects in 60s before opening. Default: 10. */
  shardBreakerReconnectsPerMin?: number;
  /** Per-shard breaker initial open window (ms). Default: 120000. */
  shardBreakerOpenMs?: number;
  /** Per-shard breaker max open window (ms) — doubles on each reopen up to this. Default: 600000. */
  shardBreakerOpenMaxMs?: number;
  /** Stream-level quorum: percent of shards that must be open. Default: 50. */
  circuitShardOpenPercent?: number;
  /** Stream-level quorum: absolute floor of open shards required. Default: 3. */
  circuitOpenShardFloor?: number;
  /** Stream-level circuit open duration (ms). Default: 120000. */
  circuitOpenMs?: number;
  /** Milliseconds a shard/stream must be stable before breaker closes. Default: 30000. */
  streamStableMs?: number;
  /**
   * Move market WS shards into dedicated worker threads. Defaults to false
   * for injected test WebSocket factories and true in production gateway wiring.
   */
  useWorkerShards?: boolean;
  /**
   * Number of market WS worker groups. Each worker can own multiple shard sockets.
   * `0` keeps the legacy main-thread runtime as an operator kill-switch.
   */
  wsWorkerCount?: number;
}

interface ShardCallbacks {
  onRecords: (records: readonly unknown[]) => Promise<void> | void;
  onError: (error: unknown) => Promise<void> | void;
  onGapDetected: (
    reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout",
    timestamp: number,
    tokenIds: readonly string[],
  ) => void;
  onReconnectScheduled: () => void;
  onQueueOverflow: (shardId: number, droppedTokenIds: readonly string[], timestamp: number) => void;
  onLagWarning: (shardId: number, drainMs: number) => void;
  onShardQueueDepth: (depth: number) => void;
  /**
   * Called synchronously at parse-time (before enqueuing) so stream-level counters
   * like `wsEventsReceived` are updated immediately, regardless of queue drain state.
   */
  onMessageParsed: (records: readonly unknown[]) => void;
  /** Worker shards already parsed and counted records, so main can update counters without rescanning. */
  onMessageMetrics: (metrics: ParsedRecordMetrics) => void;
  /** Worker shards can send fully parsed compact batches so the main thread avoids raw-record parsing. */
  onWorkerUpdateBatch?: (
    updates: readonly MarketPricingStreamUpdate[],
    lifecycleEvents: readonly MarketPricingLifecycleEvent[],
    noopUpdateCount: number,
  ) => Promise<void> | void;
  /** Worker shards include parsed event-type counts with their compact batches. */
  onWorkerEventCounts?: (counts: {
    readonly bookEventCount: number;
    readonly marketResolvedEventCount: number;
    readonly newMarketEventCount: number;
  }) => void;
  /** Notifies the stream when this shard's breaker state changes. */
  onBreakerStateChanged: (shardId: number, state: ShardBreakerState) => void;
  /** Updates per-shard heartbeat telemetry emitted from worker context. */
  onHeartbeat?: (shardId: number, heartbeat: WorkerHeartbeatSnapshot) => void;
}

type ShardBreakerState = "closed" | "open" | "half-open";

interface PricingShardRuntime {
  setTokenIds(tokenIds: readonly string[]): void;
  close(): void;
  getQueueDepth(): number;
  getDesiredTokenIds(): readonly string[];
  getBreakerReopenAtMs(): number;
}

type ShardRuntimeDeps = Readonly<{
  shardId: number;
  createWebSocket: (url: string) => MarketDataWebSocketLike;
  queueMax: number;
  lagWarnMs: number;
  overflowPolicy: OverflowPolicy;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  shardBreakerReconnectsPerMin: number;
  shardBreakerOpenMs: number;
  shardBreakerOpenMaxMs: number;
  streamStableMs: number;
}> &
  ShardCallbacks;

type WorkerGroupDeps = Readonly<{
  queueMax: number;
  lagWarnMs: number;
  overflowPolicy: OverflowPolicy;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  shardBreakerReconnectsPerMin: number;
  shardBreakerOpenMs: number;
  shardBreakerOpenMaxMs: number;
  streamStableMs: number;
  onMemory: (workerId: number, memory: WorkerMemorySnapshot) => void;
}>;

export class LiveMarketPricingStream implements MarketPricingStream {
  private readonly pricingByToken = new Map<string, MarketPricingSnapshot>();
  private readonly shards = new Map<number, PricingShardRuntime>();
  private readonly workerGroups = new Map<number, WorkerMarketPricingGroup>();
  private readonly now: () => number;
  private readonly maxSubscriptionsPerConnection: number;
  private readonly queueMax: number;
  private readonly lagWarnMs: number;
  private readonly overflowPolicy: OverflowPolicy;
  // Breaker config
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly shardBreakerReconnectsPerMin: number;
  private readonly shardBreakerOpenMs: number;
  private readonly shardBreakerOpenMaxMs: number;
  private readonly circuitShardOpenPercent: number;
  private readonly circuitOpenShardFloor: number;
  private readonly circuitOpenMs: number;
  private readonly streamStableMs: number;
  private readonly useWorkerShards: boolean;
  private readonly wsWorkerCount: number;
  private desiredTokenIds: string[] = [];
  // Pending desired tokens while stream breaker is open — applied on stream_circuit_closed.
  private pendingDesiredTokenIds: string[] | null = null;
  private closed = false;
  private window: StreamWindow;
  private telemetryWindow: StreamTelemetryWindow;
  private rawWsRecords = 0;
  private parsedUpdates = 0;
  private noopUpdates = 0;
  // Lifetime queue metrics (not window-rotated; monotonically increasing)
  private totalQueueOverflows = 0;
  private totalMaxQueueDepth = 0;
  // Stream-level circuit breaker state
  private streamBreakerOpen = false;
  private streamBreakerTimer: ReturnType<typeof setTimeout> | null = null;
  private streamStableTimer: ReturnType<typeof setTimeout> | null = null;
  // Shard breaker states indexed by shardId (shards map may not contain open shards)
  private readonly shardBreakerStates = new Map<number, ShardBreakerState>();
  private readonly heartbeatByShard = new Map<number, WorkerHeartbeatSnapshot>();
  private readonly memoryByWorker = new Map<number, WorkerMemorySnapshot>();

  constructor(private readonly deps: LiveMarketPricingStreamDeps) {
    this.now = deps.now ?? Date.now;
    this.maxSubscriptionsPerConnection = Math.min(
      DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION,
      deps.maxSubscriptionsPerConnection ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION,
    );
    this.queueMax = deps.queueMax ?? DEFAULT_QUEUE_MAX;
    this.lagWarnMs = deps.lagWarnMs ?? DEFAULT_LAG_WARN_MS;
    this.overflowPolicy = deps.overflowPolicy ?? DEFAULT_OVERFLOW_POLICY;
    this.reconnectBaseMs = deps.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = deps.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.shardBreakerReconnectsPerMin =
      deps.shardBreakerReconnectsPerMin ?? DEFAULT_SHARD_BREAKER_RECONNECTS_PER_MIN;
    this.shardBreakerOpenMs = deps.shardBreakerOpenMs ?? DEFAULT_SHARD_BREAKER_OPEN_MS;
    this.shardBreakerOpenMaxMs = deps.shardBreakerOpenMaxMs ?? DEFAULT_SHARD_BREAKER_OPEN_MAX_MS;
    this.circuitShardOpenPercent =
      deps.circuitShardOpenPercent ?? DEFAULT_CIRCUIT_SHARD_OPEN_PERCENT;
    this.circuitOpenShardFloor = deps.circuitOpenShardFloor ?? DEFAULT_CIRCUIT_OPEN_SHARD_FLOOR;
    this.circuitOpenMs = deps.circuitOpenMs ?? DEFAULT_CIRCUIT_OPEN_MS;
    this.streamStableMs = deps.streamStableMs ?? DEFAULT_STREAM_STABLE_MS;
    this.useWorkerShards = deps.useWorkerShards ?? false;
    this.wsWorkerCount = Math.max(0, deps.wsWorkerCount ?? Number.POSITIVE_INFINITY);
    const nowMs = this.now();
    this.window = this.createEmptyWindow(nowMs);
    this.telemetryWindow = this.createEmptyTelemetryWindow(nowMs);
  }

  setTokenIds(tokenIds: readonly string[]): void {
    const next = normalizeTokenIds(tokenIds);
    if (arraysEqual(this.desiredTokenIds, next)) return;
    this.desiredTokenIds = next;
    // Prune pricing entries for tokens that dropped out of the desired set.
    // Previously pricingByToken only cleared on close() or full desired=[];
    // individual token churn left stale entries forever.
    if (next.length > 0 && this.pricingByToken.size > 0) {
      const desiredSet = new Set(next);
      for (const tokenKey of [...this.pricingByToken.keys()]) {
        if (!desiredSet.has(tokenKey)) this.pricingByToken.delete(tokenKey);
      }
    }
    if (this.closed) return;
    // While the stream-level breaker is open, store the desired set so it
    // can be applied when the stream recovers.
    if (this.streamBreakerOpen) {
      this.pendingDesiredTokenIds = next;
      return;
    }
    this.syncShards();
  }

  close(): void {
    this.closed = true;
    if (this.streamBreakerTimer) {
      clearTimeout(this.streamBreakerTimer);
      this.streamBreakerTimer = null;
    }
    if (this.streamStableTimer) {
      clearTimeout(this.streamStableTimer);
      this.streamStableTimer = null;
    }
    for (const shard of this.shards.values()) {
      shard.close();
    }
    this.shards.clear();
    for (const group of this.workerGroups.values()) {
      group.close();
    }
    this.workerGroups.clear();
    this.pricingByToken.clear();
  }

  getMetricsSnapshot(): MarketPricingStreamMetricsSnapshot {
    const nowMs = this.now();
    this.rotateWindow(nowMs);
    this.rotateTelemetryWindow(nowMs);
    const elapsedSeconds = Math.max(1, Math.floor((nowMs - this.window.windowStartMs) / 1000));
    // Aggregate current queue depth across all shards.
    let totalQueueDepth = 0;
    for (const shard of this.shards.values()) {
      totalQueueDepth += shard.getQueueDepth();
    }
    return {
      windowStartMs: this.window.windowStartMs,
      wsEventsReceived: this.window.wsEventsReceived,
      wsEventsReceivedPerSec: Number((this.window.wsEventsReceived / elapsedSeconds).toFixed(3)),
      wsUpdatesApplied: this.window.wsUpdatesApplied,
      trackedTokenCount: this.desiredTokenIds.length,
      shardCount: this.shards.size,
      reconnectCount: this.window.reconnectCount,
      wsEventGapDetected: this.window.wsEventGapDetected,
      wsGapsByShard: { ...this.window.wsGapsByShard },
      wsLatencyMs: summarizeLatencySamples(this.window.latencySamples.toArray()),
      rawWsRecords: this.rawWsRecords,
      rawWsRecordsPerSec: this.telemetryRate(this.telemetryWindow.rawWsRecords, nowMs),
      parsedUpdates: this.parsedUpdates,
      parsedUpdatesPerSec: this.telemetryRate(this.telemetryWindow.parsedUpdates, nowMs),
      noopUpdates: this.noopUpdates,
      noopUpdatesPerSec: this.telemetryRate(this.telemetryWindow.noopUpdates, nowMs),
      bookEventsReceived: this.window.bookEventsReceived,
      marketResolvedEvents: this.window.marketResolvedEvents,
      newMarketEvents: this.window.newMarketEvents,
      queueDepth: totalQueueDepth,
      maxQueueDepth: this.totalMaxQueueDepth,
      queueOverflows: this.totalQueueOverflows,
      wsHeartbeat: this.getHeartbeatAggregate(),
      wsWorkerMemory: this.getWorkerMemoryAggregate(),
    };
  }

  private getHeartbeatAggregate(): WorkerHeartbeatAggregate {
    const byShard: Record<string, WorkerHeartbeatSnapshot> = {};
    let pingSent = 0;
    let pongReceived = 0;
    let timeoutFired = 0;
    let timeoutSuppressedByInbound = 0;
    let workerEventLoopLagMaxMs = 0;
    for (const [shardId, heartbeat] of this.heartbeatByShard) {
      byShard[String(shardId)] = heartbeat;
      pingSent += heartbeat.pingSent;
      pongReceived += heartbeat.pongReceived;
      timeoutFired += heartbeat.timeoutFired;
      timeoutSuppressedByInbound += heartbeat.timeoutSuppressedByInbound;
      workerEventLoopLagMaxMs = Math.max(
        workerEventLoopLagMaxMs,
        heartbeat.workerEventLoopLagMaxMs,
      );
    }
    return {
      pingSent,
      pongReceived,
      timeoutFired,
      timeoutSuppressedByInbound,
      workerEventLoopLagMaxMs,
      byShard,
    };
  }

  private getWorkerMemoryAggregate(): WorkerMemoryAggregate {
    const byWorker: Record<string, WorkerMemorySnapshot> = {};
    let rssMb = 0;
    let heapUsedMb = 0;
    let heapTotalMb = 0;
    let externalMb = 0;
    let arrayBuffersMb = 0;
    let maxRssMb = 0;
    for (const [workerId, memory] of this.memoryByWorker) {
      byWorker[String(workerId)] = memory;
      rssMb += memory.rssMb;
      heapUsedMb += memory.heapUsedMb;
      heapTotalMb += memory.heapTotalMb;
      externalMb += memory.externalMb;
      arrayBuffersMb += memory.arrayBuffersMb;
      maxRssMb = Math.max(maxRssMb, memory.rssMb);
    }
    return {
      rssMb: Number(rssMb.toFixed(1)),
      heapUsedMb: Number(heapUsedMb.toFixed(1)),
      heapTotalMb: Number(heapTotalMb.toFixed(1)),
      externalMb: Number(externalMb.toFixed(1)),
      arrayBuffersMb: Number(arrayBuffersMb.toFixed(1)),
      maxRssMb: Number(maxRssMb.toFixed(1)),
      byWorker,
    };
  }

  setFullBookTokenIds(_reason: MarketPricingFullBookReason, _tokenIds: readonly string[]): void {
    // The low-level socket stream always forwards raw market events.
    // Full-book lifecycle filtering is handled by the shared hub layer.
  }

  private syncShards(): void {
    // Per-shard chunk size is derived upstream (gateway wiring) as
    // `min(500, ceil(maxTokens / maxShards))`, so the stream can treat
    // `maxSubscriptionsPerConnection` as the authoritative hard ceiling.
    const shardAssignments = chunkItems(this.desiredTokenIds, this.maxSubscriptionsPerConnection);
    const desiredShardIds = new Set<number>();

    shardAssignments.forEach((tokenIds, index) => {
      desiredShardIds.add(index);
      // Skip shards whose breaker is open — they handle their own token set on half-open.
      const breakerState = this.shardBreakerStates.get(index);
      if (breakerState === "open" || breakerState === "half-open") return;
      const shard = this.shards.get(index) ?? this.createShard(index);
      shard.setTokenIds(tokenIds);
    });

    for (const [shardId, shard] of this.shards.entries()) {
      if (desiredShardIds.has(shardId)) continue;
      shard.close();
      this.shards.delete(shardId);
      this.shardBreakerStates.delete(shardId);
    }
    this.closeIdleWorkerGroups();

    if (this.desiredTokenIds.length === 0) {
      this.pricingByToken.clear();
    }
  }

  private createShard(shardId: number): PricingShardRuntime {
    const shardDeps: ShardRuntimeDeps = {
      shardId,
      createWebSocket: this.deps.createWebSocket,
      queueMax: this.queueMax,
      lagWarnMs: this.lagWarnMs,
      overflowPolicy: this.overflowPolicy,
      reconnectBaseMs: this.reconnectBaseMs,
      reconnectMaxMs: this.reconnectMaxMs,
      shardBreakerReconnectsPerMin: this.shardBreakerReconnectsPerMin,
      shardBreakerOpenMs: this.shardBreakerOpenMs,
      shardBreakerOpenMaxMs: this.shardBreakerOpenMaxMs,
      streamStableMs: this.streamStableMs,
      onRecords: async (records) => {
        await this.handleShardRecords(records);
      },
      onError: async (error) => {
        await this.deps.handlers.onError?.(error);
      },
      onGapDetected: (reason, timestamp, tokenIds) => {
        this.recordShardGap(shardId, timestamp);
        void this.deps.handlers.onGapDetected?.({ reason, timestamp, tokenIds });
      },
      onReconnectScheduled: () => {
        this.rotateWindow(this.now());
        this.window.reconnectCount++;
      },
      onQueueOverflow: (sid, droppedTokenIds, timestamp) => {
        this.totalQueueOverflows++;
        // Emit queue_overflow as a lifecycle event so callers can trigger poll-fallback.
        void this.deps.handlers.onLifecycleEvents?.([
          {
            type: "queue_overflow",
            shardId: sid,
            droppedCount: 1,
            tokenIds: droppedTokenIds,
            timestamp,
          },
        ]);
        // Also record it as a gap so the gap counter stays consistent.
        this.recordShardGap(sid, timestamp);
      },
      onLagWarning: (sid, drainMs) => {
        // Emit a structured warning via onError so it surfaces in logs without crashing.
        void this.deps.handlers.onError?.(
          Object.assign(new Error(`market-pricing-stream shard ${sid} drain lag ${drainMs} ms`), {
            code: "STREAM_LAG_WARNING",
            shardId: sid,
            drainMs,
          }),
        );
      },
      onShardQueueDepth: (depth) => {
        if (depth > this.totalMaxQueueDepth) {
          this.totalMaxQueueDepth = depth;
        }
      },
      onMessageParsed: (records) => {
        // Count received messages synchronously at parse-time so wsEventsReceived
        // reflects all WS messages received, not just those processed from the queue.
        this.recordParsedMetrics(collectStreamUpdatesMetricsOnly(records, this.now()));
      },
      onMessageMetrics: (metrics) => {
        this.recordParsedMetrics(metrics);
      },
      onWorkerEventCounts: (counts) => {
        this.recordWorkerEventCounts(counts);
      },
      onWorkerUpdateBatch: async (updates, lifecycleEvents, noopUpdateCount) => {
        await this.handleWorkerUpdateBatch(updates, lifecycleEvents, noopUpdateCount);
      },
      onHeartbeat: (sid, heartbeat) => {
        this.heartbeatByShard.set(sid, heartbeat);
      },
      onBreakerStateChanged: (sid, state) => {
        const currentShard = this.shards.get(sid);
        if (currentShard) this.handleShardBreakerStateChanged(sid, state, currentShard);
      },
    };
    const shouldUseWorker = this.useWorkerShards && this.wsWorkerCount > 0;
    const shard: PricingShardRuntime = shouldUseWorker
      ? this.getWorkerGroup(shardId).createShard(shardDeps)
      : new MarketPricingShard(shardDeps);
    this.shards.set(shardId, shard);
    this.shardBreakerStates.set(shardId, "closed");
    return shard;
  }

  private getWorkerGroup(shardId: number): WorkerMarketPricingGroup {
    const workerCount = Math.max(1, this.wsWorkerCount);
    const workerId = resolveWorkerGroupId(shardId, workerCount);
    const existing = this.workerGroups.get(workerId);
    if (existing) return existing;
    const group = new WorkerMarketPricingGroup(workerId, {
      queueMax: this.queueMax,
      lagWarnMs: this.lagWarnMs,
      overflowPolicy: this.overflowPolicy,
      reconnectBaseMs: this.reconnectBaseMs,
      reconnectMaxMs: this.reconnectMaxMs,
      shardBreakerReconnectsPerMin: this.shardBreakerReconnectsPerMin,
      shardBreakerOpenMs: this.shardBreakerOpenMs,
      shardBreakerOpenMaxMs: this.shardBreakerOpenMaxMs,
      streamStableMs: this.streamStableMs,
      onMemory: (id, memory) => {
        this.memoryByWorker.set(id, memory);
      },
    });
    this.workerGroups.set(workerId, group);
    return group;
  }

  private closeIdleWorkerGroups(): void {
    for (const [workerId, group] of this.workerGroups) {
      if (group.getShardCount() > 0) continue;
      group.close();
      this.workerGroups.delete(workerId);
      this.memoryByWorker.delete(workerId);
    }
  }

  private recordParsedMetrics(metrics: ParsedRecordMetrics): void {
    const { rawRecordCount, eventCount, latencySamplesMs } = metrics;
    const nowMs = this.now();
    this.rotateTelemetryWindow(nowMs);
    this.rawWsRecords += rawRecordCount;
    this.telemetryWindow.rawWsRecords += rawRecordCount;
    if (eventCount > 0) {
      this.rotateWindow(nowMs);
      this.window.wsEventsReceived += eventCount;
    }
    if (latencySamplesMs.length > 0) {
      this.window.latencySamples.pushMany(latencySamplesMs);
    }
  }

  /** Called by a shard when its breaker transitions between states. */
  private handleShardBreakerStateChanged(
    shardId: number,
    state: ShardBreakerState,
    shard: PricingShardRuntime,
  ): void {
    this.shardBreakerStates.set(shardId, state);
    if (state === "open") {
      const tokenIds = shard.getDesiredTokenIds();
      const reopenAtMs = shard.getBreakerReopenAtMs();
      void this.deps.handlers.onLifecycleEvents?.([
        { type: "shard_circuit_open", shardId, tokenIds, reopenAtMs },
      ]);
      this.maybeOpenStreamBreaker();
    } else if (state === "closed") {
      void this.deps.handlers.onLifecycleEvents?.([
        { type: "shard_circuit_closed", shardId, tokenIds: shard.getDesiredTokenIds() },
      ]);
      this.maybeCloseStreamBreaker();
    }
  }

  /**
   * Checks whether the stream-level quorum guard should open.
   * AND semantic: both percent threshold AND absolute floor must be met.
   */
  private maybeOpenStreamBreaker(): void {
    if (this.streamBreakerOpen || this.closed) return;
    const totalCount = this.shardBreakerStates.size;
    const openCount = countOpenShards(this.shardBreakerStates);
    const percentMet =
      totalCount > 0 && openCount / totalCount >= this.circuitShardOpenPercent / 100;
    const floorMet = openCount >= this.circuitOpenShardFloor;
    if (percentMet && floorMet) {
      this.openStreamBreaker();
    }
  }

  /**
   * Re-checks whether the stream-level breaker should remain open after a shard closed.
   * If quorum is no longer met, the stable timer is already running from recovery.
   */
  private maybeCloseStreamBreaker(): void {
    // Closing logic is handled via the stable timer in openStreamBreaker half-open path.
    // This hook exists for future use or if we want early close on quorum drop.
  }

  private openStreamBreaker(): void {
    if (this.streamBreakerOpen || this.closed) return;
    this.streamBreakerOpen = true;
    const nowMs = this.now();
    const reopenAtMs = nowMs + this.circuitOpenMs;

    // Close all remaining active shards.
    for (const shard of this.shards.values()) {
      shard.close();
    }
    this.shards.clear();

    void this.deps.handlers.onLifecycleEvents?.([
      { type: "stream_circuit_open", reopenAtMs, reason: "quorum" },
    ]);

    // Schedule half-open attempt.
    this.streamBreakerTimer = setTimeout(() => {
      this.streamBreakerTimer = null;
      this.attemptStreamHalfOpen();
    }, this.circuitOpenMs);
  }

  private attemptStreamHalfOpen(): void {
    if (this.closed || !this.streamBreakerOpen) return;

    // Spin one shard covering a subset of desired tokens.
    const desiredNow = this.pendingDesiredTokenIds ?? this.desiredTokenIds;
    const sliceSize = Math.min(desiredNow.length, this.maxSubscriptionsPerConnection);
    const tokenSlice = desiredNow.slice(0, sliceSize);

    if (tokenSlice.length === 0) {
      // Nothing to subscribe — consider stream recovered immediately.
      this.closeStreamBreaker();
      return;
    }

    // Create a probe shard (shardId = 0).
    const probeShard = this.createShard(0);
    probeShard.setTokenIds(tokenSlice);

    // Start stable timer; if the shard stays up for streamStableMs, close breaker.
    this.streamStableTimer = setTimeout(() => {
      this.streamStableTimer = null;
      const currentState = this.shardBreakerStates.get(0);
      if (currentState === "closed" || currentState === undefined) {
        this.closeStreamBreaker();
      }
      // If the probe shard re-opened its own breaker, it will call
      // handleShardBreakerStateChanged which will re-trigger maybeOpenStreamBreaker.
      // Since streamBreakerOpen is still true, it won't double-open.
    }, this.streamStableMs);
  }

  private closeStreamBreaker(): void {
    if (!this.streamBreakerOpen) return;
    this.streamBreakerOpen = false;
    if (this.streamBreakerTimer) {
      clearTimeout(this.streamBreakerTimer);
      this.streamBreakerTimer = null;
    }
    if (this.streamStableTimer) {
      clearTimeout(this.streamStableTimer);
      this.streamStableTimer = null;
    }
    void this.deps.handlers.onLifecycleEvents?.([{ type: "stream_circuit_closed" }]);

    // Apply any pending desired token set and re-sync all shards.
    if (this.pendingDesiredTokenIds !== null) {
      this.desiredTokenIds = this.pendingDesiredTokenIds;
      this.pendingDesiredTokenIds = null;
    }
    this.syncShards();
  }

  private async handleShardRecords(records: readonly unknown[]): Promise<void> {
    const nowMs = this.now();
    this.rotateWindow(nowMs);
    const {
      updates,
      lifecycleEvents,
      noopUpdateCount,
      bookEventCount,
      marketResolvedEventCount,
      newMarketEventCount,
    } = collectStreamUpdates(records, this.pricingByToken, nowMs);
    // wsEventsReceived and latencySamplesMs are updated synchronously at parse-time
    // via onMessageParsed to reflect all received messages, not just drained ones.
    if (bookEventCount > 0) {
      this.window.bookEventsReceived += bookEventCount;
    }
    if (marketResolvedEventCount > 0) {
      this.window.marketResolvedEvents += marketResolvedEventCount;
    }
    if (newMarketEventCount > 0) {
      this.window.newMarketEvents += newMarketEventCount;
    }
    if (lifecycleEvents.length > 0) {
      await this.deps.handlers.onLifecycleEvents?.(lifecycleEvents);
    }
    this.rotateTelemetryWindow(nowMs);
    this.parsedUpdates += updates.length;
    this.noopUpdates += noopUpdateCount;
    this.telemetryWindow.parsedUpdates += updates.length;
    this.telemetryWindow.noopUpdates += noopUpdateCount;
    if (updates.length === 0) return;
    this.window.wsUpdatesApplied += updates.length;
    await this.deps.handlers.onUpdates(updates);
  }

  private async handleWorkerUpdateBatch(
    updates: readonly MarketPricingStreamUpdate[],
    lifecycleEvents: readonly MarketPricingLifecycleEvent[],
    noopUpdateCount: number,
  ): Promise<void> {
    const nowMs = this.now();
    this.rotateWindow(nowMs);
    for (const update of updates) {
      this.pricingByToken.set(update.tokenId, update.pricing);
    }
    if (lifecycleEvents.length > 0) {
      await this.deps.handlers.onLifecycleEvents?.(lifecycleEvents);
    }
    this.rotateTelemetryWindow(nowMs);
    this.parsedUpdates += updates.length;
    this.noopUpdates += noopUpdateCount;
    this.telemetryWindow.parsedUpdates += updates.length;
    this.telemetryWindow.noopUpdates += noopUpdateCount;
    if (updates.length === 0) return;
    this.window.wsUpdatesApplied += updates.length;
    await this.deps.handlers.onUpdates(updates);
  }

  private recordWorkerEventCounts(counts: {
    readonly bookEventCount: number;
    readonly marketResolvedEventCount: number;
    readonly newMarketEventCount: number;
  }): void {
    this.rotateWindow(this.now());
    this.window.bookEventsReceived += counts.bookEventCount;
    this.window.marketResolvedEvents += counts.marketResolvedEventCount;
    this.window.newMarketEvents += counts.newMarketEventCount;
  }

  private rotateWindow(nowMs: number): void {
    if (nowMs - this.window.windowStartMs <= METRICS_WINDOW_MS) return;
    this.window = this.createEmptyWindow(nowMs);
  }

  private rotateTelemetryWindow(nowMs: number): void {
    if (nowMs - this.telemetryWindow.windowStartMs <= STREAM_TELEMETRY_WINDOW_MS) return;
    this.telemetryWindow = this.createEmptyTelemetryWindow(nowMs);
  }

  private telemetryRate(count: number, nowMs: number): number {
    const elapsedSeconds = Math.max(
      1,
      Math.floor((nowMs - this.telemetryWindow.windowStartMs) / 1000),
    );
    return Number((count / elapsedSeconds).toFixed(3));
  }

  private createEmptyWindow(nowMs: number): StreamWindow {
    return {
      windowStartMs: nowMs,
      wsEventsReceived: 0,
      wsUpdatesApplied: 0,
      latencySamples: new LatencySampleRingBuffer(MAX_LATENCY_SAMPLES_PER_WINDOW),
      reconnectCount: 0,
      wsEventGapDetected: 0,
      wsGapsByShard: {},
      bookEventsReceived: 0,
      marketResolvedEvents: 0,
      newMarketEvents: 0,
    };
  }

  private createEmptyTelemetryWindow(nowMs: number): StreamTelemetryWindow {
    return {
      windowStartMs: nowMs,
      rawWsRecords: 0,
      parsedUpdates: 0,
      noopUpdates: 0,
    };
  }

  private recordShardGap(shardId: number, timestamp: number): void {
    this.rotateWindow(timestamp);
    this.window.wsEventGapDetected++;
    const key = String(shardId);
    this.window.wsGapsByShard[key] = (this.window.wsGapsByShard[key] ?? 0) + 1;
  }
}

class MarketPricingShard {
  private readonly intentionallyClosedSockets = new WeakSet<MarketDataWebSocketLike>();
  private readonly queue: BoundedQueue<readonly unknown[]>;
  private readonly lagWarnMs: number;
  private readonly overflowPolicy: OverflowPolicy;
  private socket: MarketDataWebSocketLike | null = null;
  private socketOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private breakerTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private desiredTokenIds: string[] = [];
  private subscribedTokenIds: string[] = [];
  // True while the drain loop is actively running — prevents concurrent drains.
  private draining = false;
  // Cooldown tracker for lag warnings — one warning per shard per LAG_WARN_COOLDOWN_MS.
  private lastLagWarnAt = 0;
  // Per-shard exponential backoff state
  private consecutiveReconnects = 0;
  // Sliding 60-second window of reconnect timestamps for breaker detection.
  private reconnectTimestamps: number[] = [];
  // Per-shard circuit breaker state
  private breakerState: ShardBreakerState = "closed";
  private currentOpenWindowMs: number;
  private breakerReopenAtMs = 0;

  constructor(private readonly deps: ShardRuntimeDeps) {
    this.queue = new BoundedQueue<readonly unknown[]>(deps.queueMax);
    this.lagWarnMs = deps.lagWarnMs;
    this.overflowPolicy = deps.overflowPolicy;
    this.currentOpenWindowMs = deps.shardBreakerOpenMs;
  }

  getQueueDepth(): number {
    return this.queue.size;
  }

  getBreakerState(): ShardBreakerState {
    return this.breakerState;
  }

  getBreakerReopenAtMs(): number {
    return this.breakerReopenAtMs;
  }

  setTokenIds(tokenIds: readonly string[]): void {
    const next = normalizeTokenIds(tokenIds);
    if (arraysEqual(this.desiredTokenIds, next)) return;
    this.desiredTokenIds = next;

    // While breaker is open or half-open, store desired set for when it closes.
    if (this.breakerState !== "closed") return;
    if (this.closed) return;

    if (this.desiredTokenIds.length === 0) {
      this.subscribedTokenIds = [];
      this.clearTimers();
      this.closeSocket({ intentional: true });
      return;
    }

    if (!this.socket) {
      this.connect();
      return;
    }

    if (this.socketOpen) {
      this.syncSubscription(this.socket);
    }
  }

  close(): void {
    this.closed = true;
    this.clearBreakerTimers();
    this.clearTimers();
    this.closeSocket({ intentional: true });
  }

  getDesiredTokenIds(): readonly string[] {
    return this.desiredTokenIds;
  }

  private connect(): void {
    if (this.closed || this.desiredTokenIds.length === 0) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      const socket = this.deps.createWebSocket(CLOB_MARKET_WS_URL);
      this.socket = socket;
      this.socketOpen = false;
      this.subscribedTokenIds = [];

      socket.onopen = () => {
        if (this.socket !== socket || this.closed) return;
        this.socketOpen = true;
        socket.send(buildMarketSubscriptionPayload(this.desiredTokenIds));
        this.subscribedTokenIds = [...this.desiredTokenIds];
        this.startHeartbeat(socket);
        // Start stable timer — resets consecutiveReconnects after streamStableMs of uptime.
        this.startStableTimer();
        // If we were in half-open state, the stable timer will confirm recovery.
      };

      socket.onmessage = (event) => {
        this.handleMessage(socket, event.data);
      };

      socket.onerror = (event) => {
        if (this.shouldIgnoreSocketError(socket)) return;
        void this.deps.onError(event);
      };

      socket.onclose = (event) => {
        const ignoreEvent = this.shouldIgnoreSocketClose(socket);
        if (this.socket === socket) {
          this.socket = null;
          this.socketOpen = false;
        }
        this.cancelStableTimer();
        if (ignoreEvent || this.closed) return;
        this.clearHeartbeat(socket);
        this.subscribedTokenIds = [];
        void this.deps.onError(
          Object.assign(new Error("market websocket closed"), {
            code: "MARKET_WS_SOCKET_CLOSED",
            shardId: this.deps.shardId,
            closeCode: event.code,
            closeReason: event.reason,
            tokenCount: this.desiredTokenIds.length,
          }),
        );
        this.deps.onGapDetected("socket-closed", Date.now(), this.desiredTokenIds);
        // If we were half-open and the socket closed before stable timer fired,
        // that means the half-open failed.
        if (this.breakerState === "half-open") {
          this.reopenBreakerWithDoubledWindow();
          return;
        }
        this.scheduleReconnect();
      };
    } catch (error) {
      this.deps.onGapDetected("connect-failed", Date.now(), this.desiredTokenIds);
      void this.deps.onError(error);
      if (this.breakerState === "half-open") {
        this.reopenBreakerWithDoubledWindow();
        return;
      }
      this.scheduleReconnect();
    }
  }

  /**
   * Parse the raw WS message synchronously and enqueue the records.
   * Returns immediately — draining is handled by the per-shard promise chain.
   */
  private handleMessage(socket: MarketDataWebSocketLike, data: unknown): void {
    if (this.socket !== socket) return;
    const text = normalizeWebSocketPayload(data);
    if (!text) return;
    const trimmed = text.trim();
    if (isPongPayload(trimmed)) {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      this.deps.onGapDetected("invalid-payload", Date.now(), this.desiredTokenIds);
      void this.deps.onError(
        new Error(`unexpected market websocket payload: ${trimmed}`, { cause: error }),
      );
      return;
    }

    if (isPongPayload(parsed)) {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      return;
    }

    const records: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    // Update stream-level receive counters synchronously before queuing.
    this.deps.onMessageParsed(records);
    this.enqueueRecords(records);
  }

  /**
   * Push records onto the bounded queue and kick the drain chain.
   * On overflow: drop-oldest emits a gap event; reconnect forces socket reconnect.
   */
  private enqueueRecords(records: readonly unknown[]): void {
    const result = this.queue.push(records);
    const depth = this.queue.size;
    this.deps.onShardQueueDepth(depth);

    if (result.droppedItem !== undefined) {
      if (this.overflowPolicy === "reconnect") {
        this.queue.clear();
        this.reconnect();
        return;
      }
      // drop-oldest: extract token IDs from the dropped message for the gap event.
      const droppedTokenIds = extractTokenIdsFromRecords(result.droppedItem);
      this.deps.onQueueOverflow(this.deps.shardId, droppedTokenIds, Date.now());
    }

    // If no drain is in flight, kick the drain loop. The drain loop starts its
    // async body synchronously (up to the first await inside it), which means
    // the first item is handed to onRecords synchronously — preserving the same
    // call-depth behaviour as the old fire-and-forget onmessage handler.
    if (!this.draining) {
      this.draining = true;
      void this.runDrainLoop();
    }
  }

  /**
   * Drain all queued items serially. Runs until the queue is empty.
   * Called with void — errors are forwarded to onError, never thrown.
   */
  private async runDrainLoop(): Promise<void> {
    while (this.queue.size > 0) {
      const item = this.queue.shift()!;
      const startMs = Date.now();
      try {
        await this.deps.onRecords(item);
      } catch (error) {
        void this.deps.onError(error);
      }
      const elapsed = Date.now() - startMs;
      if (elapsed > this.lagWarnMs) {
        const now = Date.now();
        if (now - this.lastLagWarnAt >= LAG_WARN_COOLDOWN_MS) {
          this.lastLagWarnAt = now;
          this.deps.onLagWarning(this.deps.shardId, elapsed);
        }
      }
    }
    this.draining = false;
  }

  private syncSubscription(socket: MarketDataWebSocketLike): void {
    if (this.socket !== socket || !this.socketOpen || this.closed) return;
    const next = this.desiredTokenIds;
    const prev = this.subscribedTokenIds;

    const toUnsubscribe = prev.filter((tokenId) => !next.includes(tokenId));
    if (toUnsubscribe.length > 0) {
      socket.send(buildMarketSubscriptionUpdatePayload("unsubscribe", toUnsubscribe, false));
    }

    const toSubscribe = next.filter((tokenId) => !prev.includes(tokenId));
    if (toSubscribe.length > 0) {
      socket.send(buildMarketSubscriptionUpdatePayload("subscribe", toSubscribe, true));
    }

    this.subscribedTokenIds = [...next];
  }

  private startHeartbeat(socket: MarketDataWebSocketLike): void {
    this.clearHeartbeat(socket);
    this.pingTimer = setInterval(() => {
      if (this.closed || this.socket !== socket) return;
      if (this.pongTimer) return;
      socket.send(HEARTBEAT_PING);
      this.pongTimer = setTimeout(() => {
        if (this.closed || this.socket !== socket) return;
        void this.deps.onError(
          Object.assign(new Error("market websocket pong timeout"), {
            code: "MARKET_WS_PONG_TIMEOUT",
            shardId: this.deps.shardId,
            tokenCount: this.desiredTokenIds.length,
          }),
        );
        this.deps.onGapDetected("pong-timeout", Date.now(), this.desiredTokenIds);
        this.reconnect();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private clearHeartbeat(socket: MarketDataWebSocketLike): void {
    if (this.socket !== socket && this.socket != null) return;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    this.clearTimers();
    this.subscribedTokenIds = [];
    this.closeSocket({ intentional: true });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closed) return;
    // Record this reconnect in the sliding 60-second window.
    const nowMs = Date.now();
    this.reconnectTimestamps.push(nowMs);
    // Prune entries older than 60 seconds.
    const cutoff = nowMs - 60_000;
    this.reconnectTimestamps = this.reconnectTimestamps.filter((t) => t >= cutoff);

    // Check if we should open the shard breaker.
    if (
      this.breakerState === "closed" &&
      this.reconnectTimestamps.length >= this.deps.shardBreakerReconnectsPerMin
    ) {
      this.openBreaker();
      return;
    }

    this.deps.onReconnectScheduled();
    this.consecutiveReconnects++;
    const delayMs = computeReconnectDelayMs(this.consecutiveReconnects - 1, {
      baseMs: this.deps.reconnectBaseMs,
      maxMs: this.deps.reconnectMaxMs,
      jitter: "full",
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private openBreaker(): void {
    this.breakerState = "open";
    const nowMs = Date.now();
    this.breakerReopenAtMs = nowMs + this.currentOpenWindowMs;
    // Close the socket immediately.
    this.clearTimers();
    this.closeSocket({ intentional: true });
    this.subscribedTokenIds = [];
    // Notify stream of state change (emits shard_circuit_open).
    this.deps.onBreakerStateChanged(this.deps.shardId, "open");
    // Schedule half-open attempt.
    this.breakerTimer = setTimeout(() => {
      this.breakerTimer = null;
      this.attemptHalfOpen();
    }, this.currentOpenWindowMs);
  }

  private attemptHalfOpen(): void {
    if (this.closed) return;
    this.breakerState = "half-open";
    this.deps.onBreakerStateChanged(this.deps.shardId, "half-open");
    // Single reconnect attempt — onopen sets a stable timer; onclose rereopens.
    this.connect();
  }

  private startStableTimer(): void {
    this.cancelStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.consecutiveReconnects = 0;
      // If we were in half-open, transition to closed.
      if (this.breakerState === "half-open") {
        this.breakerState = "closed";
        this.currentOpenWindowMs = this.deps.shardBreakerOpenMs;
        this.reconnectTimestamps = [];
        this.deps.onBreakerStateChanged(this.deps.shardId, "closed");
      }
    }, this.deps.streamStableMs);
  }

  private cancelStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private reopenBreakerWithDoubledWindow(): void {
    this.currentOpenWindowMs = Math.min(
      this.currentOpenWindowMs * 2,
      this.deps.shardBreakerOpenMaxMs,
    );
    this.breakerState = "closed"; // will be set to "open" inside openBreaker
    // Reset timestamps so we don't double-count.
    this.reconnectTimestamps = [];
    this.openBreaker();
  }

  private clearBreakerTimers(): void {
    if (this.breakerTimer) {
      clearTimeout(this.breakerTimer);
      this.breakerTimer = null;
    }
    this.cancelStableTimer();
  }

  private shouldIgnoreSocketError(socket: MarketDataWebSocketLike): boolean {
    if (this.intentionallyClosedSockets.has(socket)) return true;
    return this.socket !== socket && this.socket != null;
  }

  private shouldIgnoreSocketClose(socket: MarketDataWebSocketLike): boolean {
    if (this.intentionallyClosedSockets.has(socket)) {
      this.intentionallyClosedSockets.delete(socket);
      return true;
    }
    return this.socket !== socket && this.socket != null;
  }

  private closeSocket(opts?: { intentional?: boolean }): void {
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    if (socket && opts?.intentional) {
      this.intentionallyClosedSockets.add(socket);
    }
    socket?.close();
  }
}

class WorkerMarketPricingGroup {
  private worker: Worker;
  private readonly shardDeps = new Map<number, ShardRuntimeDeps>();
  private readonly shardDesired = new Map<number, string[]>();
  private readonly shardQueueDepth = new Map<number, number>();
  private readonly shardBreakerReopenAt = new Map<number, number>();
  private desiredTokenIds: string[] = [];
  private closed = false;

  constructor(
    private readonly workerId: number,
    private readonly deps: WorkerGroupDeps,
  ) {
    this.worker = this.spawnWorker();
  }

  createShard(deps: ShardRuntimeDeps): PricingShardRuntime {
    this.shardDeps.set(deps.shardId, deps);
    return new WorkerMarketPricingShardHandle(this, deps.shardId);
  }

  getShardCount(): number {
    return this.shardDeps.size;
  }

  setShardTokenIds(shardId: number, tokenIds: readonly string[]): void {
    const next = normalizeTokenIds(tokenIds);
    this.shardDesired.set(shardId, next);
    this.refreshDesiredTokenIds();
    this.sendCommand({ type: "set-shard-token-ids", shardId, tokenIds: next });
  }

  closeShard(shardId: number): void {
    this.shardDeps.delete(shardId);
    this.shardDesired.delete(shardId);
    this.shardQueueDepth.delete(shardId);
    this.shardBreakerReopenAt.delete(shardId);
    this.refreshDesiredTokenIds();
    if (!this.closed) this.sendCommand({ type: "close-shard", shardId });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.worker.postMessage({ type: "close" } satisfies MarketPricingWorkerCommand);
    } catch {
      // Termination below is the authoritative close path.
    }
    void this.worker.terminate();
  }

  getShardQueueDepth(shardId: number): number {
    return this.shardQueueDepth.get(shardId) ?? 0;
  }

  getShardDesiredTokenIds(shardId: number): readonly string[] {
    return this.shardDesired.get(shardId) ?? [];
  }

  getShardBreakerReopenAtMs(shardId: number): number {
    return this.shardBreakerReopenAt.get(shardId) ?? 0;
  }

  private spawnWorker(): Worker {
    const workerData: MarketPricingWorkerData = {
      queueMax: this.deps.queueMax,
      lagWarnMs: this.deps.lagWarnMs,
      overflowPolicy: this.deps.overflowPolicy,
      reconnectBaseMs: this.deps.reconnectBaseMs,
      reconnectMaxMs: this.deps.reconnectMaxMs,
      shardBreakerReconnectsPerMin: this.deps.shardBreakerReconnectsPerMin,
      shardBreakerOpenMs: this.deps.shardBreakerOpenMs,
      shardBreakerOpenMaxMs: this.deps.shardBreakerOpenMaxMs,
      streamStableMs: this.deps.streamStableMs,
      workerId: this.workerId,
      heartbeatJitterSeedMs: (this.workerId * 977) % PING_INTERVAL_MS,
      startDelayMs: this.workerId * DEFAULT_WORKER_START_STAGGER_MS,
      memorySampleMs: DEFAULT_WORKER_MEMORY_SAMPLE_MS,
      memoryWarnRssMb: DEFAULT_WORKER_MEMORY_WARN_RSS_MB,
    };
    const worker = new Worker(new URL("./market-pricing-shard-worker.js", import.meta.url), {
      workerData,
      resourceLimits: {
        maxOldGenerationSizeMb: DEFAULT_WORKER_OLD_SPACE_MB,
        maxYoungGenerationSizeMb: DEFAULT_WORKER_YOUNG_SPACE_MB,
      },
    });
    worker.on("message", (message: unknown) => this.handleWorkerMessage(message));
    worker.on("error", (error) => this.reportWorkerFailure(error));
    worker.on("exit", (code) => {
      if (this.closed || code === 0 || worker !== this.worker) return;
      this.reportWorkerFailure(
        Object.assign(
          new Error(`market-pricing worker ${this.workerId} exited with code ${code}`),
          {
            code: "MARKET_WS_WORKER_EXITED",
          },
        ),
      );
      if (this.shardDeps.size === 0) return;
      this.worker = this.spawnWorker();
      this.replayShardSubscriptions();
    });
    return worker;
  }

  private handleWorkerMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const event = message as MarketPricingWorkerEvent;
    if (event.type === "memory") {
      this.deps.onMemory(event.workerId, event.memory);
      return;
    }
    if (event.type === "error" && event.error.shardId == null) {
      this.reportWorkerFailure(deserializeWorkerError(event.error), { gap: false });
      return;
    }
    const shardId = resolveWorkerEventShardId(event);
    if (shardId == null) return;
    const deps = this.shardDeps.get(shardId);
    if (!deps) return;
    switch (event.type) {
      case "update-batch-buffer": {
        this.shardQueueDepth.set(shardId, event.queueDepth);
        const envelope = decodeWorkerUpdateEnvelope(event.payload);
        deps.onMessageMetrics(envelope.metrics);
        if (
          envelope.bookEventCount > 0 ||
          envelope.marketResolvedEventCount > 0 ||
          envelope.newMarketEventCount > 0
        ) {
          deps.onWorkerEventCounts?.({
            bookEventCount: envelope.bookEventCount,
            marketResolvedEventCount: envelope.marketResolvedEventCount,
            newMarketEventCount: envelope.newMarketEventCount,
          });
        }
        void deps.onWorkerUpdateBatch?.(
          envelope.updates,
          envelope.lifecycleEvents,
          envelope.noopUpdateCount,
        );
        break;
      }
      case "records":
        this.shardQueueDepth.set(shardId, event.queueDepth);
        deps.onMessageMetrics(event.metrics);
        void deps.onRecords(event.records);
        break;
      case "error":
        void deps.onError(deserializeWorkerError(event.error));
        break;
      case "gap":
        deps.onGapDetected(event.reason, event.timestamp, event.tokenIds);
        break;
      case "reconnect-scheduled":
        deps.onReconnectScheduled();
        break;
      case "queue-overflow":
        deps.onQueueOverflow(shardId, event.droppedTokenIds, event.timestamp);
        break;
      case "lag-warning":
        deps.onLagWarning(shardId, event.drainMs);
        break;
      case "queue-depth":
        this.shardQueueDepth.set(shardId, event.depth);
        deps.onShardQueueDepth(event.depth);
        break;
      case "breaker-state":
        this.shardBreakerReopenAt.set(shardId, event.reopenAtMs);
        this.shardDesired.set(shardId, normalizeTokenIds(event.tokenIds));
        this.refreshDesiredTokenIds();
        deps.onBreakerStateChanged(shardId, event.state);
        break;
      case "heartbeat":
        deps.onHeartbeat?.(shardId, event.heartbeat);
        break;
    }
  }

  private refreshDesiredTokenIds(): void {
    this.desiredTokenIds = normalizeTokenIds([...this.shardDesired.values()].flat());
  }

  private replayShardSubscriptions(): void {
    for (const [shardId, tokenIds] of this.shardDesired) {
      if (tokenIds.length > 0) {
        this.sendCommand({ type: "set-shard-token-ids", shardId, tokenIds });
      }
    }
  }

  private sendCommand(command: MarketPricingWorkerCommand): void {
    if (this.closed) return;
    try {
      this.worker.postMessage(command);
    } catch (error) {
      this.reportWorkerFailure(error);
      if (this.shardDeps.size === 0) return;
      this.worker = this.spawnWorker();
      if (command.type === "close") return;
      this.replayShardSubscriptions();
    }
  }

  private reportWorkerFailure(error: unknown, opts?: { gap?: boolean }): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    const failureCode =
      typeof (failure as Error & { code?: unknown }).code === "string"
        ? (failure as Error & { code: string }).code
        : "MARKET_WS_WORKER_FAILED";
    for (const [shardId, deps] of this.shardDeps) {
      const shardError = Object.assign(new Error(failure.message), {
        code: failureCode,
        shardId,
      });
      shardError.name = failure.name;
      if (failure.stack) shardError.stack = failure.stack;
      void deps.onError(shardError);
      if (opts?.gap !== false) {
        deps.onGapDetected("connect-failed", Date.now(), this.shardDesired.get(shardId) ?? []);
      }
    }
  }
}

class WorkerMarketPricingShardHandle implements PricingShardRuntime {
  private closed = false;

  constructor(
    private readonly group: WorkerMarketPricingGroup,
    private readonly shardId: number,
  ) {}

  getQueueDepth(): number {
    return this.group.getShardQueueDepth(this.shardId);
  }

  getDesiredTokenIds(): readonly string[] {
    return this.group.getShardDesiredTokenIds(this.shardId);
  }

  getBreakerReopenAtMs(): number {
    return this.group.getShardBreakerReopenAtMs(this.shardId);
  }

  setTokenIds(tokenIds: readonly string[]): void {
    if (this.closed) return;
    this.group.setShardTokenIds(this.shardId, tokenIds);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.group.closeShard(this.shardId);
  }
}

export function resolveWorkerGroupId(shardId: number, workerCount: number): number {
  return Math.max(0, shardId) % Math.max(1, workerCount);
}

function resolveWorkerEventShardId(event: MarketPricingWorkerEvent): number | null {
  if ("shardId" in event && typeof event.shardId === "number") return event.shardId;
  return null;
}

function decodeWorkerUpdateEnvelope(payload: ArrayBuffer): WorkerUpdateEnvelope {
  const json = new TextDecoder().decode(new Uint8Array(payload));
  return JSON.parse(json) as WorkerUpdateEnvelope;
}

function deserializeWorkerError(error: {
  readonly message: string;
  readonly name?: string;
  readonly stack?: string;
  readonly code?: string;
  readonly shardId?: number;
  readonly tokenCount?: number;
  readonly closeCode?: number;
  readonly closeReason?: string;
  readonly drainMs?: number;
}): Error {
  const result = Object.assign(new Error(error.message), {
    code: error.code,
    shardId: error.shardId,
    tokenCount: error.tokenCount,
    closeCode: error.closeCode,
    closeReason: error.closeReason,
    drainMs: error.drainMs,
  });
  result.name = error.name ?? "Error";
  if (error.stack) result.stack = error.stack;
  return result;
}

function countOpenShards(states: Map<number, ShardBreakerState>): number {
  let count = 0;
  for (const state of states.values()) {
    if (state === "open" || state === "half-open") count++;
  }
  return count;
}
