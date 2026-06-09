import type Database from "better-sqlite3";
import type { NormalizedMarket, TokenId } from "@krabs/domain";

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

const WINDOW_MAX_CACHE_TTL_MS = 60_000;
const WINDOW_MAX_CACHE_MAX_ENTRIES = 10_000;
const DEFAULT_MEMORY_SAMPLE_MAX_AGE_MS = 24 * 60 * 60_000;
const DEFAULT_MEMORY_SAMPLE_MAX_PER_TOKEN = 2_000;

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
  private readonly memorySamplesByToken = new Map<string, Array<{ ts: number; price: number }>>();
  private readonly windowMaxCache = new Map<
    string,
    { computedAtMs: number; value: number | null }
  >();
  private windowMaxInvocations = 0;
  private windowMaxHits = 0;
  private windowMaxMisses = 0;

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
    if (cached && nowMs - cached.computedAtMs < WINDOW_MAX_CACHE_TTL_MS) {
      this.windowMaxHits++;
      return cached.value;
    }
    this.windowMaxMisses++;
    const memoryMax = this.maxMidpointInMemory(tokenId, windowMs, nowMs);
    if (memoryMax != null || !this.syncMissLookup) {
      this.rememberWindowMax(cacheKey, nowMs, memoryMax);
      return memoryMax;
    }
    const sinceIso = new Date(nowMs - windowMs).toISOString();
    const untilIso = new Date(nowMs).toISOString();
    const row = this.findWindowMax.get(tokenId, sinceIso, untilIso) as
      | { max_price: number | null }
      | undefined;
    const max = finitePositive(row?.max_price ?? null);
    this.rememberWindowMax(cacheKey, nowMs, max);
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
    samples.push({ ts: observedAtMs, price });
    this.pruneSamples(samples, observedAtMs);
    this.memorySamplesByToken.set(tokenKey, samples);
    this.evictWindowCacheForToken(tokenKey);
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

  private rememberWindowMax(key: string, computedAtMs: number, value: number | null): void {
    if (this.windowMaxCache.size >= WINDOW_MAX_CACHE_MAX_ENTRIES) {
      const oldestKey = this.windowMaxCache.keys().next().value;
      if (oldestKey) this.windowMaxCache.delete(oldestKey);
    }
    this.windowMaxCache.set(key, { computedAtMs, value });
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

  private pruneSamples(samples: Array<{ ts: number; price: number }>, nowMs: number): void {
    const oldestMs = nowMs - this.memorySampleMaxAgeMs;
    let deleteCount = 0;
    while (deleteCount < samples.length && samples[deleteCount]!.ts < oldestMs) {
      deleteCount++;
    }
    const overflow = Math.max(0, samples.length - deleteCount - this.memorySampleMaxPerToken);
    deleteCount += overflow;
    if (deleteCount > 0) samples.splice(0, deleteCount);
  }

  private evictWindowCacheForToken(tokenKey: string): void {
    const prefix = `${tokenKey}:`;
    for (const key of this.windowMaxCache.keys()) {
      if (key.startsWith(prefix)) this.windowMaxCache.delete(key);
    }
  }
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
