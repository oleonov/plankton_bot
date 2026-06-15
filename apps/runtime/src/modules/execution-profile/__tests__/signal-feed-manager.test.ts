import { describe, expect, it } from "vitest";

import type { HotSample } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

import { SignalFeedHotBuffer, SignalFeedWarmTier, bucketStart } from "../signal-feed-manager.js";

const TOKEN = createTokenId("signal-feed-token");

function sample(tsMs: number, midPrice: number): HotSample {
  return { tsMs, midPrice };
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
