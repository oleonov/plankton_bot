import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId } from "@krabs/domain";
import type { NormalizedMarket } from "@krabs/domain";
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
  let repo: { saveBatch: ReturnType<typeof vi.fn>; prune: ReturnType<typeof vi.fn> };
  let writer: SnapshotWriter;

  beforeEach(() => {
    repo = { saveBatch: vi.fn(), prune: vi.fn() };
    writer = new SnapshotWriter(repo, {
      intervalMs: 5 * 60 * 1000,
      pruneIntervalMs: 60 * 60 * 1000,
      pruneTtlMs: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it("writes snapshots on first call", () => {
    const markets = [makeMarket("tok-1"), makeMarket("tok-2")];
    writer.onSnapshot(markets, Date.now());

    expect(repo.saveBatch).toHaveBeenCalledTimes(1);
    expect(repo.saveBatch.mock.calls[0]![0]).toHaveLength(2);
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
      pruneIntervalMs: 60 * 60 * 1000,
      pruneTtlMs: 7 * 24 * 60 * 60 * 1000,
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

  it("prunes after pruneIntervalMs", () => {
    const now = Date.now();
    writer.onSnapshot([makeMarket("tok-1")], now);

    expect(repo.prune).not.toHaveBeenCalled();

    writer.onSnapshot([makeMarket("tok-1")], now + 60 * 60 * 1000 + 1);
    expect(repo.prune).toHaveBeenCalledTimes(1);
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
