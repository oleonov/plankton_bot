import { getHeapStatistics } from "node:v8";
import { parentPort, workerData } from "node:worker_threads";
import type { MarketPricingSnapshot } from "@krabs/domain";
import { BoundedQueue } from "./bounded-queue.js";
import {
  defaultMarketDataWebSocketFactory,
  normalizeWebSocketPayload,
  type MarketDataWebSocketLike,
} from "./market-data-stream-shared.js";
import { collectStreamUpdates } from "./market-pricing-record-parser.js";
import {
  arraysEqual,
  buildMarketSubscriptionPayload,
  buildMarketSubscriptionUpdatePayload,
  CLOB_MARKET_WS_URL,
  extractTokenIdsFromRecords,
  HEARTBEAT_PING,
  isPongPayload,
  normalizeTokenIds,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
} from "./market-pricing-ws-protocol.js";
import type {
  MarketPricingWorkerCommand,
  MarketPricingWorkerData,
  MarketPricingWorkerEvent,
  SerializedWorkerError,
  WorkerHeartbeatSnapshot,
  WorkerMemorySnapshot,
  WorkerUpdateEnvelope,
} from "./market-pricing-worker-protocol.js";
import { computeReconnectDelayMs } from "./reconnect-backoff.js";

type ShardBreakerState = "closed" | "open" | "half-open";

const LAG_WARN_COOLDOWN_MS = 30_000;
const EVENT_LOOP_SAMPLE_MS = 1_000;
const MB = 1024 * 1024;

if (!parentPort) {
  throw new Error("market-pricing-shard-worker requires parentPort");
}

class WorkerMarketPricingController {
  private readonly shards = new Map<number, WorkerMarketPricingShard>();
  private readonly pendingTokenIdsByShard = new Map<number, readonly string[]>();
  private memoryTimer: ReturnType<typeof setInterval> | null = null;
  private activationTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private closed = false;

  constructor(private readonly cfg: MarketPricingWorkerData) {
    this.startMemorySampler();
    const delayMs = Math.max(0, cfg.startDelayMs);
    if (delayMs === 0) {
      this.activate();
    } else {
      this.activationTimer = setTimeout(() => this.activate(), delayMs);
    }
  }

  setShardTokenIds(shardId: number, tokenIds: readonly string[]): void {
    if (this.closed) return;
    if (tokenIds.length === 0) {
      this.closeShard(shardId);
      return;
    }
    if (!this.active) {
      this.pendingTokenIdsByShard.set(shardId, [...tokenIds]);
      return;
    }
    const shard = this.shards.get(shardId) ?? this.createShard(shardId);
    shard.setTokenIds(tokenIds);
  }

  closeShard(shardId: number): void {
    const shard = this.shards.get(shardId);
    if (!shard) return;
    shard.close();
    this.shards.delete(shardId);
  }

  close(): void {
    this.closed = true;
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer);
      this.memoryTimer = null;
    }
    if (this.activationTimer) {
      clearTimeout(this.activationTimer);
      this.activationTimer = null;
    }
    for (const shard of this.shards.values()) shard.close();
    this.shards.clear();
    this.pendingTokenIdsByShard.clear();
  }

  private createShard(shardId: number): WorkerMarketPricingShard {
    const shard = new WorkerMarketPricingShard(this.cfg, shardId);
    this.shards.set(shardId, shard);
    return shard;
  }

  private activate(): void {
    if (this.closed || this.active) return;
    this.active = true;
    this.activationTimer = null;
    const pending = [...this.pendingTokenIdsByShard.entries()];
    this.pendingTokenIdsByShard.clear();
    for (const [shardId, tokenIds] of pending) {
      this.setShardTokenIds(shardId, tokenIds);
    }
  }

  private startMemorySampler(): void {
    const sampleMs = Math.max(5_000, this.cfg.memorySampleMs);
    this.memoryTimer = setInterval(() => {
      const memory = readMemorySnapshot();
      this.post({ type: "memory", workerId: this.cfg.workerId, memory });
      if (memory.rssMb >= this.cfg.memoryWarnRssMb) {
        this.post({
          type: "error",
          error: {
            message: "market websocket worker memory high",
            code: "MARKET_WS_WORKER_MEMORY_HIGH",
            tokenCount: totalTokenCount(this.shards),
          },
        });
      }
    }, sampleMs);
  }

  private post(message: MarketPricingWorkerEvent): void {
    parentPort!.postMessage(message);
  }
}

class WorkerMarketPricingShard {
  private readonly queue: BoundedQueue<readonly unknown[]>;
  private readonly pricingByToken = new Map<string, MarketPricingSnapshot>();
  private readonly intentionallyClosedSockets = new WeakSet<MarketDataWebSocketLike>();
  private socket: MarketDataWebSocketLike | null = null;
  private socketOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatStartTimer: ReturnType<typeof setTimeout> | null = null;
  private breakerTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private eventLoopTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private draining = false;
  private desiredTokenIds: string[] = [];
  private subscribedTokenIds: string[] = [];
  private breakerState: ShardBreakerState = "closed";
  private currentOpenWindowMs: number;
  private breakerReopenAtMs = 0;
  private consecutiveReconnects = 0;
  private reconnectTimestamps: number[] = [];
  private lastLagWarnAt = 0;
  private expectedEventLoopTickAt = Date.now() + EVENT_LOOP_SAMPLE_MS;
  private workerEventLoopLagMaxMs = 0;
  private heartbeat: WorkerHeartbeatSnapshot = {
    pingSent: 0,
    pongReceived: 0,
    timeoutFired: 0,
    timeoutSuppressedByInbound: 0,
    lastPingSentAt: null,
    lastPongAt: null,
    lastInboundMessageAt: null,
    workerEventLoopLagMaxMs: 0,
  };

  constructor(
    private readonly cfg: MarketPricingWorkerData,
    private readonly shardId: number,
  ) {
    this.queue = new BoundedQueue<readonly unknown[]>(cfg.queueMax);
    this.currentOpenWindowMs = cfg.shardBreakerOpenMs;
    this.startEventLoopSampler();
  }

  setTokenIds(tokenIds: readonly string[]): void {
    const next = normalizeTokenIds(tokenIds);
    if (arraysEqual(this.desiredTokenIds, next)) return;
    this.desiredTokenIds = next;
    this.prunePricing(next);
    if (this.breakerState !== "closed" || this.closed) return;
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
    if (this.socketOpen) this.syncSubscription(this.socket);
  }

  close(): void {
    this.closed = true;
    this.clearBreakerTimers();
    this.clearTimers();
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer);
      this.eventLoopTimer = null;
    }
    this.queue.clear();
    this.pricingByToken.clear();
    this.closeSocket({ intentional: true });
  }

  getDesiredTokenCount(): number {
    return this.desiredTokenIds.length;
  }

  private prunePricing(tokenIds: readonly string[]): void {
    const desired = new Set(tokenIds);
    for (const tokenId of [...this.pricingByToken.keys()]) {
      if (!desired.has(tokenId)) this.pricingByToken.delete(tokenId);
    }
  }

  private connect(): void {
    if (this.closed || this.desiredTokenIds.length === 0) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      const socket = defaultMarketDataWebSocketFactory(CLOB_MARKET_WS_URL);
      this.socket = socket;
      this.socketOpen = false;
      this.subscribedTokenIds = [];
      socket.onopen = () => {
        if (this.socket !== socket || this.closed) return;
        this.socketOpen = true;
        socket.send(buildMarketSubscriptionPayload(this.desiredTokenIds));
        this.subscribedTokenIds = [...this.desiredTokenIds];
        this.startHeartbeat(socket);
        this.startStableTimer();
      };
      socket.onmessage = (event) => {
        this.handleMessage(socket, event.data);
      };
      socket.onerror = (event) => {
        if (this.shouldIgnoreSocketError(socket)) return;
        this.postError({ ...serializeUnknownError(event), shardId: this.shardId });
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
        this.postError({
          message: "market websocket closed",
          code: "MARKET_WS_SOCKET_CLOSED",
          shardId: this.shardId,
          tokenCount: this.desiredTokenIds.length,
          ...(event.code !== undefined ? { closeCode: event.code } : {}),
          ...(event.reason !== undefined ? { closeReason: event.reason } : {}),
        });
        this.postGap("socket-closed", Date.now(), this.desiredTokenIds);
        if (this.breakerState === "half-open") {
          this.reopenBreakerWithDoubledWindow();
          return;
        }
        this.scheduleReconnect();
      };
    } catch (error) {
      this.postGap("connect-failed", Date.now(), this.desiredTokenIds);
      this.postError({ ...serializeUnknownError(error), shardId: this.shardId });
      if (this.breakerState === "half-open") {
        this.reopenBreakerWithDoubledWindow();
        return;
      }
      this.scheduleReconnect();
    }
  }

  private handleMessage(socket: MarketDataWebSocketLike, data: unknown): void {
    if (this.socket !== socket) return;
    const nowMs = Date.now();
    this.heartbeat = { ...this.heartbeat, lastInboundMessageAt: nowMs };
    const text = normalizeWebSocketPayload(data);
    if (!text) return;
    const trimmed = text.trim();
    if (isPongPayload(trimmed)) {
      this.clearPongTimer(nowMs);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      this.postGap("invalid-payload", nowMs, this.desiredTokenIds);
      this.postError({
        message: `unexpected market websocket payload: ${trimmed}`,
        shardId: this.shardId,
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      });
      return;
    }
    if (isPongPayload(parsed)) {
      this.clearPongTimer(nowMs);
      return;
    }
    const records: readonly unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    this.enqueueRecords(records);
  }

  private enqueueRecords(records: readonly unknown[]): void {
    const result = this.queue.push(records);
    this.post({ type: "queue-depth", shardId: this.shardId, depth: this.queue.size });
    if (result.droppedItem !== undefined) {
      if (this.cfg.overflowPolicy === "reconnect") {
        this.queue.clear();
        this.reconnect();
        return;
      }
      this.post({
        type: "queue-overflow",
        shardId: this.shardId,
        droppedTokenIds: extractTokenIdsFromRecords(result.droppedItem),
        timestamp: Date.now(),
      });
    }
    if (!this.draining) {
      this.draining = true;
      void this.runDrainLoop();
    }
  }

  private async runDrainLoop(): Promise<void> {
    while (this.queue.size > 0) {
      const item = this.queue.shift()!;
      const startMs = Date.now();
      const parsed = collectStreamUpdates(item, this.pricingByToken, startMs);
      const envelope: WorkerUpdateEnvelope = {
        updates: parsed.updates,
        lifecycleEvents: parsed.lifecycleEvents,
        metrics: {
          rawRecordCount: parsed.rawRecordCount,
          eventCount: parsed.eventCount,
          latencySamplesMs: parsed.latencySamplesMs,
        },
        noopUpdateCount: parsed.noopUpdateCount,
        bookEventCount: parsed.bookEventCount,
        marketResolvedEventCount: parsed.marketResolvedEventCount,
        newMarketEventCount: parsed.newMarketEventCount,
      };
      this.postUpdateEnvelope(envelope);
      const elapsed = Date.now() - startMs;
      if (elapsed > this.cfg.lagWarnMs) {
        const now = Date.now();
        if (now - this.lastLagWarnAt >= LAG_WARN_COOLDOWN_MS) {
          this.lastLagWarnAt = now;
          this.post({ type: "lag-warning", shardId: this.shardId, drainMs: elapsed });
        }
      }
      await Promise.resolve();
    }
    this.draining = false;
  }

  private postUpdateEnvelope(envelope: WorkerUpdateEnvelope): void {
    const encoded = new TextEncoder().encode(JSON.stringify(envelope));
    const payload = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    );
    parentPort!.postMessage(
      {
        type: "update-batch-buffer",
        shardId: this.shardId,
        payload,
        queueDepth: this.queue.size,
      },
      [payload],
    );
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
    const start = () => {
      if (this.closed || this.socket !== socket) return;
      this.pingTimer = setInterval(() => {
        if (this.closed || this.socket !== socket) return;
        if (this.pongTimer) return;
        const sentAt = Date.now();
        socket.send(HEARTBEAT_PING);
        this.heartbeat = {
          ...this.heartbeat,
          pingSent: this.heartbeat.pingSent + 1,
          lastPingSentAt: sentAt,
        };
        this.postHeartbeat();
        this.pongTimer = setTimeout(
          () => {
            if (this.closed || this.socket !== socket) return;
            const lastInbound = this.heartbeat.lastInboundMessageAt ?? 0;
            if (lastInbound >= sentAt) {
              this.heartbeat = {
                ...this.heartbeat,
                timeoutSuppressedByInbound: this.heartbeat.timeoutSuppressedByInbound + 1,
              };
              this.clearPongTimer(null);
              this.postHeartbeat();
              return;
            }
            this.heartbeat = {
              ...this.heartbeat,
              timeoutFired: this.heartbeat.timeoutFired + 1,
            };
            this.postHeartbeat();
            this.postError({
              message: "market websocket pong timeout",
              code: "MARKET_WS_PONG_TIMEOUT",
              shardId: this.shardId,
              tokenCount: this.desiredTokenIds.length,
            });
            this.postGap("pong-timeout", Date.now(), this.desiredTokenIds);
            this.reconnect();
          },
          Math.max(PONG_TIMEOUT_MS * 2, PONG_TIMEOUT_MS + this.workerEventLoopLagMaxMs),
        );
      }, PING_INTERVAL_MS);
    };
    const jitter = Math.max(
      0,
      (this.cfg.heartbeatJitterSeedMs + this.shardId * 137) % PING_INTERVAL_MS,
    );
    this.heartbeatStartTimer = setTimeout(start, jitter);
  }

  private clearPongTimer(pongAt: number | null): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    if (pongAt != null) {
      this.heartbeat = {
        ...this.heartbeat,
        pongReceived: this.heartbeat.pongReceived + 1,
        lastPongAt: pongAt,
      };
    }
    this.postHeartbeat();
  }

  private clearHeartbeat(socket: MarketDataWebSocketLike): void {
    if (this.socket !== socket && this.socket != null) return;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.heartbeatStartTimer) {
      clearTimeout(this.heartbeatStartTimer);
      this.heartbeatStartTimer = null;
    }
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
    const nowMs = Date.now();
    this.reconnectTimestamps.push(nowMs);
    const cutoff = nowMs - 60_000;
    this.reconnectTimestamps = this.reconnectTimestamps.filter((t) => t >= cutoff);
    if (
      this.breakerState === "closed" &&
      this.reconnectTimestamps.length >= this.cfg.shardBreakerReconnectsPerMin
    ) {
      this.openBreaker();
      return;
    }
    this.post({ type: "reconnect-scheduled", shardId: this.shardId });
    this.consecutiveReconnects++;
    const delayMs = computeReconnectDelayMs(this.consecutiveReconnects - 1, {
      baseMs: this.cfg.reconnectBaseMs,
      maxMs: this.cfg.reconnectMaxMs,
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
    this.clearTimers();
    this.closeSocket({ intentional: true });
    this.subscribedTokenIds = [];
    this.postBreakerState();
    this.breakerTimer = setTimeout(() => {
      this.breakerTimer = null;
      this.attemptHalfOpen();
    }, this.currentOpenWindowMs);
  }

  private attemptHalfOpen(): void {
    if (this.closed) return;
    this.breakerState = "half-open";
    this.postBreakerState();
    this.connect();
  }

  private startStableTimer(): void {
    this.cancelStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.consecutiveReconnects = 0;
      if (this.breakerState === "half-open") {
        this.breakerState = "closed";
        this.currentOpenWindowMs = this.cfg.shardBreakerOpenMs;
        this.reconnectTimestamps = [];
        this.postBreakerState();
      }
    }, this.cfg.streamStableMs);
  }

  private cancelStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private clearBreakerTimers(): void {
    if (this.breakerTimer) {
      clearTimeout(this.breakerTimer);
      this.breakerTimer = null;
    }
    this.cancelStableTimer();
  }

  private reopenBreakerWithDoubledWindow(): void {
    this.currentOpenWindowMs = Math.min(
      this.currentOpenWindowMs * 2,
      this.cfg.shardBreakerOpenMaxMs,
    );
    this.breakerState = "closed";
    this.reconnectTimestamps = [];
    this.openBreaker();
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
    if (socket && opts?.intentional) this.intentionallyClosedSockets.add(socket);
    socket?.close();
  }

  private startEventLoopSampler(): void {
    this.eventLoopTimer = setInterval(() => {
      const now = Date.now();
      const lag = Math.max(0, now - this.expectedEventLoopTickAt);
      this.expectedEventLoopTickAt = now + EVENT_LOOP_SAMPLE_MS;
      if (lag > this.workerEventLoopLagMaxMs) {
        this.workerEventLoopLagMaxMs = lag;
        this.heartbeat = { ...this.heartbeat, workerEventLoopLagMaxMs: lag };
        this.postHeartbeat();
      }
    }, EVENT_LOOP_SAMPLE_MS);
  }

  private postGap(
    reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout",
    timestamp: number,
    tokenIds: readonly string[],
  ): void {
    this.post({ type: "gap", shardId: this.shardId, reason, timestamp, tokenIds });
  }

  private postError(error: SerializedWorkerError): void {
    this.post({ type: "error", error: { ...error, shardId: error.shardId ?? this.shardId } });
  }

  private postBreakerState(): void {
    this.post({
      type: "breaker-state",
      shardId: this.shardId,
      state: this.breakerState,
      tokenIds: this.desiredTokenIds,
      reopenAtMs: this.breakerReopenAtMs,
    });
  }

  private postHeartbeat(): void {
    this.post({ type: "heartbeat", shardId: this.shardId, heartbeat: this.heartbeat });
  }

  private post(message: MarketPricingWorkerEvent): void {
    parentPort!.postMessage(message);
  }
}

const controller = new WorkerMarketPricingController(workerData as MarketPricingWorkerData);

parentPort.on("message", (message: MarketPricingWorkerCommand) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "set-shard-token-ids") {
    controller.setShardTokenIds(message.shardId, message.tokenIds);
  } else if (message.type === "set-token-ids") {
    controller.setShardTokenIds(0, message.tokenIds);
  } else if (message.type === "close-shard") {
    controller.closeShard(message.shardId);
  } else if (message.type === "close") {
    controller.close();
  }
});

function readMemorySnapshot(): WorkerMemorySnapshot {
  const memory = process.memoryUsage();
  const heapLimitMb = getHeapStatistics().heap_size_limit / MB;
  return {
    rssMb: roundMb(memory.rss),
    heapUsedMb: roundMb(memory.heapUsed),
    heapTotalMb: roundMb(memory.heapTotal),
    externalMb: roundMb(memory.external),
    arrayBuffersMb: roundMb(memory.arrayBuffers),
    heapLimitMb: Number.isFinite(heapLimitMb) ? Number(heapLimitMb.toFixed(1)) : null,
    capturedAt: Date.now(),
  };
}

function totalTokenCount(shards: ReadonlyMap<number, WorkerMarketPricingShard>): number {
  let count = 0;
  for (const shard of shards.values()) {
    count += shard.getDesiredTokenCount();
  }
  return count;
}

function roundMb(bytes: number): number {
  return Number((bytes / MB).toFixed(1));
}

function serializeUnknownError(error: unknown): SerializedWorkerError {
  if (error instanceof Error) {
    const maybe = error as Error & { code?: unknown };
    let serialized: SerializedWorkerError = { message: error.message, name: error.name };
    if (error.stack) serialized = { ...serialized, stack: error.stack };
    if (typeof maybe.code === "string") serialized = { ...serialized, code: maybe.code };
    return serialized;
  }
  return { message: String(error) };
}
