import type Database from "better-sqlite3";
import type { TokenId } from "@krabs/domain";

export interface PriceHistoryProvider {
  findReferencePrice(tokenId: TokenId, targetMs: number, maxAgeMs: number): number | null;
  maxMidpointInWindow?(tokenId: TokenId, windowMs: number, nowMs?: number): number | null;
  getWindowMaxCacheMetrics?(): WindowMaxCacheMetrics;
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

export class MarketSnapshotPriceHistoryProvider implements PriceHistoryProvider {
  private readonly findReference;
  private readonly findWindowMax;
  private readonly windowMaxCache = new Map<
    string,
    { computedAtMs: number; value: number | null }
  >();
  private windowMaxInvocations = 0;
  private windowMaxHits = 0;
  private windowMaxMisses = 0;

  constructor(db: Database.Database) {
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
  }

  findReferencePrice(tokenId: TokenId, targetMs: number, maxAgeMs: number): number | null {
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
    const sinceIso = new Date(nowMs - windowMs).toISOString();
    const untilIso = new Date(nowMs).toISOString();
    const row = this.findWindowMax.get(tokenId, sinceIso, untilIso) as
      | { max_price: number | null }
      | undefined;
    const max = finitePositive(row?.max_price ?? null);
    this.rememberWindowMax(cacheKey, nowMs, max);
    return max;
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
