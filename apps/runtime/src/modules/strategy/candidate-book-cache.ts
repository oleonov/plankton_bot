import type { Logger } from "../../logger.js";
import type { NormalizedMarket, OrderBookSnapshot } from "@krabs/domain";
import { deriveExecutableTopOfBook } from "../../executable-price.js";
import { isKnownMinOrderSize } from "../../min-order-size.js";

export interface CandidateBookGateway {
  getOrderBooks(tokenIds: string[]): Promise<Map<string, OrderBookSnapshot>>;
}

export interface CandidateBookRefreshObserved {
  readonly source: "prime" | "bridge-refresh";
  readonly tokenCount: number;
  readonly outcome: "attempted" | "refreshed" | "refresh-budget-exhausted" | "refresh-failed";
  readonly refreshedCount?: number;
  readonly durationMs?: number;
}

export interface CandidateBookUsageObserved {
  readonly type: "ws-hit" | "rest-fallback";
  readonly tokenId: string;
}

export interface CandidateBookCacheEntry {
  readonly tokenId: string;
  readonly snapshotTs: number;
  readonly cachedAtMs: number;
  readonly sourcePolledAtMs: number;
  readonly bookSource: "clob";
  readonly sourceKind: "ws" | "rest";
  readonly book: OrderBookSnapshot;
}

export interface CandidateBookResolution {
  readonly entry: CandidateBookCacheEntry | null;
  readonly status:
    | "fresh-cache"
    | "refreshed"
    | "cache-miss"
    | "cache-stale"
    | "refresh-budget-exhausted"
    | "refresh-failed";
}

interface CandidateBookCacheDeps {
  readonly gateway: CandidateBookGateway;
  readonly log: Logger;
  readonly maxAgeMs?: number;
  readonly refreshBatchWindowMs?: number;
  readonly refreshBudgetPerWindow?: number;
  readonly refreshBudgetWindowMs?: number;
  readonly pruneIntervalMs?: number;
  readonly pruneMaxAgeMs?: number;
  readonly onRefreshObserved?: ((event: CandidateBookRefreshObserved) => void) | undefined;
  readonly onUsageObserved?: ((event: CandidateBookUsageObserved) => void) | undefined;
  /**
   * The REST `/books` payload is the ONLY source of `min_order_size` the runtime
   * sees — the WSS `book` event omits it (0 hits over 115k Observer events), so a
   * WSS-tracked market keeps `minOrderSize: null` forever and every sellable-sizing
   * entry decision on it is skipped. Hand each observed value back so the pricing
   * snapshot can seed it once and keep it sticky.
   */
  readonly onMinOrderSizeObserved?: ((tokenId: string, minOrderSize: number) => void) | undefined;
}

const DEFAULT_MAX_AGE_MS = 3_000;
const DEFAULT_REFRESH_BATCH_WINDOW_MS = 10;
const DEFAULT_REFRESH_BUDGET_PER_WINDOW = 8;
const DEFAULT_REFRESH_BUDGET_WINDOW_MS = 1_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

export class CandidateBookCache {
  private entries = new Map<string, CandidateBookCacheEntry>();
  private readonly waitersByToken = new Map<
    string,
    Array<(entry: CandidateBookCacheEntry | null) => void>
  >();
  private readonly pendingRefreshes = new Map<
    string,
    {
      fallbackStatus: "cache-miss" | "cache-stale";
      force: boolean;
      resolvers: Array<(resolution: CandidateBookResolution) => void>;
    }
  >();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private refreshWindowStartedAtMs = 0;
  private refreshesInWindow = 0;
  private readonly maxAgeMs: number;
  private readonly refreshBatchWindowMs: number;
  private readonly refreshBudgetPerWindow: number;
  private readonly refreshBudgetWindowMs: number;
  private readonly pruneIntervalMs: number;
  private readonly pruneMaxAgeMs: number;

  constructor(private readonly deps: CandidateBookCacheDeps) {
    this.maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.refreshBatchWindowMs = deps.refreshBatchWindowMs ?? DEFAULT_REFRESH_BATCH_WINDOW_MS;
    this.refreshBudgetPerWindow = deps.refreshBudgetPerWindow ?? DEFAULT_REFRESH_BUDGET_PER_WINDOW;
    this.refreshBudgetWindowMs = deps.refreshBudgetWindowMs ?? DEFAULT_REFRESH_BUDGET_WINDOW_MS;
    this.pruneIntervalMs = deps.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.pruneMaxAgeMs = deps.pruneMaxAgeMs ?? this.maxAgeMs * 10;
    this.pruneTimer = setInterval(() => this.pruneStaleEntries(), this.pruneIntervalMs);
    // unref so the timer never holds the Node event loop open during tests/shutdown.
    if (typeof this.pruneTimer.unref === "function") this.pruneTimer.unref();
  }

  dispose(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const pending of this.pendingRefreshes.values()) {
      for (const resolve of pending.resolvers) {
        resolve({ entry: null, status: "refresh-failed" });
      }
    }
    this.pendingRefreshes.clear();
    for (const waiters of this.waitersByToken.values()) {
      for (const waiter of waiters) {
        waiter(null);
      }
    }
    this.waitersByToken.clear();
    // Release retained OrderBookSnapshot references (the historical leak source).
    this.entries.clear();
  }

  /** Exposed for deterministic tests; production just lets the interval fire. */
  pruneStaleEntries(nowMs: number = Date.now()): number {
    if (this.entries.size === 0) return 0;
    let removed = 0;
    for (const [tokenId, entry] of this.entries) {
      if (nowMs - entry.cachedAtMs > this.pruneMaxAgeMs) {
        this.entries.delete(tokenId);
        removed++;
      }
    }
    if (removed > 0) {
      this.deps.log.debug({ removed, remaining: this.entries.size }, "candidate book cache pruned");
    }
    return removed;
  }

  prime(tokenIds: readonly string[]): Promise<Map<string, CandidateBookCacheEntry>> {
    return this.fetchAndStore(tokenIds, "prime");
  }

  getEntry(tokenId: string): CandidateBookCacheEntry | null {
    return this.entries.get(tokenId) ?? null;
  }

  getFreshEntry(tokenId: string, nowMs: number = Date.now()): CandidateBookCacheEntry | null {
    const entry = this.getEntry(tokenId);
    if (!entry) return null;
    if (nowMs - entry.cachedAtMs > this.maxAgeMs) return null;
    return entry;
  }

  async waitForFreshEntry(
    tokenId: string,
    timeoutMs: number,
    nowMs: number = Date.now(),
  ): Promise<CandidateBookCacheEntry | null> {
    const fresh = this.getFreshEntry(tokenId, nowMs);
    if (fresh) return fresh;

    return new Promise((resolve) => {
      let waiterFn: ((entry: CandidateBookCacheEntry | null) => void) | null = null;
      const timer = setTimeout(() => {
        if (!waiterFn) {
          resolve(null);
          return;
        }
        const waiters = this.waitersByToken.get(tokenId) ?? [];
        const remaining = waiters.filter((waiter) => waiter !== waiterFn);
        if (remaining.length === 0) {
          this.waitersByToken.delete(tokenId);
        } else {
          this.waitersByToken.set(tokenId, remaining);
        }
        resolve(null);
      }, timeoutMs);
      waiterFn = (entry) => {
        clearTimeout(timer);
        resolve(entry);
      };
      const waiters = this.waitersByToken.get(tokenId) ?? [];
      waiters.push(waiterFn);
      this.waitersByToken.set(tokenId, waiters);
    });
  }

  upsertBooks(
    books:
      | ReadonlyMap<string, OrderBookSnapshot>
      | ReadonlyArray<readonly [string, OrderBookSnapshot]>,
    sourcePolledAtMs: number = Date.now(),
    sourceKind: "ws" | "rest" = "ws",
  ): Map<string, CandidateBookCacheEntry> {
    const nowMs = Date.now();
    const iterable = books instanceof Map ? books.entries() : books;
    const nextEntries = new Map<string, CandidateBookCacheEntry>();
    const nextMap = new Map(this.entries);

    for (const [tokenId, book] of iterable) {
      const entry: CandidateBookCacheEntry = {
        tokenId,
        snapshotTs: book.timestamp,
        cachedAtMs: nowMs,
        sourcePolledAtMs,
        bookSource: "clob",
        sourceKind,
        book,
      };
      nextEntries.set(tokenId, entry);
      nextMap.set(tokenId, entry);
      this.notifyMinOrderSize(tokenId, book);
      this.resolveWaiters(tokenId, entry);
    }

    this.entries = nextMap;
    return nextEntries;
  }

  async getFreshOrRefresh(
    tokenId: string,
    nowMs: number = Date.now(),
    options?: { readonly requireKnownMinOrderSize?: boolean },
  ): Promise<CandidateBookResolution> {
    const fresh = this.getFreshEntry(tokenId, nowMs);
    // A caller that needs the exchange minimum cannot be served by a book that
    // omits it (every WS book, and any partial REST payload). Letting such an
    // entry short-circuit would skip the one REST refresh that can supply the
    // value, so the unknown-minimum guard would never self-heal.
    if (fresh && (options?.requireKnownMinOrderSize !== true || hasKnownMinOrderSize(fresh))) {
      if (fresh.sourceKind === "ws") {
        this.deps.onUsageObserved?.({ type: "ws-hit", tokenId });
      }
      // The original observation may have been dropped downstream (token not
      // tracked at the time), while the cache kept the value. A caller asking
      // for the minimum is exactly the caller whose suppression depends on it,
      // so re-announce instead of silently serving from cache.
      if (options?.requireKnownMinOrderSize === true) {
        this.notifyMinOrderSize(tokenId, fresh.book);
      }
      return { entry: fresh, status: "fresh-cache" };
    }

    const cached = this.getEntry(tokenId);
    const fallbackStatus: CandidateBookResolution["status"] = cached ? "cache-stale" : "cache-miss";
    this.deps.onUsageObserved?.({ type: "rest-fallback", tokenId });
    const resolution = await this.enqueueRefresh(tokenId, fallbackStatus);
    // A REST payload that still omits the minimum satisfies nothing for this
    // caller; handing it back would read as "requirement met".
    if (
      options?.requireKnownMinOrderSize === true &&
      resolution.entry != null &&
      !hasKnownMinOrderSize(resolution.entry)
    ) {
      return { entry: null, status: fallbackStatus };
    }
    return resolution;
  }

  forceRefresh(tokenId: string): Promise<CandidateBookResolution> {
    const fallbackStatus = this.entries.has(tokenId) ? "cache-stale" : "cache-miss";
    this.deps.onUsageObserved?.({ type: "rest-fallback", tokenId });
    return this.enqueueRefresh(tokenId, fallbackStatus, true);
  }

  private async fetchAndStore(
    tokenIds: readonly string[],
    source: "prime" | "bridge-refresh",
  ): Promise<Map<string, CandidateBookCacheEntry>> {
    const uniqueTokenIds = [...new Set(tokenIds)].filter((tokenId) => tokenId.length > 0);
    if (uniqueTokenIds.length === 0) return new Map();

    this.deps.onRefreshObserved?.({
      source,
      tokenCount: uniqueTokenIds.length,
      outcome: "attempted",
    });
    const startedAtMs = Date.now();
    const sourcePolledAtMs = Date.now();
    const books = await this.deps.gateway.getOrderBooks(uniqueTokenIds);
    const nextEntries = new Map<string, CandidateBookCacheEntry>();
    const nextMap = new Map(this.entries);

    for (const tokenId of uniqueTokenIds) {
      const book = books.get(tokenId);
      if (!book) continue;
      // Two `/books` refreshes for the same token can be open at once: the flush
      // window is 10 ms and `flushQueuedRefreshes` clears `pendingRefreshes`
      // BEFORE awaiting, so a second batch starts while the first is still in
      // flight. Responses may land out of order, and applying the older one
      // regresses the cached book AND re-announces a superseded minimum.
      // Compared against REST polls only: a WS entry is always newer by clock but
      // never carries `min_order_size`, so REST must still enrich it.
      const known = nextMap.get(tokenId);
      if (known?.sourceKind === "rest" && known.sourcePolledAtMs > sourcePolledAtMs) {
        // The newer entry wins for the BOOK — but skipping this response wholesale
        // would drop its `min_order_size` too, and a `/books` payload can omit the
        // field the older response carries. Announcing it here keeps the only known
        // minimum without regressing the cached book: `notifyMinOrderSize` ignores
        // an absent or invalid value, so a min-less older response is still a no-op.
        if (!hasKnownMinOrderSize(known)) this.notifyMinOrderSize(tokenId, book);
        continue;
      }
      const entry: CandidateBookCacheEntry = {
        tokenId,
        snapshotTs: book.timestamp,
        cachedAtMs: Date.now(),
        sourcePolledAtMs,
        bookSource: "clob",
        sourceKind: "rest",
        book,
      };
      nextEntries.set(tokenId, entry);
      nextMap.set(tokenId, entry);
      this.notifyMinOrderSize(tokenId, book);
      this.resolveWaiters(tokenId, entry);
    }

    this.entries = nextMap;
    this.deps.log.debug(
      {
        tokenCount: uniqueTokenIds.length,
        cachedCount: nextEntries.size,
        source,
      },
      "candidate book cache updated",
    );
    this.deps.onRefreshObserved?.({
      source,
      tokenCount: uniqueTokenIds.length,
      outcome: "refreshed",
      refreshedCount: nextEntries.size,
      durationMs: Date.now() - startedAtMs,
    });
    return nextEntries;
  }

  /** Only a REST `/books` payload ever carries `min_order_size`; the WS book omits
   *  it, so an absent/zero value here is the norm and must stay silent. */
  private notifyMinOrderSize(tokenId: string, book: OrderBookSnapshot): void {
    if (!isKnownMinOrderSize(book.minOrderSize)) return;
    this.deps.onMinOrderSizeObserved?.(tokenId, book.minOrderSize);
  }

  private enqueueRefresh(
    tokenId: string,
    fallbackStatus: "cache-miss" | "cache-stale",
    force = false,
  ): Promise<CandidateBookResolution> {
    return new Promise((resolve) => {
      const pending = this.pendingRefreshes.get(tokenId);
      if (pending) {
        pending.force ||= force;
        pending.resolvers.push(resolve);
      } else {
        this.pendingRefreshes.set(tokenId, {
          fallbackStatus,
          force,
          resolvers: [resolve],
        });
      }

      if (this.flushTimer) return;
      this.flushTimer = setTimeout(() => {
        void this.flushQueuedRefreshes();
      }, this.refreshBatchWindowMs);
    });
  }

  private async flushQueuedRefreshes(): Promise<void> {
    const tokenIds = [...this.pendingRefreshes.keys()];
    const pending = new Map(this.pendingRefreshes);
    this.pendingRefreshes.clear();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (tokenIds.length === 0) return;
    if (!this.canSpendRefreshBudget(Date.now())) {
      this.deps.onRefreshObserved?.({
        source: "bridge-refresh",
        tokenCount: tokenIds.length,
        outcome: "refresh-budget-exhausted",
      });
      for (const tokenId of tokenIds) {
        for (const resolve of pending.get(tokenId)?.resolvers ?? []) {
          resolve({ entry: null, status: "refresh-budget-exhausted" });
        }
        this.resolveWaiters(tokenId, null);
      }
      return;
    }

    try {
      const entries = await this.fetchAndStore(tokenIds, "bridge-refresh");
      for (const tokenId of tokenIds) {
        const request = pending.get(tokenId);
        const entry = entries.get(tokenId) ?? (request?.force ? null : this.getFreshEntry(tokenId));
        const resolution: CandidateBookResolution = entry
          ? { entry, status: "refreshed" }
          : { entry: null, status: request?.fallbackStatus ?? "cache-miss" };
        for (const resolve of request?.resolvers ?? []) {
          resolve(resolution);
        }
      }
    } catch (err) {
      this.deps.log.warn({ err, tokenCount: tokenIds.length }, "candidate book refresh failed");
      this.deps.onRefreshObserved?.({
        source: "bridge-refresh",
        tokenCount: tokenIds.length,
        outcome: "refresh-failed",
      });
      for (const tokenId of tokenIds) {
        for (const resolve of pending.get(tokenId)?.resolvers ?? []) {
          resolve({ entry: null, status: "refresh-failed" });
        }
        this.resolveWaiters(tokenId, null);
      }
    }
  }

  private resolveWaiters(tokenId: string, entry: CandidateBookCacheEntry | null): void {
    const waiters = this.waitersByToken.get(tokenId);
    if (!waiters || waiters.length === 0) return;
    this.waitersByToken.delete(tokenId);
    for (const waiter of waiters) {
      waiter(entry);
    }
  }

  private canSpendRefreshBudget(nowMs: number): boolean {
    if (nowMs - this.refreshWindowStartedAtMs >= this.refreshBudgetWindowMs) {
      this.refreshWindowStartedAtMs = nowMs;
      this.refreshesInWindow = 0;
    }
    if (this.refreshesInWindow >= this.refreshBudgetPerWindow) {
      return false;
    }
    this.refreshesInWindow += 1;
    return true;
  }
}

/**
 * Whether a cached book can answer a sellable-floor question. Shared by the
 * cache's own refresh short-circuit and by the bridge's lookup path so the two
 * cannot drift into disagreeing about what counts as a usable hit.
 */
export function hasKnownMinOrderSize(entry: CandidateBookCacheEntry): boolean {
  return isKnownMinOrderSize(entry.book.minOrderSize);
}

export function applyOrderBookToMarket(
  market: NormalizedMarket,
  entry: CandidateBookCacheEntry,
): NormalizedMarket {
  const topOfBook = deriveExecutableTopOfBook(
    {
      bestBid: entry.book.bestBid,
      bestAsk: entry.book.bestAsk,
      bids: entry.book.bids,
      asks: entry.book.asks,
    },
    market.tickSize,
  );
  const bestBid = topOfBook.bestBid ?? market.bestBid;
  const bestAsk = topOfBook.bestAsk ?? market.bestAsk;
  const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : market.midPrice;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : market.spread;

  return {
    ...market,
    bestBid,
    bestAsk,
    bestBidSize: topOfBook.bestBidSize ?? market.bestBidSize ?? null,
    bestAskSize: topOfBook.bestAskSize ?? market.bestAskSize ?? null,
    askDepthExcludingOurs: null,
    midPrice,
    spread,
    minOrderSize: entry.book.minOrderSize ?? market.minOrderSize ?? null,
    bookSource: entry.bookSource,
    snapshotTs: entry.snapshotTs,
  };
}
