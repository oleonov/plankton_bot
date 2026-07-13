/**
 * AuthoritativeTickResolver unit tests.
 *
 * Covers Phase 1 requirements:
 *  - 0.01 market returns 0.01 (authoritative CLOB value).
 *  - Legit 0.001 market returns 0.001 (backward compat — never hardcodes 0.01).
 *  - Full precedence chain (plan D1):
 *      CLOB /markets minimum_tick_size
 *      → persistedTickSize (markets.tick_size)
 *      → /tick-size endpoint (getTickSize, constrained last-resort)
 *      → 0.01 (absolute fallback)
 *  - Lookup failure at each step falls through — never blocks the order.
 *  - getTickSize is skipped when persistedTick is available (truly last-resort).
 *  - Cache TTL: a second call within TTL returns the cached value without re-fetching.
 *  - Cache miss after TTL triggers a re-fetch.
 *  - invalidate() forces the next resolve() to re-fetch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AuthoritativeTickResolver } from "../modules/execution/authoritative-tick-resolver.js";
import type { ClobMarket, TokenId } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

const TOKEN_ID = createTokenId("tok-yes");

function makeMarket(tickSize: number): ClobMarket {
  return {
    conditionId: "cond-1",
    tokens: [],
    question: "Q?",
    slug: "test-slug",
    endDate: "2026-12-31",
    active: true,
    negRisk: false,
    tickSize,
    volume24h: null,
    eventMarketCount: 1,
    gammaCreatedAt: null,
  };
}

describe("AuthoritativeTickResolver", () => {
  let getMarket: ReturnType<typeof vi.fn>;
  let getTickSize: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getMarket = vi.fn();
    getTickSize = vi.fn();
  });

  // ─── Step 1: authoritative CLOB via getMarket ──────────────────────────

  it("returns the authoritative CLOB tick (0.01) for a market that disagrees with Gamma", async () => {
    getMarket.mockResolvedValue(makeMarket(0.01));
    const resolver = new AuthoritativeTickResolver({ getMarket });
    const tick = await resolver.resolve("cond-1", 0.001, TOKEN_ID);
    expect(tick).toBe(0.01);
    expect(getMarket).toHaveBeenCalledWith("cond-1");
  });

  it("returns 0.001 for a legit 0.001 market — never hardcodes 0.01", async () => {
    getMarket.mockResolvedValue(makeMarket(0.001));
    const resolver = new AuthoritativeTickResolver({ getMarket });
    const tick = await resolver.resolve("cond-1", 0.001, TOKEN_ID);
    expect(tick).toBe(0.001);
  });

  // ─── Step 2: persistedTickSize fallback ───────────────────────────────

  it("falls through to persistedTickSize when getMarket returns null", async () => {
    getMarket.mockResolvedValue(null);
    const resolver = new AuthoritativeTickResolver({ getMarket, getTickSize });
    const tick = await resolver.resolve("cond-1", 0.005, TOKEN_ID);
    expect(tick).toBe(0.005);
    // getTickSize must NOT be called when persistedTick is valid (it's truly last-resort)
    expect(getTickSize).not.toHaveBeenCalled();
  });

  it("falls through to persistedTickSize when getMarket throws", async () => {
    getMarket.mockRejectedValue(new Error("network error"));
    const resolver = new AuthoritativeTickResolver({ getMarket, getTickSize });
    const tick = await resolver.resolve("cond-1", 0.01, TOKEN_ID);
    expect(tick).toBe(0.01);
    expect(getTickSize).not.toHaveBeenCalled();
  });

  // ─── Step 3: /tick-size last-resort ──────────────────────────────────

  it("falls through to getTickSize when getMarket fails and persistedTick is invalid", async () => {
    getMarket.mockResolvedValue(null);
    getTickSize.mockResolvedValue(0.01);
    const resolver = new AuthoritativeTickResolver({ getMarket, getTickSize });
    // persistedTick = 0 (invalid)
    const tick = await resolver.resolve("cond-1", 0, TOKEN_ID);
    expect(tick).toBe(0.01);
    expect(getTickSize).toHaveBeenCalledWith(TOKEN_ID);
  });

  it("getTickSize receives the tokenId passed to resolve()", async () => {
    getMarket.mockResolvedValue(null);
    getTickSize.mockResolvedValue(0.001);
    const resolver = new AuthoritativeTickResolver({ getMarket, getTickSize });
    const myToken = createTokenId("my-special-token") as TokenId;
    await resolver.resolve("cond-x", 0, myToken);
    expect(getTickSize).toHaveBeenCalledWith(myToken);
  });

  it("falls to 0.01 when getMarket, persistedTick, AND getTickSize all fail", async () => {
    getMarket.mockRejectedValue(new Error("down"));
    getTickSize.mockRejectedValue(new Error("also down"));
    const resolver = new AuthoritativeTickResolver({ getMarket, getTickSize });
    const tick = await resolver.resolve("cond-1", 0, TOKEN_ID);
    expect(tick).toBe(0.01);
  });

  it("falls to 0.01 when getMarket returns invalid tick, persistedTick is 0, and no getTickSize provided", async () => {
    getMarket.mockResolvedValue(makeMarket(NaN));
    const resolver = new AuthoritativeTickResolver({ getMarket });
    const tick = await resolver.resolve("cond-1", 0, TOKEN_ID);
    expect(tick).toBe(0.01);
  });

  it("skips getTickSize when tokenId is not passed (falls straight to 0.01)", async () => {
    getMarket.mockResolvedValue(null);
    getTickSize.mockResolvedValue(0.01);
    const resolver = new AuthoritativeTickResolver({ getMarket, getTickSize });
    // No tokenId → getTickSize step is skipped
    const tick = await resolver.resolve("cond-1", 0);
    expect(tick).toBe(0.01);
    expect(getTickSize).not.toHaveBeenCalled();
  });

  // ─── Caching ──────────────────────────────────────────────────────────

  it("caches the result: second resolve within TTL does not call getMarket again", async () => {
    getMarket.mockResolvedValue(makeMarket(0.01));
    const resolver = new AuthoritativeTickResolver({ getMarket, ttlMs: 60_000 });
    await resolver.resolve("cond-1", 0.001, TOKEN_ID);
    await resolver.resolve("cond-1", 0.001, TOKEN_ID);
    expect(getMarket).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache TTL expires", async () => {
    getMarket.mockResolvedValue(makeMarket(0.01));
    const resolver = new AuthoritativeTickResolver({ getMarket, ttlMs: 10 }); // 10 ms TTL
    await resolver.resolve("cond-1", 0.001, TOKEN_ID);
    await new Promise((r) => setTimeout(r, 20));
    await resolver.resolve("cond-1", 0.001, TOKEN_ID);
    expect(getMarket).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces a re-fetch on the next resolve call", async () => {
    getMarket.mockResolvedValue(makeMarket(0.01));
    const resolver = new AuthoritativeTickResolver({ getMarket, ttlMs: 60_000 });
    await resolver.resolve("cond-1", 0.001, TOKEN_ID);
    resolver.invalidate("cond-1");
    await resolver.resolve("cond-1", 0.001, TOKEN_ID);
    expect(getMarket).toHaveBeenCalledTimes(2);
  });

  it("does not cross-contaminate results across different conditionIds", async () => {
    getMarket.mockImplementation((id: string) =>
      Promise.resolve(makeMarket(id === "cond-a" ? 0.001 : 0.01)),
    );
    const resolver = new AuthoritativeTickResolver({ getMarket });
    const tickA = await resolver.resolve("cond-a", 0.001, TOKEN_ID);
    const tickB = await resolver.resolve("cond-b", 0.001, TOKEN_ID);
    expect(tickA).toBe(0.001);
    expect(tickB).toBe(0.01);
  });
});
