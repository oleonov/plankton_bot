import type {
  ConditionId,
  MarketTradeCountProvider,
  PublicTradeCount24hResult,
} from "@krabs/domain";
import type { FetchLike } from "./polymarket-data-api.js";

export const DATA_API_DEFAULT_BASE_URL = "https://data-api.polymarket.com";
export const DATA_API_DEFAULT_CACHE_TTL_MS = 300_000;
// Short negative TTL so a transient data-api outage does not turn every
// algo-decision sweep into a per-token re-fetch wave. 30s is long enough to
// span a full sweep + small margin, short enough that recovery is automatic.
export const DATA_API_DEFAULT_NEGATIVE_CACHE_TTL_MS = 30_000;
// 2s was too tight: under contended event-loop (1000-market normalization +
// CLOB poll) timer callbacks can lag enough that AbortSignal.timeout fires
// well after request start, even when the network round-trip would have
// completed in ≤500ms. 5s gives margin without lifting the per-sweep ceiling.
export const DATA_API_DEFAULT_TIMEOUT_MS = 5_000;
export const DATA_API_DEFAULT_MAX_CACHE_ENTRIES = 10_000;
export const DATA_API_PUBLIC_TRADE_COUNT_24H_CAP = 100;
const PUBLIC_TRADE_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
// Bursting 30+ concurrent fetches on a busy event loop pushed undici DNS/TCP
// callbacks behind the AbortSignal timer. Sequential chunks of 5 keep the
// pool active without piling timer callbacks on top of each other.
export const DATA_API_DEFAULT_PREFETCH_CONCURRENCY = 5;

export interface TradeCountFetchEvent {
  readonly type: "fetch_ok" | "fetch_error" | "cache_hit" | "cache_miss";
  readonly conditionId: ConditionId;
  readonly latencyMs?: number;
  readonly count?: number;
  readonly error?: string;
}

export type TradeCountObserver = (event: TradeCountFetchEvent) => void;

export interface DataApiTradeCountProviderOptions {
  baseUrl?: string;
  cacheTtlMs?: number;
  /**
   * TTL for negative cache entries written when a fetch fails (HTTP non-2xx,
   * non-array payload, network throw). During a data-api outage this prevents
   * algo-decision from re-issuing one fetch per token per sweep. Defaults to
   * {@link DATA_API_DEFAULT_NEGATIVE_CACHE_TTL_MS}.
   */
  negativeCacheTtlMs?: number;
  timeoutMs?: number;
  maxCacheEntries?: number;
  prefetchConcurrency?: number;
  fetchImpl?: FetchLike;
  userAgent?: string;
  observer?: TradeCountObserver;
  now?: () => number;
}

type CacheEntry =
  | { readonly kind: "ok"; readonly count: number; readonly fetchedAtMs: number }
  | { readonly kind: "neg"; readonly fetchedAtMs: number };
type PublicTradeCount24hCacheEntry =
  | {
      readonly kind: "ok";
      readonly result: PublicTradeCount24hResult;
      readonly fetchedAtMs: number;
    }
  | { readonly kind: "neg"; readonly fetchedAtMs: number };
type FetchTradesResult =
  | { readonly ok: true; readonly data: unknown[]; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number };

/**
 * ADR-016 — calls `GET /trades?market=<conditionId>&limit=<cap>` on
 * `data-api.polymarket.com` and returns the row count. The endpoint covers
 * both outcome tokens (Yes + No) under one condition_id, matching the spec
 * definition of `trade_count`.
 *
 * `cap` is always 6 in production (matches R1 threshold). Returning `min(actual, cap)`
 * makes the 3000-row offset cap and any pagination concerns irrelevant.
 *
 * Errors (network, timeout, HTTP non-2xx, parse failure) collapse to `null`
 * so the caller can degrade to ADR-010 D1 (per-leg trade count) without
 * propagating exceptions through the hot path.
 */
export class DataApiTradeCountProvider implements MarketTradeCountProvider {
  private readonly baseUrl: string;
  private readonly cacheTtlMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxCacheEntries: number;
  private readonly prefetchConcurrency: number;
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly observer: TradeCountObserver | null;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly publicTradeCount24hCache = new Map<string, PublicTradeCount24hCacheEntry>();

  constructor(options: DataApiTradeCountProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? DATA_API_DEFAULT_BASE_URL;
    this.cacheTtlMs = options.cacheTtlMs ?? DATA_API_DEFAULT_CACHE_TTL_MS;
    this.negativeCacheTtlMs = options.negativeCacheTtlMs ?? DATA_API_DEFAULT_NEGATIVE_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DATA_API_DEFAULT_TIMEOUT_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DATA_API_DEFAULT_MAX_CACHE_ENTRIES;
    this.prefetchConcurrency = Math.max(
      1,
      options.prefetchConcurrency ?? DATA_API_DEFAULT_PREFETCH_CONCURRENCY,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? "krabs/1.0";
    this.observer = options.observer ?? null;
    this.now = options.now ?? Date.now;
  }

  async countTrades(conditionId: ConditionId, cap: number): Promise<number | null> {
    const cached = this.readCache(conditionId, cap);
    if (cached !== null) {
      if (cached.kind === "neg") {
        this.observer?.({ type: "cache_hit", conditionId });
        return null;
      }
      this.observer?.({ type: "cache_hit", conditionId, count: cached.count });
      return Math.min(cached.count, cap);
    }
    this.observer?.({ type: "cache_miss", conditionId });

    const fetched = await this.fetchTrades(conditionId, cap);
    if (!fetched.ok) {
      this.writeNegativeCache(conditionId, cap);
      this.observer?.({
        type: "fetch_error",
        conditionId,
        latencyMs: fetched.latencyMs,
        error: fetched.error,
      });
      return null;
    }
    const count = Math.min(fetched.data.length, cap);
    this.writeCache(conditionId, cap, count);
    this.observer?.({
      type: "fetch_ok",
      conditionId,
      latencyMs: fetched.latencyMs,
      count,
    });
    return count;
  }

  async fetchPublicTradeCount24h(
    conditionId: ConditionId,
    nowMs: number,
  ): Promise<PublicTradeCount24hResult | null> {
    const cached = this.readPublicTradeCount24hCache(conditionId, nowMs);
    if (cached !== null) {
      if (cached.kind === "neg") return null;
      return cached.result;
    }

    const fetched = await this.fetchTrades(conditionId, DATA_API_PUBLIC_TRADE_COUNT_24H_CAP);
    if (!fetched.ok) {
      this.writePublicTradeCount24hNegativeCache(conditionId, nowMs);
      return null;
    }
    const cutoffMs = nowMs - PUBLIC_TRADE_COUNT_WINDOW_MS;
    let count = 0;
    for (const row of fetched.data) {
      const timestampMs = readTradeTimestampMs(row);
      if (timestampMs == null) continue;
      if (timestampMs < cutoffMs) break;
      count += 1;
      if (count >= DATA_API_PUBLIC_TRADE_COUNT_24H_CAP) break;
    }
    const result: PublicTradeCount24hResult = {
      count,
      capReached: count >= DATA_API_PUBLIC_TRADE_COUNT_24H_CAP,
      fetchedAt: nowMs,
    };
    this.writePublicTradeCount24hCache(conditionId, nowMs, result);
    return result;
  }

  /**
   * Bounded-parallelism prefetch. Issues at most `prefetchConcurrency` fetches
   * in flight at once and resolves only after every conditionId has been
   * processed. Failures do not throw — they surface via the observer. A naive
   * `Promise.all` over 30+ ids saturated the event loop badly enough that the
   * AbortSignal timer fired ~30s late under contended sweeps.
   */
  async prefetch(conditionIds: readonly ConditionId[], cap: number): Promise<void> {
    if (conditionIds.length === 0) return;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < conditionIds.length) {
        const id = conditionIds[cursor++];
        if (id === undefined) return;
        await this.countTrades(id, cap);
      }
    };
    const workers = Math.min(this.prefetchConcurrency, conditionIds.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }

  // Cache key includes `cap` because the upstream response is `min(actual, cap)`:
  // a cap=6 cached value of 6 cannot satisfy a cap=10 lookup (actual could be 7+).
  // Prod always passes cap=6 today, so this is defense-in-depth — but a future
  // tuning that lifts the cap would silently undercount until TTL otherwise.
  private cacheKey(conditionId: ConditionId, cap: number): string {
    return `${conditionId}:${cap}`;
  }

  private readCache(conditionId: ConditionId, cap: number): CacheEntry | null {
    const key = this.cacheKey(conditionId, cap);
    const entry = this.cache.get(key);
    if (!entry) return null;
    const ttl = entry.kind === "ok" ? this.cacheTtlMs : this.negativeCacheTtlMs;
    if (this.now() - entry.fetchedAtMs >= ttl) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  private writeCache(conditionId: ConditionId, cap: number, count: number): void {
    this.evictIfFull();
    this.cache.set(this.cacheKey(conditionId, cap), {
      kind: "ok",
      count,
      fetchedAtMs: this.now(),
    });
  }

  private writeNegativeCache(conditionId: ConditionId, cap: number): void {
    this.evictIfFull();
    this.cache.set(this.cacheKey(conditionId, cap), { kind: "neg", fetchedAtMs: this.now() });
  }

  private async fetchTrades(conditionId: ConditionId, limit: number): Promise<FetchTradesResult> {
    const url = new URL("/trades", this.baseUrl);
    url.searchParams.set("market", conditionId);
    url.searchParams.set("limit", String(limit));

    const startedAt = this.now();
    try {
      const res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: `http_${res.status}`, latencyMs: this.now() - startedAt };
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        return { ok: false, error: "non_array_payload", latencyMs: this.now() - startedAt };
      }
      return { ok: true, data, latencyMs: this.now() - startedAt };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.name : "unknown",
        latencyMs: this.now() - startedAt,
      };
    }
  }

  private publicTradeCount24hCacheKey(conditionId: ConditionId): string {
    return `${conditionId}:public-trade-count-24h:${DATA_API_PUBLIC_TRADE_COUNT_24H_CAP}`;
  }

  private readPublicTradeCount24hCache(
    conditionId: ConditionId,
    nowMs: number,
  ): PublicTradeCount24hCacheEntry | null {
    const key = this.publicTradeCount24hCacheKey(conditionId);
    const entry = this.publicTradeCount24hCache.get(key);
    if (!entry) return null;
    const ttl = entry.kind === "ok" ? this.cacheTtlMs : this.negativeCacheTtlMs;
    if (nowMs - entry.fetchedAtMs >= ttl) {
      this.publicTradeCount24hCache.delete(key);
      return null;
    }
    this.publicTradeCount24hCache.delete(key);
    this.publicTradeCount24hCache.set(key, entry);
    return entry;
  }

  private writePublicTradeCount24hCache(
    conditionId: ConditionId,
    nowMs: number,
    result: PublicTradeCount24hResult,
  ): void {
    this.evictIfFull();
    this.publicTradeCount24hCache.set(this.publicTradeCount24hCacheKey(conditionId), {
      kind: "ok",
      result,
      fetchedAtMs: nowMs,
    });
  }

  private writePublicTradeCount24hNegativeCache(conditionId: ConditionId, nowMs: number): void {
    this.evictIfFull();
    this.publicTradeCount24hCache.set(this.publicTradeCount24hCacheKey(conditionId), {
      kind: "neg",
      fetchedAtMs: nowMs,
    });
  }

  private evictIfFull(): void {
    if (this.cache.size + this.publicTradeCount24hCache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      } else {
        const oldestPublic = this.publicTradeCount24hCache.keys().next().value;
        if (oldestPublic !== undefined) this.publicTradeCount24hCache.delete(oldestPublic);
      }
    }
  }
}

function readTradeTimestampMs(row: unknown): number | null {
  if (row == null || typeof row !== "object") return null;
  const value = row as { timestamp?: unknown; createdAt?: unknown; created_at?: unknown };
  return parseTimestampMs(value.timestamp ?? value.createdAt ?? value.created_at);
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
