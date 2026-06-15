import type {
  BookSignalsTradeStats,
  ExecutionProfileSignalFeedConfig,
  SignalSnapshot,
  TokenId,
} from "@krabs/domain";

import type { SignalFeedHotBuffer, SignalFeedWarmTier } from "./signal-feed-manager.js";
import { computeRange60, computeRecovery60, computeStd60 } from "./signal-feed-computations.js";

export interface SignalFeedTradeStatsProvider {
  getTradeStats3h(tokenId: TokenId): BookSignalsTradeStats | null;
}

export interface SignalFeedReaderDeps {
  hotBuffer: SignalFeedHotBuffer;
  warmTier: SignalFeedWarmTier;
  bookSignals: SignalFeedTradeStatsProvider;
  config: ExecutionProfileSignalFeedConfig;
}

export class SignalFeedReader {
  constructor(private readonly deps: SignalFeedReaderDeps) {}

  getSnapshot(tokenId: TokenId, nowMs = Date.now()): SignalSnapshot | null {
    const samples = this.deps.hotBuffer.getSamples(tokenId);
    if (samples.length === 0) return null;

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
    const tradeStats = this.deps.bookSignals.getTradeStats3h(tokenId);
    const warmBuckets = this.deps.warmTier
      .getBuckets(tokenId)
      .filter((bucket) => bucket.bucketStartMs >= nowMs - this.deps.config.windowLongMs);

    return {
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
  }
}
