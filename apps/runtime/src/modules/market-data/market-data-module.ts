/**
 * Market Data Module — refreshes pricing for tracked active markets
 * and publishes MarketSnapshotReceived events.
 *
 * Responsibilities:
 *  - REST polling on a configurable interval (Gamma-backed Phase 1)
 *  - Re-entrancy guard (no overlapping poll cycles)
 *  - Freshness / staleness tracking
 *  - Graceful degradation on failures (no crash, health degrades)
 *
 * Does NOT discover or classify markets — that is the scanner's job.
 * Does NOT enrich markets — that is normalization's job.
 */

import type {
  RuntimeModule,
  EventBus,
  MarketDataGateway,
  MarketPricingLifecycleEvent,
  MarketRepository,
  MarketPricingStream,
  MarketPricingStreamMetricsSnapshot,
  MarketPricingStreamUpdate,
  Market,
  NormalizedMarket,
} from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { isTransientNetworkError } from "../../network-errors.js";
import {
  applyPricingSnapshot,
  applyStreamUpdate,
  didMarketPricingChange,
} from "./market-pricing-utils.js";

const STREAM_FALLBACK_MIN_STALE_MS = 15_000;
const STREAM_UPDATE_COALESCE_MS = 100;
// Shard fan-out: one WS disconnect can fire 20× onGapDetected in quick succession,
// one per shard. Coalesce the warn log into a single line per burst. State
// updates (pendingGapTokenIds, forceFullPoll) stay synchronous so the next
// poll still picks up every gap.
const GAP_LOG_DEBOUNCE_MS = 250;

export interface MarketDataStreamActivitySnapshot {
  readonly wsEnabled: boolean;
  readonly windowStartMs: number | null;
  readonly wsEventsReceived: number;
  readonly wsEventsReceivedPerSec: number;
  readonly wsUpdatesApplied: number;
  readonly trackedTokenCount: number;
  readonly shardCount: number;
  readonly reconnectCount: number;
  readonly wsEventGapDetected: number;
  readonly wsLatencyMs: MarketPricingStreamMetricsSnapshot["wsLatencyMs"];
  readonly staleTokenCount: number;
  readonly fallbackPollCount: number;
  readonly fullBookTokenCount: number;
  readonly bookEventsReceived: number;
  readonly narrowSubscribeCount: number;
  readonly narrowUnsubscribeCount: number;
  readonly narrowRefCountLeaks: number;
  readonly marketResolvedEvents: number;
  readonly newMarketEvents: number;
  readonly gammaFallbackCount: number;
  readonly gammaFallbackTrackedTokenCount: number;
}

export interface MarketDataModuleDeps {
  gateway: MarketDataGateway;
  marketRepo: MarketRepository;
  bus: EventBus;
  log: Logger;
  pollIntervalMs: number;
  staleThresholdMs: number;
  botRunId?: string;
}

export class MarketDataModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stream: MarketPricingStream | null = null;
  private polling = false;
  private lastSuccessfulDataMs = 0;
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly trackedMarketsByToken = new Map<string, Market>();
  private readonly lastPricingUpdateAtByToken = new Map<string, number>();
  private readonly pendingGapTokenIds = new Set<string>();
  private readonly log: Logger;
  private forceFullPoll = false;
  private lastTrackedTokenCount = 0;
  private lastStaleTokenCount = 0;
  private lastFallbackPollCount = 0;
  private readonly pendingStreamUpdatesByToken = new Map<string, MarketPricingStreamUpdate>();
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private gapLogTimer: ReturnType<typeof setTimeout> | null = null;
  private gapLogBurstShardCount = 0;
  private gapLogBurstTokenCount = 0;
  private gapLogBurstForceFullPoll = false;
  private readonly gapLogBurstReasons = new Set<string>();

  constructor(private readonly deps: MarketDataModuleDeps) {
    this.log = deps.log.child({ module: "market-data" });
  }

  async start(): Promise<void> {
    this.log.info(
      { intervalMs: this.deps.pollIntervalMs, staleMs: this.deps.staleThresholdMs },
      "starting market-data module",
    );
    if (this.deps.gateway.createMarketPricingStream) {
      this.stream = this.deps.gateway.createMarketPricingStream({
        onUpdates: (updates) => this.handleStreamUpdates(updates),
        onLifecycleEvents: (events) => this.handleLifecycleEvents(events),
        onError: (error) => {
          this.log.warn({ err: error }, "market-data stream error");
        },
        onGapDetected: ({ reason, tokenIds }) => {
          const normalizedTokenIds = normalizeGapTokenIds(tokenIds);
          if (normalizedTokenIds.length === 0) {
            this.forceFullPoll = true;
          } else {
            for (const tokenId of normalizedTokenIds) {
              this.pendingGapTokenIds.add(tokenId);
            }
          }
          this.queueGapLog(reason, normalizedTokenIds.length);
        },
      });
    }
    // Fire first poll without blocking startup — interval handles retries
    this.poll().catch((err) => this.log.error({ err }, "initial poll failed"));
    this.timer = setInterval(() => {
      this.poll().catch((err) => this.log.error({ err }, "poll cycle error"));
    }, this.deps.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.streamFlushTimer) {
      clearTimeout(this.streamFlushTimer);
      this.streamFlushTimer = null;
    }
    if (this.gapLogTimer) {
      clearTimeout(this.gapLogTimer);
      this.gapLogTimer = null;
      this.flushGapLog();
    }
    await this.flushPendingStreamUpdates();
    this.stream?.close();
    this.stream = null;
    this.log.info("market-data module stopped");
  }

  private queueGapLog(reason: string, tokenCount: number): void {
    this.gapLogBurstShardCount += 1;
    this.gapLogBurstTokenCount += tokenCount;
    this.gapLogBurstReasons.add(reason);
    if (tokenCount === 0) this.gapLogBurstForceFullPoll = true;
    if (this.gapLogTimer) return;
    this.gapLogTimer = setTimeout(() => {
      this.gapLogTimer = null;
      this.flushGapLog();
    }, GAP_LOG_DEBOUNCE_MS);
  }

  private flushGapLog(): void {
    if (this.gapLogBurstShardCount === 0) return;
    this.log.warn(
      {
        reasons: [...this.gapLogBurstReasons],
        shardCount: this.gapLogBurstShardCount,
        tokenCount: this.gapLogBurstTokenCount,
        forceFullPoll: this.gapLogBurstForceFullPoll,
      },
      "market-data stream gap detected",
    );
    this.gapLogBurstShardCount = 0;
    this.gapLogBurstTokenCount = 0;
    this.gapLogBurstForceFullPoll = false;
    this.gapLogBurstReasons.clear();
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (this.lastSuccessfulDataMs === 0) {
      return { ok: false, detail: "no successful market data yet" };
    }
    const ageMs = Date.now() - this.lastSuccessfulDataMs;
    const stale = ageMs > this.deps.staleThresholdMs;
    return {
      ok: !stale,
      detail: stale
        ? `stale: last market data ${Math.round(ageMs / 1000)}s ago`
        : `fresh: last market data ${Math.round(ageMs / 1000)}s ago`,
    };
  }

  getMetricsSnapshot(): MarketDataStreamActivitySnapshot {
    const streamMetrics = this.stream?.getMetricsSnapshot?.() ?? null;
    const gammaFallbackCount = this.countTrackedGammaFallbackMarkets();
    return {
      wsEnabled: this.stream != null,
      windowStartMs: streamMetrics?.windowStartMs ?? null,
      wsEventsReceived: streamMetrics?.wsEventsReceived ?? 0,
      wsEventsReceivedPerSec: streamMetrics?.wsEventsReceivedPerSec ?? 0,
      wsUpdatesApplied: streamMetrics?.wsUpdatesApplied ?? 0,
      trackedTokenCount: streamMetrics?.trackedTokenCount ?? this.lastTrackedTokenCount,
      shardCount: streamMetrics?.shardCount ?? 0,
      reconnectCount: streamMetrics?.reconnectCount ?? 0,
      wsEventGapDetected: streamMetrics?.wsEventGapDetected ?? 0,
      wsLatencyMs: streamMetrics?.wsLatencyMs ?? null,
      staleTokenCount: this.lastStaleTokenCount,
      fallbackPollCount: this.lastFallbackPollCount,
      fullBookTokenCount: streamMetrics?.fullBookTokenCount ?? 0,
      bookEventsReceived: streamMetrics?.bookEventsReceived ?? 0,
      narrowSubscribeCount: streamMetrics?.narrowSubscribeCount ?? 0,
      narrowUnsubscribeCount: streamMetrics?.narrowUnsubscribeCount ?? 0,
      narrowRefCountLeaks: streamMetrics?.narrowRefCountLeaks ?? 0,
      marketResolvedEvents: streamMetrics?.marketResolvedEvents ?? 0,
      newMarketEvents: streamMetrics?.newMarketEvents ?? 0,
      gammaFallbackCount,
      gammaFallbackTrackedTokenCount: gammaFallbackCount,
    };
  }

  /** Exposed for testing — in production driven by the interval timer. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let tracked: readonly Market[] = [];
    let tokenIdsToPoll: string[] = [];
    try {
      this.log.debug("poll cycle starting");

      if (this.deps.botRunId) {
        await this.deps.bus.publish("MarketDataPollProgress", {
          active: true,
          page: 0,
          botRunId: this.deps.botRunId,
        });
      }

      tracked = this.deps.marketRepo.findTrackedForPricing();
      const trackedDiff = this.refreshTrackedMarkets(tracked);
      await this.publishTrackedMarketsChanged(trackedDiff);
      this.lastTrackedTokenCount = tracked.length;
      if (tracked.length === 0) {
        this.lastFallbackPollCount = 0;
        this.lastStaleTokenCount = 0;
        this.stream?.setTokenIds([]);
        this.log.debug("no active tracked markets — skipping pricing, waiting for scanner");
        // Do NOT update lastSuccessfulDataMs — no tracked markets means
        // discovery hasn't run yet or found nothing. Stay STALE.
        await this.deps.bus.publish("MarketSnapshotReceived", {
          markets: [],
          timestamp: Date.now(),
        });
        return;
      }

      const tokenIds = tracked.map((m) => String(m.tokenId));
      this.stream?.setTokenIds(tokenIds);
      const now = Date.now();
      const fallbackStaleMs = Math.max(STREAM_FALLBACK_MIN_STALE_MS, this.deps.pollIntervalMs * 3);
      tokenIdsToPoll =
        this.stream == null || this.forceFullPoll
          ? tokenIds
          : tokenIds.filter((tokenId) => {
              if (this.pendingGapTokenIds.has(tokenId)) return true;
              const cached = this.marketCache.get(tokenId);
              const lastUpdatedAt = this.lastPricingUpdateAtByToken.get(tokenId) ?? 0;
              return cached == null || now - lastUpdatedAt > fallbackStaleMs;
            });
      this.lastStaleTokenCount = tokenIdsToPoll.length;
      this.lastFallbackPollCount = tokenIdsToPoll.length;
      this.log.debug(
        {
          trackedCount: tracked.length,
          tokenCount: tokenIds.length,
          fallbackPollCount: tokenIdsToPoll.length,
          forceFullPoll: this.forceFullPoll,
        },
        "fetching pricing for tracked markets",
      );

      const pricingMap =
        tokenIdsToPoll.length > 0
          ? await this.deps.gateway.getMarketPricing(tokenIdsToPoll)
          : new Map<string, import("@plankton/domain").MarketPricingSnapshot>();
      const markets: NormalizedMarket[] = [];

      for (const market of tracked) {
        const tokenKey = String(market.tokenId);
        const current = this.marketCache.get(tokenKey);
        const baseMarket = syncTrackedMarket(current ?? null, market, now);
        const pricing = pricingMap.get(String(market.tokenId));
        const nextMarket =
          pricing != null ? applyPricingSnapshot(baseMarket, pricing, now) : baseMarket;
        if (pricing != null) {
          this.lastPricingUpdateAtByToken.set(tokenKey, now);
        }
        this.marketCache.set(tokenKey, nextMarket);
        markets.push(nextMarket);
      }

      this.lastSuccessfulDataMs = now;
      this.forceFullPoll = false;
      // A successful poll means every tracked token is either freshly priced
      // (just fetched) or still considered fresh by the stream. Drop the full
      // gap set instead of only the polled subset — otherwise entries for
      // tokens that weren't repolled linger forever and keep forcing future
      // polls to the full 9735-token batch.
      this.pendingGapTokenIds.clear();
      this.log.info({ tokenCount: markets.length }, "poll cycle complete");

      await this.deps.bus.publish("MarketSnapshotReceived", {
        markets,
        timestamp: now,
      });
    } catch (err) {
      if (this.shouldDegradeToCachedStreamState(err, tracked, tokenIdsToPoll)) {
        const nowMs = Date.now();
        await this.publishCachedMarkets(tracked, nowMs);
        this.log.warn(
          {
            err,
            trackedCount: tracked.length,
            fallbackPollCount: tokenIdsToPoll.length,
          },
          "poll cycle degraded — keeping cached websocket state",
        );
      } else {
        this.log.error({ err }, "poll cycle failed");
      }
    } finally {
      if (this.deps.botRunId) {
        await this.deps.bus.publish("MarketDataPollProgress", {
          active: false,
          page: 0,
          botRunId: this.deps.botRunId,
        });
      }
      this.polling = false;
    }
  }

  private async handleStreamUpdates(updates: readonly MarketPricingStreamUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    for (const update of updates) {
      this.pendingStreamUpdatesByToken.set(String(update.tokenId), update);
    }
    if (this.streamFlushTimer) return;
    this.streamFlushTimer = setTimeout(() => {
      this.streamFlushTimer = null;
      void this.flushPendingStreamUpdates().catch((err) => {
        this.log.error({ err }, "stream update flush failed");
      });
    }, STREAM_UPDATE_COALESCE_MS);
  }

  private async flushPendingStreamUpdates(): Promise<void> {
    if (this.pendingStreamUpdatesByToken.size === 0) return;
    const nowMs = Date.now();
    const updates = [...this.pendingStreamUpdatesByToken.values()];
    this.pendingStreamUpdatesByToken.clear();
    const changedMarkets: NormalizedMarket[] = [];

    for (const update of updates) {
      const tracked = this.trackedMarketsByToken.get(String(update.tokenId));
      if (!tracked) continue;
      const current = syncTrackedMarket(
        this.marketCache.get(String(update.tokenId)) ?? null,
        tracked,
        nowMs,
      );
      const nextMarket = applyStreamUpdate(current, update, nowMs);
      this.lastPricingUpdateAtByToken.set(String(update.tokenId), nowMs);
      if (!didMarketPricingChange(current, nextMarket)) continue;
      this.marketCache.set(String(update.tokenId), nextMarket);
      changedMarkets.push(nextMarket);
    }

    if (changedMarkets.length === 0) return;
    this.lastSuccessfulDataMs = nowMs;
    this.log.debug(
      {
        coalescedUpdates: updates.length,
        changedMarkets: changedMarkets.length,
      },
      "publishing coalesced stream market snapshot",
    );
    await this.deps.bus.publish("MarketSnapshotReceived", {
      markets: changedMarkets,
      timestamp: nowMs,
    });
  }

  private async handleLifecycleEvents(
    events: readonly MarketPricingLifecycleEvent[],
  ): Promise<void> {
    for (const event of events) {
      if (event.type === "market_resolved") {
        await this.deps.bus.publish("MarketResolvedHint", {
          conditionId: event.conditionId,
          marketId: event.marketId,
          slug: event.slug,
          tokenIds: event.tokenIds,
          winningTokenId: event.winningTokenId,
          timestamp: event.timestamp,
        });
        continue;
      }
      await this.deps.bus.publish("NewMarketDiscoveredHint", {
        conditionId: event.conditionId,
        marketId: event.marketId,
        slug: event.slug,
        question: event.question,
        active: event.active,
        tokenIds: event.tokenIds,
        timestamp: event.timestamp,
      });
    }
  }

  private refreshTrackedMarkets(tracked: readonly Market[]): {
    added: string[];
    removed: string[];
    active: string[];
  } {
    const previousTokenIds = new Set(this.trackedMarketsByToken.keys());
    const nextTokenIds = new Set<string>();
    const added: string[] = [];
    for (const market of tracked) {
      const tokenKey = String(market.tokenId);
      nextTokenIds.add(tokenKey);
      this.trackedMarketsByToken.set(tokenKey, market);
      if (!previousTokenIds.has(tokenKey)) added.push(tokenKey);
    }
    const removed: string[] = [];
    for (const tokenId of [...this.trackedMarketsByToken.keys()]) {
      if (nextTokenIds.has(tokenId)) continue;
      this.trackedMarketsByToken.delete(tokenId);
      this.marketCache.delete(tokenId);
      this.lastPricingUpdateAtByToken.delete(tokenId);
      removed.push(tokenId);
    }
    return { added, removed, active: [...nextTokenIds] };
  }

  private async publishTrackedMarketsChanged(diff: {
    added: string[];
    removed: string[];
    active: string[];
  }): Promise<void> {
    if (diff.added.length === 0 && diff.removed.length === 0) return;
    await this.deps.bus.publish("TrackedMarketsChanged", {
      addedTokenIds: diff.added.map((t) => createTokenId(t)),
      removedTokenIds: diff.removed.map((t) => createTokenId(t)),
      activeTokenIds: diff.active.map((t) => createTokenId(t)),
      timestamp: Date.now(),
    });
  }

  private countTrackedGammaFallbackMarkets(): number {
    let count = 0;
    for (const tokenId of this.trackedMarketsByToken.keys()) {
      if (this.marketCache.get(tokenId)?.bookSource === "gamma-fallback") {
        count++;
      }
    }
    return count;
  }

  private shouldDegradeToCachedStreamState(
    err: unknown,
    tracked: readonly Market[],
    tokenIdsToPoll: readonly string[],
  ): boolean {
    return (
      this.stream != null &&
      tracked.length > 0 &&
      tokenIdsToPoll.length > 0 &&
      tokenIdsToPoll.every((tokenId) => this.marketCache.has(tokenId)) &&
      isTransientNetworkError(err)
    );
  }

  private async publishCachedMarkets(tracked: readonly Market[], nowMs: number): Promise<void> {
    const markets: NormalizedMarket[] = [];
    for (const trackedMarket of tracked) {
      const tokenKey = String(trackedMarket.tokenId);
      const nextMarket = syncTrackedMarket(
        this.marketCache.get(tokenKey) ?? null,
        trackedMarket,
        nowMs,
      );
      this.marketCache.set(tokenKey, nextMarket);
      markets.push(nextMarket);
    }
    await this.deps.bus.publish("MarketSnapshotReceived", {
      markets,
      timestamp: nowMs,
    });
  }
}

function normalizeGapTokenIds(tokenIds: readonly string[] | undefined): string[] {
  if (!tokenIds) return [];
  return [
    ...new Set(tokenIds.map((tokenId) => tokenId.trim()).filter((tokenId) => tokenId.length > 0)),
  ];
}

function syncTrackedMarket(
  current: NormalizedMarket | null,
  tracked: Market,
  nowMs: number,
): NormalizedMarket {
  return {
    tokenId: tracked.tokenId,
    conditionId: tracked.conditionId,
    slug: tracked.slug,
    eventSlug: tracked.eventSlug,
    question: tracked.question,
    outcome: tracked.outcome,
    outcomeIndex: tracked.outcomeIndex ?? null,
    regime: tracked.regime,
    horizon: tracked.horizon,
    endDate: tracked.endDate,
    active: tracked.active,
    tradable: tracked.tradable,
    tickSize: tracked.tickSize,
    negRisk: tracked.negRisk,
    acceptingOrders: current?.acceptingOrders ?? false,
    enableOrderBook: current?.enableOrderBook ?? false,
    bestBid: current?.bestBid ?? null,
    bestAsk: current?.bestAsk ?? null,
    midPrice: current?.midPrice ?? null,
    spread: current?.spread ?? null,
    lastTradePrice: current?.lastTradePrice ?? null,
    lastTradeAt: current?.lastTradeAt ?? null,
    volume24h: current?.volume24h ?? null,
    liquidity: current?.liquidity ?? null,
    minOrderSize: current?.minOrderSize ?? null,
    bookSource: current?.bookSource ?? "unknown",
    snapshotTs: current?.snapshotTs ?? nowMs,
    // Use the persisted eventMarketCount from the DB row (set by scanner since Phase 4).
    // Fall back to current cached value, then to the DB default of 1.
    eventMarketCount: tracked.eventMarketCount ?? current?.eventMarketCount ?? 1,
  };
}
