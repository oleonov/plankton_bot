import { describe, expect, it, vi } from "vitest";
import { createTokenId, type OrderBookSnapshot } from "@krabs/domain";
import {
  applyOrderBookToMarket,
  CandidateBookCache,
  type CandidateBookGateway,
} from "../modules/strategy/candidate-book-cache.js";

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

function makeBook(tokenId: string, overrides?: Partial<OrderBookSnapshot>): OrderBookSnapshot {
  return {
    tokenId: createTokenId(tokenId),
    bids: [{ price: 0.04, size: 10 }],
    asks: [{ price: 0.05, size: 10 }],
    bestBid: 0.04,
    bestAsk: 0.05,
    midPrice: 0.045,
    spread: 0.01,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("CandidateBookCache", () => {
  it("stores scan-primed books as fresh cache entries", async () => {
    const gateway: CandidateBookGateway = {
      getOrderBooks: vi.fn(async (tokenIds: string[]) => {
        return new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId)]));
      }),
    };

    const cache = new CandidateBookCache({
      gateway,
      log: makeLogger(),
    });

    const entries = await cache.prime(["tok-a", "tok-b"]);

    expect(gateway.getOrderBooks).toHaveBeenCalledTimes(1);
    expect(entries.size).toBe(2);
    expect(cache.getFreshEntry("tok-a")).not.toBeNull();
    expect(cache.getFreshEntry("tok-b")).not.toBeNull();
  });

  it("coalesces concurrent refreshes into a single batched CLOB call", async () => {
    const seenBatches: string[][] = [];
    const gateway: CandidateBookGateway = {
      getOrderBooks: vi.fn(async (tokenIds: string[]) => {
        seenBatches.push([...tokenIds].sort());
        return new Map(tokenIds.map((tokenId) => [tokenId, makeBook(tokenId)]));
      }),
    };

    const cache = new CandidateBookCache({
      gateway,
      log: makeLogger(),
      refreshBatchWindowMs: 1,
      refreshBudgetPerWindow: 1,
    });

    const [a, b] = await Promise.all([
      cache.getFreshOrRefresh("tok-a"),
      cache.getFreshOrRefresh("tok-b"),
    ]);

    expect(gateway.getOrderBooks).toHaveBeenCalledTimes(1);
    expect(seenBatches).toEqual([["tok-a", "tok-b"]]);
    expect(a.status).toBe("refreshed");
    expect(b.status).toBe("refreshed");
    expect(cache.getFreshEntry("tok-a")).not.toBeNull();
    expect(cache.getFreshEntry("tok-b")).not.toBeNull();
  });

  it("reports refresh attempts and failures through the observer hook", async () => {
    const observed: string[] = [];
    const cache = new CandidateBookCache({
      gateway: {
        getOrderBooks: vi.fn(async () => {
          throw new Error("timeout");
        }),
      },
      log: makeLogger(),
      refreshBatchWindowMs: 1,
      onRefreshObserved: (event) => {
        observed.push(`${event.source}:${event.outcome}:${event.tokenCount}`);
      },
    });

    const resolution = await cache.getFreshOrRefresh("tok-a");

    expect(resolution.status).toBe("refresh-failed");
    expect(observed).toContain("bridge-refresh:attempted:1");
    expect(observed).toContain("bridge-refresh:refresh-failed:1");
  });

  it("reports ws cache hits when a fresh stream-backed entry is reused", async () => {
    const observed: string[] = [];
    const cache = new CandidateBookCache({
      gateway: {
        getOrderBooks: vi.fn(async () => new Map()),
      },
      log: makeLogger(),
      onUsageObserved: (event) => {
        observed.push(`${event.type}:${event.tokenId}`);
      },
    });

    cache.upsertBooks(new Map([["tok-a", makeBook("tok-a")]]), Date.now(), "ws");
    const resolution = await cache.getFreshOrRefresh("tok-a");

    expect(resolution.status).toBe("fresh-cache");
    expect(observed).toEqual(["ws-hit:tok-a"]);
  });

  it("waits briefly for a fresh stream-backed book before timing out", async () => {
    vi.useFakeTimers();
    try {
      const cache = new CandidateBookCache({
        gateway: {
          getOrderBooks: vi.fn(async () => new Map()),
        },
        log: makeLogger(),
      });

      const waitPromise = cache.waitForFreshEntry("tok-a", 1_000);
      await vi.advanceTimersByTimeAsync(50);
      cache.upsertBooks(new Map([["tok-a", makeBook("tok-a")]]), Date.now(), "ws");

      const entry = await waitPromise;
      expect(entry?.tokenId).toBe("tok-a");
      expect(entry?.sourceKind).toBe("ws");
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the base executable book when a fresher top-of-book is non-executable", () => {
    const market = {
      tokenId: createTokenId("tok-a"),
      conditionId: "cond-a",
      slug: "market-a",
      eventSlug: null,
      eventMarketCount: 1,
      question: "Question",
      outcome: "YES",
      outcomeIndex: 0,
      regime: "price-range",
      horizon: "daily",
      endDate: null,
      active: true,
      tradable: true,
      tickSize: 0.01,
      negRisk: false,
      gammaCreatedAt: null,
      acceptingOrders: true,
      enableOrderBook: true,
      bestBid: 0.04,
      bestAsk: 0.05,
      midPrice: 0.045,
      spread: 0.01,
      snapshotTs: 1,
      bookSource: "gamma",
    } as const;
    const next = applyOrderBookToMarket(market, {
      tokenId: "tok-a",
      snapshotTs: 2,
      cachedAtMs: 2,
      sourcePolledAtMs: 2,
      bookSource: "clob",
      sourceKind: "ws",
      book: makeBook("tok-a", {
        bestBid: null,
        bestAsk: 0.001,
        midPrice: null,
        spread: null,
      }),
    });

    expect(next.bestBid).toBe(0.04);
    expect(next.bestAsk).toBe(0.05);
    expect(next.midPrice).toBe(0.045);
    expect(next.spread).toBeCloseTo(0.01);
    expect(next.bookSource).toBe("clob");
    expect(next.snapshotTs).toBe(2);
  });

  it("uses the first deeper executable levels when the raw top-of-book is invalid", () => {
    const market = {
      tokenId: createTokenId("tok-a"),
      conditionId: "cond-a",
      slug: "market-a",
      eventSlug: null,
      eventMarketCount: 1,
      question: "Question",
      outcome: "YES",
      outcomeIndex: 0,
      regime: "price-range",
      horizon: "daily",
      endDate: null,
      active: true,
      tradable: true,
      tickSize: 0.001,
      negRisk: false,
      gammaCreatedAt: null,
      acceptingOrders: true,
      enableOrderBook: true,
      bestBid: 0.1,
      bestAsk: 0.9,
      midPrice: 0.5,
      spread: 0.8,
      snapshotTs: 1,
      bookSource: "gamma",
    } as const;
    const next = applyOrderBookToMarket(market, {
      tokenId: "tok-a",
      snapshotTs: 2,
      cachedAtMs: 2,
      sourcePolledAtMs: 2,
      bookSource: "clob",
      sourceKind: "ws",
      book: makeBook("tok-a", {
        bids: [
          { price: 0.0005, size: 10 },
          { price: 0.001, size: 9 },
        ],
        asks: [
          { price: 1, size: 10 },
          { price: 0.999, size: 9 },
        ],
        bestBid: 0.0005,
        bestAsk: 1,
        midPrice: 0.50025,
        spread: 0.9995,
      }),
    });

    expect(next.bestBid).toBe(0.001);
    expect(next.bestAsk).toBe(0.999);
    expect(next.midPrice).toBe(0.5);
    expect(next.spread).toBe(0.998);
    expect(next.bookSource).toBe("clob");
  });
});
