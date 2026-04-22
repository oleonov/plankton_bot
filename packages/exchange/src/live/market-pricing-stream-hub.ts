import type {
  MarketPricingFullBookReason,
  MarketPricingLifecycleEvent,
  MarketPricingStream,
  MarketPricingStreamMetricsSnapshot,
  MarketPricingStreamUpdate,
} from "@plankton/domain";
import { LiveMarketPricingStream } from "./market-pricing-stream.js";
import type { MarketDataWebSocketLike } from "./market-data-stream-shared.js";

interface StreamHandlers {
  readonly onUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
  readonly onLifecycleEvents?: (
    events: readonly MarketPricingLifecycleEvent[],
  ) => Promise<void> | void;
  readonly onError?: (error: unknown) => Promise<void> | void;
  readonly onGapDetected?: (
    info: Readonly<{
      reason: "socket-closed" | "invalid-payload" | "connect-failed";
      timestamp: number;
      tokenIds?: readonly string[];
    }>,
  ) => Promise<void> | void;
}

interface SharedMarketPricingStreamHubDeps {
  readonly createWebSocket: (url: string) => MarketDataWebSocketLike;
  /**
   * Per-shard subscription ceiling. The gateway derives this from
   * `min(500, ceil(maxTokens / maxShards))` so the stream itself can treat
   * the value as the authoritative chunk size.
   */
  readonly maxSubscriptionsPerConnection?: number;
  /** Max items in the per-shard ingress queue. Forwarded to LiveMarketPricingStream. */
  readonly queueMax?: number;
  /** Lag-warning threshold in ms. Forwarded to LiveMarketPricingStream. */
  readonly lagWarnMs?: number;
  /** Overflow policy. Forwarded to LiveMarketPricingStream. */
  readonly overflowPolicy?: "drop-oldest" | "reconnect";
  /** Base reconnect delay ms. Forwarded to LiveMarketPricingStream. */
  readonly reconnectBaseMs?: number;
  /** Max reconnect delay ms cap. Forwarded to LiveMarketPricingStream. */
  readonly reconnectMaxMs?: number;
  /** Per-shard breaker: max reconnects per 60s window. Forwarded to LiveMarketPricingStream. */
  readonly shardBreakerReconnectsPerMin?: number;
  /** Per-shard breaker initial open window ms. Forwarded to LiveMarketPricingStream. */
  readonly shardBreakerOpenMs?: number;
  /** Per-shard breaker max open window ms. Forwarded to LiveMarketPricingStream. */
  readonly shardBreakerOpenMaxMs?: number;
  /** Stream-level quorum percent threshold. Forwarded to LiveMarketPricingStream. */
  readonly circuitShardOpenPercent?: number;
  /** Stream-level quorum absolute floor. Forwarded to LiveMarketPricingStream. */
  readonly circuitOpenShardFloor?: number;
  /** Stream-level circuit open duration ms. Forwarded to LiveMarketPricingStream. */
  readonly circuitOpenMs?: number;
  /** Stable uptime ms before breaker closes. Forwarded to LiveMarketPricingStream. */
  readonly streamStableMs?: number;
}

interface StreamViewState {
  readonly id: number;
  readonly handlers: StreamHandlers;
  tokenIds: string[];
  fullBookTokenIdsByReason: Map<MarketPricingFullBookReason, string[]>;
  closed: boolean;
}

export class SharedMarketPricingStreamHub {
  private readonly lowLevelStream: LiveMarketPricingStream;
  private readonly views = new Map<number, StreamViewState>();
  private nextViewId = 1;
  private aggregateFullBookTokenIds = new Set<string>();
  private narrowSubscribeCount = 0;
  private narrowUnsubscribeCount = 0;
  private narrowRefCountLeaks = 0;

  constructor(deps: SharedMarketPricingStreamHubDeps) {
    this.lowLevelStream = new LiveMarketPricingStream({
      createWebSocket: deps.createWebSocket,
      ...(deps.maxSubscriptionsPerConnection !== undefined
        ? { maxSubscriptionsPerConnection: deps.maxSubscriptionsPerConnection }
        : {}),
      ...(deps.queueMax !== undefined ? { queueMax: deps.queueMax } : {}),
      ...(deps.lagWarnMs !== undefined ? { lagWarnMs: deps.lagWarnMs } : {}),
      ...(deps.overflowPolicy !== undefined ? { overflowPolicy: deps.overflowPolicy } : {}),
      ...(deps.reconnectBaseMs !== undefined ? { reconnectBaseMs: deps.reconnectBaseMs } : {}),
      ...(deps.reconnectMaxMs !== undefined ? { reconnectMaxMs: deps.reconnectMaxMs } : {}),
      ...(deps.shardBreakerReconnectsPerMin !== undefined
        ? { shardBreakerReconnectsPerMin: deps.shardBreakerReconnectsPerMin }
        : {}),
      ...(deps.shardBreakerOpenMs !== undefined
        ? { shardBreakerOpenMs: deps.shardBreakerOpenMs }
        : {}),
      ...(deps.shardBreakerOpenMaxMs !== undefined
        ? { shardBreakerOpenMaxMs: deps.shardBreakerOpenMaxMs }
        : {}),
      ...(deps.circuitShardOpenPercent !== undefined
        ? { circuitShardOpenPercent: deps.circuitShardOpenPercent }
        : {}),
      ...(deps.circuitOpenShardFloor !== undefined
        ? { circuitOpenShardFloor: deps.circuitOpenShardFloor }
        : {}),
      ...(deps.circuitOpenMs !== undefined ? { circuitOpenMs: deps.circuitOpenMs } : {}),
      ...(deps.streamStableMs !== undefined ? { streamStableMs: deps.streamStableMs } : {}),
      handlers: {
        onUpdates: async (updates) => {
          await this.dispatchUpdates(updates);
        },
        onLifecycleEvents: async (events) => {
          await this.dispatchLifecycleEvents(events);
        },
        onError: async (error) => {
          await this.dispatchError(error);
        },
        onGapDetected: async (gap) => {
          await this.dispatchGap(gap);
        },
      },
    });
  }

  createStream(handlers: StreamHandlers): MarketPricingStream {
    const id = this.nextViewId++;
    this.views.set(id, {
      id,
      handlers,
      tokenIds: [],
      fullBookTokenIdsByReason: new Map(),
      closed: false,
    });
    return new SharedMarketPricingStreamView(this, id);
  }

  setViewTokenIds(viewId: number, tokenIds: readonly string[]): void {
    const view = this.views.get(viewId);
    if (!view || view.closed) return;
    view.tokenIds = normalizeTokenIds(tokenIds);
    this.syncLowLevelStream();
  }

  setViewFullBookTokenIds(
    viewId: number,
    reason: MarketPricingFullBookReason,
    tokenIds: readonly string[],
  ): void {
    const view = this.views.get(viewId);
    if (!view || view.closed) return;
    const normalized = normalizeTokenIds(tokenIds);
    if (normalized.length === 0) {
      view.fullBookTokenIdsByReason.delete(reason);
    } else {
      view.fullBookTokenIdsByReason.set(reason, normalized);
    }
    this.syncLowLevelStream();
  }

  closeView(viewId: number): void {
    const view = this.views.get(viewId);
    if (!view || view.closed) return;
    view.closed = true;
    const leakedTokenIds = new Set<string>();
    for (const tokenIds of view.fullBookTokenIdsByReason.values()) {
      for (const tokenId of tokenIds) leakedTokenIds.add(tokenId);
    }
    this.narrowRefCountLeaks += leakedTokenIds.size;
    this.views.delete(viewId);
    this.syncLowLevelStream();
  }

  getMetricsSnapshot(): MarketPricingStreamMetricsSnapshot {
    const base = this.lowLevelStream.getMetricsSnapshot();
    return {
      ...base,
      fullBookTokenCount: this.aggregateFullBookTokenIds.size,
      narrowSubscribeCount: this.narrowSubscribeCount,
      narrowUnsubscribeCount: this.narrowUnsubscribeCount,
      narrowRefCountLeaks: this.narrowRefCountLeaks,
    };
  }

  private syncLowLevelStream(): void {
    const nextTrackedTokenIds = new Set<string>();
    const nextFullBookTokenIds = new Set<string>();

    for (const view of this.views.values()) {
      if (view.closed) continue;
      for (const tokenId of view.tokenIds) nextTrackedTokenIds.add(tokenId);
      for (const tokenIds of view.fullBookTokenIdsByReason.values()) {
        for (const tokenId of tokenIds) {
          nextTrackedTokenIds.add(tokenId);
          nextFullBookTokenIds.add(tokenId);
        }
      }
    }

    for (const tokenId of nextFullBookTokenIds) {
      if (!this.aggregateFullBookTokenIds.has(tokenId)) {
        this.narrowSubscribeCount++;
      }
    }
    for (const tokenId of this.aggregateFullBookTokenIds) {
      if (!nextFullBookTokenIds.has(tokenId)) {
        this.narrowUnsubscribeCount++;
      }
    }

    this.aggregateFullBookTokenIds = nextFullBookTokenIds;
    this.lowLevelStream.setTokenIds([...nextTrackedTokenIds]);
  }

  private async dispatchUpdates(updates: readonly MarketPricingStreamUpdate[]): Promise<void> {
    for (const view of this.views.values()) {
      if (view.closed) continue;
      const viewTokenIds = new Set(view.tokenIds);
      if (viewTokenIds.size === 0) continue;
      const viewFullBookTokenIds = collectViewFullBookTokenIds(view);
      const filtered: MarketPricingStreamUpdate[] = [];

      for (const update of updates) {
        if (!viewTokenIds.has(update.tokenId)) continue;
        if (update.book == null || viewFullBookTokenIds.has(update.tokenId)) {
          filtered.push(update);
          continue;
        }
        filtered.push({
          ...update,
          book: null,
        });
      }

      if (filtered.length === 0) continue;
      await view.handlers.onUpdates(filtered);
    }
  }

  private async dispatchLifecycleEvents(
    events: readonly MarketPricingLifecycleEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    for (const view of this.views.values()) {
      if (view.closed) continue;
      await view.handlers.onLifecycleEvents?.(events);
    }
  }

  private async dispatchError(error: unknown): Promise<void> {
    for (const view of this.views.values()) {
      if (view.closed) continue;
      await view.handlers.onError?.(error);
    }
  }

  private async dispatchGap(
    gap: Readonly<{
      reason: "socket-closed" | "invalid-payload" | "connect-failed";
      timestamp: number;
      tokenIds?: readonly string[];
    }>,
  ): Promise<void> {
    for (const view of this.views.values()) {
      if (view.closed) continue;
      await view.handlers.onGapDetected?.(gap);
    }
  }
}

class SharedMarketPricingStreamView implements MarketPricingStream {
  private closed = false;

  constructor(
    private readonly hub: SharedMarketPricingStreamHub,
    private readonly viewId: number,
  ) {}

  setTokenIds(tokenIds: readonly string[]): void {
    if (this.closed) return;
    this.hub.setViewTokenIds(this.viewId, tokenIds);
  }

  setFullBookTokenIds(reason: MarketPricingFullBookReason, tokenIds: readonly string[]): void {
    if (this.closed) return;
    this.hub.setViewFullBookTokenIds(this.viewId, reason, tokenIds);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.closeView(this.viewId);
  }

  getMetricsSnapshot(): MarketPricingStreamMetricsSnapshot {
    return this.hub.getMetricsSnapshot();
  }
}

function normalizeTokenIds(tokenIds: readonly string[]): string[] {
  return [
    ...new Set(tokenIds.map((tokenId) => tokenId.trim()).filter((tokenId) => tokenId.length > 0)),
  ].sort();
}

function collectViewFullBookTokenIds(view: StreamViewState): Set<string> {
  const tokenIds = new Set<string>();
  for (const values of view.fullBookTokenIdsByReason.values()) {
    for (const tokenId of values) tokenIds.add(tokenId);
  }
  return tokenIds;
}
