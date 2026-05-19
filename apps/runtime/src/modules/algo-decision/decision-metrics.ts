export interface LatencySnapshot {
  count: number;
  latestMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export class SlidingLatencyWindow {
  private readonly samples: number[] = [];

  constructor(private readonly maxSamples = 100) {
    if (!Number.isInteger(maxSamples) || maxSamples <= 0) {
      throw new Error("SlidingLatencyWindow maxSamples must be a positive integer");
    }
  }

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.samples.push(durationMs);
    while (this.samples.length > this.maxSamples) this.samples.shift();
  }

  snapshot(): LatencySnapshot {
    if (this.samples.length === 0) {
      return { count: 0, latestMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      count: this.samples.length,
      latestMs: roundMs(this.samples[this.samples.length - 1] ?? 0),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: roundMs(sorted[sorted.length - 1] ?? 0),
    };
  }
}

export class SustainedThresholdAlert {
  private firstExceededAtMs: number | null = null;
  private lastAlertAtMs: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly sustainedMs: number,
    private readonly cooldownMs: number,
  ) {}

  observe(value: number | null | undefined, nowMs: number): boolean {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= this.threshold) {
      this.firstExceededAtMs = null;
      return false;
    }

    this.firstExceededAtMs ??= nowMs;
    if (nowMs - this.firstExceededAtMs < this.sustainedMs) return false;
    if (this.lastAlertAtMs != null && nowMs - this.lastAlertAtMs < this.cooldownMs) return false;

    this.lastAlertAtMs = nowMs;
    return true;
  }
}

function percentile(sorted: readonly number[], pct: number): number {
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  const clamped = Math.min(Math.max(index, 0), sorted.length - 1);
  return roundMs(sorted[clamped] ?? 0);
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
