import type Database from "better-sqlite3";
import type { NormalizedMarket, TokenId } from "@krabs/domain";
import { percentile } from "./decision-metrics.js";

export interface PriceHistoryProvider {
  findReferencePrice(tokenId: TokenId, targetMs: number, maxAgeMs: number): number | null;
  maxMidpointInWindow?(tokenId: TokenId, windowMs: number, nowMs?: number): number | null;
  midpointStatsInWindow?(
    tokenId: TokenId,
    windowMs: number,
    nowMs?: number,
  ): MidpointWindowStats | null;
  observeMarket?(market: NormalizedMarket, observedAtMs?: number): void;
  getWindowMaxCacheMetrics?(): WindowMaxCacheMetrics;
  evictToken?(tokenId: TokenId): void;
  snapshotMemoryMetrics?(nowMs?: number): R23MemoryMetrics;
}

export interface MidpointWindowStats {
  minMidpoint: number;
  maxMidpoint: number;
  minAtMs: number;
  maxAtMs: number;
  firstMidpoint: number;
  lastMidpoint: number;
  sampleCount: number;
}

export interface WindowMaxCacheMetrics {
  invocations: number;
  hits: number;
  misses: number;
  hitRate: number | null;
  entries: number;
  ttlMs: number;
  maxEntries: number;
}

export interface R23MemoryMetrics {
  tokenCount: number;
  sampleCount: number;
  samplesPerTokenP50: number | null;
  samplesPerTokenP95: number | null;
  samplesPerTokenMax: number | null;
  observedSamples: number;
  agePrunedSamples: number;
  capacityPrunedSamples: number;
  evictedTokens: number;
  evictedSamples: number;
  maxAgeMs: number;
  maxSamplesPerToken: number;
}

const WINDOW_MAX_CACHE_TTL_MS = 60_000;
const WINDOW_MAX_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_MEMORY_SAMPLE_MAX_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_MEMORY_SAMPLE_MAX_PER_TOKEN = 2_000;

interface MemorySample {
  ts: number;
  price: number;
  seq: number;
}

interface WindowMaxCacheEntry {
  computedAtMs: number;
  queryAtMs: number;
  value: number | null;
  source: "memory" | "database";
  maxSampleSeq: number | null;
  maxSampleTs: number | null;
}

export interface MarketSnapshotPriceHistoryProviderOptions {
  readonly syncMissLookup?: boolean;
  readonly memorySampleMaxAgeMs?: number;
  readonly memorySampleMaxPerToken?: number;
}

export class MarketSnapshotPriceHistoryProvider implements PriceHistoryProvider {
  private readonly findReference;
  private readonly findWindowMax;
  private readonly findWindowRows;
  private readonly syncMissLookup: boolean;
  private readonly memorySampleMaxAgeMs: number;
  private readonly memorySampleMaxPerToken: number;
  private readonly memorySamplesByToken = new Map<string, MemorySample[]>();
  private readonly windowMaxCache = new Map<string, WindowMaxCacheEntry>();
  private readonly windowMaxKeysByToken = new Map<string, Set<string>>();
  private nextSampleSeq = 0;
  private windowMaxInvocations = 0;
  private windowMaxHits = 0;
  private windowMaxMisses = 0;
  private observedSamples = 0;
  private agePrunedSamples = 0;
  private capacityPrunedSamples = 0;
  private evictedTokens = 0;
  private evictedSamples = 0;

  constructor(db: Database.Database, opts: MarketSnapshotPriceHistoryProviderOptions = {}) {
    this.syncMissLookup = opts.syncMissLookup ?? true;
    this.memorySampleMaxAgeMs = opts.memorySampleMaxAgeMs ?? DEFAULT_MEMORY_SAMPLE_MAX_AGE_MS;
    this.memorySampleMaxPerToken =
      opts.memorySampleMaxPerToken ?? DEFAULT_MEMORY_SAMPLE_MAX_PER_TOKEN;
    this.findReference = db.prepare(
      `SELECT best_bid, best_ask, last_price
       FROM market_snapshots
       WHERE token_id = ?
         AND captured_at <= ?
         AND captured_at >= ?
       ORDER BY captured_at DESC
       LIMIT 1`,
    );
    this.findWindowMax = db.prepare(
      `SELECT MAX(
                CASE
                  WHEN best_bid > 0 AND best_ask > 0 THEN (best_bid + best_ask) / 2.0
                  WHEN last_price > 0 THEN last_price
                  WHEN best_bid > 0 THEN best_bid
                  WHEN best_ask > 0 THEN best_ask
                  ELSE NULL
                END
              ) AS max_price
       FROM market_snapshots
       WHERE token_id = ?
         AND captured_at >= ?
         AND captured_at <= ?`,
    );
    this.findWindowRows = db.prepare(
      `SELECT captured_at,
              CASE
                WHEN best_bid > 0 AND best_ask > 0 THEN (best_bid + best_ask) / 2.0
                WHEN last_price > 0 THEN last_price
                WHEN best_bid > 0 THEN best_bid
                WHEN best_ask > 0 THEN best_ask
                ELSE NULL
              END AS midpoint
       FROM market_snapshots
       WHERE token_id = ?
         AND captured_at >= ?
         AND captured_at <= ?
       ORDER BY captured_at ASC`,
    );
  }

  findReferencePrice(tokenId: TokenId, targetMs: number, maxAgeMs: number): number | null {
    const memoryPrice = this.findReferencePriceInMemory(tokenId, targetMs, maxAgeMs);
    if (memoryPrice != null || !this.syncMissLookup) return memoryPrice;
    const targetIso = new Date(targetMs).toISOString();
    const oldestIso = new Date(targetMs - maxAgeMs).toISOString();
    const row = this.findReference.get(tokenId, targetIso, oldestIso) as
      | {
          best_bid: number | null;
          best_ask: number | null;
          last_price: number | null;
        }
      | undefined;
    if (!row) return null;
    return normalizedSnapshotPrice(row);
  }

  maxMidpointInWindow(tokenId: TokenId, windowMs: number, nowMs = Date.now()): number | null {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
    this.windowMaxInvocations++;
    const cacheKey = `${tokenId}:${windowMs}`;
    const cached = this.windowMaxCache.get(cacheKey);
    if (cached && this.refreshMemoryWindowMax(cached, tokenId, windowMs, nowMs)) {
      this.windowMaxHits++;
      return cached.value;
    }
    this.windowMaxMisses++;
    const memoryMax = this.maxMidpointInMemory(tokenId, windowMs, nowMs);
    if (memoryMax != null || !this.syncMissLookup) {
      this.rememberWindowMax(cacheKey, String(tokenId), windowMs, nowMs, memoryMax);
      return memoryMax;
    }
    const sinceIso = new Date(nowMs - windowMs).toISOString();
    const untilIso = new Date(nowMs).toISOString();
    const row = this.findWindowMax.get(tokenId, sinceIso, untilIso) as
      | { max_price: number | null }
      | undefined;
    const max = finitePositive(row?.max_price ?? null);
    this.rememberWindowMax(cacheKey, String(tokenId), windowMs, nowMs, max, "database");
    return max;
  }

  midpointStatsInWindow(
    tokenId: TokenId,
    windowMs: number,
    nowMs = Date.now(),
  ): MidpointWindowStats | null {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return null;
    const memoryStats = this.midpointStatsInMemory(tokenId, windowMs, nowMs);
    if (memoryStats && (!this.syncMissLookup || memoryStats.sampleCount >= 2)) return memoryStats;
    if (!this.syncMissLookup) return memoryStats;

    const sinceIso = new Date(nowMs - windowMs).toISOString();
    const untilIso = new Date(nowMs).toISOString();
    const rows = this.findWindowRows.all(tokenId, sinceIso, untilIso) as Array<{
      captured_at: string;
      midpoint: number | null;
    }>;
    const stats = midpointStatsFromSamples(
      rows
        .map((row) => ({ ts: Date.parse(row.captured_at), price: finitePositive(row.midpoint) }))
        .filter(
          (row): row is { ts: number; price: number } =>
            row.price != null && Number.isFinite(row.ts),
        ),
    );
    return stats ?? memoryStats;
  }

  observeMarket(market: NormalizedMarket, observedAtMs = market.snapshotTs): void {
    const price =
      market.midPrice ??
      normalizedSnapshotPrice({
        best_bid: market.bestBid ?? null,
        best_ask: market.bestAsk ?? null,
        last_price: market.lastTradePrice ?? null,
      });
    if (price == null || !Number.isFinite(observedAtMs)) return;

    const tokenKey = String(market.tokenId);
    const samples = this.memorySamplesByToken.get(tokenKey) ?? [];
    const sample = { ts: observedAtMs, price, seq: ++this.nextSampleSeq };
    const orderedAppend = samples.length === 0 || observedAtMs > samples[samples.length - 1]!.ts;
    if (orderedAppend) samples.push(sample);
    else samples.splice(findInsertionIndex(samples, sample), 0, sample);
    this.observedSamples++;
    this.memorySamplesByToken.set(tokenKey, samples);
    if (orderedAppend) this.invalidateCoveredOrDatabaseCache(tokenKey, observedAtMs);
    else this.evictWindowCacheForToken(tokenKey);
    this.pruneTokenSamples(tokenKey, samples, Math.max(observedAtMs, samples.at(-1)!.ts));
  }

  evictToken(tokenId: TokenId): void {
    const tokenKey = String(tokenId);
    const samples = this.memorySamplesByToken.get(tokenKey);
    if (samples) {
      this.evictedTokens++;
      this.evictedSamples += samples.length;
      this.memorySamplesByToken.delete(tokenKey);
    }
    this.evictWindowCacheForToken(tokenKey);
  }

  snapshotMemoryMetrics(nowMs = Date.now()): R23MemoryMetrics {
    this.pruneAllSamples(nowMs);
    const sampleCounts = [...this.memorySamplesByToken.values()]
      .map((samples) => samples.length)
      .sort((a, b) => a - b);
    return {
      tokenCount: sampleCounts.length,
      sampleCount: sampleCounts.reduce((total, count) => total + count, 0),
      samplesPerTokenP50: sampleCounts.length > 0 ? percentile(sampleCounts, 50) : null,
      samplesPerTokenP95: sampleCounts.length > 0 ? percentile(sampleCounts, 95) : null,
      samplesPerTokenMax: sampleCounts.at(-1) ?? null,
      observedSamples: this.observedSamples,
      agePrunedSamples: this.agePrunedSamples,
      capacityPrunedSamples: this.capacityPrunedSamples,
      evictedTokens: this.evictedTokens,
      evictedSamples: this.evictedSamples,
      maxAgeMs: this.memorySampleMaxAgeMs,
      maxSamplesPerToken: this.memorySampleMaxPerToken,
    };
  }

  getWindowMaxCacheMetrics(): WindowMaxCacheMetrics {
    return {
      invocations: this.windowMaxInvocations,
      hits: this.windowMaxHits,
      misses: this.windowMaxMisses,
      hitRate:
        this.windowMaxInvocations > 0 ? this.windowMaxHits / this.windowMaxInvocations : null,
      entries: this.windowMaxCache.size,
      ttlMs: WINDOW_MAX_CACHE_TTL_MS,
      maxEntries: WINDOW_MAX_CACHE_MAX_ENTRIES,
    };
  }

  private rememberWindowMax(
    key: string,
    tokenKey: string,
    windowMs: number,
    computedAtMs: number,
    value: number | null,
    source: WindowMaxCacheEntry["source"] = "memory",
  ): void {
    if (this.windowMaxCache.size >= WINDOW_MAX_CACHE_MAX_ENTRIES) {
      const oldestKey = this.windowMaxCache.keys().next().value;
      if (oldestKey) this.removeWindowMax(oldestKey);
    }
    const backing =
      source === "memory" ? this.findLatestMaxSample(tokenKey, windowMs, computedAtMs) : null;
    this.windowMaxCache.set(key, {
      computedAtMs,
      queryAtMs: computedAtMs,
      value,
      source,
      maxSampleSeq: backing?.seq ?? null,
      maxSampleTs: backing?.ts ?? null,
    });
    const keys = this.windowMaxKeysByToken.get(tokenKey) ?? new Set<string>();
    keys.add(key);
    this.windowMaxKeysByToken.set(tokenKey, keys);
  }

  private refreshMemoryWindowMax(
    cached: WindowMaxCacheEntry,
    tokenId: TokenId,
    windowMs: number,
    nowMs: number,
  ): boolean {
    if (cached.source === "database") {
      return nowMs - cached.computedAtMs < WINDOW_MAX_CACHE_TTL_MS;
    }
    if (
      nowMs < cached.queryAtMs ||
      nowMs - cached.computedAtMs >= WINDOW_MAX_CACHE_TTL_MS ||
      (cached.maxSampleTs != null && cached.maxSampleTs < nowMs - windowMs)
    ) {
      return false;
    }
    const samples = this.memorySamplesByToken.get(String(tokenId)) ?? [];
    const oldestMs = nowMs - windowMs;
    for (let index = firstSampleAfter(samples, cached.queryAtMs); index < samples.length; index++) {
      const sample = samples[index]!;
      if (sample.ts > nowMs) break;
      if (sample.ts < oldestMs) continue;
      if (cached.value == null || sample.price >= cached.value) {
        cached.value = sample.price;
        cached.maxSampleSeq = sample.seq;
        cached.maxSampleTs = sample.ts;
      }
    }
    cached.queryAtMs = nowMs;
    return true;
  }

  private findLatestMaxSample(
    tokenKey: string,
    windowMs: number,
    nowMs: number,
  ): MemorySample | null {
    const samples = this.memorySamplesByToken.get(tokenKey) ?? [];
    let max: MemorySample | null = null;
    for (const sample of samples) {
      if (sample.ts < nowMs - windowMs || sample.ts > nowMs) continue;
      if (max == null || sample.price >= max.price) max = sample;
    }
    return max;
  }

  private findReferencePriceInMemory(
    tokenId: TokenId,
    targetMs: number,
    maxAgeMs: number,
  ): number | null {
    const samples = this.memorySamplesByToken.get(String(tokenId));
    if (!samples) return null;
    const oldestMs = targetMs - maxAgeMs;
    for (let i = samples.length - 1; i >= 0; i--) {
      const sample = samples[i]!;
      if (sample.ts > targetMs) continue;
      if (sample.ts < oldestMs) break;
      return sample.price;
    }
    return null;
  }

  private maxMidpointInMemory(tokenId: TokenId, windowMs: number, nowMs: number): number | null {
    const samples = this.memorySamplesByToken.get(String(tokenId));
    if (!samples) return null;
    const sinceMs = nowMs - windowMs;
    let max: number | null = null;
    for (let i = samples.length - 1; i >= 0; i--) {
      const sample = samples[i]!;
      if (sample.ts < sinceMs) break;
      if (sample.ts > nowMs) continue;
      max = max == null ? sample.price : Math.max(max, sample.price);
    }
    return max;
  }

  private midpointStatsInMemory(
    tokenId: TokenId,
    windowMs: number,
    nowMs: number,
  ): MidpointWindowStats | null {
    const samples = this.memorySamplesByToken.get(String(tokenId));
    if (!samples) return null;
    const sinceMs = nowMs - windowMs;
    return midpointStatsFromSamples(
      samples.filter((sample) => sample.ts >= sinceMs && sample.ts <= nowMs),
    );
  }

  private pruneAllSamples(nowMs: number): void {
    for (const [tokenKey, samples] of this.memorySamplesByToken) {
      this.pruneTokenSamples(tokenKey, samples, Math.max(nowMs, samples.at(-1)?.ts ?? nowMs));
    }
  }

  private pruneSamples(samples: MemorySample[], anchorMs: number): MemorySample[] {
    const oldestMs = anchorMs - this.memorySampleMaxAgeMs;
    let age = 0;
    while (age < samples.length && samples[age]!.ts < oldestMs) {
      age++;
    }
    const capacity = Math.max(0, samples.length - age - this.memorySampleMaxPerToken);
    const deleteCount = age + capacity;
    const removed = deleteCount > 0 ? samples.splice(0, deleteCount) : [];
    this.recordPrunedSamples({ age, capacity });
    return removed;
  }

  private recordPrunedSamples(pruned: { age: number; capacity: number }): void {
    this.agePrunedSamples += pruned.age;
    this.capacityPrunedSamples += pruned.capacity;
  }

  private evictWindowCacheForToken(tokenKey: string): void {
    for (const key of this.windowMaxKeysByToken.get(tokenKey) ?? []) this.removeWindowMax(key);
  }

  private invalidateCoveredOrDatabaseCache(tokenKey: string, observedAtMs: number): void {
    for (const key of this.windowMaxKeysByToken.get(tokenKey) ?? []) {
      const cached = this.windowMaxCache.get(key);
      if (cached?.source === "database" || (cached && observedAtMs <= cached.queryAtMs)) {
        this.removeWindowMax(key);
      }
    }
  }

  private pruneTokenSamples(tokenKey: string, samples: MemorySample[], anchorMs: number): void {
    const removed = this.pruneSamples(samples, anchorMs);
    if (removed.length > 0) {
      const seqs = new Set(removed.map((sample) => sample.seq));
      for (const key of this.windowMaxKeysByToken.get(tokenKey) ?? []) {
        const backingSeq = this.windowMaxCache.get(key)?.maxSampleSeq;
        if (backingSeq != null && seqs.has(backingSeq)) this.removeWindowMax(key);
      }
    }
    if (samples.length === 0) this.memorySamplesByToken.delete(tokenKey);
  }

  private removeWindowMax(key: string): void {
    if (!this.windowMaxCache.delete(key)) return;
    const splitAt = key.lastIndexOf(":");
    const tokenKey = key.slice(0, splitAt);
    const keys = this.windowMaxKeysByToken.get(tokenKey);
    keys?.delete(key);
    if (keys?.size === 0) this.windowMaxKeysByToken.delete(tokenKey);
  }
}

function findInsertionIndex(samples: MemorySample[], inserted: MemorySample): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const sample = samples[mid]!;
    if (sample.ts < inserted.ts || (sample.ts === inserted.ts && sample.seq < inserted.seq)) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function firstSampleAfter(samples: MemorySample[], timestampMs: number): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (samples[mid]!.ts <= timestampMs) low = mid + 1;
    else high = mid;
  }
  return low;
}

function midpointStatsFromSamples(
  samples: Array<{ ts: number; price: number }>,
): MidpointWindowStats | null {
  if (samples.length === 0) return null;
  let minMidpoint = samples[0]!.price;
  let maxMidpoint = samples[0]!.price;
  let minAtMs = samples[0]!.ts;
  let maxAtMs = samples[0]!.ts;
  for (const sample of samples) {
    if (sample.price < minMidpoint) {
      minMidpoint = sample.price;
      minAtMs = sample.ts;
    }
    if (sample.price > maxMidpoint) {
      maxMidpoint = sample.price;
      maxAtMs = sample.ts;
    }
  }
  return {
    minMidpoint,
    maxMidpoint,
    minAtMs,
    maxAtMs,
    firstMidpoint: samples[0]!.price,
    lastMidpoint: samples[samples.length - 1]!.price,
    sampleCount: samples.length,
  };
}

export function normalizedSnapshotPrice(row: {
  best_bid: number | null;
  best_ask: number | null;
  last_price: number | null;
}): number | null {
  const bid = finitePositive(row.best_bid);
  const ask = finitePositive(row.best_ask);
  if (bid != null && ask != null) return (bid + ask) / 2;
  return finitePositive(row.last_price) ?? bid ?? ask;
}

function finitePositive(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
