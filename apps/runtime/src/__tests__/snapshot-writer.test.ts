import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConditionId, createPositionId, createTokenId } from "@krabs/domain";
import type { NormalizedMarket, OrderBookSnapshot, Position } from "@krabs/domain";
import { SnapshotWriter } from "../snapshot-writer.js";

function makeMarket(
  tokenId: string,
  bestBid = 0.45,
  bestAsk = 0.55,
  extras: Partial<NormalizedMarket> = {},
): NormalizedMarket {
  return {
    tokenId: createTokenId(tokenId),
    conditionId: "cond-1",
    slug: "test",
    eventSlug: null,
    question: "test?",
    outcome: "YES",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid,
    bestAsk,
    midPrice: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...extras,
  };
}

describe("SnapshotWriter", () => {
  let repo: {
    saveBatch: ReturnType<typeof vi.fn>;
    saveBatchWithPositionValuations: ReturnType<typeof vi.fn>;
    prune: ReturnType<typeof vi.fn>;
  };
  let writer: SnapshotWriter;

  beforeEach(() => {
    repo = { saveBatch: vi.fn(), saveBatchWithPositionValuations: vi.fn(), prune: vi.fn() };
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
    });
  });

  function makePosition(tokenId: string, size = 100, overrides: Partial<Position> = {}): Position {
    return {
      positionId: createPositionId(`pos-${tokenId}`),
      tokenId: createTokenId(tokenId),
      conditionId: createConditionId(`cond-${tokenId}`),
      side: "buy",
      size,
      avgEntryPrice: 0.1,
      costBasisUsdc: size * 0.1,
      currentValueUsdc: null,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: "2026-06-12T00:00:00.000Z",
      closedAt: null,
      updatedAt: "2026-06-12T00:00:00.000Z",
      ...overrides,
    };
  }

  function makeBook(
    tokenId: string,
    bids: OrderBookSnapshot["bids"],
    asks: OrderBookSnapshot["asks"] = [{ price: 0.52, size: 100 }],
  ): OrderBookSnapshot {
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    return {
      tokenId: createTokenId(tokenId),
      bids: [...bids],
      asks: [...asks],
      bestBid,
      bestAsk,
      midPrice: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null,
      spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
      timestamp: Date.now(),
    };
  }

  it("writes snapshots on first call", () => {
    const markets = [makeMarket("tok-1"), makeMarket("tok-2")];
    writer.onSnapshot(markets, Date.now());

    expect(repo.saveBatch).toHaveBeenCalledTimes(1);
    expect(repo.saveBatch.mock.calls[0]![0]).toHaveLength(2);
  });

  it("writes heartbeat snapshots through a separate observe-only path", () => {
    const markets = [makeMarket("tok-heartbeat")];
    writer.onHeartbeat(markets, Date.now());

    expect(repo.saveBatch).toHaveBeenCalledTimes(1);
    expect(repo.saveBatch.mock.calls[0]![0]).toMatchObject([
      { tokenId: "tok-heartbeat", bestBid: 0.45, bestAsk: 0.55 },
    ]);
  });

  it("writes current and liquidation valuation atomically on heartbeat", () => {
    const now = Date.parse("2026-06-12T12:00:00.000Z");
    const metrics = { writeCounter: vi.fn(), writeEvent: vi.fn() };
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      positionValuation: {
        activePositions: () => [makePosition("tok-1", 100)],
        runtimeMetrics: metrics,
      },
    });

    writer.onHeartbeat(
      [makeMarket("tok-1", 0.48, 0.52)],
      now,
      new Map([["tok-1", makeBook("tok-1", [{ price: 0.48, size: 100 }])]]),
    );

    expect(repo.saveBatch).not.toHaveBeenCalled();
    expect(repo.saveBatchWithPositionValuations).toHaveBeenCalledTimes(1);
    expect(repo.saveBatchWithPositionValuations.mock.calls[0]![1]).toMatchObject([
      {
        positionId: "pos-tok-1",
        tokenId: "tok-1",
        currentValueUsdc: 50,
        liquidationValueUsdc: 48,
        liquidationPrice: 0.48,
        liquidationDepthExhausted: false,
        updatedAt: "2026-06-12T12:00:00.000Z",
      },
    ]);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "track_r_liquidation_computed_total",
      1,
      JSON.stringify({ outcome: "computed" }),
    );
  });

  it("values an open row and a dust row of the same token separately (#134)", () => {
    // Migration 032's unique index is PARTIAL, so one `open` row legally coexists with dust rows on
    // a token. Every mark below is derived from that row's OWN `size` — collapsing the token to one
    // winner and writing it `WHERE token_id = ?` stamped the open row's value onto the dust row.
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      positionValuation: {
        activePositions: () => [
          makePosition("tok-both", 100, { positionId: createPositionId("pos-open") }),
          makePosition("tok-both", 4, {
            positionId: createPositionId("pos-dust"),
            status: "dust",
          }),
        ],
      },
    });

    writer.onHeartbeat(
      [makeMarket("tok-both", 0.48, 0.52)],
      Date.parse("2026-08-11T12:00:00.000Z"),
      new Map([["tok-both", makeBook("tok-both", [{ price: 0.48, size: 500 }])]]),
    );

    const valuations = repo.saveBatchWithPositionValuations.mock.calls[0]![1] as Array<{
      positionId: string;
      tokenId: string;
      currentValueUsdc: number;
      liquidationValueUsdc: number;
    }>;
    expect(valuations.map((v) => v.positionId)).toEqual(["pos-open", "pos-dust"]);
    expect(valuations[0]!.currentValueUsdc).toBeCloseTo(50, 6);
    expect(valuations[1]!.currentValueUsdc).toBeCloseTo(2, 6);
    expect(valuations[0]!.liquidationValueUsdc).toBeCloseTo(48, 6);
    expect(valuations[1]!.liquidationValueUsdc).toBeCloseTo(1.92, 6);
  });

  it("allocates shared book depth MARGINALLY when it can't cover every sibling row (#134-follow-up)", () => {
    // Unlike the test above, depth here is insufficient: the book has exactly 100 bid shares — enough
    // for the open row alone. Pricing each row against the FULL book independently (the pre-fix bug)
    // would give the open row $48 AND the dust row $1.92, summing to $49.92 though only $48 is jointly
    // realizable. The fix must allocate the depth marginally: the open row (ranked first — it's the
    // live tradable position) claims it all, leaving the dust row nothing.
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      positionValuation: {
        activePositions: () => [
          makePosition("tok-scarce", 100, { positionId: createPositionId("pos-open") }),
          makePosition("tok-scarce", 4, {
            positionId: createPositionId("pos-dust"),
            status: "dust",
          }),
        ],
      },
    });

    writer.onHeartbeat(
      [makeMarket("tok-scarce", 0.48, 0.52)],
      Date.parse("2026-08-11T12:00:00.000Z"),
      new Map([["tok-scarce", makeBook("tok-scarce", [{ price: 0.48, size: 100 }])]]),
    );

    const valuations = repo.saveBatchWithPositionValuations.mock.calls[0]![1] as Array<{
      positionId: string;
      liquidationValueUsdc: number;
      liquidationDepthExhausted: boolean;
    }>;
    expect(valuations.map((v) => v.positionId)).toEqual(["pos-open", "pos-dust"]);
    const totalLiquidationValueUsdc = valuations.reduce(
      (sum, v) => sum + v.liquidationValueUsdc,
      0,
    );
    expect(totalLiquidationValueUsdc).toBeCloseTo(48, 6); // realizable total, not 49.92
    expect(valuations[0]!.liquidationValueUsdc).toBeCloseTo(48, 6);
    expect(valuations[1]!.liquidationValueUsdc).toBeCloseTo(0, 6);
    expect(valuations[1]!.liquidationDepthExhausted).toBe(true);
  });

  it("leaves a single-row token's valuation unchanged by the marginal allocation (no-regression pin)", () => {
    // A single-row token's cumulative IS its own size, and the previous cumulative is always 0, so
    // the marginal formula must degrade to exactly the pre-fix per-row computation. This scenario
    // mirrors the "atomically on heartbeat" test's numbers to pin that property explicitly.
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      positionValuation: {
        activePositions: () => [makePosition("tok-solo", 100)],
      },
    });

    writer.onHeartbeat(
      [makeMarket("tok-solo", 0.48, 0.52)],
      Date.parse("2026-08-11T12:00:00.000Z"),
      new Map([["tok-solo", makeBook("tok-solo", [{ price: 0.48, size: 100 }])]]),
    );

    expect(repo.saveBatchWithPositionValuations.mock.calls[0]![1]).toMatchObject([
      {
        tokenId: "tok-solo",
        currentValueUsdc: 50,
        liquidationValueUsdc: 48,
        liquidationPrice: 0.48,
        liquidationDepthExhausted: false,
      },
    ]);
  });

  it("liquidates thin books below mid and samples the liquidation-to-mid ratio", () => {
    const metrics = { writeCounter: vi.fn(), writeEvent: vi.fn() };
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      positionValuation: {
        activePositions: () => [makePosition("tok-thin", 100)],
        runtimeMetrics: metrics,
      },
    });

    writer.onHeartbeat(
      [makeMarket("tok-thin", 0.48, 0.52)],
      Date.parse("2026-06-12T12:05:00.000Z"),
      new Map([
        [
          "tok-thin",
          makeBook("tok-thin", [
            { price: 0.48, size: 5 },
            { price: 0.2, size: 95 },
          ]),
        ],
      ]),
    );

    const valuations = repo.saveBatchWithPositionValuations.mock.calls[0]![1] as Array<{
      liquidationValueUsdc: number;
      currentValueUsdc: number;
    }>;
    expect(valuations[0]!.liquidationValueUsdc).toBeCloseTo(21.4, 6);
    expect(valuations[0]!.liquidationValueUsdc).toBeLessThan(valuations[0]!.currentValueUsdc);
    expect(metrics.writeEvent).toHaveBeenCalledWith(
      "track_r_liquidation_value_vs_mid_ratio",
      expect.closeTo(21.4 / 50, 6),
      expect.any(String),
      "2026-06-12T12:05:00.000Z",
    );
  });

  it("uses available bid value when visible depth is exhausted", () => {
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      positionValuation: {
        activePositions: () => [makePosition("tok-exhausted", 100)],
      },
    });

    writer.onHeartbeat(
      [makeMarket("tok-exhausted", 0.48, 0.52)],
      Date.parse("2026-06-12T12:10:00.000Z"),
      new Map([["tok-exhausted", makeBook("tok-exhausted", [{ price: 0.48, size: 5 }])]]),
    );

    // liquidationPrice is now valueUsdc / row size (not the book's per-unit fill price), so it stays
    // self-consistent with liquidationValueUsdc even when the row's own size exceeds visible depth:
    // 2.4 realized across a 100-share row is 0.024/share, not the 0.48 the filled 5 shares traded at.
    expect(repo.saveBatchWithPositionValuations.mock.calls[0]![1]).toMatchObject([
      {
        tokenId: "tok-exhausted",
        liquidationValueUsdc: 2.4,
        liquidationPrice: 0.024,
        liquidationDepthExhausted: true,
      },
    ]);
  });

  it("writes zero liquidation and a skip counter when no book is available", () => {
    const metrics = { writeCounter: vi.fn(), writeEvent: vi.fn() };
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      positionValuation: {
        activePositions: () => [makePosition("tok-no-book", 100)],
        runtimeMetrics: metrics,
      },
    });

    writer.onHeartbeat(
      [makeMarket("tok-no-book", 0.48, 0.52)],
      Date.parse("2026-06-12T12:15:00.000Z"),
    );

    expect(repo.saveBatchWithPositionValuations.mock.calls[0]![1]).toMatchObject([
      {
        tokenId: "tok-no-book",
        currentValueUsdc: 50,
        liquidationValueUsdc: 0,
        liquidationPrice: 0,
        liquidationDepthExhausted: true,
      },
    ]);
    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "track_r_liquidation_compute_skipped_no_book",
      1,
      JSON.stringify({ reason: "missing_book" }),
    );
  });

  it("skips tokens written less than intervalMs ago", () => {
    const now = Date.now();
    const markets = [makeMarket("tok-1")];

    writer.onSnapshot(markets, now);
    writer.onSnapshot(markets, now + 60_000); // 1 min later

    expect(repo.saveBatch).toHaveBeenCalledTimes(1); // only first call writes
  });

  it("writes again after intervalMs has elapsed", () => {
    const now = Date.now();
    const markets = [makeMarket("tok-1")];

    writer.onSnapshot(markets, now);
    writer.onSnapshot(markets, now + 5 * 60 * 1000 + 1); // just past 5 min

    expect(repo.saveBatch).toHaveBeenCalledTimes(2);
  });

  it("does not let heartbeat writes suppress the next real changed snapshot", () => {
    const now = Date.now();
    const markets = [makeMarket("tok-1")];

    writer.onHeartbeat(markets, now);
    writer.onSnapshot([makeMarket("tok-1", 0.46, 0.56)], now + 1);

    expect(repo.saveBatch).toHaveBeenCalledTimes(2);
    expect(repo.saveBatch.mock.calls[1]![0]).toMatchObject([{ bestBid: 0.46, bestAsk: 0.56 }]);
  });

  it("skips heartbeat when a real snapshot was written recently", () => {
    const now = Date.now();
    const markets = [makeMarket("tok-1")];

    writer.onSnapshot(markets, now);
    writer.onHeartbeat(markets, now + 60_000);

    expect(repo.saveBatch).toHaveBeenCalledTimes(1);
  });

  it("does not update dedupe state when saveBatch throws", () => {
    repo.saveBatch.mockImplementationOnce(() => {
      throw new Error("db error");
    });
    const now = Date.now();
    const markets = [makeMarket("tok-1")];

    expect(() => writer.onSnapshot(markets, now)).toThrow("db error");

    // Retry should work because dedupe state was not updated
    writer.onSnapshot(markets, now + 1);
    expect(repo.saveBatch).toHaveBeenCalledTimes(2);
  });

  it("does not write or update dedupe state while disabled", () => {
    let enabled = false;
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      enabled: () => enabled,
    });
    const now = Date.now();
    const markets = [makeMarket("tok-paused")];

    writer.onSnapshot(markets, now);
    enabled = true;
    writer.onSnapshot(markets, now + 1);

    expect(repo.saveBatch).toHaveBeenCalledTimes(1);
    expect(repo.saveBatch.mock.calls[0]![0]).toHaveLength(1);
  });

  it("never deletes snapshot rows after the old prune interval", () => {
    const now = Date.now();
    writer.onSnapshot([makeMarket("tok-1")], now);

    expect(repo.prune).not.toHaveBeenCalled();

    writer.onSnapshot([makeMarket("tok-1")], now + 60 * 60 * 1000 + 1);
    expect(repo.prune).not.toHaveBeenCalled();
  });

  it("bounds independent real/heartbeat throttle maps during token churn without SQL deletion", () => {
    const now = Date.now();
    writer.onSnapshot([makeMarket("real-old")], now);
    writer.onHeartbeat([makeMarket("heartbeat-old")], now);
    writer.onSnapshot([makeMarket("current")], now + 3 * 86_400_000 + 1);
    const state = writer as unknown as {
      lastRealWrittenAt: Map<string, number>;
      lastHeartbeatWrittenAt: Map<string, number>;
    };
    expect([...state.lastRealWrittenAt.keys()]).toEqual(["current"]);
    expect(state.lastHeartbeatWrittenAt.size).toBe(0);
    expect(repo.prune).not.toHaveBeenCalled();
  });

  it("heartbeat-only capture leaves deletion to LedgerRetention", () => {
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
    });
    const now = Date.now();

    writer.onHeartbeat([makeMarket("tok-active")], now + 60 * 60 * 1000 + 1);

    expect(repo.prune).not.toHaveBeenCalled();
  });

  it("propagates lastPrice, volume24h, liquidity, and public trade count", () => {
    const market = makeMarket("tok-1", 0.45, 0.55, {
      lastTradePrice: 0.4712,
      volume24hr: 1234.56,
      liquidity: 78_900,
      publicTradeCount24h: 41,
    });
    writer.onSnapshot([market], Date.now());

    const batch = repo.saveBatch.mock.calls[0]![0] as {
      lastPrice: unknown;
      volume24h: unknown;
      liquidity: unknown;
      publicTradeCount24h: unknown;
    }[];
    expect(batch[0]!.lastPrice).toBe(0.4712);
    expect(batch[0]!.volume24h).toBe(1234.56);
    expect(batch[0]!.liquidity).toBe(78_900);
    expect(batch[0]!.publicTradeCount24h).toBe(41);
  });

  it("falls back to volume24h when volume24hr is absent", () => {
    const market = makeMarket("tok-2", 0.45, 0.55, {
      volume24h: 999.99,
    });
    writer.onSnapshot([market], Date.now());

    const batch = repo.saveBatch.mock.calls[0]![0] as { volume24h: unknown }[];
    expect(batch[0]!.volume24h).toBe(999.99);
  });

  it("writes null when source fields are missing", () => {
    writer.onSnapshot([makeMarket("tok-3")], Date.now());

    const batch = repo.saveBatch.mock.calls[0]![0] as {
      lastPrice: unknown;
      volume24h: unknown;
      liquidity: unknown;
      publicTradeCount24h: unknown;
    }[];
    expect(batch[0]!.lastPrice).toBeNull();
    expect(batch[0]!.volume24h).toBeNull();
    expect(batch[0]!.liquidity).toBeNull();
    expect(batch[0]!.publicTradeCount24h).toBeNull();
  });
});
