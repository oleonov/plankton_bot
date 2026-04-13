import type { Logger } from "../../logger.js";
import type { NormalizedMarket, OrderBookSnapshot } from "@plankton/domain";

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
  readonly onRefreshObserved?: ((event: CandidateBookRefreshObserved) => void) | undefined;
  readonly onUsageObserved?: ((event: CandidateBookUsageObserved) => void) | undefined;
}

const DEFAULT_MAX_AGE_MS = 3_000;
const DEFAULT_REFRESH_BATCH_WINDOW_MS = 10;
const DEFAULT_REFRESH_BUDGET_PER_WINDOW = 8;
const DEFAULT_REFRESH_BUDGET_WINDOW_MS = 1_000;

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
      resolvers: Array<(resolution: CandidateBookResolution) => void>;
    }
  >();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshWindowStartedAtMs = 0;
  private refreshesInWindow = 0;
  private readonly maxAgeMs: number;
  private readonly refreshBatchWindowMs: number;
  private readonly refreshBudgetPerWindow: number;
  private readonly refreshBudgetWindowMs: number;

  constructor(private readonly deps: CandidateBookCacheDeps) {
    this.maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.refreshBatchWindowMs = deps.refreshBatchWindowMs ?? DEFAULT_REFRESH_BATCH_WINDOW_MS;
    this.refreshBudgetPerWindow = deps.refreshBudgetPerWindow ?? DEFAULT_REFRESH_BUDGET_PER_WINDOW;
    this.refreshBudgetWindowMs = deps.refreshBudgetWindowMs ?? DEFAULT_REFRESH_BUDGET_WINDOW_MS;
  }

  dispose(): void {
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
      this.resolveWaiters(tokenId, entry);
    }

    this.entries = nextMap;
    return nextEntries;
  }

  async getFreshOrRefresh(
    tokenId: string,
    nowMs: number = Date.now(),
  ): Promise<CandidateBookResolution> {
    const fresh = this.getFreshEntry(tokenId, nowMs);
    if (fresh) {
      if (fresh.sourceKind === "ws") {
        this.deps.onUsageObserved?.({ type: "ws-hit", tokenId });
      }
      return { entry: fresh, status: "fresh-cache" };
    }

    const cached = this.getEntry(tokenId);
    const fallbackStatus: CandidateBookResolution["status"] = cached ? "cache-stale" : "cache-miss";
    this.deps.onUsageObserved?.({ type: "rest-fallback", tokenId });
    return this.enqueueRefresh(tokenId, fallbackStatus);
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

  private enqueueRefresh(
    tokenId: string,
    fallbackStatus: "cache-miss" | "cache-stale",
  ): Promise<CandidateBookResolution> {
    return new Promise((resolve) => {
      const pending = this.pendingRefreshes.get(tokenId);
      if (pending) {
        pending.resolvers.push(resolve);
      } else {
        this.pendingRefreshes.set(tokenId, {
          fallbackStatus,
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
        const entry = entries.get(tokenId) ?? this.getFreshEntry(tokenId);
        const resolution: CandidateBookResolution = entry
          ? { entry, status: "refreshed" }
          : { entry: null, status: pending.get(tokenId)?.fallbackStatus ?? "cache-miss" };
        for (const resolve of pending.get(tokenId)?.resolvers ?? []) {
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

export function applyOrderBookToMarket(
  market: NormalizedMarket,
  entry: CandidateBookCacheEntry,
): NormalizedMarket {
  return {
    ...market,
    bestBid: entry.book.bestBid,
    bestAsk: entry.book.bestAsk,
    midPrice: entry.book.midPrice,
    spread: entry.book.spread,
    minOrderSize: entry.book.minOrderSize ?? market.minOrderSize ?? null,
    bookSource: entry.bookSource,
    snapshotTs: entry.snapshotTs,
  };
}
