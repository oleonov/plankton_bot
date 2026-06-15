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

type SignalFeedManagerConfig = Pick<
  ExecutionProfileSignalFeedConfig,
  "enabled" | "windowShortMs" | "warmBucketMs"
> &
  Partial<ExecutionProfileSignalFeedConfig>;

export interface SignalFeedManagerDeps {
  bus: EventBus;
  repository: SignalFeedBucketRepository;
  config: SignalFeedManagerConfig;
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
    this.warm = new SignalFeedWarmTier(deps.config.warmBucketMs);
  }

  async start(): Promise<void> {
    if (this.started || !this.deps.config.enabled) return;
    this.started = true;
    this.unsubscribers.push(
      this.deps.bus.subscribe("MarketSnapshotHeartbeat", async (event) => {
        this.ingestMarkets(event.markets, event.timestamp);
      }),
      this.deps.bus.subscribe("NormalizedMarketUpdated", async (event) => {
        this.ingestMarkets(event.markets, event.timestamp);
      }),
    );
    this.startTimer(this.deps.config.flushHotToWarmIntervalMs, () =>
      this.flushHotToWarm(Date.now()),
    );
    this.startTimer(this.deps.config.flushWarmToColdIntervalMs, () =>
      this.flushWarmToCold(Date.now()),
    );
    this.startTimer(this.deps.config.maintenanceIntervalMs, () =>
      this.maintenancePrune(Date.now()),
    );
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

  flushHotToWarm(nowMs: number): void {
    if (!this.deps.config.enabled) return;
    for (const tokenKey of this.tokenIds) {
      const tokenId = tokenKey as TokenId;
      const afterTs = this.lastHotFlushTsByToken.get(tokenKey) ?? Number.NEGATIVE_INFINITY;
      const samples = this.hot
        .samplesBetween(tokenId, afterTs + 1, nowMs)
        .filter((sample) => Number.isFinite(sample.midPrice) && sample.midPrice > 0);
      if (samples.length === 0) continue;
      this.warm.ingestSamples(tokenId, samples);
      this.lastHotFlushTsByToken.set(tokenKey, samples[samples.length - 1]!.tsMs);
    }
  }

  flushWarmToCold(nowMs: number): void {
    if (!this.deps.config.enabled) return;
    for (const tokenKey of this.tokenIds) {
      const tokenId = tokenKey as TokenId;
      const unpersisted = this.warm.takeUnpersisted(tokenId);
      if (unpersisted.length === 0) continue;
      this.deps.repository.upsertBuckets(unpersisted, nowMs);
      for (const bucket of unpersisted) this.warm.markPersisted(tokenId, bucket.bucketStartMs);
    }
  }

  maintenancePrune(nowMs: number): void {
    if (!this.deps.config.enabled) return;
    const coldBucketMs = this.deps.config.coldArchiveBucketMs ?? DEFAULT_COLD_BUCKET_MS;
    const retentionDays = this.deps.config.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.deps.repository.deleteBucketsBefore(
      coldBucketMs,
      nowMs - retentionDays * 24 * 60 * 60_000,
    );
  }

  private ingestMarkets(markets: readonly NormalizedMarket[], timestamp: number): void {
    for (const market of markets) {
      if (market.midPrice == null || !Number.isFinite(market.midPrice) || market.midPrice <= 0)
        continue;
      if (this.hot.push(market.tokenId, { tsMs: timestamp, midPrice: market.midPrice })) {
        this.tokenIds.add(String(market.tokenId));
      }
    }
  }

  private startTimer(intervalMs: number | undefined, fn: () => void): void {
    if (intervalMs == null || intervalMs <= 0) return;
    const timer = setInterval(fn, intervalMs);
    timer.unref?.();
    this.timers.push(timer);
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
    samples.push(sample);
    samples.sort((left, right) => left.tsMs - right.tsMs);
    this.samplesByToken.set(key, samples);
    this.lastSampleTsByToken.set(key, sample.tsMs);
    this.evictOlderThan(tokenId, sample.tsMs - this.windowMs);
    return true;
  }

  getSamples(tokenId: TokenId): HotSample[] {
    return [...(this.samplesByToken.get(String(tokenId)) ?? [])];
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
    const next = current.filter((sample) => sample.tsMs >= minTsMs);
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
    const created: OhlcBucket[] = [];
    for (const sample of [...samples].sort((left, right) => left.tsMs - right.tsMs)) {
      const bucket = this.getOrCreateBucket(
        tokenId,
        bucketStart(sample.tsMs, this.bucketGranularityMs),
      );
      if (bucket.sampleCount === 0) created.push(bucket);
      updateBucket(bucket, sample.midPrice);
    }
    this.trim(tokenId);
    return created;
  }

  getBuckets(tokenId: TokenId): OhlcBucket[] {
    return (this.bucketsByToken.get(String(tokenId)) ?? []).map(cloneBucket);
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

  private trim(tokenId: TokenId): void {
    const buckets = this.mutableBuckets(tokenId);
    const overflow = buckets.length - this.maxBucketsPerToken;
    if (overflow > 0) buckets.splice(0, overflow);
  }
}

export function bucketStart(tsMs: number, bucketGranularityMs: number): number {
  return Math.floor(tsMs / bucketGranularityMs) * bucketGranularityMs;
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
