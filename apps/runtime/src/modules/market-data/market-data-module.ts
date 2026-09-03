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
  RuntimeControl,
  EventBus,
  MarketDataGateway,
  MarketPricingSnapshot,
  MarketPricingLifecycleEvent,
  MarketPricingRawTradeObservation,
  MarketRepository,
  MarketPricingStream,
  MarketPricingStreamMetricsSnapshot,
  MarketPricingStreamUpdate,
  OrderBookSnapshot,
  Market,
  Position,
  TrackedForPricing,
  NormalizedMarket,
  TokenId,
  MarketTradeCountProvider,
  V4AdmissionTelemetrySnapshot,
  SignatureThresholds,
} from "@krabs/domain";
import {
  PositionStatus,
  createConditionId,
  createTokenId,
  recordStageDuration,
} from "@krabs/domain";
import { performance } from "node:perf_hooks";
import type { Logger } from "../../logger.js";
import { isKnownMinOrderSize } from "../../min-order-size.js";
import {
  classifyHttpError,
  isRateLimitError,
  isTransientNetworkError,
  type HttpErrorClass,
} from "../../network-errors.js";
import {
  consumeWarnThrottle,
  createWarnThrottleState,
  resetWarnThrottle,
  type WarnThrottleState,
} from "../../warn-throttle.js";
import {
  applyPricingSnapshot,
  applyStreamUpdate,
  didMarketPricingChange,
} from "./market-pricing-utils.js";

const STREAM_FALLBACK_MIN_STALE_MS = 15_000;
const STREAM_GAMMA_REFRESH_MIN_STALE_MS = 30_000;
const STREAM_QUIET_CLOB_REFRESH_MIN_STALE_MS = 60_000;
const STREAM_UNKNOWN_EXECUTION_CRITICAL_REFRESH_MIN_STALE_MS = 15_000;
const STREAM_UNKNOWN_ENTRY_CANDIDATE_REFRESH_MIN_STALE_MS = 120_000;
const STREAM_UNKNOWN_LEGACY_REFRESH_MIN_STALE_MS = 30_000;
const STREAM_UPDATE_COALESCE_MS = 100;
/**
 * Floor for the parked-hydration cap; the real cap follows `maxTrackedTokens`.
 *
 * Parked hydrations are retried every poll, so the cap only stops tokens that
 * never return — but every parked value belongs to a token we still route to,
 * and evicting one loses a minimum nothing re-observes until the hydration
 * retry window elapses. A fixed 512 was below the 2 000–5 000 tracked tier the
 * runtime advertises, so one pre-pause `/books` batch could overflow it. The
 * floor covers the legacy flat path, which sets no tracked-token cap.
 */
const MIN_PENDING_MIN_ORDER_SIZE_HYDRATIONS = 512;

/** A minimum awaiting delivery, plus when the hydration branch last repolled it. */
interface ParkedMinOrderSize {
  minOrderSize: number;
  repolledAt: number;
}
// Step 3 (audit doc §F2): soft-ranking feature inputs (`liquidity`,
// `volume24hr`) only refresh via REST/Gamma — CLOB stream updates do NOT
// carry them. The book-refresh budget can return Infinity for healthy
// WS-tier tokens, so we need a separate, smaller budget keyed off
// `featuresCapturedTs` to make sure feature timestamps stay inside the
// 4h freshness window enforced by `effectiveScore` in the repository.
// 3h gives ~1h of slack before scores get nulled by staleness.
const SOFT_RANKING_FEATURE_REFRESH_MAX_AGE_MS = 3 * 60 * 60 * 1000;
// Shard fan-out: one WS disconnect can fire 20× onGapDetected in quick succession,
// one per shard. Coalesce the warn log into a single line per burst. State
// updates (pendingGapTokenIds, forceFullPoll) stay synchronous so the next
// poll still picks up every gap.
const GAP_LOG_DEBOUNCE_MS = 250;
const FALLBACK_POLL_TIMEOUT_BASE_MS = 10_000;
const FALLBACK_POLL_TIMEOUT_PER_TOKEN_MS = 25;
const FALLBACK_POLL_TIMEOUT_MAX_MS = 30_000;
const TRANSIENT_POLL_WARN_THROTTLE_MS = 15 * 60_000;
const GAMMA_RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const PUBLIC_TRADE_COUNT_ENRICH_CONCURRENCY = 5;
const DEFAULT_TIERED_PRICING_CACHE_TTL_MS = 60_000;
const BOOK_SIGNAL_FULL_BOOK_CAP_WARN_THROTTLE_MS = 15 * 60_000;
/**
 * How many departed tokens keep their fallback-poll wait for a possible rejoin. Comfortably above
 * any realistic tracked set, so a token that leaves and returns within the same trading day always
 * resumes its wait, while a process that churns through tokens for weeks stays bounded.
 */
const RETAINED_FALLBACK_WAIT_LIMIT = 5_000;

export interface MarketDataTrackedRoleCounts {
  executionCritical: number;
  /** Reserved plankton-signature tier (spec 2026-07-01) — see WsTierRole. */
  planktonSignature: number;
  entryCandidate: number;
  legacy: number;
  unassigned: number;
}

export interface MarketDataTrackedBookSourceCounts {
  unknown: number;
  clob: number;
  gamma: number;
  gammaFallback: number;
  other: number;
}

export interface MarketDataFallbackReasonCounts {
  pendingGap: number;
  missingCache: number;
  unknownSourceRefresh: number;
  knownSourceRefresh: number;
  forceFullPoll: number;
  streamUnavailable: number;
  /**
   * Step 3 (audit doc §F2): tokens repolled because the soft-ranking
   * feature timestamp (`featuresCapturedTs`) exceeded the REST/Gamma
   * feature-refresh budget (`SOFT_RANKING_FEATURE_REFRESH_MAX_AGE_MS`),
   * even when the book itself is still considered fresh by the stream.
   */
  featureFreshness: number;
  /**
   * Tokens repolled because a hydrated `minOrderSize` is still parked. A parked
   * value only reaches downstream on a publish, and a publish needs fresh
   * pricing; a healthy WS-tier token with a known `bookSource` has an INFINITE
   * book budget, so nothing else would poll it.
   */
  minOrderSizeHydration: number;
}

export interface MarketDataTrackedDiffCounts {
  added: number;
  removed: number;
  unchanged: number;
}

export interface MarketDataStreamActivitySnapshot {
  readonly wsEnabled: boolean;
  readonly windowStartMs: number | null;
  readonly wsEventsReceived: number;
  readonly wsEventsReceivedPerSec: number;
  readonly wsUpdatesApplied: number;
  readonly rawWsRecords: number;
  readonly rawWsRecordsPerSec: number;
  readonly parsedUpdates: number;
  readonly parsedUpdatesPerSec: number;
  readonly emittedUpdates: number;
  readonly emittedUpdatesPerSec: number;
  readonly noopUpdates: number;
  readonly noopUpdatesPerSec: number;
  readonly suppressedTradingNoopCountTotal: number;
  readonly suppressedTradingNoopPerSec: number;
  readonly suppressedTradingNoopByReason: MarketPricingStreamMetricsSnapshot["suppressedTradingNoopByReason"];
  readonly hubFilterChecked: number;
  readonly hubFilterCheckedPerSec: number;
  readonly hubFilterPassed: number;
  readonly hubFilterPassedPerSec: number;
  readonly trackedTokenCount: number;
  /**
   * ADR-021 §D-F #1 — WS-tier capacity utilisation as a 0–100 integer.
   * `round(trackedTokenCount * 100 / maxTrackedTokens)`. Null when the
   * module runs without a configured cap (legacy / simulation paths).
   * Sustained ≥80 % is the operational signal for a D-C cap resize.
   */
  readonly wsCapUtilizationPct: number | null;
  readonly shardCount: number;
  readonly reconnectCount: number;
  readonly wsEventGapDetected: number;
  readonly wsLatencyMs: MarketPricingStreamMetricsSnapshot["wsLatencyMs"];
  readonly trackedRoleCounts: MarketDataTrackedRoleCounts;
  readonly trackedBookSourceCounts: MarketDataTrackedBookSourceCounts;
  readonly staleTokenCount: number;
  readonly silentTrackedTokenCount: number;
  readonly fallbackPollCount: number;
  readonly fallbackCandidateCount: number;
  readonly fallbackDeferredCount: number;
  readonly pendingGapTokenCount: number;
  readonly fallbackDroppedStaleCount: number;
  readonly fallbackPollLimit: number;
  readonly fallbackReasonCounts: MarketDataFallbackReasonCounts;
  readonly fallbackRoleCounts: MarketDataTrackedRoleCounts;
  readonly trackedDiffCounts: MarketDataTrackedDiffCounts;
  readonly cachedTrackedTokenCountAtPollStart: number;
  readonly pricingHitCountLastPoll: number;
  readonly fullBookTokenCount: number;
  readonly bookSignalFullBookDemandCount: number;
  readonly bookSignalFullBookSubscribedCount: number;
  readonly bookSignalFullBookSkippedCount: number;
  readonly bookSignalFullBookCapUtilizationPct: number | null;
  readonly bookEventsReceived: number;
  readonly narrowSubscribeCount: number;
  readonly narrowUnsubscribeCount: number;
  readonly narrowRefCountLeaks: number;
  readonly marketResolvedEvents: number;
  readonly newMarketEvents: number;
  readonly v4AdmissionTelemetry: V4AdmissionTelemetrySnapshot | null;
  readonly gammaFallbackCount: number;
  readonly gammaFallbackTrackedTokenCount: number;
  readonly gammaFallbackExecutionCriticalCount: number;
  readonly gammaFallbackEntryCandidateCount: number;
  readonly publicTradeCountEnrichmentEligibleCount: number;
  readonly publicTradeCountEnrichmentSkippedCount: number;
  readonly publicTradeCountEnrichmentConditionCount: number;
  readonly publicTradeCountEnrichmentRequestCount: number;
  readonly wsGapsByShard: Readonly<Record<string, number>>;
  readonly wsHeartbeat: MarketPricingStreamMetricsSnapshot["wsHeartbeat"] | null;
  readonly wsWorkerMemory: MarketPricingStreamMetricsSnapshot["wsWorkerMemory"] | null;
}

type WsTierRole = "executionCritical" | "planktonSignature" | "entryCandidate" | "legacy";
type FallbackReason = keyof MarketDataFallbackReasonCounts;

interface FallbackPollCandidate {
  readonly tokenId: string;
  readonly role: WsTierRole | undefined;
  readonly reason: FallbackReason;
}

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
  /**
   * Reserved WS-tier slots for plankton-signature markets (spec 2026-07-01),
   * given live slots before V4 ranking applies. Forwarded to
   * `findTrackedForPricingTiered`. Default: repo default (300).
   */
  signatureReserve?: number;
  /** Thresholds a fresh market must clear to match the signature. Default: repo default. */
  signatureThresholds?: SignatureThresholds;
  /**
   * Shadow-first rollout (2026-07-02). "shadow" (default when undefined) calls
   * the repo with `reserveSignature: false` so signature markets are never
   * pulled out of the V4 pool — `planktonSignature` is a measurement
   * projection only, and every market still flows into entryCandidates/
   * discoveryOnly (and therefore into `tracked`/`discoveryTier`) exactly as it
   * would without the signature feature, producing ZERO change to live
   * placement vs baseline. "live" calls the repo with `reserveSignature: true`,
   * feeds `planktonSignature` into `tracked`, and tags them with the
   * `planktonSignature` WS-tier role, so R23 can start entering signature
   * markets.
   */
  signatureTierMode?: "shadow" | "live";
  /**
   * Observe-only coverage metric sink (spec 2026-07-01 §4.5): called once per
   * poll with `inLiveTier: "yes"` (count = planktonSignature.length) and once
   * with `"no"` (count = signatureOverflow) — the denominator is always the
   * full signature-matching set, not just what fit in the WS tier. `mode`
   * reflects whether the tier is currently shadow-only or live (§4.6).
   */
  recordSignatureCoverage?: (
    inLiveTier: "yes" | "no",
    count: number,
    mode: "shadow" | "live",
  ) => void;
  /** Observe-only current tracked-set snapshot; failures must not affect pricing. */
  trackedMarketObserver?: (activeTokenIds: readonly string[], observedAt: number) => void;
  /** Interval in ms between discovery-tier poll batches. Default: 300_000. */
  discoveryPollIntervalMs?: number;
  /** Number of discovery-tier tokens to poll per batch cycle. Default: 50. */
  discoveryBatchSize?: number;
  /**
   * Safety cap for the main poll batch under forceFullPoll (Task 5).
   * If the priority tier somehow exceeds this limit, the batch is trimmed and
   * a warning is logged. Default: 500.
   */
  fallbackBatchSize?: number;
  /** Max tokens included in one fallback REST poll after WS gaps. Default: 50. */
  fallbackPollMaxConcurrency?: number;
  /** Sustained fallback poll token budget per second. Default: 5 tokens/s. */
  fallbackPollRatePerSec?: number;
  /** Drop stale gap tokens after this age instead of re-polling forever. Default: 30s. */
  fallbackStaleTokenAgeMs?: number;
  /** Cache the expensive priority-universe DB scan/sort. Default: 60s. */
  tieredPricingCacheTtlMs?: number;
  /** Optional Data API enrichment for D9_LOSS_EXIT liquidity signal. */
  tradeCountProvider?: MarketTradeCountProvider;
  /**
   * Restricts public_trade_count enrichment to tokens where D9 or an already
   * selected entry path can use it. Keeping this predicate narrow prevents
   * 5000-token entry batches from fanning out into hundreds of Data API calls.
   */
  publicTradeCountEnrichmentFilter?: (tokenId: string, role: WsTierRole | undefined) => boolean;
  httpErrorMetricsSink?: (
    event: Readonly<{ source: string; errorClass: HttpErrorClass; message: string }>,
  ) => void;
  fullLifetimeSnapshots?: {
    enabled: boolean;
    heartbeatMs: number;
    postCloseGraceMs: number;
    activePositionTokenIds: () => readonly TokenId[];
    recordMissingMarket?: (reason: FullLifetimeMarketCacheMissReason) => void;
    recordMarketCacheHydrated?: (reason: FullLifetimeMarketCacheHydratedReason) => void;
    recordSkippedSnapshot?: (reason: FullLifetimeSnapshotSkipReason) => void;
  };
  /**
   * Optional pause gate. When the runtime is paused, periodic poll and
   * discovery batch cycles are skipped so the bot stops issuing new external
   * requests. Incoming WS events still update the in-memory cache, but
   * `MarketSnapshotReceived` bus publications are suppressed so downstream
   * writers (snapshot writer, risk inventory mark-to-market, soft-ranking
   * scorer) stop dirtying the database while paused.
   */
  runtimeControl?: RuntimeControl;
  bookSignals?: {
    openPositionTokenIds: () => readonly import("@krabs/domain").TokenId[];
    /**
     * Trade-stats track-set — the tokens book-signals should accumulate (positions ∪ GATE-whitelist
     * entry candidates), so `tradeCount3h` is available at GATE entry time. Falls back to
     * `openPositionTokenIds` when absent. Distinct from the full-book (depth) subscription, which
     * stays position-only to respect its capped WS budget.
     */
    trackedTokenIds?: () => readonly import("@krabs/domain").TokenId[];
    setOpenPositionTokenIds: (tokenIds: readonly import("@krabs/domain").TokenId[]) => void;
    ingestTopOfBook: (observation: {
      readonly tokenId: import("@krabs/domain").TokenId;
      readonly ts: number;
      readonly bestBid: number | null;
      readonly bestAsk?: number | null;
    }) => void;
    ingestLastTradePrice: (observation: {
      readonly tokenId: import("@krabs/domain").TokenId;
      readonly ts: number;
      readonly price: number | null;
    }) => void;
    ingestBook: (observation: {
      readonly tokenId: import("@krabs/domain").TokenId;
      readonly ts: number;
      readonly bids: readonly import("@krabs/domain").PriceLevel[];
    }) => void;
    invalidateTokenIds?: (tokenIds: readonly string[]) => void;
  };
}

type FullLifetimeMarketCacheMissReason = "market_lookup_error" | "market_row_missing";

type FullLifetimeMarketCacheHydratedReason = "cache_miss_hydrated";

type FullLifetimeSnapshotSkipReason = "inactive_or_untradable" | "metadata_only_no_book";

export class MarketDataModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private discoveryPollTimer: ReturnType<typeof setInterval> | null = null;
  private stream: MarketPricingStream | null = null;
  private polling = false;
  private lastSuccessfulDataMs = 0;
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly latestOrderBookByToken = new Map<string, OrderBookSnapshot>();
  private readonly lastPublishedMarketByToken = new Map<string, NormalizedMarket>();
  private readonly trackedMarketsByToken = new Map<string, Market>();
  private readonly lastPricingUpdateAtByToken = new Map<string, number>();
  private readonly lastPricingAttemptAtByToken = new Map<string, number>();
  private readonly pendingGapTokenIds = new Map<string, number>();
  /**
   * Hydrated minimums that could not be delivered yet — see
   * `noteMinOrderSizeObserved`. `repolledAt` is carried per entry rather than in
   * a second map so it shares this one's lifecycle and cannot outlive it.
   */
  private readonly pendingMinOrderSizeByToken = new Map<string, ParkedMinOrderSize>();
  /**
   * When each token was last actually polled by the fallback batch — the
   * least-recently-polled ordering that makes the over-limit set starvation-free
   * (see `selectFallbackPollCandidates`). Pruned with `trackedMarketsByToken`.
   */
  private readonly lastFallbackPollAtByToken = new Map<string, number>();
  /** Admission time per tracked token — the start of a never-polled token's wait. Pruned with it. */
  private readonly trackedTokenAdmittedAtByToken = new Map<string, number>();
  /**
   * How much wait a token had ACCUMULATED (a duration, not a stamp) when it left the tracked
   * set, so re-admission RESUMES it instead of restarting it. A fresh admission stamp is newer
   * than every resident's, so it never trips the starvation tier: a peer that keeps dropping out
   * and rejoining (the tracked set churns on every scan) would be passed over forever, which is
   * the very starvation the tier exists to prevent. Storing the duration is what keeps time
   * spent OUTSIDE the set from counting as wait. Insertion-ordered and capped, so a process that
   * churns through tokens for weeks cannot grow it without bound.
   */
  private readonly retainedFallbackWaitMsByToken = new Map<string, number>();
  private readonly log: Logger;
  private forceFullPoll = false;
  private lastTrackedTokenCount = 0;
  private lastStaleTokenCount = 0;
  private lastSilentTrackedTokenCount = 0;
  private lastFallbackPollCount = 0;
  private lastFallbackCandidateCount = 0;
  private lastFallbackDeferredCount = 0;
  private lastFallbackDroppedStaleCount = 0;
  private lastFallbackPollLimit = 0;
  private lastFallbackReasonCounts: MarketDataFallbackReasonCounts = zeroFallbackReasonCounts();
  private lastFallbackRoleCounts: MarketDataTrackedRoleCounts = zeroTrackedRoleCounts();
  private lastTrackedDiffCounts: MarketDataTrackedDiffCounts = zeroTrackedDiffCounts();
  private lastCachedTrackedTokenCountAtPollStart = 0;
  private lastPricingHitCount = 0;
  private lastPublicTradeCountEnrichmentEligibleCount = 0;
  private lastPublicTradeCountEnrichmentSkippedCount = 0;
  private lastPublicTradeCountEnrichmentConditionCount = 0;
  private lastPublicTradeCountEnrichmentRequestCount = 0;
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
  /**
   * `discoveryTier` keyed for O(1) membership. Only `canHydrateLater` needs it,
   * and that runs once per parked minimum per poll — scanning the array there
   * would be O(parked x discovery) on every cycle.
   */
  private discoveryTokenIds = new Set<string>();
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
  private readonly cachedPollDegradeWarn: WarnThrottleState = createWarnThrottleState();
  private readonly discoveryPollFailureWarn: WarnThrottleState = createWarnThrottleState();
  private readonly fallbackRateCapWarn: WarnThrottleState = createWarnThrottleState();
  private readonly bookSignalFullBookCapWarn: WarnThrottleState = createWarnThrottleState();
  private lastBookSignalFullBookDemandCount = 0;
  private lastBookSignalFullBookSubscribedCount = 0;
  private lastBookSignalFullBookSkippedCount = 0;
  private pricingPollBackoffUntilMs = 0;
  private discoveryPollBackoffUntilMs = 0;
  private tieredPricingCache: {
    maxTokens: number;
    reserveSignature: boolean;
    capturedAtMs: number;
    value: TrackedForPricing;
  } | null = null;
  private readonly fullLifetimeActiveTokenIds = new Set<string>();
  private readonly fullLifetimePostCloseUntilByToken = new Map<string, number>();
  private readonly fullLifetimeLastHeartbeatAtByToken = new Map<string, number>();
  private readonly fullLifetimeMissingMarketLoggedAtByToken = new Map<string, number>();
  private readonly fullLifetimeMarketCacheHydratedLoggedAtByToken = new Map<string, number>();
  private readonly fullLifetimeSkippedSnapshotLoggedAtByToken = new Map<string, number>();
  private readonly fullLifetimeMetadataOnlyTokenIds = new Set<string>();
  private fullLifetimePollTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribers: Array<() => void> = [];
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
        onRawTradeObservations: (observations) => this.handleRawTradeObservations(observations),
        onLifecycleEvents: (events) => this.handleLifecycleEvents(events),
        onError: (error) => {
          this.log.warn({ err: error }, "market-data stream error");
        },
        onGapDetected: ({ reason, tokenIds }) => {
          const normalizedTokenIds = normalizeGapTokenIds(tokenIds);
          if (normalizedTokenIds.length === 0) {
            this.forceFullPoll = true;
          } else {
            this.addPendingGapTokenIds(normalizedTokenIds, Date.now());
          }
          this.invalidateBookSignalsForGap(normalizedTokenIds);
          this.queueGapLog(reason, normalizedTokenIds.length);
        },
      });
    }
    this.hydrateFullLifetimeActiveTokens();
    if (this.fullLifetimeEnabled()) {
      this.unsubscribers.push(
        this.deps.bus.subscribe("PositionUpdated", async ({ position }) => {
          this.handleFullLifetimePositionUpdated(position);
        }),
        this.deps.bus.subscribe("PositionSettled", async ({ tokenId }) => {
          this.handleFullLifetimePositionSettled(tokenId);
        }),
      );
    }
    // Fire first poll without blocking startup — interval handles retries
    this.poll().catch((err) => this.log.error({ err }, "initial poll failed"));
    this.timer = setInterval(() => {
      this.poll().catch((err) => this.log.error({ err }, "poll cycle error"));
    }, this.deps.pollIntervalMs);

    // Discovery poll loop: separate channel for tokens beyond the WS cap.
    const discoveryIntervalMs = this.deps.discoveryPollIntervalMs ?? 5 * 60_000;
    this.discoveryPollTimer = setInterval(() => {
      this.pollDiscoveryBatch().catch((err) =>
        this.log.error({ err }, "discovery poll cycle error"),
      );
    }, discoveryIntervalMs);
  }

  /** Single writer for both discovery views, so the id set cannot drift. */
  private setDiscoveryTier(markets: Market[]): void {
    this.discoveryTier = markets;
    this.discoveryTokenIds = new Set(markets.map((market) => String(market.tokenId)));
  }

  /**
   * Seed `minOrderSize` from a REST `/books` payload — the only source that
   * carries it. Gamma pricing and the WSS `book` event both omit the field, so a
   * WSS-tracked market would otherwise keep `minOrderSize: null` for its whole
   * lifetime and every sellable-sizing entry decision on it would be skipped.
   * Once seeded the value is sticky: `syncTrackedMarket`, `applyPricingSnapshot`
   * and `applyStreamUpdate` all fall back to the cached market's value.
   */
  noteMinOrderSizeObserved(tokenId: string, minOrderSize: number): void {
    if (!isKnownMinOrderSize(minOrderSize)) return;
    const tokenKey = String(tokenId);
    if (this.deliverMinOrderSizeHydration(tokenKey, minOrderSize)) {
      // An older parked value for the same token is now stale. Leaving it would
      // let the next flush republish it OVER this newer minimum — and since the
      // parked one can be smaller, that sizes an entry below the exchange floor.
      this.pendingMinOrderSizeByToken.delete(tokenKey);
      return;
    }
    // Undeliverable right now (runtime paused, or the token is not tracked yet).
    // Dropping the value would be permanent: the book cache dedupes the refresh
    // request, so nothing re-observes this minimum and the suppression never
    // clears. Park it for the next poll instead.
    this.parkMinOrderSizeHydration(tokenKey, minOrderSize);
  }

  /**
   * Park an undeliverable minimum for the next poll.
   *
   * Eviction prefers tokens we have no route to: evicting a token we still track
   * costs a hydration-retry window (`MIN_ORDER_SIZE_HYDRATION_RETRY_MS`) during
   * which nothing re-observes the minimum and the entry stays suppressed. When
   * every parked token is still routable the oldest one goes anyway — an
   * unbounded map is worse than one re-requested refresh, and without that
   * fallback the cap would not bound anything at all.
   */
  private get maxPendingMinOrderSizeHydrations(): number {
    return Math.max(MIN_PENDING_MIN_ORDER_SIZE_HYDRATIONS, this.deps.maxTrackedTokens ?? 0);
  }

  private parkMinOrderSizeHydration(tokenKey: string, minOrderSize: number): void {
    const pending = this.pendingMinOrderSizeByToken;
    const existing = pending.get(tokenKey);
    if (existing == null && pending.size >= this.maxPendingMinOrderSizeHydrations) {
      const routeless = [...pending.keys()].find((key) => !this.canHydrateLater(key));
      const evictable = routeless ?? pending.keys().next().value;
      if (evictable !== undefined) pending.delete(evictable);
    }
    // A re-observed value must not reset `repolledAt`: the token would then
    // become eligible for another repoll immediately, which is exactly the
    // hammering loop the budget exists to stop.
    pending.set(tokenKey, { minOrderSize, repolledAt: existing?.repolledAt ?? 0 });
  }

  private stampSelectedMinOrderSizeRepolls(
    selected: readonly FallbackPollCandidate[],
    now: number,
  ): void {
    for (const candidate of selected) {
      if (candidate.reason !== "minOrderSizeHydration") continue;
      const parked = this.pendingMinOrderSizeByToken.get(candidate.tokenId);
      if (parked != null) parked.repolledAt = now;
    }
  }

  /**
   * Whether a hydrated minimum for this token can reach downstream modules.
   *
   * Deliberately BOTH preconditions `deliverMinOrderSizeHydration` enforces — a
   * publishable `marketCache` entry AND fresh pricing — and NOT the broader
   * `canHydrateLater`. Discovery-tier markets are kept out of that cache on
   * purpose (see `pollDiscoveryBatch`), and a token can also sit in
   * `trackedMarketsByToken` with no cache entry: promoted into the WS tier, then
   * omitted from the Gamma batch with no initial WS book. Answering "yes" there
   * makes the entry pre-filter suppress a signal only a delivery that cannot
   * happen would unblock. Answering "no" is fail-safe — the signal is emitted and
   * signal-to-order fetches the minimum from the REST book itself.
   *
   * The freshness half is not redundant with the cache check: the book-refresh
   * budget returns Infinity for a healthy WS-tier token (see
   * `SOFT_RANKING_FEATURE_REFRESH_MAX_AGE_MS` above), so a quiet token is never
   * REST-repolled and `lastPricingUpdateAtByToken` only advances on a WS tick.
   * After a long pause such a token keeps a cache entry with stale pricing
   * indefinitely — advertising it as hydratable would suppress the entry while
   * the delivery it is waiting on can never fire.
   */
  canHydrateMinOrderSize(tokenId: string): boolean {
    const tokenKey = String(tokenId);
    return this.marketCache.has(tokenKey) && this.hasPublishableFreshPricing(tokenKey, Date.now());
  }

  /**
   * Whether a parked minimum still has a delivery route on a LATER poll.
   *
   * Broader than `canHydrateMinOrderSize` on purpose: this one drives eviction,
   * where the question is "will this token ever become deliverable", and a
   * tracked-but-uncached token normally gains its cache entry on the next poll.
   * The advertiser above answers about right now, so it must be stricter.
   *
   * Discovery-tier membership counts as a route. A discovery market is held out
   * of BOTH caches on purpose (see `pollDiscoveryBatch`), so without this clause
   * a minimum observed while placing a discovery-tier entry looks routeless and
   * `flushPendingMinOrderSizeHydration` discards it on the very next poll —
   * before the fill can promote the token into the execution-critical tier. The
   * book cache dedupes the refresh, so nothing re-observes the value, and the
   * promoted snapshot carries a null minimum: live-lite then blocks the EXIT as
   * unknown-minimum. Such a token has not "left" the tracked set the way the
   * discard rule assumes — it has not joined it yet.
   */
  private canHydrateLater(tokenKey: string): boolean {
    return (
      this.marketCache.has(tokenKey) ||
      this.trackedMarketsByToken.has(tokenKey) ||
      this.discoveryTokenIds.has(tokenKey)
    );
  }

  /**
   * Publish a hydrated minimum to downstream modules.
   *
   * Downstream modules keep their OWN market caches, fed only by
   * `MarketSnapshotReceived`, so seeding ours is invisible to the entry decision
   * until this market is next published — hours on a quiet market.
   *
   * "Already downstream" is read off `lastPublishedMarketByToken`, never off
   * `marketCache`: several writers (`flushPendingStreamUpdates` and
   * `retainCachedMarketState`) update the cache while paused and publish
   * nothing, so a matching cached value proves only that we know the minimum,
   * not that anyone else does.
   *
   * @returns whether the value is now downstream (or already was).
   */
  private deliverMinOrderSizeHydration(tokenKey: string, minOrderSize: number): boolean {
    if (this.lastPublishedMarketByToken.get(tokenKey)?.minOrderSize === minOrderSize) return true;
    const current = this.marketCache.get(tokenKey);
    if (!current) return false;
    const hydrated = current.minOrderSize === minOrderSize ? current : { ...current, minOrderSize };
    // Seed the cache even when the publish below is refused. `syncTrackedMarket`
    // carries `minOrderSize` forward, so this poll's own pricing publish then
    // delivers the minimum together with FRESH prices — the preferred route. The
    // value stays parked until something actually reaches downstream.
    this.marketCache.set(tokenKey, hydrated);
    if (this.deps.runtimeControl?.isPaused()) return false;
    if (!this.hasPublishableFreshPricing(tokenKey, Date.now())) return false;
    // The book-cache callback is synchronous, hence fire-and-forget.
    void this.publishMarketSnapshotDelta([hydrated], Date.now()).catch((err: unknown) => {
      this.log.error({ err, tokenId: tokenKey }, "min order size hydration publish failed");
    });
    return true;
  }

  /**
   * Whether this token's cached prices may be republished on their own.
   *
   * Delivering a hydrated minimum republishes the CACHED market, so its prices
   * ride along. A pause that outlasts the pricing cadence leaves those prices
   * arbitrarily old, and a republished market carrying a known minimum and
   * `bookSource: "clob"` is accepted by signal-to-order WITHOUT a fresh book —
   * so an unguarded delivery can price a real BUY off pre-pause data before the
   * current poll's pricing work lands. Refusing here only defers: the poll
   * refreshes the price and republishes the seeded minimum with it.
   *
   * Uses the same staleness budget as the poll's own stream-fallback trigger, so
   * the two cannot drift into disagreeing about what counts as current pricing.
   */
  private hasPublishableFreshPricing(tokenKey: string, nowMs: number): boolean {
    const lastUpdatedAt = this.lastPricingUpdateAtByToken.get(tokenKey) ?? 0;
    if (lastUpdatedAt === 0) return false;
    const budgetMs = Math.max(STREAM_FALLBACK_MIN_STALE_MS, this.deps.pollIntervalMs * 3);
    return nowMs - lastUpdatedAt <= budgetMs;
  }

  /**
   * Retry parked hydrations — the poll loop is the only unpaused, tracked-token tick.
   *
   * A value whose token has since left the tracked set is discarded here rather
   * than kept: nothing will deliver it (this runs right after the tracked-set
   * reconcile, so the caches it needs are already gone), and holding it lets a
   * later rejoin republish a minimum observed an arbitrary time ago. The rejoin
   * releases the hydration dedupe anyway, so a fresh `/books` re-observes the
   * current value — keeping the stale one buys nothing and can only mis-size.
   */
  private flushPendingMinOrderSizeHydration(): void {
    for (const [tokenKey, parked] of [...this.pendingMinOrderSizeByToken]) {
      if (this.deliverMinOrderSizeHydration(tokenKey, parked.minOrderSize)) {
        this.pendingMinOrderSizeByToken.delete(tokenKey);
        continue;
      }
      if (!this.canHydrateLater(tokenKey)) this.pendingMinOrderSizeByToken.delete(tokenKey);
    }
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
    if (this.fullLifetimePollTimer) {
      clearTimeout(this.fullLifetimePollTimer);
      this.fullLifetimePollTimer = null;
    }
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
    await this.flushPendingStreamUpdates();
    // Evict any tokens from the final discovery batch so downstream caches
    // don't retain the tail across restarts / supervisor rotation.
    await this.flushDiscoveryBatchEviction(new Set(), Date.now());
    this.stream?.close();
    this.stream = null;
    // Same policy `flushPendingMinOrderSizeHydration` already applies to a token
    // that left the tracked set: a minimum observed an arbitrary time ago must
    // not be republished after a gap, and a stop/start is the largest gap there
    // is. Dropping it costs nothing — the restart releases the hydration dedupe,
    // so a fresh `/books` re-observes the current value.
    this.pendingMinOrderSizeByToken.clear();
    this.lastFallbackPollAtByToken.clear();
    this.trackedTokenAdmittedAtByToken.clear();
    this.retainedFallbackWaitMsByToken.clear();
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
    const trackedRoleCounts = countTrackedRoleCounts(this.wsTierRoleByToken.values());
    const trackedBookSourceCounts = countTrackedBookSourceCounts(
      this.trackedMarketsByToken.keys(),
      this.marketCache,
    );
    const trackedTokenCount = streamMetrics?.trackedTokenCount ?? this.lastTrackedTokenCount;
    const cap = this.deps.maxTrackedTokens ?? null;
    const wsCapUtilizationPct =
      cap != null && cap > 0 ? Math.round((trackedTokenCount * 100) / cap) : null;
    return {
      wsEnabled: this.stream != null,
      windowStartMs: streamMetrics?.windowStartMs ?? null,
      wsEventsReceived: streamMetrics?.wsEventsReceived ?? 0,
      wsEventsReceivedPerSec: streamMetrics?.wsEventsReceivedPerSec ?? 0,
      wsUpdatesApplied: streamMetrics?.wsUpdatesApplied ?? 0,
      rawWsRecords: streamMetrics?.rawWsRecords ?? 0,
      rawWsRecordsPerSec: streamMetrics?.rawWsRecordsPerSec ?? 0,
      parsedUpdates: streamMetrics?.parsedUpdates ?? 0,
      parsedUpdatesPerSec: streamMetrics?.parsedUpdatesPerSec ?? 0,
      emittedUpdates: streamMetrics?.emittedUpdates ?? 0,
      emittedUpdatesPerSec: streamMetrics?.emittedUpdatesPerSec ?? 0,
      noopUpdates: streamMetrics?.noopUpdates ?? 0,
      noopUpdatesPerSec: streamMetrics?.noopUpdatesPerSec ?? 0,
      suppressedTradingNoopCountTotal: streamMetrics?.suppressedTradingNoopCountTotal ?? 0,
      suppressedTradingNoopPerSec: streamMetrics?.suppressedTradingNoopPerSec ?? 0,
      suppressedTradingNoopByReason: streamMetrics?.suppressedTradingNoopByReason ?? {
        topOfBookOnly: 0,
        bookOnly: 0,
        lastTradeOnly: 0,
        tickSizeOnly: 0,
        mixedNonCritical: 0,
      },
      hubFilterChecked: streamMetrics?.hubFilterChecked ?? 0,
      hubFilterCheckedPerSec: streamMetrics?.hubFilterCheckedPerSec ?? 0,
      hubFilterPassed: streamMetrics?.hubFilterPassed ?? 0,
      hubFilterPassedPerSec: streamMetrics?.hubFilterPassedPerSec ?? 0,
      trackedTokenCount,
      wsCapUtilizationPct,
      shardCount: streamMetrics?.shardCount ?? 0,
      reconnectCount: streamMetrics?.reconnectCount ?? 0,
      wsEventGapDetected: streamMetrics?.wsEventGapDetected ?? 0,
      wsLatencyMs: streamMetrics?.wsLatencyMs ?? null,
      trackedRoleCounts,
      trackedBookSourceCounts,
      staleTokenCount: this.lastStaleTokenCount,
      silentTrackedTokenCount: this.lastSilentTrackedTokenCount,
      fallbackPollCount: this.lastFallbackPollCount,
      fallbackCandidateCount: this.lastFallbackCandidateCount,
      fallbackDeferredCount: this.lastFallbackDeferredCount,
      pendingGapTokenCount: this.pendingGapTokenIds.size,
      fallbackDroppedStaleCount: this.lastFallbackDroppedStaleCount,
      fallbackPollLimit: this.lastFallbackPollLimit,
      fallbackReasonCounts: this.lastFallbackReasonCounts,
      fallbackRoleCounts: this.lastFallbackRoleCounts,
      trackedDiffCounts: this.lastTrackedDiffCounts,
      cachedTrackedTokenCountAtPollStart: this.lastCachedTrackedTokenCountAtPollStart,
      pricingHitCountLastPoll: this.lastPricingHitCount,
      fullBookTokenCount: streamMetrics?.fullBookTokenCount ?? 0,
      bookSignalFullBookDemandCount: this.lastBookSignalFullBookDemandCount,
      bookSignalFullBookSubscribedCount: this.lastBookSignalFullBookSubscribedCount,
      bookSignalFullBookSkippedCount: this.lastBookSignalFullBookSkippedCount,
      bookSignalFullBookCapUtilizationPct: this.resolveBookSignalFullBookCapUtilizationPct(),
      bookEventsReceived: streamMetrics?.bookEventsReceived ?? 0,
      narrowSubscribeCount: streamMetrics?.narrowSubscribeCount ?? 0,
      narrowUnsubscribeCount: streamMetrics?.narrowUnsubscribeCount ?? 0,
      narrowRefCountLeaks: streamMetrics?.narrowRefCountLeaks ?? 0,
      marketResolvedEvents: streamMetrics?.marketResolvedEvents ?? 0,
      newMarketEvents: streamMetrics?.newMarketEvents ?? 0,
      v4AdmissionTelemetry: readV4AdmissionTelemetry(this.deps.marketRepo),
      gammaFallbackCount: gammaFallbackCounts.total,
      gammaFallbackTrackedTokenCount: gammaFallbackCounts.total,
      gammaFallbackExecutionCriticalCount: gammaFallbackCounts.executionCritical,
      gammaFallbackEntryCandidateCount: gammaFallbackCounts.entryCandidate,
      publicTradeCountEnrichmentEligibleCount: this.lastPublicTradeCountEnrichmentEligibleCount,
      publicTradeCountEnrichmentSkippedCount: this.lastPublicTradeCountEnrichmentSkippedCount,
      publicTradeCountEnrichmentConditionCount: this.lastPublicTradeCountEnrichmentConditionCount,
      publicTradeCountEnrichmentRequestCount: this.lastPublicTradeCountEnrichmentRequestCount,
      wsGapsByShard: streamMetrics?.wsGapsByShard ?? {},
      wsHeartbeat: streamMetrics?.wsHeartbeat ?? null,
      wsWorkerMemory: streamMetrics?.wsWorkerMemory ?? null,
    };
  }

  /** Exposed for testing — in production driven by the interval timer. */
  async poll(): Promise<void> {
    if (this.polling) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.log.debug("market-data poll skipped while runtime is paused");
      return;
    }
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
        const sigMode = this.deps.signatureTierMode ?? "shadow";
        const tiered = this.getTieredTrackedForPricing(
          this.deps.maxTrackedTokens,
          Date.now(),
          sigMode === "live",
        );
        if (sigMode === "live") {
          this.syncWsTierRoles({
            executionCritical: tiered.executionCritical,
            planktonSignature: tiered.planktonSignature,
            entryCandidates: tiered.entryCandidates,
          });
          // Merge WS tier into a flat list for the existing poll machinery.
          tracked = [
            ...tiered.executionCritical,
            ...tiered.planktonSignature,
            ...tiered.entryCandidates,
          ];
          this.setDiscoveryTier(tiered.discoveryOnly);
        } else {
          // Shadow-first (default): the repo was called with
          // reserveSignature=false, so `tiered.planktonSignature` is a
          // measurement projection ONLY — those markets were never removed
          // from the V4 pool and already flow into entryCandidates/
          // discoveryOnly on their own merit, exactly as they would without
          // the signature feature. Do NOT re-home them here: that would let a
          // signature market skip the normal V4 admit/reject split and change
          // live placement vs baseline, defeating shadow mode's entire point.
          this.syncWsTierRoles({
            executionCritical: tiered.executionCritical,
            entryCandidates: tiered.entryCandidates,
          });
          tracked = [...tiered.executionCritical, ...tiered.entryCandidates];
          this.setDiscoveryTier(tiered.discoveryOnly);
        }
        // Observe-only coverage metric (spec §4.5) — denominator is the full
        // signature-matching set (planktonSignature + signatureOverflow), not
        // just what fit in the WS tier. Emitted regardless of mode.
        this.deps.recordSignatureCoverage?.("yes", tiered.planktonSignature.length, sigMode);
        this.deps.recordSignatureCoverage?.("no", tiered.signatureOverflow, sigMode);
        if (this.discoveryCursor >= this.discoveryTier.length) {
          this.discoveryCursor = 0;
        }
      } else {
        // Legacy flat path (simulation / tests that don't set maxTrackedTokens).
        tracked = this.deps.marketRepo.findTrackedForPricing();
        this.setDiscoveryTier([]);
        this.syncWsTierRoles({ legacy: tracked });
      }

      const trackedDiff = this.refreshTrackedMarkets(tracked);
      this.observeTrackedMarkets(trackedDiff.active);
      this.lastTrackedDiffCounts = {
        added: trackedDiff.added.length,
        removed: trackedDiff.removed.length,
        unchanged: tracked.length - trackedDiff.added.length,
      };
      await this.publishTrackedMarketsChanged(trackedDiff);
      // AFTER the tracked set is reconciled and its removals are published, and
      // before this poll's pricing work — a parked hydration must not depend on
      // this poll happening to select its token, but it must not resurrect a
      // token that just left the WS tier either: publishing a stale cached
      // market for a deselected token can start an Algo evaluation that places a
      // real BUY on a market we no longer track.
      this.flushPendingMinOrderSizeHydration();
      this.lastTrackedTokenCount = tracked.length;
      if (tracked.length === 0) {
        this.lastFallbackPollCount = 0;
        this.lastFallbackCandidateCount = 0;
        this.lastFallbackDeferredCount = 0;
        this.lastFallbackDroppedStaleCount = 0;
        this.lastFallbackPollLimit = 0;
        this.lastStaleTokenCount = 0;
        this.lastSilentTrackedTokenCount = 0;
        this.lastFallbackReasonCounts = zeroFallbackReasonCounts();
        this.lastFallbackRoleCounts = zeroTrackedRoleCounts();
        this.lastTrackedDiffCounts = zeroTrackedDiffCounts();
        this.lastCachedTrackedTokenCountAtPollStart = 0;
        this.lastPricingHitCount = 0;
        this.stream?.setTokenIds([]);
        this.syncBookSignalSubscriptions();
        this.log.debug("no active tracked markets — skipping pricing, waiting for scanner");
        // Do NOT update lastSuccessfulDataMs — no tracked markets means
        // discovery hasn't run yet or found nothing. Stay STALE.
        await this.deps.bus.publish("MarketSnapshotReceived", {
          markets: [],
          timestamp: Date.now(),
        });
        await this.publishFullLifetimeHeartbeat(Date.now(), new Set());
        return;
      }

      const tokenIds = tracked.map((m) => String(m.tokenId));
      // Feed only WS-tier (executionCritical + entryCandidates) to the stream.
      this.stream?.setTokenIds(tokenIds);
      this.syncBookSignalSubscriptions();
      const now = Date.now();
      const fallbackHardStaleMs = Math.max(
        STREAM_FALLBACK_MIN_STALE_MS,
        this.deps.pollIntervalMs * 3,
      );
      const streamMetrics = this.stream?.getMetricsSnapshot?.() ?? null;
      const quietWsTierPollingRelaxed =
        this.stream != null &&
        !this._streamDegradedMode &&
        streamMetrics != null &&
        streamMetrics.shardCount > 0 &&
        streamMetrics.wsEventsReceived > 0 &&
        streamMetrics.wsEventGapDetected === 0;
      let silentTrackedTokenCount = 0;
      let cachedTrackedTokenCountAtPollStart = 0;
      const fallbackCandidates: FallbackPollCandidate[] = [];
      const staleGapDrop = this.pruneStalePendingGaps(now, new Set(tokenIds));
      const staleGapDropCount = staleGapDrop.droppedCount;
      const staleGapDroppedTokenIds = staleGapDrop.droppedTokenIds;

      if (this.stream == null || this.forceFullPoll) {
        // Under forceFullPoll (gap/circuit-open), only poll the priority tier
        // (executionCritical + entryCandidates) — `tracked` already contains
        // exactly those tokens. Discovery staleness is tolerable; it has its
        // own rolling timer. Final selection below applies bounded rate caps.
        const reason = this.forceFullPoll ? "forceFullPoll" : "streamUnavailable";
        for (const tokenId of tokenIds) {
          fallbackCandidates.push({
            tokenId,
            role: this.wsTierRoleByToken.get(tokenId),
            reason,
          });
        }
      } else {
        for (const tokenId of tokenIds) {
          if (staleGapDroppedTokenIds.has(tokenId)) {
            continue;
          }
          if (this.pendingGapTokenIds.has(tokenId)) {
            fallbackCandidates.push({
              tokenId,
              role: this.wsTierRoleByToken.get(tokenId),
              reason: "pendingGap",
            });
            continue;
          }
          const cached = this.marketCache.get(tokenId);
          if (cached != null) {
            cachedTrackedTokenCountAtPollStart += 1;
          }
          const lastUpdatedAt = this.lastPricingUpdateAtByToken.get(tokenId) ?? 0;
          const lastAttemptedAt = this.lastPricingAttemptAtByToken.get(tokenId) ?? 0;
          const role = this.wsTierRoleByToken.get(tokenId);
          if (cached == null) {
            if (lastAttemptedAt > 0) {
              const refreshBudgetMs = getTrackedTokenRefreshBudgetMs(
                { bookSource: "unknown" },
                this.deps.pollIntervalMs,
                quietWsTierPollingRelaxed && role != null,
                role,
              );
              if (now - lastAttemptedAt <= refreshBudgetMs) continue;
              fallbackCandidates.push({
                tokenId,
                role,
                reason: "unknownSourceRefresh",
              });
              continue;
            }
            fallbackCandidates.push({
              tokenId,
              role,
              reason: "missingCache",
            });
            continue;
          }
          const refreshReferenceAt =
            cached.bookSource == null || cached.bookSource === "unknown"
              ? Math.max(lastUpdatedAt, lastAttemptedAt)
              : lastUpdatedAt;
          const ageMs = now - refreshReferenceAt;
          const tokenSubscribedOnHealthyWsTier = quietWsTierPollingRelaxed && role != null;
          const refreshBudgetMs = getTrackedTokenRefreshBudgetMs(
            cached,
            this.deps.pollIntervalMs,
            tokenSubscribedOnHealthyWsTier,
            role,
          );
          if (ageMs > refreshBudgetMs) {
            fallbackCandidates.push({
              tokenId,
              role,
              reason:
                cached.bookSource == null || cached.bookSource === "unknown"
                  ? "unknownSourceRefresh"
                  : "knownSourceRefresh",
            });
            continue;
          }
          // The book budget above says this token needs no refresh — for a
          // healthy WS-tier token with a known `bookSource` it is literally
          // Infinity. But a minimum still parked at this point already failed
          // delivery in THIS poll's flush (it runs before this loop), and the
          // only reason left is stale pricing: a publish republishes the cached
          // market, so `hasPublishableFreshPricing` gates it. Waiting for the
          // 3h feature-freshness repoll below leaves the token's EXIT
          // unpriceable in live-lite for that whole window, because SELL
          // pricing never fetches `/books` itself. Poll it now instead — the
          // fresh book refreshes pricing AND re-observes the minimum, so the
          // delta publish carries the value out on current prices rather than
          // pre-pause ones.
          //
          // Rate-limited against ITSELF, not against `lastPricingAttemptAtByToken`:
          // a partial Gamma batch that omits the token records an attempt yet
          // leaves the value parked, and a gateway error records no attempt at
          // all — either way an unthrottled branch re-requests this token every
          // single poll for as long as the minimum stays undelivered. The budget
          // is the unknown-source one the `cached == null` branch above already
          // applies, so both anti-hammering paths move together.
          const parked = this.pendingMinOrderSizeByToken.get(tokenId);
          if (parked != null) {
            const repollBudgetMs = getTrackedTokenRefreshBudgetMs(
              { bookSource: "unknown" },
              this.deps.pollIntervalMs,
              quietWsTierPollingRelaxed && role != null,
              role,
            );
            if (now - parked.repolledAt > repollBudgetMs) {
              // NOT stamped here: `selectFallbackPollCandidates` sorts by role
              // with a STABLE sort and slices, so the same over-limit prefix wins
              // every round. Stamping at candidacy would put the dropped tail
              // into a fresh backoff it never earned — permanent starvation, not
              // "one more budget". Stamp only what is actually polled (below).
              fallbackCandidates.push({ tokenId, role, reason: "minOrderSizeHydration" });
              continue;
            }
          }
          // Step 3 (audit doc §F2): even when the book is still considered
          // fresh by the stream, soft-ranking feature inputs (liquidity /
          // volume24hr) only refresh via REST/Gamma. The book-refresh budget
          // returns `Number.POSITIVE_INFINITY` for healthy WS-tier tokens
          // with a known `bookSource`, so without a feature-keyed poll those
          // tokens never get features refreshed.
          //
          // Trigger a REST poll for two cases:
          //   (a) `featuresCapturedTs != null` AND the timestamp exceeds the
          //       dedicated 3h budget — covers tokens that were previously
          //       primed but are about to age past the 4h
          //       `FEATURE_FRESHNESS_MS` window enforced by `effectiveScore`.
          //   (b) `featuresCapturedTs == null` AND the token is on a healthy
          //       WS tier with a known `bookSource` — these tokens have an
          //       infinite book budget, so without this they could remain
          //       permanently unscored. Other null cases (unknown source /
          //       pendingGap / missingCache / inactive WS) already get
          //       polled by the branches above, so we don't double-count
          //       them here.
          const featuresCapturedTs = cached.featuresCapturedTs ?? null;
          if (featuresCapturedTs != null) {
            if (now - featuresCapturedTs > SOFT_RANKING_FEATURE_REFRESH_MAX_AGE_MS) {
              fallbackCandidates.push({ tokenId, role, reason: "featureFreshness" });
              continue;
            }
          } else if (
            tokenSubscribedOnHealthyWsTier &&
            cached.bookSource != null &&
            cached.bookSource !== "unknown"
          ) {
            fallbackCandidates.push({ tokenId, role, reason: "featureFreshness" });
            continue;
          }
          if (ageMs > fallbackHardStaleMs) {
            silentTrackedTokenCount += 1;
          }
        }
      }

      const fallbackPollLimit = resolveFallbackPollLimit({
        fallbackBatchSize: this.deps.fallbackBatchSize ?? 500,
        maxConcurrency: this.deps.fallbackPollMaxConcurrency ?? 50,
        ratePerSec: this.deps.fallbackPollRatePerSec ?? 5,
        pollIntervalMs: this.deps.pollIntervalMs,
      });
      const selectedFallbackCandidates = selectFallbackPollCandidates(
        fallbackCandidates,
        fallbackPollLimit,
        (tokenId) => ({
          lastPolledAt: this.lastFallbackPollAtByToken.get(tokenId) ?? null,
          admittedAt: this.trackedTokenAdmittedAtByToken.get(tokenId) ?? 0,
        }),
        now,
        this.deps.pollIntervalMs,
      );
      tokenIdsToPoll = selectedFallbackCandidates.map((candidate) => candidate.tokenId);
      const fallbackReasonCounts = countFallbackReasons(selectedFallbackCandidates);
      const fallbackRoleCounts = countFallbackRoles(selectedFallbackCandidates);
      const deferredCount = Math.max(
        0,
        fallbackCandidates.length - selectedFallbackCandidates.length,
      );
      if (fallbackCandidates.length > selectedFallbackCandidates.length) {
        const suppressedCount = consumeWarnThrottle(
          this.fallbackRateCapWarn,
          now,
          TRANSIENT_POLL_WARN_THROTTLE_MS,
        );
        if (suppressedCount != null) {
          this.log.warn(
            {
              candidateCount: fallbackCandidates.length,
              selectedCount: selectedFallbackCandidates.length,
              deferredCount,
              limit: fallbackPollLimit,
              suppressedCount,
            },
            "fallback poll candidates exceed bounded rate cap — deferring tail",
          );
        }
      } else {
        resetWarnThrottle(this.fallbackRateCapWarn);
      }

      this.lastStaleTokenCount = tokenIdsToPoll.length;
      this.lastSilentTrackedTokenCount = silentTrackedTokenCount;
      this.lastFallbackPollCount = tokenIdsToPoll.length;
      this.lastFallbackCandidateCount = fallbackCandidates.length;
      this.lastFallbackDeferredCount = deferredCount;
      this.lastFallbackDroppedStaleCount = staleGapDropCount;
      this.lastFallbackPollLimit = fallbackPollLimit;
      this.lastFallbackReasonCounts = fallbackReasonCounts;
      this.lastFallbackRoleCounts = fallbackRoleCounts;
      this.lastCachedTrackedTokenCountAtPollStart = cachedTrackedTokenCountAtPollStart;
      this.log.debug(
        {
          trackedCount: tracked.length,
          tokenCount: tokenIds.length,
          silentTrackedTokenCount,
          fallbackPollCount: tokenIdsToPoll.length,
          fallbackCandidateCount: fallbackCandidates.length,
          fallbackDeferredCount: deferredCount,
          fallbackDroppedStaleCount: staleGapDropCount,
          fallbackPollLimit,
          fallbackReasonCounts,
          fallbackRoleCounts,
          trackedDiffCounts: this.lastTrackedDiffCounts,
          cachedTrackedTokenCountAtPollStart,
          forceFullPoll: this.forceFullPoll,
        },
        "fetching pricing for tracked markets",
      );

      const timeoutMs = resolveMarketPricingTimeoutMs(tokenIdsToPoll.length);
      if (tokenIdsToPoll.length > 0 && now < this.pricingPollBackoffUntilMs) {
        this.lastPricingHitCount = 0;
        await this.publishCachedMarkets(tracked, now);
        this.logCachedPollDegraded(
          new Error("Gamma pricing rate-limit backoff active"),
          tracked.length,
          tokenIdsToPoll.length,
          now,
        );
        return;
      }
      // Stamped here, not at selection: only tokens Gamma is actually asked
      // about have earned a backoff. Selection happens before the rate-limit
      // early return above, so stamping there would charge a full hydration
      // budget to tokens the poll never reached — stretching an entry or exit
      // recovery by that budget on top of the five-minute Gamma backoff. The
      // dropped tail likewise keeps its old `repolledAt` and stays eligible.
      this.stampSelectedMinOrderSizeRepolls(selectedFallbackCandidates, now);
      // Same reason, same place: the least-recently-polled cursor must record
      // what Gamma was actually asked about, or a token dropped by the backoff
      // goes to the back of the queue without ever having been polled.
      for (const candidate of selectedFallbackCandidates) {
        this.lastFallbackPollAtByToken.set(candidate.tokenId, now);
      }
      const pricingMap =
        tokenIdsToPoll.length > 0
          ? await this.deps.gateway.getMarketPricing(tokenIdsToPoll, { timeoutMs })
          : new Map<string, import("@krabs/domain").MarketPricingSnapshot>();
      if (this.deps.runtimeControl?.isPaused()) {
        this.log.debug(
          { polledTokenCount: tokenIdsToPoll.length },
          "poll snapshot suppressed after pause flip mid-await",
        );
        return;
      }
      await this.enrichPricingWithPublicTradeCounts(pricingMap, tracked, now);
      if (this.deps.runtimeControl?.isPaused()) {
        this.log.debug(
          { polledTokenCount: tokenIdsToPoll.length },
          "poll snapshot suppressed after pause flip mid-enrichment",
        );
        return;
      }
      this.lastPricingHitCount = pricingMap.size;
      for (const tokenId of tokenIdsToPoll) {
        this.lastPricingAttemptAtByToken.set(tokenId, now);
      }
      const changedMarkets: NormalizedMarket[] = [];
      let nullPricingGateCount = 0;

      for (const tokenKey of tokenIdsToPoll) {
        const market = this.trackedMarketsByToken.get(tokenKey);
        if (!market) continue;
        const current = this.marketCache.get(tokenKey);
        const baseMarket = syncTrackedMarket(current ?? null, market, now);
        const pricing = pricingMap.get(String(market.tokenId));
        if (pricing == null) {
          nullPricingGateCount++;
          continue;
        }
        const nextMarket = applyPricingSnapshot(baseMarket, pricing, now);
        this.lastPricingUpdateAtByToken.set(tokenKey, now);
        this.marketCache.set(tokenKey, nextMarket);
        this.fullLifetimeMetadataOnlyTokenIds.delete(tokenKey);
        const lastPublished = this.lastPublishedMarketByToken.get(tokenKey) ?? null;
        if (lastPublished == null || didMarketPricingChange(lastPublished, nextMarket)) {
          changedMarkets.push(nextMarket);
        }
      }

      this.lastSuccessfulDataMs = now;
      this.forceFullPoll = false;
      resetWarnThrottle(this.cachedPollDegradeWarn);
      // A successful bounded poll only proves freshness for the selected
      // fallback slice. Deferred gap tokens stay queued until they are polled
      // or age out via MARKET_DATA_STALE_TOKEN_AGE_MS.
      for (const tokenId of tokenIdsToPoll) {
        this.pendingGapTokenIds.delete(tokenId);
      }
      this.log.info(
        {
          changedMarketCount: changedMarkets.length,
          polledTokenCount: tokenIdsToPoll.length,
          pricingHitCount: pricingMap.size,
          nullPricingGateCount,
          trackedDiffCounts: this.lastTrackedDiffCounts,
          cachedTrackedTokenCountAtPollStart,
        },
        "poll cycle complete",
      );

      await this.publishMarketSnapshotDelta(changedMarkets, now);
      await this.publishFullLifetimeHeartbeat(
        now,
        new Set(changedMarkets.map((market) => String(market.tokenId))),
      );
    } catch (err) {
      this.recordHttpError("gamma-pricing", err);
      if (isRateLimitError(err)) {
        this.pricingPollBackoffUntilMs = Date.now() + GAMMA_RATE_LIMIT_BACKOFF_MS;
      }
      if (this.shouldDegradeToCachedStreamState(err, tracked, tokenIdsToPoll)) {
        const nowMs = Date.now();
        await this.publishCachedMarkets(tracked, nowMs);
        this.logCachedPollDegraded(err, tracked.length, tokenIdsToPoll.length, nowMs);
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

  private getTieredTrackedForPricing(
    maxTokens: number,
    nowMs: number,
    reserveSignature: boolean,
  ): TrackedForPricing {
    const ttlMs = this.deps.tieredPricingCacheTtlMs ?? DEFAULT_TIERED_PRICING_CACHE_TTL_MS;
    if (
      this.tieredPricingCache &&
      this.tieredPricingCache.maxTokens === maxTokens &&
      this.tieredPricingCache.reserveSignature === reserveSignature &&
      nowMs - this.tieredPricingCache.capturedAtMs <= ttlMs
    ) {
      return this.tieredPricingCache.value;
    }
    const value = this.deps.marketRepo.findTrackedForPricingTiered({
      maxTokens,
      reserveSignature,
      ...(this.deps.signatureReserve != null
        ? { signatureReserve: this.deps.signatureReserve }
        : {}),
      ...(this.deps.signatureThresholds != null
        ? { signature: this.deps.signatureThresholds }
        : {}),
    });
    const v4Telemetry = readV4AdmissionTelemetry(this.deps.marketRepo);
    if (v4Telemetry) {
      this.log.debug(
        {
          evaluatedTotal: v4Telemetry.evaluatedTotal,
          admitCountTotal: v4Telemetry.admitCountTotal,
          rejectCountTotal: v4Telemetry.rejectCountTotal,
          admitRate: v4Telemetry.admitRate,
          rejectCountByReason: v4Telemetry.rejectCountByReason,
        },
        "V4 admission telemetry updated",
      );
    }
    this.tieredPricingCache = { maxTokens, reserveSignature, capturedAtMs: nowMs, value };
    return value;
  }

  private async enrichPricingWithPublicTradeCounts(
    pricingMap: Map<string, MarketPricingSnapshot>,
    markets: readonly Market[],
    nowMs: number,
  ): Promise<void> {
    const provider = this.deps.tradeCountProvider;
    this.lastPublicTradeCountEnrichmentEligibleCount = 0;
    this.lastPublicTradeCountEnrichmentSkippedCount = 0;
    this.lastPublicTradeCountEnrichmentConditionCount = 0;
    this.lastPublicTradeCountEnrichmentRequestCount = 0;
    if (!provider?.fetchPublicTradeCount24h || pricingMap.size === 0) return;
    const fetchPublicTradeCount24h = provider.fetchPublicTradeCount24h.bind(provider);

    const tokenIdsByCondition = new Map<string, string[]>();
    for (const market of markets) {
      const tokenId = String(market.tokenId);
      if (!pricingMap.has(tokenId)) continue;
      const role = this.wsTierRoleByToken.get(tokenId);
      if (!this.shouldEnrichPublicTradeCount(tokenId, role)) {
        this.lastPublicTradeCountEnrichmentSkippedCount++;
        continue;
      }
      this.lastPublicTradeCountEnrichmentEligibleCount++;
      const conditionId = String(market.conditionId);
      const tokenIds = tokenIdsByCondition.get(conditionId) ?? [];
      tokenIds.push(tokenId);
      tokenIdsByCondition.set(conditionId, tokenIds);
    }
    const entries = [...tokenIdsByCondition.entries()];
    this.lastPublicTradeCountEnrichmentConditionCount = entries.length;
    if (entries.length === 0) return;

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const entry = entries[cursor++];
        if (!entry) return;
        const [conditionId, tokenIds] = entry;
        this.lastPublicTradeCountEnrichmentRequestCount++;
        let result: Awaited<ReturnType<typeof fetchPublicTradeCount24h>> = null;
        try {
          result = await fetchPublicTradeCount24h(createConditionId(conditionId), nowMs);
        } catch (err) {
          this.recordHttpError("data-api-public-trade-count", err);
          continue;
        }
        for (const tokenId of tokenIds) {
          const pricing = pricingMap.get(tokenId);
          if (!pricing) continue;
          pricingMap.set(tokenId, {
            ...pricing,
            publicTradeCount24h: result?.count ?? null,
          });
        }
      }
    };
    const workers = Math.min(PUBLIC_TRADE_COUNT_ENRICH_CONCURRENCY, entries.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  private shouldEnrichPublicTradeCount(tokenId: string, role: WsTierRole | undefined): boolean {
    if (this.deps.publicTradeCountEnrichmentFilter) {
      return this.deps.publicTradeCountEnrichmentFilter(tokenId, role);
    }
    return true;
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
    if (this.deps.runtimeControl?.isPaused()) {
      this.log.debug("discovery poll skipped while runtime is paused");
      return;
    }
    const nowMs = Date.now();
    if (nowMs < this.discoveryPollBackoffUntilMs) {
      this.log.debug(
        { backoffRemainingMs: this.discoveryPollBackoffUntilMs - nowMs },
        "discovery poll skipped during Gamma rate-limit backoff",
      );
      return;
    }
    if (this.discoveryTier.length === 0) {
      // Even when the discovery tier has emptied out (scanner withdrew it, or
      // selection rules narrowed the universe), we must still flush any
      // tokens from the previous batch so they don't linger in downstream
      // caches forever.
      await this.flushDiscoveryBatchEviction(new Set(), nowMs);
      return;
    }
    const batchSize = this.deps.discoveryBatchSize ?? 50;
    const cursor = this.discoveryCursor % this.discoveryTier.length;
    const batch = this.discoveryTier.slice(cursor, cursor + batchSize);
    const tokenIds = batch.map((m) => String(m.tokenId));
    const marketByToken = new Map<string, Market>();
    for (const market of batch) {
      marketByToken.set(String(market.tokenId), market);
    }
    this.discoveryCursor = (cursor + batch.length) % this.discoveryTier.length;

    try {
      const timeoutMs = resolveMarketPricingTimeoutMs(tokenIds.length);
      const pricingMap = await this.deps.gateway.getMarketPricing(tokenIds, { timeoutMs });
      if (this.deps.runtimeControl?.isPaused()) {
        this.log.debug(
          { batchSize: batch.length },
          "discovery snapshot suppressed after pause flip mid-await",
        );
        return;
      }
      const nowMs = Date.now();
      await this.enrichPricingWithPublicTradeCounts(pricingMap, batch, nowMs);
      if (this.deps.runtimeControl?.isPaused()) {
        this.log.debug(
          { batchSize: batch.length },
          "discovery snapshot suppressed after pause flip mid-enrichment",
        );
        return;
      }
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
        const publishStartMs = performance.now();
        await this.deps.bus.publish("MarketSnapshotReceived", {
          markets: snapshots,
          timestamp: nowMs,
        });
        recordStageDuration("discovery_poll_publish", performance.now() - publishStartMs);
      }

      await this.flushDiscoveryBatchEviction(new Set(tokenIds), nowMs);
      resetWarnThrottle(this.discoveryPollFailureWarn);
    } catch (err) {
      this.recordHttpError("gamma-discovery", err);
      if (isRateLimitError(err)) {
        this.discoveryPollBackoffUntilMs = Date.now() + GAMMA_RATE_LIMIT_BACKOFF_MS;
      }
      this.logDiscoveryPollFailure(err, {
        batchSize: batch.length,
        cursor,
        discoveryTotal: this.discoveryTier.length,
      });
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
      const publishStartMs = performance.now();
      await this.deps.bus.publish("TrackedMarketsChanged", {
        addedTokenIds: [],
        removedTokenIds: removedTokenIds.map((t) => createTokenId(t)),
        activeTokenIds: [...wsTier].map((t) => createTokenId(t)),
        timestamp: nowMs,
      });
      recordStageDuration("discovery_poll_publish", performance.now() - publishStartMs);
    }
    this.lastDiscoveryBatchTokenIds = new Set(currentBatchTokens);
  }

  private async handleStreamUpdates(updates: readonly MarketPricingStreamUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    this.recordBookSignalStreamUpdates(updates, Date.now());
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

  private async handleRawTradeObservations(
    observations: readonly MarketPricingRawTradeObservation[],
  ): Promise<void> {
    if (!this.deps.bookSignals) return;
    for (const observation of observations) {
      this.deps.bookSignals.ingestLastTradePrice({
        tokenId: createTokenId(observation.tokenId),
        ts: observation.timestamp,
        price: observation.price,
      });
    }
  }

  private syncBookSignalSubscriptions(): void {
    const bookSignals = this.deps.bookSignals;
    if (!bookSignals || !this.stream) return;
    const openPositionTokenIds = bookSignals.openPositionTokenIds();
    // Trade-stats track-set may extend beyond open positions (e.g. GATE-whitelist entry candidates)
    // so tradeCount3h is available at entry; the full-book depth subscription stays position-only to
    // respect its capped WS budget (resolveBookSignalFullBookTokenIds).
    const trackedTokenIds = bookSignals.trackedTokenIds?.() ?? openPositionTokenIds;
    bookSignals.setOpenPositionTokenIds(trackedTokenIds);
    const fullBookTokenIds = this.resolveBookSignalFullBookTokenIds(openPositionTokenIds);
    this.stream.setFullBookTokenIds?.("open-position", fullBookTokenIds);
  }

  private resolveBookSignalFullBookTokenIds(
    tokenIds: readonly import("@krabs/domain").TokenId[],
  ): string[] {
    const requested = tokenIds.map(String);
    const cap = this.deps.maxTrackedTokens ?? requested.length;
    const subscribed = requested.slice(0, cap);
    const skippedCount = Math.max(0, requested.length - subscribed.length);
    this.lastBookSignalFullBookDemandCount = requested.length;
    this.lastBookSignalFullBookSubscribedCount = subscribed.length;
    this.lastBookSignalFullBookSkippedCount = skippedCount;

    if (cap > 0 && requested.length > 0) {
      const utilizationPct = (requested.length * 100) / cap;
      if (utilizationPct > 80 || skippedCount > 0) {
        const suppressedCount = consumeWarnThrottle(
          this.bookSignalFullBookCapWarn,
          Date.now(),
          BOOK_SIGNAL_FULL_BOOK_CAP_WARN_THROTTLE_MS,
        );
        if (suppressedCount != null) {
          this.log.warn(
            {
              demandCount: requested.length,
              subscribedCount: subscribed.length,
              skippedCount,
              cap,
              utilizationPct: Math.round(utilizationPct),
              suppressedCount,
            },
            "Track G full-book subscription demand exceeds cap; depthTop3 degrades for skipped tokens",
          );
        }
      } else {
        resetWarnThrottle(this.bookSignalFullBookCapWarn);
      }
    }

    // Track G depthTop3 is optional in Phase 1. When open-position full-book demand reaches
    // the WS-tier cap, keep top-of-book/trade subscriptions intact and degrade only depthTop3
    // for skipped tokens by omitting them from the full-book reason set.
    return subscribed;
  }

  private resolveBookSignalFullBookCapUtilizationPct(): number | null {
    const cap = this.deps.maxTrackedTokens;
    if (cap == null || cap <= 0) return null;
    return Math.round((this.lastBookSignalFullBookSubscribedCount * 100) / cap);
  }

  private invalidateBookSignalsForGap(tokenIds: readonly string[]): void {
    const bookSignals = this.deps.bookSignals;
    if (!bookSignals) return;
    const affectedTokenIds =
      tokenIds.length > 0 ? tokenIds : bookSignals.openPositionTokenIds().map(String);
    if (affectedTokenIds.length === 0) return;
    bookSignals.invalidateTokenIds?.(affectedTokenIds);
  }

  private recordBookSignalStreamUpdates(
    updates: readonly MarketPricingStreamUpdate[],
    observedAt: number,
  ): void {
    const bookSignals = this.deps.bookSignals;
    if (!bookSignals) return;
    for (const update of updates) {
      const tokenId = createTokenId(String(update.tokenId));
      bookSignals.ingestTopOfBook({
        tokenId,
        ts: update.book?.timestamp ?? observedAt,
        bestBid: update.pricing.bestBid,
        bestAsk: update.pricing.bestAsk,
      });
      if (update.book?.bids != null) {
        bookSignals.ingestBook({
          tokenId,
          ts: update.book.timestamp,
          bids: update.book.bids,
        });
      }
    }
  }

  private async flushPendingStreamUpdates(): Promise<void> {
    const startMs = performance.now();
    try {
      if (this.pendingStreamUpdatesByToken.size === 0) return;
      const nowMs = Date.now();
      const updates = [...this.pendingStreamUpdatesByToken.values()];
      this.pendingStreamUpdatesByToken.clear();
      const changedMarkets: NormalizedMarket[] = [];

      for (const update of updates) {
        const tokenKey = String(update.tokenId);
        const tracked = this.trackedMarketsByToken.get(tokenKey);
        if (!tracked) continue;
        if (update.book) this.latestOrderBookByToken.set(tokenKey, update.book);
        const current = syncTrackedMarket(this.marketCache.get(tokenKey) ?? null, tracked, nowMs);
        const nextMarket = applyStreamUpdate(current, update, nowMs);
        this.lastPricingUpdateAtByToken.set(tokenKey, nowMs);
        this.marketCache.set(tokenKey, nextMarket);
        this.fullLifetimeMetadataOnlyTokenIds.delete(tokenKey);
        const lastPublished = this.lastPublishedMarketByToken.get(tokenKey) ?? null;
        if (lastPublished == null || didMarketPricingChange(lastPublished, nextMarket)) {
          changedMarkets.push(nextMarket);
        }
      }

      if (changedMarkets.length > 0) {
        this.lastSuccessfulDataMs = nowMs;
      }
      if (this.deps.runtimeControl?.isPaused()) {
        this.log.debug(
          { coalescedUpdates: updates.length, changedMarkets: changedMarkets.length },
          "stream snapshot suppressed while runtime is paused",
        );
        await this.publishFullLifetimeHeartbeat(
          nowMs,
          new Set(changedMarkets.map((market) => String(market.tokenId))),
        );
        return;
      }
      if (changedMarkets.length > 0) {
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
      await this.publishFullLifetimeHeartbeat(
        nowMs,
        new Set(changedMarkets.map((market) => String(market.tokenId))),
      );
    } finally {
      recordStageDuration("coalescing_flush", performance.now() - startMs);
    }
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
          this.addPendingGapTokenIds(event.tokenIds, event.timestamp);
          this.invalidateBookSignalsForGap(event.tokenIds);
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
        this.addPendingGapTokenIds(event.tokenIds, Date.now());
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

  /**
   * Carry a departing token's accumulated wait over to a possible rejoin, as a DURATION rather
   * than the absolute stamp it was measured from: a token that leaves and returns months later
   * would otherwise re-enter carrying a months-old `waitingSince`, trip the starvation tier
   * immediately, and outrank execution-critical residents that have genuinely been waiting —
   * for time it spent outside the set and could not have been polled anyway.
   *
   * Insertion order is eviction order: the oldest retained entry is the one least likely to
   * still be waiting for anything, and dropping it only costs that token a restarted wait if it
   * ever returns.
   */
  private retainWaitForRejoin(tokenId: string, nowMs: number): void {
    const waitingSince =
      this.lastFallbackPollAtByToken.get(tokenId) ??
      this.trackedTokenAdmittedAtByToken.get(tokenId);
    if (waitingSince == null) return;
    this.retainedFallbackWaitMsByToken.delete(tokenId);
    this.retainedFallbackWaitMsByToken.set(tokenId, Math.max(0, nowMs - waitingSince));
    while (this.retainedFallbackWaitMsByToken.size > RETAINED_FALLBACK_WAIT_LIMIT) {
      const oldest = this.retainedFallbackWaitMsByToken.keys().next().value;
      if (oldest == null) break;
      this.retainedFallbackWaitMsByToken.delete(oldest);
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
    const admittedAtMs = Date.now();
    for (const market of tracked) {
      const tokenKey = String(market.tokenId);
      nextTokenIds.add(tokenKey);
      this.trackedMarketsByToken.set(tokenKey, market);
      if (previousTokenIds.has(tokenKey)) continue;
      added.push(tokenKey);
      // Where a never-polled token's wait starts. Measured from zero instead, it outranks every
      // peer that has ever been polled — and the tracked set churns, so a trickle of newcomers
      // (each one "oldest", each one first) starves a continuously eligible resident forever.
      // A REJOINING token resumes the wait it left with: a fresh stamp would hand any peer that
      // drops out and returns a permanently newer wait than the residents it is queued behind.
      // It resumes the DURATION it had accrued, not the stamp — time spent outside the set is
      // not wait, and back-dating by it would let a long-absent token jump the whole queue.
      const retainedWaitMs = this.retainedFallbackWaitMsByToken.get(tokenKey);
      this.retainedFallbackWaitMsByToken.delete(tokenKey);
      this.trackedTokenAdmittedAtByToken.set(
        tokenKey,
        retainedWaitMs == null ? admittedAtMs : admittedAtMs - retainedWaitMs,
      );
    }
    const removed: string[] = [];
    for (const tokenId of [...this.trackedMarketsByToken.keys()]) {
      if (nextTokenIds.has(tokenId)) continue;
      this.trackedMarketsByToken.delete(tokenId);
      this.marketCache.delete(tokenId);
      this.fullLifetimeMetadataOnlyTokenIds.delete(tokenId);
      this.fullLifetimeMarketCacheHydratedLoggedAtByToken.delete(tokenId);
      this.fullLifetimeSkippedSnapshotLoggedAtByToken.delete(tokenId);
      this.latestOrderBookByToken.delete(tokenId);
      this.lastPublishedMarketByToken.delete(tokenId);
      this.lastPricingUpdateAtByToken.delete(tokenId);
      this.retainWaitForRejoin(tokenId, admittedAtMs);
      this.lastFallbackPollAtByToken.delete(tokenId);
      this.trackedTokenAdmittedAtByToken.delete(tokenId);
      removed.push(tokenId);
    }
    // Defensive sweep: any entry in the aux caches that isn't in the current
    // WS tier is an orphan (e.g., from past discovery-tier leaks or renames).
    // Keep these maps bounded to the WS tier — discovery snapshots are
    // published on the fly and must not leave residue here.
    for (const tokenId of [...this.marketCache.keys()]) {
      if (!nextTokenIds.has(tokenId)) {
        this.marketCache.delete(tokenId);
        this.fullLifetimeMetadataOnlyTokenIds.delete(tokenId);
        this.fullLifetimeMarketCacheHydratedLoggedAtByToken.delete(tokenId);
        this.fullLifetimeSkippedSnapshotLoggedAtByToken.delete(tokenId);
      }
    }
    for (const tokenId of [...this.latestOrderBookByToken.keys()]) {
      if (!nextTokenIds.has(tokenId)) this.latestOrderBookByToken.delete(tokenId);
    }
    for (const tokenId of [...this.lastPublishedMarketByToken.keys()]) {
      if (!nextTokenIds.has(tokenId)) this.lastPublishedMarketByToken.delete(tokenId);
    }
    for (const tokenId of [...this.lastPricingUpdateAtByToken.keys()]) {
      if (!nextTokenIds.has(tokenId)) this.lastPricingUpdateAtByToken.delete(tokenId);
    }
    for (const tokenId of [...this.lastPricingAttemptAtByToken.keys()]) {
      if (!nextTokenIds.has(tokenId)) this.lastPricingAttemptAtByToken.delete(tokenId);
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

  private observeTrackedMarkets(activeTokenIds: readonly string[]): void {
    try {
      this.deps.trackedMarketObserver?.([...activeTokenIds], Date.now());
    } catch (error) {
      this.log.warn({ err: error }, "tracked-market shadow observer failed; pricing unaffected");
    }
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
    planktonSignature?: readonly Market[];
    entryCandidates?: readonly Market[];
    legacy?: readonly Market[];
  }): void {
    this.wsTierRoleByToken.clear();
    for (const market of args.executionCritical ?? []) {
      this.wsTierRoleByToken.set(String(market.tokenId), "executionCritical");
    }
    for (const market of args.planktonSignature ?? []) {
      this.wsTierRoleByToken.set(String(market.tokenId), "planktonSignature");
    }
    for (const market of args.entryCandidates ?? []) {
      this.wsTierRoleByToken.set(String(market.tokenId), "entryCandidate");
    }
    for (const market of args.legacy ?? []) {
      this.wsTierRoleByToken.set(String(market.tokenId), "legacy");
    }
  }

  private addPendingGapTokenIds(tokenIds: readonly string[], observedAtMs: number): void {
    for (const tokenId of tokenIds) {
      const normalized = tokenId.trim();
      if (normalized.length === 0) continue;
      this.pendingGapTokenIds.set(normalized, observedAtMs);
    }
  }

  private pruneStalePendingGaps(
    nowMs: number,
    trackedTokenIds: ReadonlySet<string>,
  ): { droppedCount: number; droppedTokenIds: ReadonlySet<string> } {
    const maxAgeMs = this.deps.fallbackStaleTokenAgeMs ?? 30_000;
    const droppedTokenIds = new Set<string>();
    for (const [tokenId, observedAtMs] of this.pendingGapTokenIds.entries()) {
      if (trackedTokenIds.has(tokenId) && nowMs - observedAtMs <= maxAgeMs) continue;
      this.pendingGapTokenIds.delete(tokenId);
      droppedTokenIds.add(tokenId);
    }
    return { droppedCount: droppedTokenIds.size, droppedTokenIds };
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
      isTransientNetworkError(err)
    );
  }

  private recordHttpError(source: string, err: unknown): void {
    const sink = this.deps.httpErrorMetricsSink;
    if (!sink) return;
    try {
      sink({
        source,
        errorClass: classifyHttpError(err),
        message: err instanceof Error ? err.message : String(err),
      });
    } catch {
      // Diagnostics must not affect market-data recovery.
    }
  }

  getFullLifetimeSnapshotPreserveTokenIds(nowMs = Date.now()): TokenId[] {
    if (!this.fullLifetimeEnabled()) return [];
    const preserve = new Set<string>(this.fullLifetimeActiveTokenIds);
    for (const [tokenId, untilMs] of this.fullLifetimePostCloseUntilByToken) {
      if (nowMs <= untilMs) preserve.add(tokenId);
    }
    return [...preserve].map((tokenId) => createTokenId(tokenId));
  }

  private fullLifetimeEnabled(): boolean {
    return this.deps.fullLifetimeSnapshots?.enabled === true;
  }

  private hydrateFullLifetimeActiveTokens(): void {
    if (!this.fullLifetimeEnabled()) return;
    try {
      for (const tokenId of this.deps.fullLifetimeSnapshots?.activePositionTokenIds() ?? []) {
        this.fullLifetimeActiveTokenIds.add(String(tokenId));
      }
    } catch (err) {
      this.log.warn({ err }, "full-lifetime active position hydration failed");
    }
  }

  private handleFullLifetimePositionUpdated(position: Position): void {
    if (!this.fullLifetimeEnabled()) return;
    const tokenId = String(position.tokenId);
    const wasActive = this.fullLifetimeActiveTokenIds.has(tokenId);
    const isActive = isFullLifetimeActivePosition(position);
    if (isActive) {
      this.fullLifetimePostCloseUntilByToken.delete(tokenId);
      if (wasActive) return;
      this.fullLifetimeActiveTokenIds.add(tokenId);
      this.invalidateTieredPricingCache("full-lifetime-active-position");
      this.queueFullLifetimePoll();
      return;
    }
    if (!wasActive) return;
    this.fullLifetimeActiveTokenIds.delete(tokenId);
    this.fullLifetimeLastHeartbeatAtByToken.delete(tokenId);
    this.fullLifetimeMarketCacheHydratedLoggedAtByToken.delete(tokenId);
    this.fullLifetimeSkippedSnapshotLoggedAtByToken.delete(tokenId);
    this.fullLifetimeMetadataOnlyTokenIds.delete(tokenId);
    const postCloseGraceMs = this.deps.fullLifetimeSnapshots?.postCloseGraceMs ?? 0;
    if (postCloseGraceMs > 0) {
      this.fullLifetimePostCloseUntilByToken.set(tokenId, Date.now() + postCloseGraceMs);
    } else {
      this.fullLifetimePostCloseUntilByToken.delete(tokenId);
    }
    this.invalidateTieredPricingCache("full-lifetime-inactive-position");
    this.queueFullLifetimePoll();
  }

  private handleFullLifetimePositionSettled(tokenId: TokenId): void {
    if (!this.fullLifetimeEnabled()) return;
    const tokenKey = String(tokenId);
    const hadState =
      this.fullLifetimeActiveTokenIds.delete(tokenKey) ||
      this.fullLifetimePostCloseUntilByToken.delete(tokenKey);
    this.fullLifetimeLastHeartbeatAtByToken.delete(tokenKey);
    this.fullLifetimeMissingMarketLoggedAtByToken.delete(tokenKey);
    this.fullLifetimeMarketCacheHydratedLoggedAtByToken.delete(tokenKey);
    this.fullLifetimeSkippedSnapshotLoggedAtByToken.delete(tokenKey);
    this.fullLifetimeMetadataOnlyTokenIds.delete(tokenKey);
    if (hadState) {
      this.invalidateTieredPricingCache("full-lifetime-position-settled");
    }
  }

  private invalidateTieredPricingCache(reason: string): void {
    if (!this.tieredPricingCache) return;
    this.tieredPricingCache = null;
    this.log.debug({ reason }, "tiered pricing cache invalidated");
  }

  private queueFullLifetimePoll(): void {
    if (this.fullLifetimePollTimer) return;
    this.forceFullPoll = true;
    this.fullLifetimePollTimer = setTimeout(() => {
      this.fullLifetimePollTimer = null;
      this.poll().catch((err) => this.log.error({ err }, "full-lifetime poll failed"));
    }, 0);
  }

  private async publishFullLifetimeHeartbeat(
    timestamp: number,
    realChangedTokenIds: ReadonlySet<string>,
  ): Promise<void> {
    if (!this.fullLifetimeEnabled()) return;
    const tokenIds = this.resolveFullLifetimeHeartbeatTokenIds(timestamp);
    if (tokenIds.length === 0) return;

    const markets: NormalizedMarket[] = [];
    const booksByToken = new Map<string, OrderBookSnapshot>();
    for (const tokenId of tokenIds) {
      if (realChangedTokenIds.has(tokenId)) continue;
      const market = this.resolveFullLifetimeHeartbeatMarket(tokenId, timestamp);
      if (market == null) {
        continue;
      }
      const lastHeartbeatAt = this.fullLifetimeLastHeartbeatAtByToken.get(tokenId);
      if (
        lastHeartbeatAt !== undefined &&
        timestamp - lastHeartbeatAt < (this.deps.fullLifetimeSnapshots?.heartbeatMs ?? 0)
      ) {
        continue;
      }
      markets.push(market);
      const book = this.latestOrderBookByToken.get(tokenId);
      if (book) booksByToken.set(tokenId, book);
    }
    if (markets.length === 0) return;

    await this.deps.bus.publish("MarketSnapshotHeartbeat", {
      markets,
      booksByToken,
      timestamp,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    for (const market of markets) {
      this.fullLifetimeLastHeartbeatAtByToken.set(String(market.tokenId), timestamp);
    }
  }

  private resolveFullLifetimeHeartbeatTokenIds(nowMs: number): string[] {
    const tokenIds = new Set<string>(this.fullLifetimeActiveTokenIds);
    for (const [tokenId, untilMs] of [...this.fullLifetimePostCloseUntilByToken]) {
      if (nowMs <= untilMs) {
        tokenIds.add(tokenId);
      } else {
        this.fullLifetimePostCloseUntilByToken.delete(tokenId);
      }
    }
    return [...tokenIds];
  }

  private resolveFullLifetimeHeartbeatMarket(
    tokenId: string,
    nowMs: number,
  ): NormalizedMarket | null {
    const cached = this.marketCache.get(tokenId);
    if (cached != null) {
      if (this.fullLifetimeMetadataOnlyTokenIds.has(tokenId) && !hasLivePricing(cached)) {
        this.recordFullLifetimeSkippedSnapshot(tokenId, nowMs, "metadata_only_no_book");
        return null;
      }
      return cached;
    }

    let persisted: Market | null;
    try {
      persisted = this.deps.marketRepo.findByTokenId(createTokenId(tokenId));
    } catch (err) {
      this.recordFullLifetimeMissingMarket(tokenId, nowMs, "market_lookup_error", err);
      return null;
    }
    if (persisted == null) {
      this.recordFullLifetimeMissingMarket(tokenId, nowMs, "market_row_missing");
      return null;
    }
    if (!persisted.active || !persisted.tradable) {
      this.recordFullLifetimeSkippedSnapshot(tokenId, nowMs, "inactive_or_untradable");
      return null;
    }

    const hydrated = syncTrackedMarket(null, persisted, nowMs);
    this.marketCache.set(tokenId, hydrated);
    this.fullLifetimeMetadataOnlyTokenIds.add(tokenId);
    this.recordFullLifetimeMarketCacheHydrated(tokenId, nowMs, "cache_miss_hydrated");
    this.recordFullLifetimeSkippedSnapshot(tokenId, nowMs, "metadata_only_no_book");
    return null;
  }

  private recordFullLifetimeMissingMarket(
    tokenId: string,
    nowMs: number,
    reason: FullLifetimeMarketCacheMissReason,
    err?: unknown,
  ): void {
    const lastLoggedAt = this.fullLifetimeMissingMarketLoggedAtByToken.get(tokenId);
    const throttleMs = Math.max(this.deps.fullLifetimeSnapshots?.heartbeatMs ?? 0, 60_000);
    if (lastLoggedAt !== undefined && nowMs - lastLoggedAt < throttleMs) return;
    this.fullLifetimeMissingMarketLoggedAtByToken.set(tokenId, nowMs);
    this.deps.fullLifetimeSnapshots?.recordMissingMarket?.(reason);
    this.log.warn(
      { tokenId, reason, err },
      "full-lifetime snapshot active position token missing market cache",
    );
  }

  private recordFullLifetimeMarketCacheHydrated(
    tokenId: string,
    nowMs: number,
    reason: FullLifetimeMarketCacheHydratedReason,
  ): void {
    const lastLoggedAt = this.fullLifetimeMarketCacheHydratedLoggedAtByToken.get(tokenId);
    const throttleMs = Math.max(this.deps.fullLifetimeSnapshots?.heartbeatMs ?? 0, 60_000);
    if (lastLoggedAt !== undefined && nowMs - lastLoggedAt < throttleMs) return;
    this.fullLifetimeMarketCacheHydratedLoggedAtByToken.set(tokenId, nowMs);
    this.deps.fullLifetimeSnapshots?.recordMarketCacheHydrated?.(reason);
    this.log.debug(
      { tokenId, reason },
      "full-lifetime snapshot active position token market cache hydrated",
    );
  }

  private recordFullLifetimeSkippedSnapshot(
    tokenId: string,
    nowMs: number,
    reason: FullLifetimeSnapshotSkipReason,
  ): void {
    const lastLoggedAt = this.fullLifetimeSkippedSnapshotLoggedAtByToken.get(tokenId);
    const throttleMs = Math.max(this.deps.fullLifetimeSnapshots?.heartbeatMs ?? 0, 60_000);
    if (lastLoggedAt !== undefined && nowMs - lastLoggedAt < throttleMs) return;
    this.fullLifetimeSkippedSnapshotLoggedAtByToken.set(tokenId, nowMs);
    this.deps.fullLifetimeSnapshots?.recordSkippedSnapshot?.(reason);
    this.log.debug(
      { tokenId, reason },
      "full-lifetime snapshot active position token skipped metadata-only heartbeat",
    );
  }

  private async publishCachedMarkets(tracked: readonly Market[], nowMs: number): Promise<void> {
    if (this.deps.runtimeControl?.isPaused()) {
      this.log.debug(
        { trackedCount: tracked.length },
        "cached market snapshot suppressed while runtime is paused",
      );
      return;
    }
    for (const trackedMarket of tracked) {
      const tokenKey = String(trackedMarket.tokenId);
      const nextMarket = syncTrackedMarket(
        this.marketCache.get(tokenKey) ?? null,
        trackedMarket,
        nowMs,
      );
      this.marketCache.set(tokenKey, nextMarket);
    }
    this.log.debug(
      { trackedCount: tracked.length },
      "cached market state retained without downstream snapshot fanout",
    );
    await this.publishFullLifetimeHeartbeat(nowMs, new Set());
  }

  private async publishMarketSnapshotDelta(
    markets: readonly NormalizedMarket[],
    timestamp: number,
  ): Promise<void> {
    if (markets.length === 0) return;
    for (const market of markets) {
      this.lastPublishedMarketByToken.set(String(market.tokenId), market);
    }
    await this.deps.bus.publish("MarketSnapshotReceived", {
      markets,
      timestamp,
    });
  }

  private logCachedPollDegraded(
    err: unknown,
    trackedCount: number,
    fallbackPollCount: number,
    nowMs: number,
  ): void {
    const suppressedCount = consumeWarnThrottle(
      this.cachedPollDegradeWarn,
      nowMs,
      TRANSIENT_POLL_WARN_THROTTLE_MS,
    );
    if (suppressedCount == null) return;
    this.log.warn(
      {
        err,
        trackedCount,
        fallbackPollCount,
        suppressedCount,
      },
      "poll cycle degraded — keeping cached websocket state",
    );
  }

  private logDiscoveryPollFailure(
    err: unknown,
    context: Readonly<{ batchSize: number; cursor: number; discoveryTotal: number }>,
  ): void {
    const suppressedCount = consumeWarnThrottle(
      this.discoveryPollFailureWarn,
      Date.now(),
      TRANSIENT_POLL_WARN_THROTTLE_MS,
    );
    if (suppressedCount == null) return;
    this.log.warn(
      {
        err,
        ...context,
        suppressedCount,
      },
      "discovery poll batch failed",
    );
  }
}

function resolveMarketPricingTimeoutMs(tokenCount: number): number {
  return Math.min(
    FALLBACK_POLL_TIMEOUT_MAX_MS,
    FALLBACK_POLL_TIMEOUT_BASE_MS + tokenCount * FALLBACK_POLL_TIMEOUT_PER_TOKEN_MS,
  );
}

function resolveFallbackPollLimit(args: {
  fallbackBatchSize: number;
  maxConcurrency: number;
  ratePerSec: number;
  pollIntervalMs: number;
}): number {
  const rateWindow = Math.max(1, Math.floor(args.ratePerSec * (args.pollIntervalMs / 1000)));
  return Math.max(1, Math.min(args.fallbackBatchSize, args.maxConcurrency, rateWindow));
}

/**
 * Role priority first, then least-recently-polled — `lastPolledAt` returns 0 for
 * a token never polled, so newcomers lead.
 *
 * Skipping the tail is not enough on its own: the sort is STABLE and role
 * priority alone leaves candidates in tracked-token order, so a token sitting
 * past the limit loses to the same earlier prefix every time that prefix's
 * refresh budget expires — with 101 same-role tokens, a limit of 25 and a
 * budget under 4 poll cycles, token 101 is eligible at every poll and polled at
 * none.
 *
 * A rotating cursor over the candidate list does NOT fix that, because the list
 * is not stable: a selected token disappears under its own backoff and returns
 * later, so an offset counted in list POSITIONS lands on a different membership
 * each cycle and can cycle through a strict subset forever (7 same-role
 * candidates, limit 1, poll 5 s, budget 15 s → `tok-1/3/5` are never reached).
 * The wait is a property of the TOKEN, not of its position, so it survives the
 * set changing: a selected token's stamp becomes strictly the newest, so it
 * cannot win again until every continuously-eligible peer of the same role has
 * been polled.
 *
 * That wait starts at ADMISSION, not at zero. A never-polled token measured
 * from zero outranks every peer that has ever been polled, and the tracked set
 * churns — so a trickle of newcomers, each one "oldest", starves a resident
 * forever. Admission time makes the order a genuine FIFO; never-polled only
 * breaks the tie among tokens whose wait began at the same instant.
 *
 * Within a role that is enough; ACROSS roles it is not, because the priority
 * term dominates the wait: with a limit of 1 and one continuously eligible
 * `executionCritical`, an `entryCandidate` loses every single cycle no matter
 * how long it has waited — and a token that never gets polled is a token whose
 * pending hydration never lands. Hence the starvation tier: a full rotation at
 * this limit takes `ceil(n / limit)` poll cycles, so anything that has waited
 * longer than that was passed over by the ORDERING, not merely by its turn not
 * having come, and is promoted above every role for one cycle. The bound is
 * derived from the candidate set and the limit themselves, so it self-calibrates
 * instead of trading one hard-coded starvation horizon for another. Coverage
 * then holds for any limit, role mix, and churn.
 */
function selectFallbackPollCandidates(
  candidates: readonly FallbackPollCandidate[],
  limit: number,
  rotationState: (tokenId: string) => FallbackRotationState,
  nowMs: number,
  pollIntervalMs: number,
): FallbackPollCandidate[] {
  if (candidates.length <= limit) return [...candidates];
  const rotationMs = Math.ceil(candidates.length / limit) * pollIntervalMs;
  return candidates
    .map((candidate) => {
      const { lastPolledAt, admittedAt } = rotationState(candidate.tokenId);
      const waitingSince = lastPolledAt ?? admittedAt;
      const starved = nowMs - waitingSince > rotationMs;
      return {
        candidate,
        waitingSince,
        neverPolled: lastPolledAt == null ? 0 : 1,
        tier: starved ? FALLBACK_STARVED_TIER : fallbackCandidatePriority(candidate),
      };
    })
    .sort(
      (a, b) => a.tier - b.tier || a.waitingSince - b.waitingSince || a.neverPolled - b.neverPolled,
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

interface FallbackRotationState {
  /** Null when the token has never been fallback-polled — its wait runs from {@link admittedAt}. */
  lastPolledAt: number | null;
  /** When the token entered the tracked set. */
  admittedAt: number;
}

/** Above every value {@link fallbackCandidatePriority} can return. */
const FALLBACK_STARVED_TIER = -1;

function fallbackCandidatePriority(candidate: FallbackPollCandidate): number {
  if (candidate.role === "executionCritical") return 0;
  if (candidate.role === "planktonSignature") return 1;
  if (candidate.role === "entryCandidate") return 2;
  if (candidate.role === "legacy") return 3;
  return 4;
}

function countFallbackReasons(
  candidates: readonly FallbackPollCandidate[],
): MarketDataFallbackReasonCounts {
  const counts = zeroFallbackReasonCounts();
  for (const candidate of candidates) {
    counts[candidate.reason] += 1;
  }
  return counts;
}

function countFallbackRoles(
  candidates: readonly FallbackPollCandidate[],
): MarketDataTrackedRoleCounts {
  const counts = zeroTrackedRoleCounts();
  for (const candidate of candidates) {
    incrementTrackedRoleCounts(counts, candidate.role);
  }
  return counts;
}

function normalizeGapTokenIds(tokenIds: readonly string[] | undefined): string[] {
  if (!tokenIds) return [];
  return [
    ...new Set(tokenIds.map((tokenId) => tokenId.trim()).filter((tokenId) => tokenId.length > 0)),
  ];
}

function isFullLifetimeActivePosition(position: Position): boolean {
  return (
    position.closedAt == null &&
    position.size > 0 &&
    (position.status === PositionStatus.Open || position.status === PositionStatus.Dust)
  );
}

function zeroTrackedRoleCounts(): MarketDataTrackedRoleCounts {
  return {
    executionCritical: 0,
    planktonSignature: 0,
    entryCandidate: 0,
    legacy: 0,
    unassigned: 0,
  };
}

function incrementTrackedRoleCounts(
  counts: MarketDataTrackedRoleCounts,
  role: WsTierRole | undefined,
): void {
  if (role === "executionCritical") {
    counts.executionCritical += 1;
    return;
  }
  if (role === "planktonSignature") {
    counts.planktonSignature += 1;
    return;
  }
  if (role === "entryCandidate") {
    counts.entryCandidate += 1;
    return;
  }
  if (role === "legacy") {
    counts.legacy += 1;
    return;
  }
  counts.unassigned += 1;
}

/** Exported for testing — role-count aggregation used by tracked/fallback metrics. */
export function countTrackedRoleCounts(
  roles: IterableIterator<WsTierRole> | Iterable<WsTierRole>,
): MarketDataTrackedRoleCounts {
  const counts = zeroTrackedRoleCounts();
  for (const role of roles) {
    incrementTrackedRoleCounts(counts, role);
  }
  return counts;
}

function zeroTrackedBookSourceCounts(): MarketDataTrackedBookSourceCounts {
  return {
    unknown: 0,
    clob: 0,
    gamma: 0,
    gammaFallback: 0,
    other: 0,
  };
}

function zeroTrackedDiffCounts(): MarketDataTrackedDiffCounts {
  return {
    added: 0,
    removed: 0,
    unchanged: 0,
  };
}

function countTrackedBookSourceCounts(
  trackedTokenIds: IterableIterator<string> | Iterable<string>,
  marketCache: ReadonlyMap<string, { bookSource?: string | null }>,
): MarketDataTrackedBookSourceCounts {
  const counts = zeroTrackedBookSourceCounts();
  for (const tokenId of trackedTokenIds) {
    const source = marketCache.get(tokenId)?.bookSource ?? "unknown";
    if (source === "unknown") {
      counts.unknown += 1;
    } else if (source === "clob") {
      counts.clob += 1;
    } else if (source === "gamma") {
      counts.gamma += 1;
    } else if (source === "gamma-fallback") {
      counts.gammaFallback += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

function zeroFallbackReasonCounts(): MarketDataFallbackReasonCounts {
  return {
    pendingGap: 0,
    missingCache: 0,
    unknownSourceRefresh: 0,
    knownSourceRefresh: 0,
    forceFullPoll: 0,
    streamUnavailable: 0,
    featureFreshness: 0,
    minOrderSizeHydration: 0,
  };
}

function readV4AdmissionTelemetry(
  marketRepo: MarketRepository,
): V4AdmissionTelemetrySnapshot | null {
  const getter = (
    marketRepo as Partial<{
      getV4AdmissionTelemetrySnapshot: () => V4AdmissionTelemetrySnapshot;
    }>
  ).getV4AdmissionTelemetrySnapshot;
  return typeof getter === "function" ? getter.call(marketRepo) : null;
}

function getTrackedTokenRefreshBudgetMs(
  market: { bookSource?: string | null },
  pollIntervalMs: number,
  tokenSubscribedOnHealthyWsTier: boolean,
  role?: WsTierRole,
): number {
  if (market.bookSource == null || market.bookSource === "unknown") {
    if (role === "executionCritical") {
      return Math.max(STREAM_UNKNOWN_EXECUTION_CRITICAL_REFRESH_MIN_STALE_MS, pollIntervalMs * 3);
    }
    if (role === "entryCandidate") {
      return Math.max(STREAM_UNKNOWN_ENTRY_CANDIDATE_REFRESH_MIN_STALE_MS, pollIntervalMs * 24);
    }
    return Math.max(STREAM_UNKNOWN_LEGACY_REFRESH_MIN_STALE_MS, pollIntervalMs * 6);
  }
  if (
    tokenSubscribedOnHealthyWsTier &&
    market.bookSource != null &&
    market.bookSource !== "unknown"
  ) {
    return Number.POSITIVE_INFINITY;
  }
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
    volume24hr: current?.volume24hr ?? null,
    publicTradeCount24h: current?.publicTradeCount24h ?? null,
    liquidity: current?.liquidity ?? null,
    minOrderSize: current?.minOrderSize ?? null,
    bookSource: current?.bookSource ?? "unknown",
    snapshotTs: current?.snapshotTs ?? nowMs,
    featuresCapturedTs: current?.featuresCapturedTs ?? null,
    // Persisted eventMarketCount from the DB row (always set by scanner).
    // Required field on Market — no silent `?? 1` fallback (ADR-019 §D2).
    eventMarketCount: tracked.eventMarketCount,
    // Persisted Gamma createdAt — null-preserving in DB, propagated as-is here.
    gammaCreatedAt: tracked.gammaCreatedAt ?? current?.gammaCreatedAt ?? null,
    // Track B strike-signal fields (spec §4) — propagated from the persisted
    // Market row so the decision/exit paths can call classifyMarketRegime.
    groupItemTitle: tracked.groupItemTitle ?? null,
    groupItemThreshold: tracked.groupItemThreshold ?? null,
    tags: tracked.tags ?? null,
    // Step 3 (audit doc §P3 step 0) — propagate Step2 verdict so the
    // soft-ranking-score subscriber can filter without DB round-trip.
    selectionStatus: tracked.selectionStatus ?? null,
    // Scanner-persisted signature features (spec §4.3). These survive stream
    // updates automatically because applyPricingSnapshot / applyStreamUpdate
    // use `...market` spread and do NOT explicitly overwrite these fields.
    // Primary input to isMakerUniverse — CLOB stream updates omit liquidity /
    // volume24hr so the live fields are frequently NULL on the decision path.
    sigLiquidity: tracked.sigLiquidity ?? null,
    sigVol24hr: tracked.sigVol24h ?? null,
  };
}

function hasLivePricing(market: NormalizedMarket): boolean {
  return market.bestBid != null || market.bestAsk != null;
}
