import type { HotSample, OhlcBucket } from "@krabs/domain";

const DEFAULT_WINDOW_60M_MS = 60 * 60_000;
const DEFAULT_WINDOW_3H_MS = 3 * 60 * 60_000;
const DEFAULT_RECOVERY_MIN_SAMPLES = 60;
const DEFAULT_SNAPSHOT_MIN_SAMPLES = 30;

export interface SignalComputationOptions {
  windowMs?: number;
  minSamples?: number;
}

export interface SignalComputationResult {
  value: number;
  insufficient: boolean;
  sampleCount: number;
  midNow: number;
  midMin: number;
  midMax: number;
  midMean: number;
}

export interface TradeCountComputationResult {
  value: number;
  bucketCount: number;
}

export function selectHotSamples(
  samples: readonly HotSample[],
  nowMs: number,
  windowMs = DEFAULT_WINDOW_60M_MS,
): HotSample[] {
  const startMs = nowMs - windowMs;
  return samples
    .filter((sample) => sample.tsMs >= startMs && sample.tsMs <= nowMs)
    .slice()
    .sort((left, right) => left.tsMs - right.tsMs);
}

export function computeRecovery60(
  samples: readonly HotSample[],
  nowMs: number,
  options: SignalComputationOptions = {},
): SignalComputationResult {
  const selected = selectHotSamples(samples, nowMs, options.windowMs);
  const stats = computeMidStats(selected);
  const minSamples = options.minSamples ?? DEFAULT_RECOVERY_MIN_SAMPLES;

  if (selected.length < minSamples || stats.midMin <= 0) {
    return { ...stats, value: 0, insufficient: selected.length < minSamples };
  }

  return {
    ...stats,
    value: stats.midNow / stats.midMin - 1,
    insufficient: false,
  };
}

export function computeRange60(
  samples: readonly HotSample[],
  nowMs: number,
  options: SignalComputationOptions = {},
): SignalComputationResult {
  const selected = selectHotSamples(samples, nowMs, options.windowMs);
  const stats = computeMidStats(selected);
  const minSamples = options.minSamples ?? DEFAULT_SNAPSHOT_MIN_SAMPLES;

  if (selected.length < minSamples || stats.midMin <= 0) {
    return { ...stats, value: 0, insufficient: selected.length < minSamples };
  }

  return {
    ...stats,
    value: (stats.midMax - stats.midMin) / stats.midMin,
    insufficient: false,
  };
}

export function computeStd60(
  samples: readonly HotSample[],
  nowMs: number,
  options: SignalComputationOptions = {},
): SignalComputationResult {
  const selected = selectHotSamples(samples, nowMs, options.windowMs);
  const positive = selected.filter((sample) => sample.midPrice > 0);
  const stats = computeMidStats(positive);
  const minSamples = options.minSamples ?? DEFAULT_SNAPSHOT_MIN_SAMPLES;

  if (positive.length < minSamples || stats.midMean <= 0) {
    return { ...stats, value: 0, insufficient: positive.length < minSamples };
  }

  const variance =
    positive.reduce((total, sample) => total + (sample.midPrice - stats.midMean) ** 2, 0) /
    positive.length;

  return {
    ...stats,
    value: Math.sqrt(variance) / stats.midMean,
    insufficient: false,
  };
}

export function computeTradeCount3h(
  buckets: readonly Pick<OhlcBucket, "bucketStartMs" | "tradeCount">[],
  nowMs: number,
  windowMs = DEFAULT_WINDOW_3H_MS,
): TradeCountComputationResult {
  const startMs = nowMs - windowMs;
  const selected = buckets.filter(
    (bucket) => bucket.bucketStartMs >= startMs && bucket.bucketStartMs <= nowMs,
  );
  return {
    value: selected.reduce((total, bucket) => total + bucket.tradeCount, 0),
    bucketCount: selected.length,
  };
}

function computeMidStats(samples: readonly HotSample[]): Omit<SignalComputationResult, "value"> {
  if (samples.length === 0) {
    return {
      insufficient: true,
      sampleCount: 0,
      midNow: 0,
      midMin: 0,
      midMax: 0,
      midMean: 0,
    };
  }

  const mids = samples.map((sample) => sample.midPrice);
  return {
    insufficient: false,
    sampleCount: samples.length,
    midNow: mids[mids.length - 1] ?? 0,
    midMin: Math.min(...mids),
    midMax: Math.max(...mids),
    midMean: mids.reduce((total, mid) => total + mid, 0) / mids.length,
  };
}
