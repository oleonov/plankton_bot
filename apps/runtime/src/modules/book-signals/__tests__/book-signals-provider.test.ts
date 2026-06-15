import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { createTokenId } from "@krabs/domain";
import {
  computeBidMovement30m,
  computeBidPersistenceS,
  computeDepthTop3,
  computePublicTradeCount1h,
  DEFAULT_MAX_ENTRIES_PER_BUFFER,
  TrackCBookSignalsProvider,
} from "../book-signals-provider.js";

const tokenId = createTokenId("token-a");

describe("TrackCBookSignalsProvider formulas", () => {
  it("computes bidPersistenceS from the oldest contiguous same-bid state, not hardcoded warmup 1800", () => {
    const anchor = 10_000_000;
    const states = [
      { ts: anchor - 900_000, bestBid: 0.42 },
      { ts: anchor - 600_000, bestBid: 0.42 },
      { ts: anchor - 1_000, bestBid: 0.42 },
    ];

    expect(computeBidPersistenceS(states, anchor)).toBe(900);
  });

  it("breaks bidPersistenceS on missing or changed bid using 1e-12 tolerance", () => {
    const anchor = 10_000_000;
    const states = [
      { ts: anchor - 20_000, bestBid: 0.400000000002 },
      { ts: anchor - 10_000, bestBid: 0.4000000000005 },
      { ts: anchor - 1_000, bestBid: 0.4000000000004 },
    ];

    expect(computeBidPersistenceS(states, anchor)).toBe(10);
  });

  it("computes bidMovement30m as max-min over parsable states", () => {
    const anchor = 10_000_000;
    expect(
      computeBidMovement30m(
        [
          { ts: anchor - 1_700_000, bestBid: 0.31 },
          { ts: anchor - 900_000, bestBid: null },
          { ts: anchor - 300_000, bestBid: 0.36 },
          { ts: anchor - 1_000, bestBid: 0.32 },
        ],
        anchor,
      ),
    ).toBeCloseTo(0.05, 12);
  });

  it("skips null bid states but keeps zero bids for movement and persistence", () => {
    const provider = new TrackCBookSignalsProvider();
    const anchor = 10_000_000;
    provider.setOpenPositionTokenIds([tokenId]);
    provider.ingestTopOfBook({ tokenId, ts: anchor - 20_000, bestBid: 0.11, bestAsk: 0.12 });
    provider.ingestTopOfBook({ tokenId, ts: anchor - 10_000, bestBid: 0, bestAsk: 0.02 });
    provider.ingestTopOfBook({ tokenId, ts: anchor - 5_000, bestBid: null, bestAsk: 0.02 });

    expect(provider.getBookSignals(tokenId, anchor)).toMatchObject({
      bidPersistenceS: 10,
      bidMovement30m: 0.11,
    });
  });

  it("counts public trades in [anchor-3600, anchor) with exclusive upper bound", () => {
    const anchor = 10_000_000;
    expect(
      computePublicTradeCount1h(
        [anchor - 3_600_000, anchor - 1_000, anchor, anchor + 1_000],
        anchor,
      ),
    ).toBe(2);
  });

  it("computes latest non-null depthTop3 within 30 minutes", () => {
    const anchor = 10_000_000;
    expect(
      computeDepthTop3(
        [
          { ts: anchor - 2_000_000, depthTop3: 999 },
          { ts: anchor - 1_000_000, depthTop3: 25 },
          { ts: anchor - 10_000, depthTop3: null },
        ],
        anchor,
      ),
    ).toBe(25);
  });

  it("matches observer compensated sum for depthTop3", () => {
    expect(
      computeDepthTop3(
        [{ ts: 10_000_000, depthTop3: computeDepthValueForTest([40.71, 100, 30.05]) }],
        10_000_000,
      ),
    ).toBe(170.76);
  });

  it("returns synchronous provider signals from in-memory state", () => {
    const provider = new TrackCBookSignalsProvider();
    const anchor = 10_000_000;
    provider.setOpenPositionTokenIds([tokenId]);
    provider.ingestTopOfBook({ tokenId, ts: anchor - 2_000, bestBid: 0.4, bestAsk: 0.45 });
    provider.ingestTopOfBook({ tokenId, ts: anchor - 1_000, bestBid: 0.41, bestAsk: 0.45 });
    provider.ingestLastTradePrice({ tokenId, ts: anchor - 500, price: 0.42 });
    provider.ingestBook({
      tokenId,
      ts: anchor - 400,
      bids: [
        { price: 0.4, size: 10 },
        { price: 0.39, size: 20 },
        { price: 0.38, size: 30 },
        { price: 0.37, size: 40 },
      ],
    });

    expect(provider.getBookSignals(tokenId, anchor)).toEqual({
      bidPersistenceS: 1,
      bidMovement30m: 0.009999999999999953,
      publicTradeCount1h: 1,
      depthTop3: 60,
    });
  });

  it("keeps high-rate ingest buffers bounded by configured max entries", () => {
    const provider = new TrackCBookSignalsProvider({
      maxEntriesPerBuffer: 1_000,
    });
    const anchor = 10_000_000;
    provider.setOpenPositionTokenIds([tokenId]);

    for (let index = 0; index < 10_000; index++) {
      const ts = anchor + index * 10;
      provider.ingestTopOfBook({ tokenId, ts, bestBid: 0.4 + index * 0.000001 });
      provider.ingestLastTradePrice({ tokenId, ts, price: 0.41 });
      provider.ingestBook({
        tokenId,
        ts,
        bids: [
          { price: 0.4, size: 10 },
          { price: 0.39, size: 20 },
          { price: 0.38, size: 30 },
        ],
      });
    }

    expect(provider.getDebugSnapshot(tokenId)).toEqual({
      bidStateCount: 1_000,
      tradeTimestampCount: 1_000,
      depthStateCount: 1_000,
      activeTokenCount: 1,
    });
  });

  it("uses a 5000-entry default buffer cap for 3h trade-count coverage", () => {
    expect(DEFAULT_MAX_ENTRIES_PER_BUFFER).toBe(5_000);
  });

  it("exposes 3h trade stats from the existing last-trade buffer", () => {
    const provider = new TrackCBookSignalsProvider();
    const anchor = 10_000_000;
    provider.setOpenPositionTokenIds([tokenId]);

    for (let index = 0; index < 90; index++) {
      provider.ingestLastTradePrice({
        tokenId,
        ts: anchor - 89_000 + index * 1_000,
        price: 0.41,
      });
    }
    provider.ingestLastTradePrice({ tokenId, ts: anchor - 3 * 60 * 60_000, price: 0.41 });
    provider.ingestLastTradePrice({ tokenId, ts: anchor, price: 0.41 });

    expect(provider.getTradeStats3h(tokenId, anchor)).toEqual({
      publicTradeCount3h: 91,
      publicNotional3h: null,
      status: "ok",
      windowStartMs: anchor - 3 * 60 * 60_000,
    });
  });

  it("marks 3h trade stats unknown before 90 samples and stale after 60 seconds", () => {
    const provider = new TrackCBookSignalsProvider();
    const anchor = 10_000_000;
    provider.setOpenPositionTokenIds([tokenId]);
    provider.ingestLastTradePrice({ tokenId, ts: anchor - 30_000, price: 0.41 });

    expect(provider.getTradeStats3h(tokenId, anchor)).toMatchObject({
      publicTradeCount3h: 1,
      status: "unknown",
    });
    expect(provider.getTradeStats3h(tokenId, anchor + 61_000)).toMatchObject({
      publicTradeCount3h: 1,
      status: "stale",
    });
  });

  it("returns null 3h trade stats only when a tracked token has never been observed", () => {
    const provider = new TrackCBookSignalsProvider();
    provider.setOpenPositionTokenIds([tokenId]);

    expect(provider.getTradeStats3h(tokenId, 10_000_000)).toBeNull();
  });

  it("reports bounded buffer metrics for high-rate ingest diagnostics", () => {
    const provider = new TrackCBookSignalsProvider({
      maxEntriesPerBuffer: 3,
    });
    provider.setOpenPositionTokenIds([tokenId]);

    for (let index = 0; index < 5; index++) {
      provider.ingestTopOfBook({ tokenId, ts: 10_000_000 + index, bestBid: 0.4 });
    }

    const snapshot = provider.getDebugSnapshot(tokenId);
    expect(snapshot.bidStateCount).toBe(3);
    expect(snapshot.activeTokenCount).toBe(1);
  });

  it("clears affected token buffers when a WSS gap invalidates Track G state", () => {
    const otherTokenId = createTokenId("token-b");
    const provider = new TrackCBookSignalsProvider();
    const anchor = 10_000_000;
    provider.setOpenPositionTokenIds([tokenId, otherTokenId]);
    provider.ingestTopOfBook({ tokenId, ts: anchor - 1_000, bestBid: 0.4 });
    provider.ingestLastTradePrice({ tokenId, ts: anchor - 500, price: 0.41 });
    provider.ingestBook({
      tokenId,
      ts: anchor - 400,
      bids: [{ price: 0.4, size: 10 }],
    });
    provider.ingestTopOfBook({ tokenId: otherTokenId, ts: anchor - 1_000, bestBid: 0.3 });

    provider.invalidateTokenIds([tokenId]);

    expect(provider.getBookSignals(tokenId, anchor)).toEqual({
      bidPersistenceS: null,
      bidMovement30m: null,
      publicTradeCount1h: null,
      depthTop3: null,
    });
    expect(provider.getDebugSnapshot(tokenId)).toMatchObject({
      bidStateCount: 0,
      tradeTimestampCount: 0,
      depthStateCount: 0,
    });
    expect(provider.getDebugSnapshot(otherTokenId).bidStateCount).toBe(1);
  });

  it("degrades to null during a WSS gap, then resumes after reconnect refill", () => {
    const provider = new TrackCBookSignalsProvider();
    const anchor = 10_000_000;
    provider.setOpenPositionTokenIds([tokenId]);
    provider.ingestTopOfBook({ tokenId, ts: anchor - 2_000, bestBid: 0.4 });
    provider.ingestLastTradePrice({ tokenId, ts: anchor - 1_500, price: 0.41 });
    provider.ingestBook({
      tokenId,
      ts: anchor - 1_000,
      bids: [
        { price: 0.4, size: 10 },
        { price: 0.39, size: 20 },
        { price: 0.38, size: 30 },
      ],
    });

    provider.invalidateTokenIds([tokenId]);

    expect(provider.getBookSignals(tokenId, anchor)).toEqual({
      bidPersistenceS: null,
      bidMovement30m: null,
      publicTradeCount1h: null,
      depthTop3: null,
    });

    const refillAnchor = anchor + 2_000;
    provider.ingestTopOfBook({ tokenId, ts: refillAnchor - 1_000, bestBid: 0.5 });
    provider.ingestLastTradePrice({ tokenId, ts: refillAnchor - 500, price: 0.51 });
    provider.ingestBook({
      tokenId,
      ts: refillAnchor - 400,
      bids: [
        { price: 0.5, size: 5 },
        { price: 0.49, size: 6 },
        { price: 0.48, size: 7 },
      ],
    });

    expect(provider.getBookSignals(tokenId, refillAnchor)).toEqual({
      bidPersistenceS: 1,
      bidMovement30m: 0,
      publicTradeCount1h: 1,
      depthTop3: 18,
    });
  });

  it("keeps buffers bounded and compute latency low under a 1000 events/sec soak", () => {
    const provider = new TrackCBookSignalsProvider({
      maxEntriesPerBuffer: 1_000,
    });
    const start = 10_000_000;
    provider.setOpenPositionTokenIds([tokenId]);

    for (let index = 0; index < 300_000; index++) {
      const ts = start + index;
      provider.ingestTopOfBook({ tokenId, ts, bestBid: 0.4 + (index % 100) * 0.00001 });
      provider.ingestLastTradePrice({ tokenId, ts, price: 0.41 });
    }

    const snapshot = provider.getDebugSnapshot(tokenId);
    expect(snapshot.bidStateCount).toBeLessThanOrEqual(1_000);
    expect(snapshot.tradeTimestampCount).toBeLessThanOrEqual(1_000);

    const computeStart = performance.now();
    const signals = provider.getBookSignals(tokenId, start + 299_999);
    const computeDurationMs = performance.now() - computeStart;

    expect(signals.bidMovement30m).toBeGreaterThan(0);
    expect(signals.publicTradeCount1h).toBe(999);
    // Local/prod p99 is sub-ms, but GitHub runners can briefly cross 5ms under load.
    // Keep a strict enough budget to catch real regressions without making CI flaky.
    expect(computeDurationMs).toBeLessThan(20);
  });

  it("returns all nulls for tokens outside the open-position scope", () => {
    const provider = new TrackCBookSignalsProvider();
    const anchor = 10_000_000;
    provider.ingestTopOfBook({ tokenId, ts: anchor - 1_000, bestBid: 0.4, bestAsk: 0.45 });

    expect(provider.getBookSignals(tokenId, anchor)).toEqual({
      bidPersistenceS: null,
      bidMovement30m: null,
      publicTradeCount1h: null,
      depthTop3: null,
    });
  });
});

function computeDepthValueForTest(sizes: readonly number[]): number | null {
  const provider = new TrackCBookSignalsProvider();
  provider.setOpenPositionTokenIds([tokenId]);
  provider.ingestBook({
    tokenId,
    ts: 10_000_000,
    bids: sizes.map((size, index) => ({ price: 0.99 - index * 0.001, size })),
  });
  return provider.getBookSignals(tokenId, 10_000_000).depthTop3;
}
