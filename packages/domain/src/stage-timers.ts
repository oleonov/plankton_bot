export const STAGE_TIMER_NAMES = [
  "ipc_decode",
  "handle_worker_batch",
  "hub_dispatch",
  "coalescing_flush",
  "latency_summary",
  "diagnostics_write",
] as const;

export type StageTimerName = (typeof STAGE_TIMER_NAMES)[number];

export interface StageTimerSnapshot {
  readonly count: number;
  readonly maxMs: number;
  readonly p95Ms: number;
}

export type StageTimerSnapshotMap = Readonly<Record<StageTimerName, StageTimerSnapshot>>;

const RESERVOIR_SIZE = 1_000;

class StageTimerReservoir {
  private readonly samples = new Float64Array(RESERVOIR_SIZE);
  private sampleCount = 0;
  private totalCount = 0;
  private maxMs = 0;

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.totalCount++;
    if (durationMs > this.maxMs) this.maxMs = durationMs;
    if (this.sampleCount < RESERVOIR_SIZE) {
      this.samples[this.sampleCount] = durationMs;
      this.sampleCount++;
      return;
    }
    const replacementIndex = Math.floor(Math.random() * this.totalCount);
    if (replacementIndex < RESERVOIR_SIZE) {
      this.samples[replacementIndex] = durationMs;
    }
  }

  snapshot(): StageTimerSnapshot {
    return {
      count: this.totalCount,
      maxMs: roundMs(this.maxMs),
      p95Ms: roundMs(this.estimateP95()),
    };
  }

  reset(): void {
    this.sampleCount = 0;
    this.totalCount = 0;
    this.maxMs = 0;
  }

  private estimateP95(): number {
    if (this.sampleCount === 0) return 0;
    const sorted = Array.from(this.samples.slice(0, this.sampleCount)).sort(
      (left, right) => left - right,
    );
    const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.95));
    return sorted[index] ?? 0;
  }
}

const stageTimers: Record<StageTimerName, StageTimerReservoir> = {
  ipc_decode: new StageTimerReservoir(),
  handle_worker_batch: new StageTimerReservoir(),
  hub_dispatch: new StageTimerReservoir(),
  coalescing_flush: new StageTimerReservoir(),
  latency_summary: new StageTimerReservoir(),
  diagnostics_write: new StageTimerReservoir(),
};

export function recordStageDuration(stage: StageTimerName, durationMs: number): void {
  stageTimers[stage].record(durationMs);
}

export function snapshotStageTimers(): StageTimerSnapshotMap {
  return {
    ipc_decode: stageTimers.ipc_decode.snapshot(),
    handle_worker_batch: stageTimers.handle_worker_batch.snapshot(),
    hub_dispatch: stageTimers.hub_dispatch.snapshot(),
    coalescing_flush: stageTimers.coalescing_flush.snapshot(),
    latency_summary: stageTimers.latency_summary.snapshot(),
    diagnostics_write: stageTimers.diagnostics_write.snapshot(),
  };
}

export function resetStageTimers(): void {
  for (const stage of STAGE_TIMER_NAMES) stageTimers[stage].reset();
}

export function snapshotAndResetStageTimers(): StageTimerSnapshotMap {
  const snapshot = snapshotStageTimers();
  resetStageTimers();
  return snapshot;
}

function roundMs(value: number): number {
  return Number(value.toFixed(3));
}
