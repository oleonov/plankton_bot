import type { LatencySnapshot } from "./modules/algo-decision/decision-metrics.js";

export interface EventLoopLagSnapshot {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface RuntimeDiagnosticsSnapshot {
  eventLoopLagMs: EventLoopLagSnapshot;
  gcPauseMs: LatencySnapshot;
  memoryMb: {
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
}

export function buildRuntimeDiagnosticsSnapshot(
  eventLoopLagMs: EventLoopLagSnapshot,
  gcPauseMs: LatencySnapshot,
  memory: NodeJS.MemoryUsage,
): RuntimeDiagnosticsSnapshot {
  return {
    eventLoopLagMs,
    gcPauseMs,
    memoryMb: {
      rss: bytesToMiB(memory.rss),
      heapUsed: bytesToMiB(memory.heapUsed),
      heapTotal: bytesToMiB(memory.heapTotal),
      external: bytesToMiB(memory.external),
      arrayBuffers: bytesToMiB(memory.arrayBuffers),
    },
  };
}

function bytesToMiB(value: number): number {
  return Math.round(value / 1024 / 1024);
}
