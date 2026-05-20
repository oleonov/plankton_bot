import type { ConditionId, MarketTradeCountProvider } from "@krabs/domain";
import type { Logger } from "../../logger.js";

export interface ContinuationTradeCountCacheOptions {
  readonly provider: MarketTradeCountProvider;
  readonly log: Logger;
  readonly ttlMs?: number;
  readonly negativeTtlMs?: number;
  readonly concurrency?: number;
  readonly maxQueueSize?: number;
  readonly now?: () => number;
}

export interface ContinuationTradeCountCacheStats {
  readonly queued: number;
  readonly inFlight: number;
  readonly hits: number;
  readonly misses: number;
  readonly dropped: number;
}

type CacheEntry = {
  readonly value: number | null;
  readonly expiresAt: number;
};

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 60_000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUE_SIZE = 500;

export class ContinuationTradeCountCache {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly queued = new Map<string, { conditionId: ConditionId; cap: number }>();
  private readonly inFlightKeys = new Set<string>();
  private inFlight = 0;
  private draining = false;
  private hits = 0;
  private misses = 0;
  private dropped = 0;

  constructor(private readonly opts: ContinuationTradeCountCacheOptions) {}

  read(conditionId: ConditionId, cap: number): number | null | undefined {
    const key = cacheKey(conditionId, cap);
    const entry = this.cache.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.cache.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  schedule(conditionIds: readonly ConditionId[], cap: number): void {
    if (conditionIds.length === 0) return;
    const maxQueueSize = this.opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    const missing: ConditionId[] = [];
    for (const conditionId of conditionIds) {
      const key = cacheKey(conditionId, cap);
      if (this.cache.has(key) || this.queued.has(key) || this.inFlightKeys.has(key)) continue;
      if (this.queued.size >= maxQueueSize) {
        this.dropped++;
        continue;
      }
      this.queued.set(key, { conditionId, cap });
      missing.push(conditionId);
    }
    if (missing.length > 0) {
      void this.opts.provider.prefetch?.(missing, cap).catch((err) => {
        this.opts.log.warn({ err }, "continuation trade-count provider prefetch failed");
      });
    }
    this.drain();
  }

  stats(): ContinuationTradeCountCacheStats {
    return {
      queued: this.queued.size,
      inFlight: this.inFlight,
      hits: this.hits,
      misses: this.misses,
      dropped: this.dropped,
    };
  }

  private drainSoon(): void {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      this.drain();
    });
  }

  private drain(): void {
    const concurrency = this.opts.concurrency ?? DEFAULT_CONCURRENCY;
    while (this.inFlight < concurrency && this.queued.size > 0) {
      const next = this.queued.entries().next().value as
        | [string, { conditionId: ConditionId; cap: number }]
        | undefined;
      if (!next) break;
      const [key, job] = next;
      this.queued.delete(key);
      this.fetch(key, job.conditionId, job.cap);
    }
  }

  private fetch(key: string, conditionId: ConditionId, cap: number): void {
    this.inFlight++;
    this.inFlightKeys.add(key);
    void this.opts.provider
      .countTrades(conditionId, cap)
      .then((value) => {
        const ttlMs = value == null ? this.negativeTtlMs() : this.ttlMs();
        this.cache.set(key, {
          value,
          expiresAt: this.now() + ttlMs,
        });
      })
      .catch((err) => {
        this.opts.log.warn(
          { err, conditionId: String(conditionId) },
          "continuation trade-count background refresh failed",
        );
        this.cache.set(key, {
          value: null,
          expiresAt: this.now() + this.negativeTtlMs(),
        });
      })
      .finally(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.inFlightKeys.delete(key);
        if (this.queued.size > 0) this.drainSoon();
      });
  }

  private ttlMs(): number {
    return this.opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  private negativeTtlMs(): number {
    return this.opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}

function cacheKey(conditionId: ConditionId, cap: number): string {
  return `${conditionId}:${cap}`;
}
