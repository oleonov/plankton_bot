import type {
  BookSignalsTradeStats,
  ExecutionProfileSignalFeedConfig,
  SignalSnapshot,
  TokenId,
} from "@krabs/domain";

import type {
  SignalFeedHotBuffer,
  SignalFeedMetricWriter,
  SignalFeedWarmTier,
} from "./signal-feed-manager.js";
import { SIGNAL_FEED_METRICS as METRICS } from "./signal-feed-manager.js";
import { computeRange60, computeRecovery60, computeStd60 } from "./signal-feed-computations.js";

type SignalFeedMetricName = (typeof METRICS)[keyof typeof METRICS];

export interface SignalFeedTradeStatsProvider {
  getTradeStats3h(tokenId: TokenId, nowMs?: number): BookSignalsTradeStats | null;
}

export interface SignalFeedReaderDeps {
  hotBuffer: SignalFeedHotBuffer;
  warmTier: SignalFeedWarmTier;
  bookSignals: SignalFeedTradeStatsProvider;
  config: ExecutionProfileSignalFeedConfig;
  metrics?: SignalFeedMetricWriter | undefined;
  clock?: { now(): number } | undefined;
}

export class SignalFeedReader {
  constructor(private readonly deps: SignalFeedReaderDeps) {}

  getSnapshot(
    tokenId: TokenId,
    nowMs = this.deps.clock?.now() ?? Date.now(),
  ): SignalSnapshot | null {
    if (!this.deps.config.enabled) return null;
    const samples = this.deps.hotBuffer.getSamples(tokenId);
    if (samples.length === 0) {
      this.recordCounter(METRICS.snapshotsNull);
      return null;
    }

    const recovery = computeRecovery60(samples, nowMs, {
      windowMs: this.deps.config.windowShortMs,
      minSamples: this.deps.config.minSamplesForRecovery60,
    });
    const range = computeRange60(samples, nowMs, {
      windowMs: this.deps.config.windowShortMs,
      minSamples: this.deps.config.minSamplesForSnapshot,
    });
    const std = computeStd60(samples, nowMs, {
      windowMs: this.deps.config.windowShortMs,
      minSamples: this.deps.config.minSamplesForSnapshot,
    });
    const tradeStats = this.deps.bookSignals.getTradeStats3h(tokenId, nowMs);
    const warmBuckets = this.deps.warmTier
      .getBuckets(tokenId)
      .filter((bucket) => bucket.bucketStartMs >= nowMs - this.deps.config.windowLongMs);

    const snapshot: SignalSnapshot = {
      tokenId,
      computedAtMs: nowMs,
      windowStartMs: nowMs - this.deps.config.windowShortMs,
      hotSampleCount: recovery.sampleCount,
      warmBucketCount3h: warmBuckets.length,
      recovery60: recovery.value,
      range60: range.value,
      std60: std.value,
      tradeCount3h: tradeStats?.publicTradeCount3h ?? 0,
      notional3h: tradeStats?.publicNotional3h ?? null,
      midNow: range.midNow,
      midMin60m: range.midMin,
      midMax60m: range.midMax,
      midMean60m: range.midMean,
      insufficientForRecovery: recovery.insufficient,
      insufficientForRange: range.insufficient,
      insufficientForStd: std.insufficient,
      insufficientForTradeCount: tradeStats?.status !== "ok",
    };
    this.recordSnapshotTelemetry(snapshot, nowMs);
    return snapshot;
  }

  private recordSnapshotTelemetry(snapshot: SignalSnapshot, nowMs: number): void {
    const hasInsufficient =
      snapshot.insufficientForRecovery ||
      snapshot.insufficientForRange ||
      snapshot.insufficientForStd ||
      snapshot.insufficientForTradeCount;
    this.recordCounter(hasInsufficient ? METRICS.snapshotsInsufficient : METRICS.snapshotsReturned);
    if (!snapshot.insufficientForRecovery) {
      this.recordGauge(METRICS.recovery60Value, snapshot.recovery60, nowMs);
    }
    if (!snapshot.insufficientForRange) {
      this.recordGauge(METRICS.range60Value, snapshot.range60, nowMs);
    }
    if (!snapshot.insufficientForTradeCount) {
      this.recordGauge(METRICS.tradeCount3hValue, snapshot.tradeCount3h, nowMs);
    }
  }

  private recordCounter(name: SignalFeedMetricName): void {
    this.deps.metrics?.writeCounter(name, 1, null);
  }

  private recordGauge(name: SignalFeedMetricName, value: number, nowMs: number): void {
    this.deps.metrics?.writeEvent(name, value, "{}", new Date(nowMs).toISOString());
  }
}
