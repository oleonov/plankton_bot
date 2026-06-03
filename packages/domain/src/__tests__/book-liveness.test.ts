import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLiveBook, type BookContext, type LiveBookVerdict } from "../book-liveness.js";
import { createTokenId } from "../ids.js";

interface Point1Fixture {
  readonly anchor_ts: number | string;
  readonly asset_id: string;
  readonly expected_verdict: "LIVE" | "DEAD";
  readonly signals: {
    readonly bid_movement_30m: number | null;
    readonly bid_persistence_s: number | null;
    readonly spread_ratio: number | null;
    readonly public_trade_count_1h: number | null;
  };
  readonly best_bid?: number | null;
  readonly best_ask?: number | null;
}

interface Point1Results {
  readonly fixtures: {
    readonly alive_anchors: readonly Point1Fixture[];
    readonly dead_anchors: readonly Point1Fixture[];
    readonly stuck_positions: readonly Point1Fixture[];
  };
}

const NOW_MS = Date.parse("2026-06-02T00:00:00Z");
const ASSET_ID = createTokenId("asset-live");

function loadPoint1Fixtures(): Point1Results {
  const file = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "research_plankton",
    "track_c",
    "point_1_islivebook_results.json",
  );
  return JSON.parse(readFileSync(file, "utf-8")) as Point1Results;
}

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

function fixtureCtx(fixture: Point1Fixture): BookContext {
  const ts =
    typeof fixture.anchor_ts === "number"
      ? fixture.anchor_ts * 1000
      : Date.parse(fixture.anchor_ts);
  return {
    assetId: createTokenId(fixture.asset_id),
    bestBid: fixture.best_bid ?? null,
    bestAsk: fixture.best_ask ?? null,
    spreadRatio: fixture.signals.spread_ratio ?? null,
    bidPersistenceS: fixture.signals.bid_persistence_s ?? null,
    bidMovement30m: fixture.signals.bid_movement_30m ?? null,
    publicTradeCount1h: fixture.signals.public_trade_count_1h ?? null,
    ts,
    capturedAt: ts,
  };
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

  it("classifies point 1 counter-factual alive anchors as LIVE", () => {
    const fixtures = loadPoint1Fixtures().fixtures.alive_anchors;
    expect(fixtures).toHaveLength(20);
    for (const fixture of fixtures) {
      expect(isLiveBook(fixtureCtx(fixture)).verdict).toBe("live");
    }
  });

  it("classifies point 1 counter-factual dead anchors as DEAD", () => {
    const fixtures = loadPoint1Fixtures().fixtures.dead_anchors;
    expect(fixtures).toHaveLength(20);
    for (const fixture of fixtures) {
      expect(isLiveBook(fixtureCtx(fixture)).verdict).toBe("dead");
    }
  });

  it("classifies the 5 known stuck positions as DEAD", () => {
    const fixtures = loadPoint1Fixtures().fixtures.stuck_positions;
    expect(fixtures).toHaveLength(5);
    for (const fixture of fixtures) {
      expect(isLiveBook(fixtureCtx(fixture)).verdict).toBe("dead");
    }
  });
});
