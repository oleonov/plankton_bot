import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId } from "@plankton/domain";
import type { NormalizedMarket } from "@plankton/domain";
import { SnapshotWriter } from "../snapshot-writer.js";

function makeMarket(tokenId: string, bestBid = 0.45, bestAsk = 0.55): NormalizedMarket {
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

  it("sets lastPrice to null, volume24h to null, liquidity to null", () => {
    writer.onSnapshot([makeMarket("tok-1")], Date.now());

    const batch = repo.saveBatch.mock.calls[0]![0] as {
      lastPrice: unknown;
      volume24h: unknown;
      liquidity: unknown;
    }[];
    expect(batch[0]!.lastPrice).toBeNull();
    expect(batch[0]!.volume24h).toBeNull();
    expect(batch[0]!.liquidity).toBeNull();
  });
});
