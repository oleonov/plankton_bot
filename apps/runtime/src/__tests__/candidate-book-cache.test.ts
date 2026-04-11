import { describe, expect, it, vi } from "vitest";
import { createTokenId, type OrderBookSnapshot } from "@plankton/domain";
import {
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
});
