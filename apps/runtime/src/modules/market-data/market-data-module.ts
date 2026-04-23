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
const STREAM_GAMMA_REFRESH_MIN_STALE_MS = 30_000;
const STREAM_QUIET_CLOB_REFRESH_MIN_STALE_MS = 60_000;
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
  readonly silentTrackedTokenCount: number;
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
  readonly gammaFallbackExecutionCriticalCount: number;
  readonly gammaFallbackEntryCandidateCount: number;
}

type WsTierRole = "executionCritical" | "entryCandidate" | "legacy";

export interface MarketDataModuleDeps {
  gateway: MarketDataGateway;
  marketRepo: MarketRepository;
  bus: EventBus;
  log: Logger;
  pollIntervalMs: number;
  staleThresholdMs: number;
  botRunId?: string;
  /** Max tokens subscribed via WebSocket (executionCritical + entryCandidates). Default: unbounded (legacy). */
  maxTrackedTokens?: number;
  /** Interval in ms between discovery-tier poll batches. Default: 60_000. */
  discoveryPollIntervalMs?: number;
  /** Number of discovery-tier tokens to poll per batch cycle. Default: 200. */
  discoveryBatchSize?: number;
  /**
   * Safety cap for the main poll batch under forceFullPoll (Task 5).
   * If the priority tier somehow exceeds this limit, the batch is trimmed and
   * a warning is logged. Default: 500.
   */
  fallbackBatchSize?: number;
}

export class MarketDataModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private discoveryPollTimer: ReturnType<typeof setInterval> | null = null;
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
  private lastSilentTrackedTokenCount = 0;
  private lastFallbackPollCount = 0;
  private readonly wsTierRoleByToken = new Map<string, WsTierRole>();
  private readonly pendingStreamUpdatesByToken = new Map<string, MarketPricingStreamUpdate>();
  private streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private gapLogTimer: ReturnType<typeof setTimeout> | null = null;
  private gapLogBurstShardCount = 0;
  private gapLogBurstTokenCount = 0;
  private gapLogBurstForceFullPoll = false;
  private readonly gapLogBurstReasons = new Set<string>();
  /** Discovery-tier markets (beyond WS cap) — polled in rolling batches. */
  private discoveryTier: Market[] = [];
  private discoveryCursor = 0;
  /**
   * Token ids from the last discovery poll batch. Discovery snapshots flow
   * into downstream caches (MarketSelectionCache, SignalToOrderBridge) via
   * NormalizedMarketUpdated, but those caches only evict on
   * TrackedMarketsChanged.removedTokenIds. We remember the previous batch so
   * we can emit targeted eviction when the rolling cursor moves on, keeping
   * downstream cache footprint bounded to (WS tier + current discovery batch).
   */
  private lastDiscoveryBatchTokenIds: Set<string> = new Set();
  /**
   * True when the stream-level circuit breaker is open — the module degrades to
   * poll-only mode, polling the full WS-tier each cycle. Readable by Task 5.
   */
  private _streamDegradedMode = false;

  get streamDegradedMode(): boolean {
    return this._streamDegradedMode;
  }

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

    // Discovery poll loop: separate channel for tokens beyond the WS cap.
    const discoveryIntervalMs = this.deps.discoveryPollIntervalMs ?? 60_000;
    this.discoveryPollTimer = setInterval(() => {
      this.pollDiscoveryBatch().catch((err) =>
        this.log.error({ err }, "discovery poll cycle error"),
      );
    }, discoveryIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.discoveryPollTimer) {
      clearInterval(this.discoveryPollTimer);
      this.discoveryPollTimer = null;
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
    // Evict any tokens from the final discovery batch so downstream caches
    // don't retain the tail across restarts / supervisor rotation.
    await this.flushDiscoveryBatchEviction(new Set(), Date.now());
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
    const gammaFallbackCounts = this.countTrackedGammaFallbackMarkets();
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
      silentTrackedTokenCount: this.lastSilentTrackedTokenCount,
      fallbackPollCount: this.lastFallbackPollCount,
      fullBookTokenCount: streamMetrics?.fullBookTokenCount ?? 0,
      bookEventsReceived: streamMetrics?.bookEventsReceived ?? 0,
      narrowSubscribeCount: streamMetrics?.narrowSubscribeCount ?? 0,
      narrowUnsubscribeCount: streamMetrics?.narrowUnsubscribeCount ?? 0,
      narrowRefCountLeaks: streamMetrics?.narrowRefCountLeaks ?? 0,
      marketResolvedEvents: streamMetrics?.marketResolvedEvents ?? 0,
      newMarketEvents: streamMetrics?.newMarketEvents ?? 0,
      gammaFallbackCount: gammaFallbackCounts.total,
      gammaFallbackTrackedTokenCount: gammaFallbackCounts.total,
      gammaFallbackExecutionCriticalCount: gammaFallbackCounts.executionCritical,
      gammaFallbackEntryCandidateCount: gammaFallbackCounts.entryCandidate,
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

      // Determine tracked WS-tier markets (executionCritical + entryCandidates).
      if (this.deps.maxTrackedTokens != null) {
        const tiered = this.deps.marketRepo.findTrackedForPricingTiered({
          maxTokens: this.deps.maxTrackedTokens,
        });
        this.syncWsTierRoles({
          executionCritical: tiered.executionCritical,
          entryCandidates: tiered.entryCandidates,
        });
        // Merge WS tier into a flat list for the existing poll machinery.
        tracked = [...tiered.executionCritical, ...tiered.entryCandidates];
        // Discovery tier refreshed each poll cycle so cursor stays valid.
        this.discoveryTier = tiered.discoveryOnly;
        if (this.discoveryCursor >= this.discoveryTier.length) {
          this.discoveryCursor = 0;
        }
      } else {
        // Legacy flat path (simulation / tests that don't set maxTrackedTokens).
        tracked = this.deps.marketRepo.findTrackedForPricing();
        this.discoveryTier = [];
        this.syncWsTierRoles({ legacy: tracked });
      }

      const trackedDiff = this.refreshTrackedMarkets(tracked);
      await this.publishTrackedMarketsChanged(trackedDiff);
      this.lastTrackedTokenCount = tracked.length;
      if (tracked.length === 0) {
        this.lastFallbackPollCount = 0;
        this.lastStaleTokenCount = 0;
        this.lastSilentTrackedTokenCount = 0;
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
      // Feed only WS-tier (executionCritical + entryCandidates) to the stream.
      this.stream?.setTokenIds(tokenIds);
      const now = Date.now();
      const fallbackHardStaleMs = Math.max(
        STREAM_FALLBACK_MIN_STALE_MS,
        this.deps.pollIntervalMs * 3,
      );
      let silentTrackedTokenCount = 0;

      if (this.stream == null || this.forceFullPoll) {
        // Under forceFullPoll (gap/circuit-open), only poll the priority tier
        // (executionCritical + entryCandidates) — `tracked` already contains
        // exactly those tokens. Discovery staleness is tolerable; it has its
        // own rolling timer. Apply a defensive cap in case Task 1 bounds are
        // exceeded for any reason.
        tokenIdsToPoll = [...tokenIds];
        const cap = this.deps.fallbackBatchSize ?? 500;
        if (tokenIdsToPoll.length > cap) {
          this.log.warn(
            { tokenCount: tokenIdsToPoll.length, cap },
            "priority-tier poll batch exceeds fallbackBatchSize cap — trimming",
          );
          tokenIdsToPoll = tokenIdsToPoll.slice(0, cap);
        }
      } else {
        tokenIdsToPoll = tokenIds.filter((tokenId) => {
          if (this.pendingGapTokenIds.has(tokenId)) return true;
          const cached = this.marketCache.get(tokenId);
          const lastUpdatedAt = this.lastPricingUpdateAtByToken.get(tokenId) ?? 0;
          if (cached == null) return true;
          const ageMs = now - lastUpdatedAt;
          const refreshBudgetMs = getTrackedTokenRefreshBudgetMs(cached, this.deps.pollIntervalMs);
          if (ageMs > refreshBudgetMs) return true;
          if (ageMs > fallbackHardStaleMs) {
            silentTrackedTokenCount += 1;
          }
          return false;
        });
      }

      this.lastStaleTokenCount = tokenIdsToPoll.length;
      this.lastSilentTrackedTokenCount = silentTrackedTokenCount;
      this.lastFallbackPollCount = tokenIdsToPoll.length;
      this.log.debug(
        {
          trackedCount: tracked.length,
          tokenCount: tokenIds.length,
          silentTrackedTokenCount,
          fallbackPollCount: tokenIdsToPoll.length,
          forceFullPoll: this.forceFullPoll,
        },
        "fetching pricing for tracked markets",
      );

      // Scale timeout proportionally to batch size: base 5 s + 10 ms/token, cap 30 s.
      const timeoutMs = Math.min(30_000, 5_000 + tokenIdsToPoll.length * 10);
      const pricingMap =
        tokenIdsToPoll.length > 0
          ? await this.deps.gateway.getMarketPricing(tokenIdsToPoll, { timeoutMs })
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

  /**
   * Poll a rolling batch from the discovery tier via Gamma REST.
   * Advances `discoveryCursor` so each invocation covers a different slice.
   *
   * Discovery tokens are NOT in the WS stream and are deliberately kept out
   * of `trackedMarketsByToken` / `marketCache` / `lastPricingUpdateAtByToken`
   * to avoid WS-tier retention growing without bound. Instead we build
   * NormalizedMarket snapshots on the fly and publish them so downstream
   * modules (Normalization, AlgoDecision, SignalToOrder) see fresh pricing.
   */
  private async pollDiscoveryBatch(): Promise<void> {
    if (this.discoveryTier.length === 0) {
      // Even when the discovery tier has emptied out (scanner withdrew it, or
      // selection rules narrowed the universe), we must still flush any
      // tokens from the previous batch so they don't linger in downstream
      // caches forever.
      await this.flushDiscoveryBatchEviction(new Set(), Date.now());
      return;
    }
    const batchSize = this.deps.discoveryBatchSize ?? 200;
    const cursor = this.discoveryCursor % this.discoveryTier.length;
    const batch = this.discoveryTier.slice(cursor, cursor + batchSize);
    const tokenIds = batch.map((m) => String(m.tokenId));
    const marketByToken = new Map<string, Market>();
    for (const market of batch) {
      marketByToken.set(String(market.tokenId), market);
    }
    this.discoveryCursor = (cursor + batch.length) % this.discoveryTier.length;

    try {
      const pricingMap = await this.deps.gateway.getMarketPricing(tokenIds);
      const nowMs = Date.now();
      const snapshots: NormalizedMarket[] = [];
      for (const [tokenId, pricing] of pricingMap) {
        const market = marketByToken.get(tokenId);
        if (market == null) continue;
        const baseMarket = syncTrackedMarket(null, market, nowMs);
        snapshots.push(applyPricingSnapshot(baseMarket, pricing, nowMs));
      }
      this.log.debug(
        {
          batchSize: batch.length,
          cursor,
          discoveryTotal: this.discoveryTier.length,
          publishedCount: snapshots.length,
        },
        "discovery poll batch complete",
      );
      if (snapshots.length > 0) {
        await this.deps.bus.publish("MarketSnapshotReceived", {
          markets: snapshots,
          timestamp: nowMs,
        });
      }

      await this.flushDiscoveryBatchEviction(new Set(tokenIds), nowMs);
    } catch (err) {
      this.log.warn({ err }, "discovery poll batch failed");
    }
  }

  /**
   * Emit TrackedMarketsChanged.removedTokenIds for previous-batch tokens that
   * are neither in the current batch nor in the WS tier so downstream caches
   * (MarketSelectionCache, SignalToOrderBridge, AlgoDecision sweep) stay
   * bounded to (WS tier + current discovery batch). Called after each
   * successful discovery poll AND on lifecycle edges where the batch would
   * otherwise be left dangling (empty discovery tier, module stop).
   */
  private async flushDiscoveryBatchEviction(
    currentBatchTokens: ReadonlySet<string>,
    nowMs: number,
  ): Promise<void> {
    if (this.lastDiscoveryBatchTokenIds.size === 0) {
      this.lastDiscoveryBatchTokenIds = new Set(currentBatchTokens);
      return;
    }
    const wsTier = new Set(this.trackedMarketsByToken.keys());
    const removedTokenIds: string[] = [];
    for (const prev of this.lastDiscoveryBatchTokenIds) {
      if (!currentBatchTokens.has(prev) && !wsTier.has(prev)) {
        removedTokenIds.push(prev);
      }
    }
    if (removedTokenIds.length > 0) {
      await this.deps.bus.publish("TrackedMarketsChanged", {
        addedTokenIds: [],
        removedTokenIds: removedTokenIds.map((t) => createTokenId(t)),
        activeTokenIds: [...wsTier].map((t) => createTokenId(t)),
        timestamp: nowMs,
      });
    }
    this.lastDiscoveryBatchTokenIds = new Set(currentBatchTokens);
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
      // queue_overflow: route affected tokens to poll-fallback (Task 3 + Task 4 alignment).
      // Dropped WS updates cannot be recovered from the queue — the next poll
      // cycle must refetch fresh pricing for each affected token.
      if (event.type === "queue_overflow") {
        if (event.tokenIds.length > 0) {
          this.log.warn(
            { shardId: event.shardId, tokenCount: event.tokenIds.length },
            "ws ingress queue overflow — routing tokens to poll-fallback",
          );
          for (const tokenId of event.tokenIds) {
            this.pendingGapTokenIds.add(tokenId);
          }
        }
        continue;
      }

      // shard_circuit_open: merge shard's tokens into pendingGapTokenIds so the
      // next poll cycle fetches fresh pricing for them via Gamma REST.
      // Other shards keep streaming — only this shard's tokens degrade to poll.
      if (event.type === "shard_circuit_open") {
        this.log.warn(
          {
            shardId: event.shardId,
            tokenCount: event.tokenIds.length,
            reopenAtMs: event.reopenAtMs,
          },
          "shard circuit breaker opened — routing tokens to poll-fallback",
        );
        for (const tokenId of event.tokenIds) {
          this.pendingGapTokenIds.add(tokenId);
        }
        continue;
      }

      // shard_circuit_closed: natural reconciliation drains pendingGapTokenIds
      // on the next successful poll — no extra action needed here.
      if (event.type === "shard_circuit_closed") {
        this.log.info(
          { shardId: event.shardId, tokenCount: event.tokenIds.length },
          "shard circuit breaker closed — resuming WS streaming",
        );
        continue;
      }

      // stream_circuit_open: degrade to full poll-only for the WS-tier.
      if (event.type === "stream_circuit_open") {
        this.log.warn(
          { reopenAtMs: event.reopenAtMs, reason: event.reason },
          "stream circuit breaker opened — degrading to poll-only mode",
        );
        this._streamDegradedMode = true;
        this.forceFullPoll = true;
        continue;
      }

      // stream_circuit_closed: restore normal WS-primary mode.
      if (event.type === "stream_circuit_closed") {
        this.log.info("stream circuit breaker closed — resuming WS-primary mode");
        this._streamDegradedMode = false;
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
    // Defensive sweep: any entry in the aux caches that isn't in the current
    // WS tier is an orphan (e.g., from past discovery-tier leaks or renames).
    // Keep these maps bounded to the WS tier — discovery snapshots are
    // published on the fly and must not leave residue here.
    for (const tokenId of [...this.marketCache.keys()]) {
      if (!nextTokenIds.has(tokenId)) this.marketCache.delete(tokenId);
    }
    for (const tokenId of [...this.lastPricingUpdateAtByToken.keys()]) {
      if (!nextTokenIds.has(tokenId)) this.lastPricingUpdateAtByToken.delete(tokenId);
    }
    for (const tokenId of [...this.wsTierRoleByToken.keys()]) {
      if (!nextTokenIds.has(tokenId)) this.wsTierRoleByToken.delete(tokenId);
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

  private countTrackedGammaFallbackMarkets(): {
    total: number;
    executionCritical: number;
    entryCandidate: number;
  } {
    let total = 0;
    let executionCritical = 0;
    let entryCandidate = 0;
    for (const tokenId of this.trackedMarketsByToken.keys()) {
      if (this.marketCache.get(tokenId)?.bookSource === "gamma-fallback") {
        total++;
        const role = this.wsTierRoleByToken.get(tokenId);
        if (role === "executionCritical") executionCritical++;
        else if (role === "entryCandidate") entryCandidate++;
      }
    }
    return { total, executionCritical, entryCandidate };
  }

  private syncWsTierRoles(args: {
    executionCritical?: readonly Market[];
    entryCandidates?: readonly Market[];
    legacy?: readonly Market[];
  }): void {
    this.wsTierRoleByToken.clear();
    for (const market of args.executionCritical ?? []) {
      this.wsTierRoleByToken.set(String(market.tokenId), "executionCritical");
    }
    for (const market of args.entryCandidates ?? []) {
      this.wsTierRoleByToken.set(String(market.tokenId), "entryCandidate");
    }
    for (const market of args.legacy ?? []) {
      this.wsTierRoleByToken.set(String(market.tokenId), "legacy");
    }
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

function getTrackedTokenRefreshBudgetMs(
  market: Pick<NormalizedMarket, "bookSource">,
  pollIntervalMs: number,
): number {
  if (market.bookSource === "clob") {
    return Math.max(STREAM_QUIET_CLOB_REFRESH_MIN_STALE_MS, pollIntervalMs * 12);
  }
  return Math.max(STREAM_GAMMA_REFRESH_MIN_STALE_MS, pollIntervalMs * 6);
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
