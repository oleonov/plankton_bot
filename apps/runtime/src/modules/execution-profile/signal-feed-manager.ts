import type {
  EventBus,
  ExecutionProfileSignalFeedConfig,
  HotSample,
  NormalizedMarket,
  OhlcBucket,
  RuntimeModule,
  TokenId,
} from "@krabs/domain";

import type { SignalFeedBucketRepository } from "./signal-feed-repository.js";

const DEFAULT_WARM_BUCKET_CAP = 24 * 60;
const DEFAULT_COLD_BUCKET_MS = 60 * 60_000;
const DEFAULT_RETENTION_DAYS = 120;
const STALE_TOKEN_THRESHOLD_MS = 5 * 60_000;
// Fixed v1 eviction horizon (1h) — intentionally NOT operator-configurable.
// Hot tokens silent past this point are dropped from the buffer so silent
// markets cannot accumulate unbounded. Sits well beyond STALE_TOKEN_THRESHOLD_MS
// (5m), so a token is reported stale for ~55m before it is ever evicted. Revisit
// only if a real workload needs a different window; do not wire it to config yet.
const STALE_TOKEN_EVICTION_MS = 60 * 60_000;
const STALE_TOKEN_SAMPLE_CAP = 10;
const EMPTY_LABELS = "{}";

export const SIGNAL_FEED_METRICS = {
  samplesReceivedHeartbeat: "signal_feed_samples_received_heartbeat",
  samplesReceivedChanged: "signal_feed_samples_received_changed",
  bucketsFlushedWarm: "signal_feed_buckets_flushed_warm",
  bucketsFlushedCold: "signal_feed_buckets_flushed_cold",
  maintenanceRuns: "signal_feed_maintenance_runs",
  maintenanceFailures: "signal_feed_maintenance_failures",
  snapshotsReturned: "signal_feed_snapshots_returned",
  snapshotsNull: "signal_feed_snapshots_null",
  snapshotsInsufficient: "signal_feed_snapshots_insufficient",
  hotBufferSize: "signal_feed_hot_buffer_size",
  warmBucketCount: "signal_feed_warm_bucket_count",
  activeTokens: "signal_feed_active_tokens",
  recovery60Value: "signal_feed_recovery60_value",
  range60Value: "signal_feed_range60_value",
  tradeCount3hValue: "signal_feed_tradeCount3h_value",
  staleTokens: "signal_feed_stale_tokens",
  staleTokensEvicted: "signal_feed_stale_tokens_evicted",
} as const;

export const SIGNAL_FEED_RISK_EVENTS = {
  initialized: "signal_feed_initialized",
  maintenanceCompleted: "signal_feed_maintenance_completed",
  maintenanceFailed: "signal_feed_maintenance_failed",
  staleToken: "signal_feed_stale_token",
} as const;

export interface SignalFeedMetricWriter {
  writeCounter(name: string, value?: number, labels?: string | null): void;
  writeEvent(metricName: string, value: number, labels: string | null, capturedAt: string): void;
}

export interface SignalFeedRiskEventWriter {
  insert(event: { eventType: string; payload: Record<string, unknown> }): void;
}

type SignalFeedManagerConfig = Pick<
  ExecutionProfileSignalFeedConfig,
  "enabled" | "windowShortMs" | "warmBucketMs"
> &
  Partial<ExecutionProfileSignalFeedConfig>;

export interface SignalFeedManagerDeps {
  bus: EventBus;
  repository: SignalFeedBucketRepository;
  config: SignalFeedManagerConfig;
  metrics?: SignalFeedMetricWriter;
  riskEvents?: SignalFeedRiskEventWriter;
}

export class SignalFeedManager implements RuntimeModule {
  private readonly hot: SignalFeedHotBuffer;
  private readonly warm: SignalFeedWarmTier;
  private readonly tokenIds = new Set<string>();
  private readonly lastHotFlushTsByToken = new Map<string, number>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private started = false;

  constructor(private readonly deps: SignalFeedManagerDeps) {
    this.hot = new SignalFeedHotBuffer(deps.config.windowShortMs);
    const windowLongMs = deps.config.windowLongMs;
    const warmBucketCap =
      windowLongMs == null
        ? DEFAULT_WARM_BUCKET_CAP
        : Math.ceil(windowLongMs / deps.config.warmBucketMs) + 1;
    this.warm = new SignalFeedWarmTier(deps.config.warmBucketMs, warmBucketCap);
  }

  async start(): Promise<void> {
    if (this.started || !this.deps.config.enabled) return;
    this.started = true;
    this.unsubscribers.push(
      this.deps.bus.subscribe("MarketSnapshotHeartbeat", async (event) => {
        this.ingestMarkets(
          event.markets,
          event.timestamp,
          SIGNAL_FEED_METRICS.samplesReceivedHeartbeat,
        );
      }),
      this.deps.bus.subscribe("NormalizedMarketUpdated", async (event) => {
        this.ingestMarkets(
          event.markets,
          event.timestamp,
          SIGNAL_FEED_METRICS.samplesReceivedChanged,
        );
      }),
    );
    this.recordRiskEvent(SIGNAL_FEED_RISK_EVENTS.initialized, {
      enabled: true,
      tokenCountResumed: this.tokenIds.size,
      warmBucketsResumed: this.warm.totalBuckets(),
    });
    this.startTimer(this.deps.config.flushHotToWarmIntervalMs, () =>
      this.flushHotToWarm(Date.now()),
    );
    this.startTimer(this.deps.config.flushWarmToColdIntervalMs, () =>
      this.flushWarmToCold(Date.now()),
    );
    this.startTimer(this.deps.config.flushHotToWarmIntervalMs, () =>
      this.writeGaugeSnapshot(Date.now()),
    );
    this.startTimer(this.deps.config.maintenanceIntervalMs, () => this.runMaintenanceTimer());
  }

  async stop(): Promise<void> {
    while (this.unsubscribers.length > 0) {
      this.unsubscribers.pop()?.();
    }
    while (this.timers.length > 0) {
      clearInterval(this.timers.pop());
    }
    this.started = false;
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true, detail: `tokens=${this.tokenIds.size}` };
  }

  getHotSamples(tokenId: TokenId): HotSample[] {
    return this.hot.getSamples(tokenId);
  }

  getHotBuffer(): SignalFeedHotBuffer {
    return this.hot;
  }

  getWarmTier(): SignalFeedWarmTier {
    return this.warm;
  }

  writeGaugeSnapshot(_nowMs: number): void {
    if (!this.deps.config.enabled) return;
    const capturedAt = new Date(_nowMs).toISOString();
    this.deps.metrics?.writeEvent(
      SIGNAL_FEED_METRICS.hotBufferSize,
      this.hot.totalSamples(),
      EMPTY_LABELS,
      capturedAt,
    );
    this.deps.metrics?.writeEvent(
      SIGNAL_FEED_METRICS.warmBucketCount,
      this.warm.totalBuckets(),
      EMPTY_LABELS,
      capturedAt,
    );
    this.deps.metrics?.writeEvent(
      SIGNAL_FEED_METRICS.activeTokens,
      this.hot.size(),
      EMPTY_LABELS,
      capturedAt,
    );
  }

  flushHotToWarm(nowMs: number): void {
    if (!this.deps.config.enabled) return;
    for (const tokenKey of this.tokenIds) {
      const tokenId = tokenKey as TokenId;
      const afterTs = this.lastHotFlushTsByToken.get(tokenKey) ?? Number.NEGATIVE_INFINITY;
      const samples = this.hot
        .samplesBetween(tokenId, afterTs + 1, nowMs)
        .filter((sample) => Number.isFinite(sample.midPrice) && sample.midPrice > 0);
      if (samples.length === 0) continue;
      const buckets = this.warm.ingestSamples(tokenId, samples);
      this.recordCounter(SIGNAL_FEED_METRICS.bucketsFlushedWarm, buckets.length);
      this.lastHotFlushTsByToken.set(tokenKey, samples[samples.length - 1]!.tsMs);
    }
  }

  flushWarmToCold(nowMs: number): void {
    if (!this.deps.config.enabled) return;
    for (const tokenKey of this.tokenIds) this.persistUnpersisted(tokenKey, nowMs);
  }

  maintenancePrune(nowMs: number): void {
    if (!this.deps.config.enabled) return;
    this.recordCounter(SIGNAL_FEED_METRICS.maintenanceRuns);
    const startedAt = Date.now();
    try {
      const coldBucketMs = this.deps.config.coldArchiveBucketMs ?? DEFAULT_COLD_BUCKET_MS;
      const retentionDays = this.deps.config.retentionDays ?? DEFAULT_RETENTION_DAYS;
      const bucketsPurged = this.deps.repository.deleteBucketsBefore(
        coldBucketMs,
        nowMs - retentionDays * 24 * 60 * 60_000,
      );
      this.detectStaleTokens(nowMs);
      this.recordRiskEvent(SIGNAL_FEED_RISK_EVENTS.maintenanceCompleted, {
        bucketsCompacted: 0,
        bucketsPurged,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      this.recordCounter(SIGNAL_FEED_METRICS.maintenanceFailures);
      this.recordRiskEvent(SIGNAL_FEED_RISK_EVENTS.maintenanceFailed, {
        errorClass: error instanceof Error ? error.constructor.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private ingestMarkets(
    markets: readonly NormalizedMarket[],
    timestamp: number,
    metricName: string,
  ): void {
    for (const market of markets) {
      if (market.midPrice == null || !Number.isFinite(market.midPrice) || market.midPrice <= 0)
        continue;
      if (this.hot.push(market.tokenId, { tsMs: timestamp, midPrice: market.midPrice })) {
        this.tokenIds.add(String(market.tokenId));
        this.recordCounter(metricName);
      }
    }
  }

  private detectStaleTokens(nowMs: number): void {
    const tokenKeys = this.hot.keys();
    const staleAges: number[] = [];
    const sampleTokenIds: string[] = [];
    const evictKeys: string[] = [];
    for (const tokenKey of tokenKeys) {
      const lastSampleTsMs = this.hot.lastSampleTsMs(tokenKey as TokenId);
      if (lastSampleTsMs == null) continue;
      const lastSampleAgeMs = nowMs - lastSampleTsMs;
      if (lastSampleAgeMs <= STALE_TOKEN_THRESHOLD_MS) continue;
      staleAges.push(lastSampleAgeMs);
      if (sampleTokenIds.length < STALE_TOKEN_SAMPLE_CAP) sampleTokenIds.push(tokenKey);
      if (lastSampleAgeMs >= STALE_TOKEN_EVICTION_MS) evictKeys.push(tokenKey);
    }
    for (const tokenKey of evictKeys) this.dropToken(tokenKey, nowMs);
    if (staleAges.length === 0) return;
    staleAges.sort((left, right) => left - right);
    const evictedTokenCount = evictKeys.length;
    this.recordCounter(SIGNAL_FEED_METRICS.staleTokens, staleAges.length);
    if (evictedTokenCount > 0) {
      this.recordCounter(SIGNAL_FEED_METRICS.staleTokensEvicted, evictedTokenCount);
    }
    this.recordRiskEvent(SIGNAL_FEED_RISK_EVENTS.staleToken, {
      staleTokenCount: staleAges.length,
      totalTokens: tokenKeys.length,
      evictedTokenCount,
      sampleTokenIds,
      ageP50Ms: percentile(staleAges, 0.5),
      ageP90Ms: percentile(staleAges, 0.9),
      ageMaxMs: staleAges[staleAges.length - 1]!,
    });
  }

  private dropToken(tokenKey: string, nowMs: number): void {
    this.persistUnpersisted(tokenKey, nowMs);
    this.hot.dropToken(tokenKey as TokenId);
    this.tokenIds.delete(tokenKey);
    this.lastHotFlushTsByToken.delete(tokenKey);
    this.warm.dropToken(tokenKey as TokenId);
  }

  private persistUnpersisted(tokenKey: string, nowMs: number): void {
    const tokenId = tokenKey as TokenId;
    const unpersisted = this.warm.takeUnpersisted(tokenId);
    if (unpersisted.length === 0) return;
    this.deps.repository.upsertBuckets(unpersisted, nowMs);
    this.recordCounter(SIGNAL_FEED_METRICS.bucketsFlushedCold, unpersisted.length);
    for (const bucket of unpersisted) this.warm.markPersisted(tokenId, bucket.bucketStartMs);
  }

  private recordCounter(name: string, value = 1): void {
    this.deps.metrics?.writeCounter(name, value, null);
  }

  private recordRiskEvent(eventType: string, payload: Record<string, unknown>): void {
    this.deps.riskEvents?.insert({ eventType, payload });
  }

  private startTimer(intervalMs: number | undefined, fn: () => void): void {
    if (intervalMs == null || intervalMs <= 0) return;
    const timer = setInterval(fn, intervalMs);
    timer.unref?.();
    this.timers.push(timer);
  }

  private runMaintenanceTimer(): void {
    try {
      this.maintenancePrune(Date.now());
    } catch {
      // Manual maintenance calls surface errors to tests/callers. Periodic
      // telemetry maintenance records failures but must not crash runtime.
    }
  }
}

export class SignalFeedHotBuffer {
  private readonly samplesByToken = new Map<string, HotSample[]>();
  private readonly lastSampleTsByToken = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  push(tokenId: TokenId, sample: HotSample): boolean {
    const key = String(tokenId);
    if (this.lastSampleTsByToken.get(key) === sample.tsMs) return false;
    const samples = this.samplesByToken.get(key) ?? [];
    const priorTailTsMs = samples[samples.length - 1]?.tsMs;
    samples.push(sample);
    if (priorTailTsMs != null && sample.tsMs < priorTailTsMs) {
      samples.sort((left, right) => left.tsMs - right.tsMs);
    }
    this.samplesByToken.set(key, samples);
    this.lastSampleTsByToken.set(key, sample.tsMs);
    this.evictOlderThan(tokenId, sample.tsMs - this.windowMs);
    return true;
  }

  getSamples(tokenId: TokenId): HotSample[] {
    return [...(this.samplesByToken.get(String(tokenId)) ?? [])];
  }

  keys(): string[] {
    return [...this.samplesByToken.keys()];
  }

  size(): number {
    return this.samplesByToken.size;
  }

  totalSamples(): number {
    return [...this.samplesByToken.values()].reduce((sum, samples) => sum + samples.length, 0);
  }

  lastSampleTsMs(tokenId: TokenId): number | null {
    return this.lastSampleTsByToken.get(String(tokenId)) ?? null;
  }

  dropToken(tokenId: TokenId): void {
    const key = String(tokenId);
    this.samplesByToken.delete(key);
    this.lastSampleTsByToken.delete(key);
  }

  samplesBetween(tokenId: TokenId, startMs: number, endMs: number): HotSample[] {
    return this.getSamples(tokenId).filter(
      (sample) => sample.tsMs >= startMs && sample.tsMs <= endMs,
    );
  }

  evictOlderThan(tokenId: TokenId, minTsMs: number): void {
    const key = String(tokenId);
    const current = this.samplesByToken.get(key);
    if (current == null) return;
    const next =
      current[0]!.tsMs >= minTsMs ? current : current.filter((sample) => sample.tsMs >= minTsMs);
    if (next.length === 0) {
      this.samplesByToken.delete(key);
      this.lastSampleTsByToken.delete(key);
      return;
    }
    this.samplesByToken.set(key, next);
    this.lastSampleTsByToken.set(key, next[next.length - 1]?.tsMs ?? Number.NEGATIVE_INFINITY);
  }
}

export class SignalFeedWarmTier {
  private readonly bucketsByToken = new Map<string, OhlcBucket[]>();

  constructor(
    private readonly bucketGranularityMs: number,
    private readonly maxBucketsPerToken = DEFAULT_WARM_BUCKET_CAP,
  ) {}

  ingestSamples(tokenId: TokenId, samples: readonly HotSample[]): OhlcBucket[] {
    const touchedByStart = new Map<number, OhlcBucket>();
    for (const sample of [...samples].sort((left, right) => left.tsMs - right.tsMs)) {
      const bucket = this.getOrCreateBucket(
        tokenId,
        bucketStart(sample.tsMs, this.bucketGranularityMs),
      );
      updateBucket(bucket, sample.midPrice);
      touchedByStart.set(bucket.bucketStartMs, bucket);
    }
    this.trim(tokenId);
    return [...touchedByStart.values()].map(cloneBucket);
  }

  getBuckets(tokenId: TokenId): OhlcBucket[] {
    return (this.bucketsByToken.get(String(tokenId)) ?? []).map(cloneBucket);
  }

  totalBuckets(): number {
    return [...this.bucketsByToken.values()].reduce((sum, buckets) => sum + buckets.length, 0);
  }

  markPersisted(tokenId: TokenId, bucketStartMs: number): void {
    const bucket = this.mutableBuckets(tokenId).find(
      (item) => item.bucketStartMs === bucketStartMs,
    );
    if (bucket != null) bucket.persisted = true;
  }

  takeUnpersisted(tokenId: TokenId): OhlcBucket[] {
    return this.mutableBuckets(tokenId)
      .filter((bucket) => !bucket.persisted)
      .map(cloneBucket);
  }

  dropToken(tokenId: TokenId): void {
    this.bucketsByToken.delete(String(tokenId));
  }

  private getOrCreateBucket(tokenId: TokenId, bucketStartMs: number): OhlcBucket {
    const buckets = this.mutableBuckets(tokenId);
    const existing = buckets.find((bucket) => bucket.bucketStartMs === bucketStartMs);
    if (existing != null) return existing;
    const created: OhlcBucket = {
      tokenId,
      bucketStartMs,
      bucketGranularityMs: this.bucketGranularityMs,
      openMid: 0,
      highMid: 0,
      lowMid: 0,
      closeMid: 0,
      sampleCount: 0,
      tradeCount: 0,
      notionalSum: 0,
      persisted: false,
    };
    buckets.push(created);
    buckets.sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    return created;
  }

  private mutableBuckets(tokenId: TokenId): OhlcBucket[] {
    const key = String(tokenId);
    const existing = this.bucketsByToken.get(key);
    if (existing != null) return existing;
    const created: OhlcBucket[] = [];
    this.bucketsByToken.set(key, created);
    return created;
  }

  // The cap applies to persisted buckets only: trimming an unpersisted one would lose data
  // that never reached cold storage, whatever order the flush timers happen to fire in.
  private trim(tokenId: TokenId): void {
    const buckets = this.mutableBuckets(tokenId);
    const overflow = buckets.length - this.maxBucketsPerToken;
    let removable = 0;
    while (removable < overflow && buckets[removable]!.persisted) removable += 1;
    if (removable > 0) buckets.splice(0, removable);
  }
}

export function bucketStart(tsMs: number, bucketGranularityMs: number): number {
  return Math.floor(tsMs / bucketGranularityMs) * bucketGranularityMs;
}

function percentile(sortedAsc: readonly number[], fraction: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = Math.min(sortedAsc.length - 1, Math.floor(fraction * sortedAsc.length));
  return sortedAsc[index]!;
}

function updateBucket(bucket: OhlcBucket, midPrice: number): void {
  if (bucket.sampleCount === 0) {
    bucket.openMid = midPrice;
    bucket.highMid = midPrice;
    bucket.lowMid = midPrice;
  } else {
    bucket.highMid = Math.max(bucket.highMid, midPrice);
    bucket.lowMid = Math.min(bucket.lowMid, midPrice);
  }
  bucket.closeMid = midPrice;
  bucket.sampleCount += 1;
}

function cloneBucket(bucket: OhlcBucket): OhlcBucket {
  return { ...bucket };
}
