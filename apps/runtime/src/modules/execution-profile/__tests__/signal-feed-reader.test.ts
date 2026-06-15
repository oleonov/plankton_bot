import { describe, expect, it } from "vitest";

import type {
  BookSignalsTradeStats,
  ExecutionProfileSignalFeedConfig,
  HotSample,
} from "@krabs/domain";
import { DEFAULT_EXECUTION_PROFILE_POLICY, createTokenId } from "@krabs/domain";

import { SignalFeedHotBuffer, SignalFeedWarmTier } from "../signal-feed-manager.js";
import { SignalFeedReader, type SignalFeedTradeStatsProvider } from "../signal-feed-reader.js";

const TOKEN = createTokenId("signal-feed-token");
const NOW = 10_000_000;

function config(
  overrides: Partial<ExecutionProfileSignalFeedConfig> = {},
): ExecutionProfileSignalFeedConfig {
  return {
    ...DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed,
    minSamplesForSnapshot: 3,
    minSamplesForRecovery60: 3,
    ...overrides,
  };
}

function sample(midPrice: number, ageMs: number): HotSample {
  return { tsMs: NOW - ageMs, midPrice };
}

function tradeStats(overrides: Partial<BookSignalsTradeStats> = {}): BookSignalsTradeStats {
  return {
    publicTradeCount3h: 80,
    publicNotional3h: null,
    status: "ok",
    windowStartMs: NOW - 3 * 60 * 60_000,
    ...overrides,
  };
}

function makeReader(stats: BookSignalsTradeStats | null = tradeStats()): {
  hot: SignalFeedHotBuffer;
  warm: SignalFeedWarmTier;
  reader: SignalFeedReader;
} {
  const hot = new SignalFeedHotBuffer(config().windowShortMs);
  const warm = new SignalFeedWarmTier(config().warmBucketMs);
  const bookSignals: SignalFeedTradeStatsProvider = {
    getTradeStats3h: () => stats,
  };
  return {
    hot,
    warm,
    reader: new SignalFeedReader({ hotBuffer: hot, warmTier: warm, bookSignals, config: config() }),
  };
}

describe("SignalFeedReader", () => {
  it("returns null when no hot samples exist for the token", () => {
    const { reader } = makeReader();

    expect(reader.getSnapshot(TOKEN, NOW)).toBeNull();
  });

  it("computes price signals from hot samples and trade signals from bookSignals", () => {
    const { hot, warm, reader } = makeReader(tradeStats({ publicTradeCount3h: 90 }));

    for (const item of [sample(0.1, 30_000), sample(0.05, 20_000), sample(0.12, 10_000)]) {
      hot.push(TOKEN, item);
    }
    warm.ingestSamples(TOKEN, [sample(0.1, 30_000), sample(0.12, 10_000)]);

    const snapshot = reader.getSnapshot(TOKEN, NOW);

    expect(snapshot).toMatchObject({
      tokenId: TOKEN,
      computedAtMs: NOW,
      hotSampleCount: 3,
      warmBucketCount3h: 1,
      tradeCount3h: 90,
      notional3h: null,
      midNow: 0.12,
      midMin60m: 0.05,
      midMax60m: 0.12,
      insufficientForRecovery: false,
      insufficientForRange: false,
      insufficientForStd: false,
      insufficientForTradeCount: false,
    });
    expect(snapshot?.recovery60).toBeCloseTo(1.4, 8);
    expect(snapshot?.range60).toBeCloseTo(1.4, 8);
  });

  it("marks insufficient flags when samples or bookSignals are not ready", () => {
    const { hot, reader } = makeReader(tradeStats({ status: "unknown", publicTradeCount3h: 0 }));

    hot.push(TOKEN, sample(0.1, 10_000));

    expect(reader.getSnapshot(TOKEN, NOW)).toMatchObject({
      recovery60: 0,
      range60: 0,
      std60: 0,
      tradeCount3h: 0,
      insufficientForRecovery: true,
      insufficientForRange: true,
      insufficientForStd: true,
      insufficientForTradeCount: true,
    });
  });
});
