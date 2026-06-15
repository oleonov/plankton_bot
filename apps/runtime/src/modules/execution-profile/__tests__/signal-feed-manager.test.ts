import { describe, expect, it } from "vitest";

import { InProcessEventBus } from "@krabs/event-bus";
import type { HotSample, NormalizedMarket, OhlcBucket, TokenId } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

import {
  SIGNAL_FEED_METRICS,
  SIGNAL_FEED_RISK_EVENTS,
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
  deleteResult = 0;
  deleteError: Error | null = null;

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
    if (this.deleteError) throw this.deleteError;
    this.deleteArgs.push({ granularity: bucketGranularityMs, beforeMs });
    return this.deleteResult;
  }
}

function makeMetrics() {
  return {
    counters: [] as Array<{ name: string; value: number | undefined; labels: string | null }>,
    events: [] as Array<{ name: string; value: number; labels: string | null; capturedAt: string }>,
    latest: [] as Array<{
      name: string;
      value: number | undefined;
      labels: string | null | undefined;
    }>,
    writeCounter(name: string, value?: number, labels: string | null = null): void {
      this.counters.push({ name, value, labels });
    },
    writeEvent(name: string, value: number, labels: string | null, capturedAt: string): void {
      this.events.push({ name, value, labels, capturedAt });
    },
    writeLatest(name: string, value?: number, labels?: string | null): void {
      this.latest.push({ name, value, labels });
    },
  };
}

function makeRiskEvents() {
  return {
    inserts: [] as Array<{ eventType: string; payload: Record<string, unknown> }>,
    insert(event: { eventType: string; payload: Record<string, unknown> }): void {
      this.inserts.push(event);
    },
  };
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
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = new SignalFeedManager({
      bus,
      repository: repo,
      config: { enabled: false, windowShortMs: 60_000, warmBucketMs: 60_000 },
      metrics,
      riskEvents,
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
    manager.maintenancePrune(61_000);
    manager.writeGaugeSnapshot(61_000);

    expect(manager.getHotSamples(TOKEN)).toEqual([]);
    expect(repo.upserts).toEqual([]);
    expect(metrics.counters).toEqual([]);
    expect(metrics.events).toEqual([]);
    expect(metrics.latest).toEqual([]);
    expect(riskEvents.inserts).toEqual([]);
  });

  it("publishes signal_feed_initialized on start", async () => {
    const riskEvents = makeRiskEvents();
    const manager = new SignalFeedManager({
      bus: new InProcessEventBus(),
      repository: new RecordingSignalFeedRepository(),
      config: { enabled: true, windowShortMs: 60_000, warmBucketMs: 60_000 },
      riskEvents,
    });

    await manager.start();

    expect(riskEvents.inserts).toContainEqual({
      eventType: SIGNAL_FEED_RISK_EVENTS.initialized,
      payload: { enabled: true, tokenCountResumed: 0, warmBucketsResumed: 0 },
    });
  });

  it("increments signal_feed_samples_received_heartbeat per heartbeat sample", async () => {
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const manager = new SignalFeedManager({
      bus,
      repository: new RecordingSignalFeedRepository(),
      config: { enabled: true, windowShortMs: 60_000, warmBucketMs: 60_000 },
      metrics,
    });

    await manager.start();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market(TOKEN, 0.1)],
      timestamp: 1_000,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });

    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.samplesReceivedHeartbeat,
      value: 1,
      labels: null,
    });
  });

  it("increments signal_feed_samples_received_changed per changed-market sample", async () => {
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const manager = new SignalFeedManager({
      bus,
      repository: new RecordingSignalFeedRepository(),
      config: { enabled: true, windowShortMs: 60_000, warmBucketMs: 60_000 },
      metrics,
    });

    await manager.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.2)],
      timestamp: 1_000,
    });

    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.samplesReceivedChanged,
      value: 1,
      labels: null,
    });
  });

  it("increments warm and cold flush counters per bucket", async () => {
    const bus = new InProcessEventBus();
    const repo = new RecordingSignalFeedRepository();
    const metrics = makeMetrics();
    const manager = new SignalFeedManager({
      bus,
      repository: repo,
      config: { enabled: true, windowShortMs: 60_000, warmBucketMs: 60_000 },
      metrics,
    });

    await manager.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.2)],
      timestamp: 1_000,
    });
    manager.flushHotToWarm(61_000);
    manager.flushWarmToCold(61_000);

    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.bucketsFlushedWarm,
      value: 1,
      labels: null,
    });
    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.bucketsFlushedCold,
      value: 1,
      labels: null,
    });
  });

  it("increments maintenance runs and publishes completion events", () => {
    const repo = new RecordingSignalFeedRepository();
    repo.deleteResult = 7;
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = new SignalFeedManager({
      bus: new InProcessEventBus(),
      repository: repo,
      config: {
        enabled: true,
        windowShortMs: 60_000,
        warmBucketMs: 60_000,
        coldArchiveBucketMs: 3_600_000,
        retentionDays: 1,
      },
      metrics,
      riskEvents,
    });

    manager.maintenancePrune(2 * 24 * 60 * 60_000);

    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.maintenanceRuns,
      value: 1,
      labels: null,
    });
    expect(riskEvents.inserts).toContainEqual({
      eventType: SIGNAL_FEED_RISK_EVENTS.maintenanceCompleted,
      payload: expect.objectContaining({ bucketsPurged: 7 }),
    });
  });

  it("increments maintenance failures and publishes failure events on DB error", () => {
    const repo = new RecordingSignalFeedRepository();
    repo.deleteError = new Error("delete failed");
    const metrics = makeMetrics();
    const riskEvents = makeRiskEvents();
    const manager = new SignalFeedManager({
      bus: new InProcessEventBus(),
      repository: repo,
      config: { enabled: true, windowShortMs: 60_000, warmBucketMs: 60_000 },
      metrics,
      riskEvents,
    });

    expect(() => manager.maintenancePrune(61_000)).toThrow("delete failed");
    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.maintenanceFailures,
      value: 1,
      labels: null,
    });
    expect(riskEvents.inserts).toContainEqual({
      eventType: SIGNAL_FEED_RISK_EVENTS.maintenanceFailed,
      payload: expect.objectContaining({ errorClass: "Error", message: "delete failed" }),
    });
  });

  it("writes buffer gauges via writeEvent and never writeLatest", async () => {
    const bus = new InProcessEventBus();
    const metrics = makeMetrics();
    const manager = new SignalFeedManager({
      bus,
      repository: new RecordingSignalFeedRepository(),
      config: { enabled: true, windowShortMs: 60_000, warmBucketMs: 60_000 },
      metrics,
    });

    await manager.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.2)],
      timestamp: 1_000,
    });
    manager.flushHotToWarm(61_000);
    manager.writeGaugeSnapshot(61_000);

    expect(metrics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: SIGNAL_FEED_METRICS.hotBufferSize, value: 1 }),
        expect.objectContaining({ name: SIGNAL_FEED_METRICS.warmBucketCount, value: 1 }),
        expect.objectContaining({ name: SIGNAL_FEED_METRICS.activeTokens, value: 1 }),
      ]),
    );
    expect(metrics.latest).toEqual([]);
  });

  it("publishes stale-token risk events at most once per 5-minute window", async () => {
    const bus = new InProcessEventBus();
    const riskEvents = makeRiskEvents();
    const manager = new SignalFeedManager({
      bus,
      repository: new RecordingSignalFeedRepository(),
      config: { enabled: true, windowShortMs: 10 * 60_000, warmBucketMs: 60_000 },
      riskEvents,
    });

    await manager.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.2)],
      timestamp: 1_000,
    });
    manager.maintenancePrune(6 * 60_000 + 1_000);
    manager.maintenancePrune(7 * 60_000 + 1_000);

    expect(
      riskEvents.inserts.filter((event) => event.eventType === SIGNAL_FEED_RISK_EVENTS.staleToken),
    ).toHaveLength(1);
    expect(riskEvents.inserts).toContainEqual({
      eventType: SIGNAL_FEED_RISK_EVENTS.staleToken,
      payload: { tokenId: String(TOKEN), lastSampleAgeMs: 6 * 60_000 },
    });
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
