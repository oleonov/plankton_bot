import { describe, expect, it } from "vitest";
import { isLiveBook, type BookContext, type LiveBookVerdict } from "../book-liveness.js";
import { createTokenId } from "../ids.js";

const NOW_MS = Date.parse("2026-06-02T00:00:00Z");
const ASSET_ID = createTokenId("asset-live");

function liveCtx(overrides: Partial<BookContext> = {}): BookContext {
  return {
    assetId: ASSET_ID,
    bestBid: 0.27,
    bestAsk: 0.49,
    spreadRatio: 0.5,
    bidPersistenceS: 2,
    bidMovement30m: 0.01,
    publicTradeCount1h: 2,
    ts: NOW_MS,
    capturedAt: NOW_MS,
    ...overrides,
  };
}

function expectVerdict(result: LiveBookVerdict, verdict: LiveBookVerdict["verdict"]): void {
  expect(result.verdict).toBe(verdict);
}

describe("isLiveBook", () => {
  it("returns LIVE when all Phase 1 signal conditions pass", () => {
    expect(isLiveBook(liveCtx())).toEqual({
      verdict: "live",
      reason: "spread_depth_activity_persistence_ok",
    });
  });

  it("requires branded asset ids at compile time", () => {
    const brandedContext: BookContext = liveCtx({ assetId: ASSET_ID });
    expect(brandedContext.assetId).toBe(ASSET_ID);

    // @ts-expect-error assetId must be TokenId, not a plain string.
    const plainContext: BookContext = { ...brandedContext, assetId: "plain-asset" };
    expect(plainContext.assetId).toBe("plain-asset");
  });

  it("returns DEAD when spread ratio fails", () => {
    expect(isLiveBook(liveCtx({ spreadRatio: 0.6153 }))).toEqual({
      verdict: "dead",
      reason: "wide_spread",
    });
  });

  it("returns DEAD when bid persistence fails", () => {
    expect(isLiveBook(liveCtx({ bidPersistenceS: 35.5 }))).toEqual({
      verdict: "dead",
      reason: "insufficient_bid_persistence",
    });
  });

  it("returns DEAD when both activity sides fail", () => {
    expect(isLiveBook(liveCtx({ bidMovement30m: 0.0014, publicTradeCount1h: 0 }))).toEqual({
      verdict: "dead",
      reason: "insufficient_trade_activity",
    });
  });

  it("keeps activity OR semantics for movement and public trade count", () => {
    expectVerdict(isLiveBook(liveCtx({ bidMovement30m: 0, publicTradeCount1h: 1 })), "live");
    expectVerdict(isLiveBook(liveCtx({ bidMovement30m: 0.0015, publicTradeCount1h: 0 })), "live");
  });

  it("returns UNKNOWN when optional Phase 1 signals are missing", () => {
    expect(isLiveBook(liveCtx({ bidPersistenceS: null }))).toEqual({
      verdict: "unknown",
      reason: "missing_persistence",
    });
    expect(isLiveBook(liveCtx({ bidMovement30m: null, publicTradeCount1h: null }))).toEqual({
      verdict: "unknown",
      reason: "missing_trade_activity",
    });
  });

  it("returns UNKNOWN when captured book data is stale", () => {
    expect(isLiveBook(liveCtx({ capturedAt: NOW_MS - 10 * 60_000 - 1 }))).toEqual({
      verdict: "unknown",
      reason: "stale_book",
    });
  });
});
