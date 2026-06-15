import { describe, expect, it } from "vitest";

import { InProcessEventBus } from "@krabs/event-bus";
import type { HotSample, NormalizedMarket, OhlcBucket, TokenId } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

import {
  SignalFeedHotBuffer,
  SignalFeedManager,
  SignalFeedWarmTier,
  bucketStart,
} from "../signal-feed-manager.js";
import type { SignalFeedBucketRepository } from "../signal-feed-repository.js";

const TOKEN = createTokenId("signal-feed-token");

function sample(tsMs: number, midPrice: number): HotSample {
  return { tsMs, midPrice };
}

function market(tokenId: TokenId = TOKEN, midPrice: number | null = 0.12): NormalizedMarket {
  return {
    tokenId,
    conditionId: "condition",
    slug: "slug",
    eventSlug: null,
    eventMarketCount: 1,
    question: "question",
    outcome: "YES",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.11,
    bestAsk: 0.13,
    midPrice,
    spread: 0.02,
    gammaCreatedAt: null,
    snapshotTs: 1_000,
  };
}

class RecordingSignalFeedRepository implements SignalFeedBucketRepository {
  readonly upserts: OhlcBucket[] = [];
  deleteArgs: Array<{ granularity: number; beforeMs: number }> = [];

  upsertBucket(bucket: OhlcBucket): void {
    this.upserts.push({ ...bucket });
  }

  upsertBuckets(buckets: readonly OhlcBucket[]): void {
    this.upserts.push(...buckets.map((bucket) => ({ ...bucket })));
  }

  selectBucketsForToken(): OhlcBucket[] {
    return [];
  }

  deleteBucketsBefore(bucketGranularityMs: number, beforeMs: number): number {
    this.deleteArgs.push({ granularity: bucketGranularityMs, beforeMs });
    return 0;
  }
}

describe("SignalFeedHotBuffer", () => {
  it("pushes samples in timestamp order and dedupes by token timestamp", () => {
    const buffer = new SignalFeedHotBuffer(60_000);

    expect(buffer.push(TOKEN, sample(2_000, 0.2))).toBe(true);
    expect(buffer.push(TOKEN, sample(1_000, 0.1))).toBe(true);
    expect(buffer.push(TOKEN, sample(2_000, 0.3))).toBe(false);

    expect(buffer.getSamples(TOKEN)).toEqual([sample(1_000, 0.1), sample(2_000, 0.2)]);
  });

  it("evicts only samples older than the configured window", () => {
    const buffer = new SignalFeedHotBuffer(60_000);

    buffer.push(TOKEN, sample(1_000, 0.1));
    buffer.push(TOKEN, sample(61_000, 0.2));
    buffer.push(TOKEN, sample(62_000, 0.3));

    expect(buffer.getSamples(TOKEN)).toEqual([sample(61_000, 0.2), sample(62_000, 0.3)]);
  });

  it("returns inclusive samplesBetween results", () => {
    const buffer = new SignalFeedHotBuffer(60_000);

    buffer.push(TOKEN, sample(1_000, 0.1));
    buffer.push(TOKEN, sample(2_000, 0.2));
    buffer.push(TOKEN, sample(3_000, 0.3));

    expect(buffer.samplesBetween(TOKEN, 1_000, 2_000)).toEqual([
      sample(1_000, 0.1),
      sample(2_000, 0.2),
    ]);
  });
});

describe("SignalFeedWarmTier", () => {
  it("builds OHLC buckets from ordered samples", () => {
    const tier = new SignalFeedWarmTier(60_000);

    tier.ingestSamples(TOKEN, [
      sample(61_000, 0.2),
      sample(1_000, 0.1),
      sample(2_000, 0.15),
      sample(3_000, 0.05),
    ]);

    expect(tier.getBuckets(TOKEN)).toEqual([
      expect.objectContaining({
        bucketStartMs: 0,
        openMid: 0.1,
        highMid: 0.15,
        lowMid: 0.05,
        closeMid: 0.05,
        sampleCount: 3,
        tradeCount: 0,
        notionalSum: 0,
        persisted: false,
      }),
      expect.objectContaining({
        bucketStartMs: 60_000,
        openMid: 0.2,
        highMid: 0.2,
        lowMid: 0.2,
        closeMid: 0.2,
        sampleCount: 1,
      }),
    ]);
  });

  it("marks persisted buckets and returns unpersisted copies", () => {
    const tier = new SignalFeedWarmTier(60_000);

    tier.ingestSamples(TOKEN, [sample(1_000, 0.1), sample(61_000, 0.2)]);
    tier.markPersisted(TOKEN, 0);

    expect(tier.getBuckets(TOKEN)[0]).toMatchObject({ persisted: true });
    expect(tier.takeUnpersisted(TOKEN)).toEqual([
      expect.objectContaining({ bucketStartMs: 60_000, persisted: false }),
    ]);
  });

  it("caps warm buckets per token by dropping oldest buckets", () => {
    const tier = new SignalFeedWarmTier(60_000, 2);

    tier.ingestSamples(TOKEN, [sample(1_000, 0.1), sample(61_000, 0.2), sample(121_000, 0.3)]);

    expect(tier.getBuckets(TOKEN).map((bucket) => bucket.bucketStartMs)).toEqual([60_000, 120_000]);
  });

  it("computes bucket starts by granularity", () => {
    expect(bucketStart(119_999, 60_000)).toBe(60_000);
  });
});

describe("SignalFeedManager", () => {
  it("does not subscribe or write when disabled", async () => {
    const bus = new InProcessEventBus();
    const repo = new RecordingSignalFeedRepository();
    const manager = new SignalFeedManager({
      bus,
      repository: repo,
      config: { enabled: false, windowShortMs: 60_000, warmBucketMs: 60_000 },
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market(TOKEN, 0.1)],
      timestamp: 1_000,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    manager.flushHotToWarm(61_000);
    manager.flushWarmToCold(61_000);

    expect(manager.getHotSamples(TOKEN)).toEqual([]);
    expect(repo.upserts).toEqual([]);
  });

  it("samples heartbeat and changed-market updates, dedupes by timestamp, and flushes buckets", async () => {
    const bus = new InProcessEventBus();
    const repo = new RecordingSignalFeedRepository();
    const manager = new SignalFeedManager({
      bus,
      repository: repo,
      config: { enabled: true, windowShortMs: 60_000, warmBucketMs: 60_000 },
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market(TOKEN, 0.1)],
      timestamp: 1_000,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.2), market(TOKEN, 0.3)],
      timestamp: 1_000,
    });
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.3)],
      timestamp: 2_000,
    });

    expect(manager.getHotSamples(TOKEN)).toEqual([sample(1_000, 0.1), sample(2_000, 0.3)]);

    manager.flushHotToWarm(61_000);
    manager.flushWarmToCold(61_000);

    expect(repo.upserts).toEqual([
      expect.objectContaining({
        tokenId: TOKEN,
        bucketStartMs: 0,
        openMid: 0.1,
        closeMid: 0.3,
        sampleCount: 2,
        persisted: false,
      }),
    ]);
  });

  it("clears subscriptions on stop and prunes cold buckets by retention", async () => {
    const bus = new InProcessEventBus();
    const repo = new RecordingSignalFeedRepository();
    const manager = new SignalFeedManager({
      bus,
      repository: repo,
      config: {
        enabled: true,
        windowShortMs: 60_000,
        warmBucketMs: 60_000,
        coldArchiveBucketMs: 3_600_000,
        retentionDays: 1,
      },
    });

    await manager.start();
    await manager.stop();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market(TOKEN, 0.1)],
      timestamp: 1_000,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    manager.maintenancePrune(2 * 24 * 60 * 60_000);

    expect(manager.getHotSamples(TOKEN)).toEqual([]);
    expect(repo.deleteArgs).toEqual([{ granularity: 3_600_000, beforeMs: 24 * 60 * 60_000 }]);
  });
});
