import type { OrderBookSnapshot, TokenId } from "@krabs/domain";
import type { Logger } from "../../logger.js";

/**
 * Secondary order-book source for the exit path. Implemented by the exchange market-data gateway
 * (`getOrderBook`). Returns null when the book is unavailable so the cache can fall through to a
 * graceful `missing_book` block instead of throwing.
 */
export interface ExitBookFetcher {
  getOrderBook(tokenId: TokenId): Promise<OrderBookSnapshot | null>;
}

export type ExitBookSource = "heartbeat" | "fetch";

export interface ExitBookResolution {
  book: OrderBookSnapshot;
  source: ExitBookSource;
}

export interface ExitBookFallbackCacheDeps {
  log: Logger;
  /** Secondary source for cold-miss / stale-primary / overflow tokens. Omitted in primary-only setups. */
  fetcher?: ExitBookFetcher | undefined;
  /** A heartbeat book older than this (now − book.timestamp) is stale → secondary fetch. */
  stalenessMs: () => number;
  /** A freshly fetched book is reused for this long before re-fetching. Short (15-30s); thin books move fast. */
  fetchTtlMs: () => number;
  /** Bounded LRU size for the heartbeat and fetch caches. */
  maxEntries?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

interface FetchCacheEntry {
  book: OrderBookSnapshot;
  fetchedAtMs: number;
}

interface BackoffEntry {
  failures: number;
  nextEligibleMs: number;
}

/**
 * Track S5 P0a — exit-path book fallback.
 *
 * The taker exit path reads only the candidate book cache; held-position books already exist (WS-fed,
 * published via MarketSnapshotHeartbeat) but were never wired in, so a candidate miss became a hard
 * `missing_book` block. This cache bridges the gap:
 *
 *   PRIMARY   passive heartbeat cache — books written from MarketSnapshotHeartbeat (no decision trigger);
 *             freshness gated on `now − book.timestamp ≤ stalenessMs` (book.timestamp, NOT updatedAt).
 *   SECONDARY direct gateway fetch for cold-miss / stale-primary / overflow tokens, with a short TTL,
 *             in-flight dedupe (one fetch per token), per-token exponential backoff, and a bounded LRU.
 *
 * Decoupled from the bridge for unit-testability; the bridge owns the candidate-cache check and the
 * counters, and only consults this cache on a candidate miss.
 */
export class ExitBookFallbackCache {
  private readonly log: Logger;
  private readonly fetcher?: ExitBookFetcher | undefined;
  private readonly stalenessMs: () => number;
  private readonly fetchTtlMs: () => number;
  private readonly maxEntries: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  private readonly heartbeatBooks = new Map<string, OrderBookSnapshot>();
  private readonly fetchCache = new Map<string, FetchCacheEntry>();
  private readonly inFlight = new Map<string, Promise<OrderBookSnapshot | null>>();
  private readonly backoff = new Map<string, BackoffEntry>();

  constructor(deps: ExitBookFallbackCacheDeps) {
    this.log = deps.log;
    this.fetcher = deps.fetcher;
    this.stalenessMs = deps.stalenessMs;
    this.fetchTtlMs = deps.fetchTtlMs;
    this.maxEntries = Math.max(1, deps.maxEntries ?? 256);
    this.backoffBaseMs = Math.max(1, deps.backoffBaseMs ?? 1_000);
    this.backoffMaxMs = Math.max(this.backoffBaseMs, deps.backoffMaxMs ?? 60_000);
  }

  /** Passive write of the heartbeat `booksByToken` map. Never triggers a decision cascade. */
  writeHeartbeatBooks(books: ReadonlyMap<string, OrderBookSnapshot>): void {
    for (const [token, book] of books) {
      this.heartbeatBooks.delete(token); // re-insert to mark most-recently-written
      this.heartbeatBooks.set(token, book);
    }
    this.evictLru(this.heartbeatBooks);
  }

  async resolve(tokenId: TokenId, nowMs: number): Promise<ExitBookResolution | null> {
    const key = String(tokenId);
    const heartbeat = this.heartbeatBooks.get(key);
    if (heartbeat && nowMs - heartbeat.timestamp <= this.stalenessMs()) {
      return { book: heartbeat, source: "heartbeat" };
    }
    const fetched = await this.secondaryFetch(tokenId, key, nowMs);
    return fetched ? { book: fetched, source: "fetch" } : null;
  }

  private async secondaryFetch(
    tokenId: TokenId,
    key: string,
    nowMs: number,
  ): Promise<OrderBookSnapshot | null> {
    if (!this.fetcher) return null;
    const cached = this.fetchCache.get(key);
    if (cached && nowMs - cached.fetchedAtMs <= this.fetchTtlMs()) return cached.book;
    const backoff = this.backoff.get(key);
    if (backoff && nowMs < backoff.nextEligibleMs) return null;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = this.runFetch(tokenId, key, nowMs);
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async runFetch(
    tokenId: TokenId,
    key: string,
    nowMs: number,
  ): Promise<OrderBookSnapshot | null> {
    try {
      const book = await this.fetcher!.getOrderBook(tokenId);
      // A null book or an empty shell (no bids and no asks) is unusable for a
      // taker exit — treat both as a fetch failure so the bridge blocks via
      // track_r_exit_book_fetch_failed instead of pricing off a hollow book.
      if (!book || (book.bids.length === 0 && book.asks.length === 0)) {
        this.registerFailure(key, nowMs);
        return null;
      }
      this.backoff.delete(key);
      this.fetchCache.set(key, { book, fetchedAtMs: nowMs });
      this.evictLru(this.fetchCache);
      return book;
    } catch (err) {
      this.log.warn({ err, tokenId: key }, "exit-book secondary fetch failed");
      this.registerFailure(key, nowMs);
      return null;
    }
  }

  private registerFailure(key: string, nowMs: number): void {
    const failures = (this.backoff.get(key)?.failures ?? 0) + 1;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (failures - 1));
    this.backoff.set(key, { failures, nextEligibleMs: nowMs + delay });
  }

  private evictLru(map: Map<string, unknown>): void {
    while (map.size > this.maxEntries) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
