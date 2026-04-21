import {
  createTokenId,
  type MarketPricingLifecycleEvent,
  type MarketPricingFullBookReason,
  type MarketPricingSnapshot,
  type MarketPricingStream,
  type MarketPricingStreamMetricsSnapshot,
  type MarketPricingStreamUpdate,
} from "@plankton/domain";
import { mapOrderBook } from "../mappers.js";
import {
  extractBookTokenId,
  normalizeWebSocketPayload,
  parseOptionalIsoTimestamp,
  parseOptionalNumber,
  summarizeLatencySamples,
  type MarketDataWebSocketLike,
} from "./market-data-stream-shared.js";

const CLOB_MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION = 500;
const METRICS_WINDOW_MS = 10 * 60 * 1000;
const HEARTBEAT_PING = "PING";
const HEARTBEAT_PONG = "PONG";
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 1_000;

interface StreamWindow {
  windowStartMs: number;
  wsEventsReceived: number;
  wsUpdatesApplied: number;
  latencySamplesMs: number[];
  reconnectCount: number;
  wsEventGapDetected: number;
  bookEventsReceived: number;
  marketResolvedEvents: number;
  newMarketEvents: number;
}

interface LiveMarketPricingStreamDeps {
  createWebSocket: (url: string) => MarketDataWebSocketLike;
  handlers: Readonly<{
    onUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
    onLifecycleEvents?: (events: readonly MarketPricingLifecycleEvent[]) => Promise<void> | void;
    onError?: (error: unknown) => Promise<void> | void;
    onGapDetected?: (
      info: Readonly<{
        reason: "socket-closed" | "invalid-payload" | "connect-failed";
        timestamp: number;
        tokenIds?: readonly string[];
      }>,
    ) => Promise<void> | void;
  }>;
  maxSubscriptionsPerConnection?: number;
  now?: () => number;
}

interface ShardCallbacks {
  onRecords: (records: readonly unknown[]) => Promise<void> | void;
  onError: (error: unknown) => Promise<void> | void;
  onGapDetected: (
    reason: "socket-closed" | "invalid-payload" | "connect-failed",
    timestamp: number,
    tokenIds: readonly string[],
  ) => void;
  onReconnectScheduled: () => void;
}

interface CollectStreamUpdatesResult {
  readonly updates: readonly MarketPricingStreamUpdate[];
  readonly lifecycleEvents: readonly MarketPricingLifecycleEvent[];
  readonly eventCount: number;
  readonly bookEventCount: number;
  readonly marketResolvedEventCount: number;
  readonly newMarketEventCount: number;
  readonly latencySamplesMs: readonly number[];
}

export class LiveMarketPricingStream implements MarketPricingStream {
  private readonly pricingByToken = new Map<string, MarketPricingSnapshot>();
  private readonly shards = new Map<number, MarketPricingShard>();
  private readonly now: () => number;
  private readonly maxSubscriptionsPerConnection: number;
  private desiredTokenIds: string[] = [];
  private closed = false;
  private window: StreamWindow;

  constructor(private readonly deps: LiveMarketPricingStreamDeps) {
    this.now = deps.now ?? Date.now;
    this.maxSubscriptionsPerConnection =
      deps.maxSubscriptionsPerConnection ?? DEFAULT_MAX_SUBSCRIPTIONS_PER_CONNECTION;
    this.window = this.createEmptyWindow(this.now());
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
    this.syncShards();
  }

  close(): void {
    this.closed = true;
    for (const shard of this.shards.values()) {
      shard.close();
    }
    this.shards.clear();
    this.pricingByToken.clear();
  }

  getMetricsSnapshot(): MarketPricingStreamMetricsSnapshot {
    const nowMs = this.now();
    this.rotateWindow(nowMs);
    const elapsedSeconds = Math.max(1, Math.floor((nowMs - this.window.windowStartMs) / 1000));
    return {
      windowStartMs: this.window.windowStartMs,
      wsEventsReceived: this.window.wsEventsReceived,
      wsEventsReceivedPerSec: Number((this.window.wsEventsReceived / elapsedSeconds).toFixed(3)),
      wsUpdatesApplied: this.window.wsUpdatesApplied,
      trackedTokenCount: this.desiredTokenIds.length,
      shardCount: this.shards.size,
      reconnectCount: this.window.reconnectCount,
      wsEventGapDetected: this.window.wsEventGapDetected,
      wsLatencyMs: summarizeLatencySamples(this.window.latencySamplesMs),
      bookEventsReceived: this.window.bookEventsReceived,
      marketResolvedEvents: this.window.marketResolvedEvents,
      newMarketEvents: this.window.newMarketEvents,
    };
  }

  setFullBookTokenIds(_reason: MarketPricingFullBookReason, _tokenIds: readonly string[]): void {
    // The low-level socket stream always forwards raw market events.
    // Full-book lifecycle filtering is handled by the shared hub layer.
  }

  private syncShards(): void {
    const shardAssignments = chunkItems(this.desiredTokenIds, this.maxSubscriptionsPerConnection);
    const desiredShardIds = new Set<number>();

    shardAssignments.forEach((tokenIds, index) => {
      desiredShardIds.add(index);
      const shard = this.shards.get(index) ?? this.createShard(index);
      shard.setTokenIds(tokenIds);
    });

    for (const [shardId, shard] of this.shards.entries()) {
      if (desiredShardIds.has(shardId)) continue;
      shard.close();
      this.shards.delete(shardId);
    }

    if (this.desiredTokenIds.length === 0) {
      this.pricingByToken.clear();
    }
  }

  private createShard(shardId: number): MarketPricingShard {
    const shard = new MarketPricingShard({
      shardId,
      createWebSocket: this.deps.createWebSocket,
      onRecords: async (records) => {
        await this.handleShardRecords(records);
      },
      onError: async (error) => {
        await this.deps.handlers.onError?.(error);
      },
      onGapDetected: (reason, timestamp, tokenIds) => {
        this.rotateWindow(timestamp);
        this.window.wsEventGapDetected++;
        void this.deps.handlers.onGapDetected?.({ reason, timestamp, tokenIds });
      },
      onReconnectScheduled: () => {
        this.rotateWindow(this.now());
        this.window.reconnectCount++;
      },
    });
    this.shards.set(shardId, shard);
    return shard;
  }

  private async handleShardRecords(records: readonly unknown[]): Promise<void> {
    const nowMs = this.now();
    this.rotateWindow(nowMs);
    const {
      updates,
      lifecycleEvents,
      eventCount,
      bookEventCount,
      marketResolvedEventCount,
      newMarketEventCount,
      latencySamplesMs,
    } = collectStreamUpdates(records, this.pricingByToken, nowMs);
    if (eventCount > 0) {
      this.window.wsEventsReceived += eventCount;
    }
    if (latencySamplesMs.length > 0) {
      this.window.latencySamplesMs.push(...latencySamplesMs);
    }
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
    if (updates.length === 0) return;
    this.window.wsUpdatesApplied += updates.length;
    await this.deps.handlers.onUpdates(updates);
  }

  private rotateWindow(nowMs: number): void {
    if (nowMs - this.window.windowStartMs <= METRICS_WINDOW_MS) return;
    this.window = this.createEmptyWindow(nowMs);
  }

  private createEmptyWindow(nowMs: number): StreamWindow {
    return {
      windowStartMs: nowMs,
      wsEventsReceived: 0,
      wsUpdatesApplied: 0,
      latencySamplesMs: [],
      reconnectCount: 0,
      wsEventGapDetected: 0,
      bookEventsReceived: 0,
      marketResolvedEvents: 0,
      newMarketEvents: 0,
    };
  }
}

class MarketPricingShard {
  private readonly intentionallyClosedSockets = new WeakSet<MarketDataWebSocketLike>();
  private socket: MarketDataWebSocketLike | null = null;
  private socketOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private desiredTokenIds: string[] = [];
  private subscribedTokenIds: string[] = [];

  constructor(
    private readonly deps: Readonly<{
      shardId: number;
      createWebSocket: (url: string) => MarketDataWebSocketLike;
    }> &
      ShardCallbacks,
  ) {}

  setTokenIds(tokenIds: readonly string[]): void {
    const next = normalizeTokenIds(tokenIds);
    if (arraysEqual(this.desiredTokenIds, next)) return;
    this.desiredTokenIds = next;

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
      };

      socket.onmessage = (event) => {
        void this.handleMessage(socket, event.data);
      };

      socket.onerror = (event) => {
        if (this.shouldIgnoreSocketError(socket)) return;
        void this.deps.onError(event);
      };

      socket.onclose = () => {
        const ignoreEvent = this.shouldIgnoreSocketClose(socket);
        if (this.socket === socket) {
          this.socket = null;
          this.socketOpen = false;
        }
        if (ignoreEvent || this.closed) return;
        this.clearHeartbeat(socket);
        this.subscribedTokenIds = [];
        this.deps.onGapDetected("socket-closed", Date.now(), this.desiredTokenIds);
        this.scheduleReconnect();
      };
    } catch (error) {
      this.deps.onGapDetected("connect-failed", Date.now(), this.desiredTokenIds);
      void this.deps.onError(error);
      this.scheduleReconnect();
    }
  }

  private async handleMessage(socket: MarketDataWebSocketLike, data: unknown): Promise<void> {
    try {
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
        await this.deps.onError(
          new Error(`unexpected market websocket payload: ${trimmed}`, {
            cause: error,
          }),
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

      const records = Array.isArray(parsed) ? parsed : [parsed];
      await this.deps.onRecords(records);
    } catch (error) {
      await this.deps.onError(error);
    }
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
        this.deps.onGapDetected("socket-closed", Date.now(), this.desiredTokenIds);
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
    this.deps.onReconnectScheduled();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
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

function normalizeTokenIds(tokenIds: readonly string[]): string[] {
  return [
    ...new Set(tokenIds.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function chunkItems<T>(items: readonly T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function buildMarketSubscriptionPayload(tokenIds: readonly string[]): string {
  return JSON.stringify({
    type: "market",
    assets_ids: tokenIds,
    custom_feature_enabled: true,
  });
}

function buildMarketSubscriptionUpdatePayload(
  operation: "subscribe" | "unsubscribe",
  tokenIds: readonly string[],
  customFeatureEnabled: boolean,
): string {
  return JSON.stringify({
    operation,
    assets_ids: tokenIds,
    ...(customFeatureEnabled ? { custom_feature_enabled: true } : {}),
  });
}

function isPongPayload(payload: unknown): boolean {
  if (typeof payload === "string") {
    return payload.trim().toUpperCase() === HEARTBEAT_PONG;
  }
  return (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Object.keys(payload as Record<string, unknown>).length === 0
  );
}

function collectStreamUpdates(
  records: readonly unknown[],
  pricingByToken: Map<string, MarketPricingSnapshot>,
  nowMs: number,
): CollectStreamUpdatesResult {
  const updates: MarketPricingStreamUpdate[] = [];
  const lifecycleEvents: MarketPricingLifecycleEvent[] = [];
  const latencySamplesMs: number[] = [];
  let eventCount = 0;
  let bookEventCount = 0;
  let marketResolvedEventCount = 0;
  let newMarketEventCount = 0;

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const raw = record as Record<string, unknown>;
    const eventType = typeof raw.event_type === "string" ? raw.event_type : "";

    if (eventType === "price_change" && Array.isArray(raw.price_changes)) {
      for (const priceChange of raw.price_changes) {
        if (!priceChange || typeof priceChange !== "object") continue;
        const tokenId =
          extractBookTokenId(priceChange as Record<string, unknown>) ?? extractBookTokenId(raw);
        if (!tokenId) continue;
        const current = getCurrentPricing(pricingByToken, tokenId);
        const next: MarketPricingSnapshot = {
          ...current,
          bestBid:
            parseOptionalNumber((priceChange as Record<string, unknown>).best_bid) ??
            current.bestBid,
          bestAsk:
            parseOptionalNumber((priceChange as Record<string, unknown>).best_ask) ??
            current.bestAsk,
          lastTradePrice: current.lastTradePrice,
          lastTradeAt: parseOptionalIsoTimestamp(raw.timestamp) ?? current.lastTradeAt ?? null,
          bookSource: "clob",
        };
        pricingByToken.set(tokenId, next);
        updates.push({ tokenId, pricing: next });
        eventCount++;
        noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      }
      continue;
    }

    if (eventType === "market_resolved") {
      const tokenIds = extractLifecycleTokenIds(raw);
      if (tokenIds.length === 0) continue;
      lifecycleEvents.push({
        type: "market_resolved",
        conditionId: resolveLifecycleConditionId(raw),
        marketId: typeof raw.market === "string" ? raw.market : null,
        slug: typeof raw.slug === "string" ? raw.slug : null,
        tokenIds,
        winningTokenId: resolveWinningTokenId(raw),
        timestamp: resolveEventTimestamp(raw, nowMs),
      });
      eventCount++;
      marketResolvedEventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "new_market") {
      const tokenIds = extractLifecycleTokenIds(raw);
      const slug = typeof raw.slug === "string" ? raw.slug : null;
      if (!slug) continue;
      lifecycleEvents.push({
        type: "new_market",
        conditionId: resolveLifecycleConditionId(raw),
        marketId: typeof raw.market === "string" ? raw.market : null,
        slug,
        question: typeof raw.question === "string" ? raw.question : null,
        active: raw.active !== false,
        tokenIds,
        timestamp: resolveEventTimestamp(raw, nowMs),
      });
      eventCount++;
      newMarketEventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    const tokenId = extractBookTokenId(raw);
    if (!tokenId) continue;
    const current = getCurrentPricing(pricingByToken, tokenId);

    if (eventType === "book") {
      const book = mapOrderBook(createTokenId(tokenId), raw);
      const next: MarketPricingSnapshot = {
        ...current,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        minOrderSize: book.minOrderSize ?? current.minOrderSize ?? null,
        bookSource: "clob",
      };
      pricingByToken.set(tokenId, next);
      updates.push({ tokenId, pricing: next, book });
      eventCount++;
      bookEventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "best_bid_ask") {
      const next: MarketPricingSnapshot = {
        ...current,
        bestBid: parseOptionalNumber(raw.best_bid),
        bestAsk: parseOptionalNumber(raw.best_ask),
        bookSource: "clob",
      };
      pricingByToken.set(tokenId, next);
      updates.push({ tokenId, pricing: next });
      eventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "last_trade_price") {
      const next: MarketPricingSnapshot = {
        ...current,
        lastTradePrice: parseOptionalNumber(raw.price ?? raw.last_trade_price),
        lastTradeAt: parseOptionalIsoTimestamp(raw.timestamp) ?? current.lastTradeAt ?? null,
        bookSource: "clob",
      };
      pricingByToken.set(tokenId, next);
      updates.push({ tokenId, pricing: next });
      eventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "tick_size_change") {
      const nextTickSize =
        parseOptionalNumber(raw.new_tick_size) ?? parseOptionalNumber(raw.tick_size);
      updates.push({
        tokenId,
        pricing: current,
        tickSize: nextTickSize,
      });
      eventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "price_change") {
      const next: MarketPricingSnapshot = {
        ...current,
        bestBid: parseOptionalNumber(raw.best_bid) ?? current.bestBid,
        bestAsk: parseOptionalNumber(raw.best_ask) ?? current.bestAsk,
        bookSource: "clob",
      };
      pricingByToken.set(tokenId, next);
      updates.push({ tokenId, pricing: next });
      eventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
    }
  }

  return {
    updates,
    lifecycleEvents,
    eventCount,
    bookEventCount,
    marketResolvedEventCount,
    newMarketEventCount,
    latencySamplesMs,
  };
}

function getCurrentPricing(
  pricingByToken: Map<string, MarketPricingSnapshot>,
  tokenId: string,
): MarketPricingSnapshot {
  return (
    pricingByToken.get(tokenId) ?? {
      bestBid: null,
      bestAsk: null,
      lastTradePrice: null,
      lastTradeAt: null,
      volume24h: null,
      liquidity: null,
      minOrderSize: null,
      bookSource: "clob" as const,
      // Fail-closed — stream deltas spread over this snapshot; must not silently claim liveness.
      acceptingOrders: false,
      enableOrderBook: false,
    }
  );
}

function noteLatencySample(samples: number[], timestamp: unknown, nowMs: number): void {
  const eventAtIso = parseOptionalIsoTimestamp(timestamp);
  if (!eventAtIso) return;
  const eventAtMs = Date.parse(eventAtIso);
  if (!Number.isFinite(eventAtMs)) return;
  const latencyMs = Math.max(0, nowMs - eventAtMs);
  samples.push(latencyMs);
}

function extractLifecycleTokenIds(raw: Record<string, unknown>) {
  const ids = raw.assets_ids ?? raw.clob_token_ids;
  if (!Array.isArray(ids)) return [];
  return ids
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => createTokenId(value));
}

function resolveLifecycleConditionId(raw: Record<string, unknown>): string {
  if (typeof raw.condition_id === "string" && raw.condition_id.trim().length > 0) {
    return raw.condition_id;
  }
  if (typeof raw.market === "string" && raw.market.trim().length > 0) {
    return raw.market;
  }
  if (typeof raw.id === "string" && raw.id.trim().length > 0) {
    return raw.id;
  }
  return "";
}

function resolveWinningTokenId(raw: Record<string, unknown>) {
  return typeof raw.winning_asset_id === "string" && raw.winning_asset_id.trim().length > 0
    ? createTokenId(raw.winning_asset_id)
    : null;
}

function resolveEventTimestamp(raw: Record<string, unknown>, nowMs: number): number {
  const iso = parseOptionalIsoTimestamp(raw.timestamp);
  if (!iso) return nowMs;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : nowMs;
}
