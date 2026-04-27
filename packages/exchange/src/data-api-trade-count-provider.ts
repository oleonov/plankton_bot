import type { ConditionId, MarketTradeCountProvider } from "@plankton/domain";
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

  constructor(options: DataApiTradeCountProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? DATA_API_DEFAULT_BASE_URL;
    this.cacheTtlMs = options.cacheTtlMs ?? DATA_API_DEFAULT_CACHE_TTL_MS;
    this.negativeCacheTtlMs =
      options.negativeCacheTtlMs ?? DATA_API_DEFAULT_NEGATIVE_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DATA_API_DEFAULT_TIMEOUT_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DATA_API_DEFAULT_MAX_CACHE_ENTRIES;
    this.prefetchConcurrency = Math.max(
      1,
      options.prefetchConcurrency ?? DATA_API_DEFAULT_PREFETCH_CONCURRENCY,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? "poly-plankton/1.0";
    this.observer = options.observer ?? null;
    this.now = options.now ?? Date.now;
  }

  async countTrades(conditionId: ConditionId, cap: number): Promise<number | null> {
    const cached = this.readCache(conditionId);
    if (cached !== null) {
      if (cached.kind === "neg") {
        this.observer?.({ type: "cache_hit", conditionId });
        return null;
      }
      this.observer?.({ type: "cache_hit", conditionId, count: cached.count });
      return Math.min(cached.count, cap);
    }
    this.observer?.({ type: "cache_miss", conditionId });

    const url = new URL("/trades", this.baseUrl);
    url.searchParams.set("market", conditionId);
    url.searchParams.set("limit", String(cap));

    const startedAt = this.now();
    try {
      const res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        this.writeNegativeCache(conditionId);
        this.observer?.({
          type: "fetch_error",
          conditionId,
          latencyMs: this.now() - startedAt,
          error: `http_${res.status}`,
        });
        return null;
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        this.writeNegativeCache(conditionId);
        this.observer?.({
          type: "fetch_error",
          conditionId,
          latencyMs: this.now() - startedAt,
          error: "non_array_payload",
        });
        return null;
      }
      const count = Math.min(data.length, cap);
      this.writeCache(conditionId, count);
      this.observer?.({
        type: "fetch_ok",
        conditionId,
        latencyMs: this.now() - startedAt,
        count,
      });
      return count;
    } catch (err) {
      this.writeNegativeCache(conditionId);
      this.observer?.({
        type: "fetch_error",
        conditionId,
        latencyMs: this.now() - startedAt,
        error: err instanceof Error ? err.name : "unknown",
      });
      return null;
    }
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

  private readCache(conditionId: ConditionId): CacheEntry | null {
    const entry = this.cache.get(conditionId);
    if (!entry) return null;
    const ttl = entry.kind === "ok" ? this.cacheTtlMs : this.negativeCacheTtlMs;
    if (this.now() - entry.fetchedAtMs >= ttl) {
      this.cache.delete(conditionId);
      return null;
    }
    this.cache.delete(conditionId);
    this.cache.set(conditionId, entry);
    return entry;
  }

  private writeCache(conditionId: ConditionId, count: number): void {
    this.evictIfFull();
    this.cache.set(conditionId, { kind: "ok", count, fetchedAtMs: this.now() });
  }

  private writeNegativeCache(conditionId: ConditionId): void {
    this.evictIfFull();
    this.cache.set(conditionId, { kind: "neg", fetchedAtMs: this.now() });
  }

  private evictIfFull(): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}
