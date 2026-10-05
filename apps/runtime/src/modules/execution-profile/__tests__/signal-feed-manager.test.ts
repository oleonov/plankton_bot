import { describe, expect, it, vi } from "vitest";

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
  upsertError: Error | null = null;

  upsertBucket(bucket: OhlcBucket): void {
    this.upserts.push({ ...bucket });
  }

  upsertBuckets(buckets: readonly OhlcBucket[]): void {
    if (this.upsertError) throw this.upsertError;
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
  it("keeps mixed timestamps stable and dedupes only the cached maximum", () => {
    const buffer = new SignalFeedHotBuffer(60_000);

    expect([
      buffer.push(TOKEN, sample(2_000, 0.2)),
      buffer.push(TOKEN, sample(1_000, 0.1)),
      buffer.push(TOKEN, sample(1_000, 0.15)),
      buffer.push(TOKEN, sample(2_000, 0.3)),
    ]).toEqual([true, true, true, false]);

    expect(buffer.getSamples(TOKEN)).toEqual([
      sample(1_000, 0.1),
      sample(1_000, 0.15),
      sample(2_000, 0.2),
    ]);
    expect(buffer.lastSampleTsMs(TOKEN)).toBe(2_000);

    const tier = new SignalFeedWarmTier(60_000);
    tier.ingestSamples(TOKEN, buffer.getSamples(TOKEN));
    expect(tier.getBuckets(TOKEN)[0]).toMatchObject({
      openMid: 0.1,
      highMid: 0.2,
      lowMid: 0.1,
      closeMid: 0.2,
      sampleCount: 3,
    });
  });

  it("does no sorting or eviction filtering for 5,000 chronological samples", () => {
    const buffer = new SignalFeedHotBuffer(60_000);
    const sortSpy = vi.spyOn(Array.prototype, "sort");
    const filterSpy = vi.spyOn(Array.prototype, "filter");
    const accepted: boolean[] = [];
    let sortCount = 0;
    let filterCount = 0;

    try {
      for (let tsMs = 0; tsMs < 5_000; tsMs += 1) {
        accepted.push(buffer.push(TOKEN, sample(tsMs, tsMs / 10_000)));
      }
    } finally {
      sortCount = sortSpy.mock.calls.length;
      filterCount = filterSpy.mock.calls.length;
      sortSpy.mockRestore();
      filterSpy.mockRestore();
    }

    expect(accepted).toEqual(Array.from({ length: 5_000 }, () => true));
    expect(buffer.getSamples(TOKEN)).toEqual(
      Array.from({ length: 5_000 }, (_, tsMs) => sample(tsMs, tsMs / 10_000)),
    );
    expect({ sortCount, filterCount }).toEqual({ sortCount: 0, filterCount: 0 });
  });

  it("uses the incoming timestamp for eviction and keeps the cutoff inclusive", () => {
    const buffer = new SignalFeedHotBuffer(100);

    buffer.push(TOKEN, sample(1_000, 0.1));
    buffer.push(TOKEN, sample(1_100, 0.2));
    buffer.push(TOKEN, sample(1_050, 0.15));
    buffer.push(TOKEN, sample(900, 0.09));

    expect(buffer.getSamples(TOKEN)).toEqual([
      sample(900, 0.09),
      sample(1_000, 0.1),
      sample(1_050, 0.15),
      sample(1_100, 0.2),
    ]);
    buffer.push(TOKEN, sample(1_101, 0.21));
    expect(buffer.getSamples(TOKEN)).toEqual([
      sample(1_050, 0.15),
      sample(1_100, 0.2),
      sample(1_101, 0.21),
    ]);
  });

  it("handles no-op, full, absent, and drop eviction without stale cached maxima", () => {
    const other = createTokenId("other-token");
    const buffer = new SignalFeedHotBuffer(60_000);

    buffer.push(TOKEN, sample(Number.POSITIVE_INFINITY, 0.2));
    buffer.push(TOKEN, sample(2_000, 0.1));
    buffer.push(other, sample(3_000, 0.3));
    buffer.evictOlderThan(TOKEN, 1_000);

    expect(buffer.getSamples(TOKEN)).toEqual([
      sample(2_000, 0.1),
      sample(Number.POSITIVE_INFINITY, 0.2),
    ]);
    expect(buffer.lastSampleTsMs(TOKEN)).toBe(Number.POSITIVE_INFINITY);
    expect(buffer.push(TOKEN, sample(Number.POSITIVE_INFINITY, 0.4))).toBe(false);
    expect(() => buffer.evictOlderThan(createTokenId("absent"), 0)).not.toThrow();
    expect(buffer.getSamples(other)).toEqual([sample(3_000, 0.3)]);

    buffer.evictOlderThan(TOKEN, Number.POSITIVE_INFINITY);
    expect(buffer.getSamples(TOKEN)).toEqual([sample(Number.POSITIVE_INFINITY, 0.2)]);
    buffer.dropToken(TOKEN);
    expect(buffer.lastSampleTsMs(TOKEN)).toBeNull();
    expect(buffer.push(TOKEN, sample(2_000, 0.5))).toBe(true);
    buffer.evictOlderThan(TOKEN, 2_001);
    expect(buffer.getSamples(TOKEN)).toEqual([]);
    expect(buffer.lastSampleTsMs(TOKEN)).toBeNull();
  });

  it("returns a new array with the retained sample identities", () => {
    const buffer = new SignalFeedHotBuffer(60_000);
    const retained = sample(1_000, 0.1);

    buffer.push(TOKEN, retained);
    const first = buffer.getSamples(TOKEN);
    const second = buffer.getSamples(TOKEN);

    expect(first).not.toBe(second);
    expect(first[0]).toBe(retained);
    expect(second[0]).toBe(retained);
    expect(retained.tsMs).toBe(1_000);
  });

  it("preserves NaN timestamp clearing behavior", () => {
    const buffer = new SignalFeedHotBuffer(60_000);

    buffer.push(TOKEN, sample(1_000, 0.1));
    expect(buffer.push(TOKEN, sample(Number.NaN, 0.2))).toBe(true);

    expect(buffer.getSamples(TOKEN)).toEqual([]);
    expect(buffer.lastSampleTsMs(TOKEN)).toBeNull();
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

  it("caps warm buckets per token by dropping oldest persisted buckets", () => {
    const tier = new SignalFeedWarmTier(60_000, 2);

    tier.ingestSamples(TOKEN, [sample(1_000, 0.1), sample(61_000, 0.2)]);
    tier.markPersisted(TOKEN, 0);
    tier.markPersisted(TOKEN, 60_000);
    tier.ingestSamples(TOKEN, [sample(121_000, 0.3)]);

    expect(tier.getBuckets(TOKEN).map((bucket) => bucket.bucketStartMs)).toEqual([60_000, 120_000]);
  });

  it("never drops an unpersisted bucket, even past the cap, until it is persisted", () => {
    const tier = new SignalFeedWarmTier(60_000, 3);

    tier.ingestSamples(TOKEN, [
      sample(1_000, 0.1),
      sample(61_000, 0.2),
      sample(121_000, 0.3),
      sample(181_000, 0.4),
      sample(241_000, 0.5),
    ]);

    expect(tier.getBuckets(TOKEN).map((bucket) => bucket.bucketStartMs)).toEqual([
      0, 60_000, 120_000, 180_000, 240_000,
    ]);

    for (const bucketStartMs of [0, 60_000, 120_000, 180_000, 240_000]) {
      tier.markPersisted(TOKEN, bucketStartMs);
    }
    tier.ingestSamples(TOKEN, [sample(301_000, 0.6)]);

    expect(tier.getBuckets(TOKEN).map((bucket) => bucket.bucketStartMs)).toEqual([
      180_000, 240_000, 300_000,
    ]);
  });

  it("computes bucket starts by granularity", () => {
    expect(bucketStart(119_999, 60_000)).toBe(60_000);
  });

  it("deletes a token's buckets on dropToken", () => {
    const tier = new SignalFeedWarmTier(60_000);

    tier.ingestSamples(TOKEN, [sample(1_000, 0.1)]);
    expect(tier.getBuckets(TOKEN)).not.toEqual([]);

    tier.dropToken(TOKEN);

    expect(tier.getBuckets(TOKEN)).toEqual([]);
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

  it("retries an unpersisted warm bucket after a transient batch failure", async () => {
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

    repo.upsertError = new Error("transient write failure");
    expect(() => manager.flushWarmToCold(61_000)).toThrow("transient write failure");
    expect(repo.upserts).toEqual([]);
    expect(metrics.counters).not.toContainEqual(
      expect.objectContaining({ name: SIGNAL_FEED_METRICS.bucketsFlushedCold }),
    );

    repo.upsertError = null;
    manager.flushWarmToCold(62_000);
    expect(repo.upserts).toHaveLength(1);
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

  it("emits one aggregated stale-token event per scan regardless of token count", async () => {
    const bus = new InProcessEventBus();
    const riskEvents = makeRiskEvents();
    const metrics = makeMetrics();
    const manager = new SignalFeedManager({
      bus,
      repository: new RecordingSignalFeedRepository(),
      config: { enabled: true, windowShortMs: 10 * 60_000, warmBucketMs: 60_000 },
      metrics,
      riskEvents,
    });

    await manager.start();
    const markets = Array.from({ length: 50 }, (_, index) =>
      market(createTokenId(`stale-token-${index}`), 0.2),
    );
    await bus.publish("NormalizedMarketUpdated", { markets, timestamp: 1_000 });

    manager.maintenancePrune(6 * 60_000 + 1_000);

    const staleEvents = riskEvents.inserts.filter(
      (event) => event.eventType === SIGNAL_FEED_RISK_EVENTS.staleToken,
    );
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]!.payload).toMatchObject({
      staleTokenCount: 50,
      totalTokens: 50,
      evictedTokenCount: 0,
      ageMaxMs: 6 * 60_000,
    });
    expect((staleEvents[0]!.payload.sampleTokenIds as string[]).length).toBeLessThanOrEqual(10);
    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.staleTokens,
      value: 50,
      labels: null,
    });
  });

  it("evicts hot tokens silent past the fixed 1h eviction horizon", async () => {
    const bus = new InProcessEventBus();
    const riskEvents = makeRiskEvents();
    const metrics = makeMetrics();
    const manager = new SignalFeedManager({
      bus,
      repository: new RecordingSignalFeedRepository(),
      config: { enabled: true, windowShortMs: 10 * 60_000, warmBucketMs: 60_000 },
      metrics,
      riskEvents,
    });

    await manager.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.2)],
      timestamp: 1_000,
    });

    // Just past the fixed v1 1h horizon (age > 60m): the token is evicted.
    manager.maintenancePrune(60 * 60_000 + 1_000 + 1);

    expect(manager.getHotSamples(TOKEN)).toEqual([]);
    const staleEvents = riskEvents.inserts.filter(
      (event) => event.eventType === SIGNAL_FEED_RISK_EVENTS.staleToken,
    );
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]!.payload).toMatchObject({ staleTokenCount: 1, evictedTokenCount: 1 });
    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.staleTokensEvicted,
      value: 1,
      labels: null,
    });
  });

  it("reports stale but does not evict before the fixed 1h horizon", async () => {
    const bus = new InProcessEventBus();
    const riskEvents = makeRiskEvents();
    const metrics = makeMetrics();
    const manager = new SignalFeedManager({
      bus,
      repository: new RecordingSignalFeedRepository(),
      config: { enabled: true, windowShortMs: 10 * 60_000, warmBucketMs: 60_000 },
      metrics,
      riskEvents,
    });

    await manager.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.2)],
      timestamp: 1_000,
    });

    // Age 30m: well past the 5m stale-report threshold, well short of the fixed
    // 1h eviction horizon. The token is reported stale but its samples survive.
    manager.maintenancePrune(30 * 60_000 + 1_000);

    expect(manager.getHotSamples(TOKEN)).toHaveLength(1);
    const staleEvents = riskEvents.inserts.filter(
      (event) => event.eventType === SIGNAL_FEED_RISK_EVENTS.staleToken,
    );
    expect(staleEvents).toHaveLength(1);
    expect(staleEvents[0]!.payload).toMatchObject({ staleTokenCount: 1, evictedTokenCount: 0 });
    expect(metrics.counters).not.toContainEqual(
      expect.objectContaining({ name: SIGNAL_FEED_METRICS.staleTokensEvicted }),
    );
  });

  it("keeps the warm tier bounded across 30h of per-minute samples via timer-driven flushes", async () => {
    const bus = new InProcessEventBus();
    const manager = new SignalFeedManager({
      bus,
      repository: new RecordingSignalFeedRepository(),
      config: {
        enabled: true,
        windowShortMs: 5 * 60_000,
        warmBucketMs: 60_000,
        windowLongMs: 3 * 60 * 60_000,
      },
    });

    await manager.start();
    const totalMinutes = 30 * 60;
    for (let minute = 0; minute <= totalMinutes; minute += 1) {
      const tsMs = minute * 60_000;
      await bus.publish("NormalizedMarketUpdated", {
        markets: [market(TOKEN, 0.1)],
        timestamp: tsMs,
      });
      manager.flushHotToWarm(tsMs);
      manager.flushWarmToCold(tsMs);
    }

    // windowLongMs 3h / warmBucketMs 60s + 1 = 181. The old hardcoded 24h cap (1440)
    // would still be well over this bound after 30h of per-minute ingestion.
    expect(manager.getWarmTier().getBuckets(TOKEN).length).toBeLessThanOrEqual(181);
  });

  it("persists a stale token's unpersisted warm buckets and clears them on eviction, keeping active tokens", async () => {
    const bus = new InProcessEventBus();
    const repo = new RecordingSignalFeedRepository();
    const activeToken = createTokenId("active-token");
    const manager = new SignalFeedManager({
      bus,
      repository: repo,
      config: { enabled: true, windowShortMs: 10 * 60_000, warmBucketMs: 60_000 },
    });

    await manager.start();
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(TOKEN, 0.2), market(activeToken, 0.3)],
      timestamp: 1_000,
    });
    manager.flushHotToWarm(1_000);
    // Keep activeToken fresh right up to the eviction check, unlike TOKEN.
    await bus.publish("NormalizedMarketUpdated", {
      markets: [market(activeToken, 0.4)],
      timestamp: 60 * 60_000,
    });
    manager.flushHotToWarm(60 * 60_000);

    expect(manager.getWarmTier().getBuckets(TOKEN).length).toBeGreaterThan(0);
    expect(repo.upserts).toEqual([]);

    manager.maintenancePrune(60 * 60_000 + 1_000 + 1);

    expect(manager.getWarmTier().getBuckets(TOKEN)).toEqual([]);
    expect(repo.upserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tokenId: TOKEN, bucketStartMs: 0, persisted: false }),
      ]),
    );
    expect(manager.getWarmTier().getBuckets(activeToken).length).toBeGreaterThan(0);
  });

  it("does not report fresh tokens as stale", async () => {
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

    manager.maintenancePrune(61_000);

    expect(
      riskEvents.inserts.filter((event) => event.eventType === SIGNAL_FEED_RISK_EVENTS.staleToken),
    ).toHaveLength(0);
    expect(manager.getHotSamples(TOKEN)).toHaveLength(1);
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

  it("preserves buffered samples across stop/start and prunes cold buckets", async () => {
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
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market(TOKEN, 0.1)],
      timestamp: 1_000,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await manager.stop();
    await bus.publish("MarketSnapshotHeartbeat", {
      markets: [market(TOKEN, 0.2)],
      timestamp: 2_000,
      reason: "full_lifetime_active_position",
      source: "market-data",
    });
    await manager.start();
    expect(manager.getHotSamples(TOKEN)).toEqual([sample(1_000, 0.1)]);

    manager.maintenancePrune(2 * 24 * 60 * 60_000);

    expect(repo.deleteArgs).toEqual([{ granularity: 3_600_000, beforeMs: 24 * 60 * 60_000 }]);
  });
});
