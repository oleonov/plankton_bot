import { describe, expect, it, vi } from "vitest";

import type {
  BookSignalsTradeStats,
  ExecutionProfileSignalFeedConfig,
  HotSample,
} from "@krabs/domain";
import { DEFAULT_EXECUTION_PROFILE_POLICY, createTokenId } from "@krabs/domain";

import { SignalFeedHotBuffer, SignalFeedWarmTier } from "../signal-feed-manager.js";
import { SIGNAL_FEED_METRICS } from "../signal-feed-manager.js";
import { SignalFeedReader, type SignalFeedTradeStatsProvider } from "../signal-feed-reader.js";

const TOKEN = createTokenId("signal-feed-token");
const NOW = 10_000_000;

function config(
  overrides: Partial<ExecutionProfileSignalFeedConfig> = {},
): ExecutionProfileSignalFeedConfig {
  return {
    ...DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed,
    enabled: true,
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

function makeMetrics() {
  return {
    counters: [] as Array<{ name: string; value: number | undefined; labels: string | null }>,
    events: [] as Array<{ name: string; value: number; labels: string | null; capturedAt: string }>,
    writeCounter(name: string, value?: number, labels: string | null = null): void {
      this.counters.push({ name, value, labels });
    },
    writeEvent(name: string, value: number, labels: string | null, capturedAt: string): void {
      this.events.push({ name, value, labels, capturedAt });
    },
  };
}

function makeReader(
  stats: BookSignalsTradeStats | null = tradeStats(),
  options: {
    metrics?: ReturnType<typeof makeMetrics>;
    getTradeStats3h?: ReturnType<typeof vi.fn>;
  } = {},
): {
  hot: SignalFeedHotBuffer;
  warm: SignalFeedWarmTier;
  reader: SignalFeedReader;
  bookSignals: SignalFeedTradeStatsProvider;
} {
  const hot = new SignalFeedHotBuffer(config().windowShortMs);
  const warm = new SignalFeedWarmTier(config().warmBucketMs);
  const bookSignals: SignalFeedTradeStatsProvider = {
    getTradeStats3h: options.getTradeStats3h ?? vi.fn(() => stats),
  };
  return {
    hot,
    warm,
    bookSignals,
    reader: new SignalFeedReader({
      hotBuffer: hot,
      warmTier: warm,
      bookSignals,
      config: config(),
      metrics: options.metrics,
      clock: { now: () => NOW },
    }),
  };
}

describe("SignalFeedReader", () => {
  it("returns null when no hot samples exist for the token", () => {
    const metrics = makeMetrics();
    const { reader } = makeReader(tradeStats(), { metrics });

    expect(reader.getSnapshot(TOKEN, NOW)).toBeNull();
    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.snapshotsNull,
      value: 1,
      labels: null,
    });
  });

  it("computes price signals from hot samples and trade signals from bookSignals", () => {
    const metrics = makeMetrics();
    const { hot, warm, reader } = makeReader(tradeStats({ publicTradeCount3h: 90 }), { metrics });

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
    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.snapshotsReturned,
      value: 1,
      labels: null,
    });
    expect(metrics.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: SIGNAL_FEED_METRICS.recovery60Value }),
        expect.objectContaining({ name: SIGNAL_FEED_METRICS.range60Value }),
        expect.objectContaining({ name: SIGNAL_FEED_METRICS.tradeCount3hValue, value: 90 }),
      ]),
    );
  });

  it("marks insufficient flags when samples or bookSignals are not ready", () => {
    const metrics = makeMetrics();
    const { hot, reader } = makeReader(tradeStats({ status: "unknown", publicTradeCount3h: 0 }), {
      metrics,
    });

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
    expect(metrics.counters).toContainEqual({
      name: SIGNAL_FEED_METRICS.snapshotsInsufficient,
      value: 1,
      labels: null,
    });
  });

  it("propagates nowMs to bookSignals.getTradeStats3h", () => {
    const getTradeStats3h = vi.fn(() => tradeStats({ publicTradeCount3h: 90 }));
    const { hot, reader } = makeReader(tradeStats(), { getTradeStats3h });

    for (const item of [sample(0.1, 30_000), sample(0.05, 20_000), sample(0.12, 10_000)]) {
      hot.push(TOKEN, item);
    }
    reader.getSnapshot(TOKEN, NOW);

    expect(getTradeStats3h).toHaveBeenCalledWith(TOKEN, NOW);
  });
});
