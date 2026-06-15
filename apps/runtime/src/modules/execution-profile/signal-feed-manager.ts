import type { HotSample, OhlcBucket, TokenId } from "@krabs/domain";

const DEFAULT_WARM_BUCKET_CAP = 24 * 60;

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
