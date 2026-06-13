import { describe, expect, it, vi } from "vitest";
import { createTokenId, type OrderBookSnapshot } from "@krabs/domain";
import {
  ExitBookFallbackCache,
  type ExitBookFetcher,
} from "../modules/strategy/exit-book-fallback-cache.js";

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => makeLogger()),
    trace: vi.fn(),
    level: "info",
    silent: vi.fn(),
  } as unknown as import("../logger.js").Logger;
}

function makeBook(tokenId: string, timestamp: number): OrderBookSnapshot {
  return {
    tokenId: createTokenId(tokenId),
    bids: [{ price: 0.04, size: 10 }],
    asks: [{ price: 0.05, size: 10 }],
    bestBid: 0.04,
    bestAsk: 0.05,
    midPrice: 0.045,
    spread: 0.01,
    timestamp,
  };
}

function makeEmptyBook(tokenId: string, timestamp: number): OrderBookSnapshot {
  return {
    tokenId: createTokenId(tokenId),
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    timestamp,
  };
}

const TOKEN = createTokenId("tok-1");

function makeCache(opts: {
  fetcher?: ExitBookFetcher;
  stalenessMs?: number;
  fetchTtlMs?: number;
  maxEntries?: number;
}) {
  return new ExitBookFallbackCache({
    log: makeLogger(),
    fetcher: opts.fetcher,
    stalenessMs: () => opts.stalenessMs ?? 30_000,
    fetchTtlMs: () => opts.fetchTtlMs ?? 20_000,
    maxEntries: opts.maxEntries ?? 256,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
  });
}

describe("ExitBookFallbackCache (Track S5 P0a)", () => {
  it("returns a fresh heartbeat book without calling the fetcher", async () => {
    const fetcher: ExitBookFetcher = { getOrderBook: vi.fn() };
    const cache = makeCache({ fetcher });
    const now = 1_000_000;
    cache.writeHeartbeatBooks(new Map([[String(TOKEN), makeBook(String(TOKEN), now - 5_000)]]));

    const result = await cache.resolve(TOKEN, now);

    expect(result?.source).toBe("heartbeat");
    expect(result?.book.bestBid).toBe(0.04);
    expect(fetcher.getOrderBook).not.toHaveBeenCalled();
  });

  it("falls back to a secondary fetch when the heartbeat book is stale", async () => {
    const fetched = makeBook(String(TOKEN), 2_000_000);
    const fetcher: ExitBookFetcher = { getOrderBook: vi.fn(async () => fetched) };
    const cache = makeCache({ fetcher, stalenessMs: 30_000 });
    const now = 2_000_000;
    // heartbeat 40s old → stale
    cache.writeHeartbeatBooks(new Map([[String(TOKEN), makeBook(String(TOKEN), now - 40_000)]]));

    const result = await cache.resolve(TOKEN, now);

    expect(result?.source).toBe("fetch");
    expect(fetcher.getOrderBook).toHaveBeenCalledTimes(1);
  });

  it("returns null without a fetcher when no fresh heartbeat exists", async () => {
    const cache = makeCache({});
    const result = await cache.resolve(TOKEN, 3_000_000);
    expect(result).toBeNull();
  });

  it("reuses a freshly fetched book within the fetch TTL (no re-fetch)", async () => {
    const fetcher: ExitBookFetcher = {
      getOrderBook: vi.fn(async () => makeBook(String(TOKEN), 4_000_000)),
    };
    const cache = makeCache({ fetcher, fetchTtlMs: 20_000 });
    const now = 4_000_000;

    await cache.resolve(TOKEN, now);
    await cache.resolve(TOKEN, now + 10_000); // within TTL

    expect(fetcher.getOrderBook).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent fetches for the same token (single in-flight)", async () => {
    let resolveFetch: ((b: OrderBookSnapshot) => void) | null = null;
    const fetcher: ExitBookFetcher = {
      getOrderBook: vi.fn(
        () =>
          new Promise<OrderBookSnapshot>((res) => {
            resolveFetch = res;
          }),
      ),
    };
    const cache = makeCache({ fetcher });
    const now = 5_000_000;

    const p1 = cache.resolve(TOKEN, now);
    const p2 = cache.resolve(TOKEN, now);
    resolveFetch!(makeBook(String(TOKEN), now));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(fetcher.getOrderBook).toHaveBeenCalledTimes(1);
    expect(r1?.source).toBe("fetch");
    expect(r2?.source).toBe("fetch");
  });

  it("applies per-token backoff after a fetch failure", async () => {
    const fetcher: ExitBookFetcher = {
      getOrderBook: vi.fn(async () => {
        throw new Error("clob down");
      }),
    };
    const cache = makeCache({ fetcher });
    const now = 6_000_000;

    const first = await cache.resolve(TOKEN, now);
    const second = await cache.resolve(TOKEN, now + 100); // inside backoff window

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetcher.getOrderBook).toHaveBeenCalledTimes(1); // backoff suppressed the retry
  });

  it("treats a fetched book with no bids and no asks as a failure (no fetch fallback)", async () => {
    // MEDIUM 1 — an empty book (gateway returned a shell with no levels) is
    // unusable for a taker exit. The cache must surface it as a failed fetch
    // (null + per-token backoff) so the bridge emits track_r_exit_book_fetch_failed
    // instead of mis-classifying it as a usable fallback book.
    const fetcher: ExitBookFetcher = {
      getOrderBook: vi.fn(async () => makeEmptyBook(String(TOKEN), 8_000_000)),
    };
    const cache = makeCache({ fetcher });
    const now = 8_000_000;

    const first = await cache.resolve(TOKEN, now);
    const second = await cache.resolve(TOKEN, now + 100); // inside backoff window

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetcher.getOrderBook).toHaveBeenCalledTimes(1); // backoff suppressed the retry
  });

  it("evicts the oldest entry when the heartbeat cache exceeds maxEntries", async () => {
    // No fetcher: isolates the LRU bound on the heartbeat cache. An evicted token has no
    // heartbeat entry and no secondary source, so it resolves to null.
    const cache = makeCache({ maxEntries: 2 });
    const now = 7_000_000;
    cache.writeHeartbeatBooks(new Map([["a", makeBook("a", now)]]));
    cache.writeHeartbeatBooks(new Map([["b", makeBook("b", now)]]));
    cache.writeHeartbeatBooks(new Map([["c", makeBook("c", now)]])); // evicts "a"

    expect(await cache.resolve(createTokenId("a"), now)).toBeNull();
    expect((await cache.resolve(createTokenId("b"), now))?.source).toBe("heartbeat");
    expect((await cache.resolve(createTokenId("c"), now))?.source).toBe("heartbeat");
  });
});
