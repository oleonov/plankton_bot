import { describe, expect, it } from "vitest";
import { buildRuntimeDiagnosticsSnapshot } from "../runtime-diagnostics.js";

describe("buildRuntimeDiagnosticsSnapshot", () => {
  it("normalizes memory usage to MiB and preserves lag snapshots", () => {
    const snapshot = buildRuntimeDiagnosticsSnapshot(
      { p50Ms: 10, p95Ms: 25, p99Ms: 40, maxMs: 55 },
      { count: 2, latestMs: 3, p50Ms: 2, p95Ms: 3, p99Ms: 3, maxMs: 3 },
      {
        rss: 128 * 1024 * 1024,
        heapUsed: 33 * 1024 * 1024,
        heapTotal: 64 * 1024 * 1024,
        external: 4 * 1024 * 1024,
        arrayBuffers: 2 * 1024 * 1024,
      },
      {
        ipc_decode: { count: 1, maxMs: 2, p95Ms: 2 },
        handle_worker_batch: { count: 0, maxMs: 0, p95Ms: 0 },
        hub_dispatch: { count: 0, maxMs: 0, p95Ms: 0 },
        coalescing_flush: { count: 0, maxMs: 0, p95Ms: 0 },
        latency_summary: { count: 0, maxMs: 0, p95Ms: 0 },
        diagnostics_write: { count: 0, maxMs: 0, p95Ms: 0 },
        metrics_flush_total: { count: 0, maxMs: 0, p95Ms: 0 },
        metrics_flush_sqlite_writes: { count: 0, maxMs: 0, p95Ms: 0 },
        metrics_flush_snapshot_serialize: { count: 0, maxMs: 0, p95Ms: 0 },
        risk_signal_approval: { count: 0, maxMs: 0, p95Ms: 0 },
        signal_to_order_bridge: { count: 0, maxMs: 0, p95Ms: 0 },
        worker_non_update_events: { count: 0, maxMs: 0, p95Ms: 0 },
        discovery_poll_publish: { count: 0, maxMs: 0, p95Ms: 0 },
        signal_path_aggregate: { count: 0, maxMs: 0, p95Ms: 0 },
        cooldown_registry_sweep: { count: 0, maxMs: 0, p95Ms: 0 },
      },
    );

    expect(snapshot.eventLoopLagMs).toEqual({ p50Ms: 10, p95Ms: 25, p99Ms: 40, maxMs: 55 });
    expect(snapshot.gcPauseMs).toEqual({
      count: 2,
      latestMs: 3,
      p50Ms: 2,
      p95Ms: 3,
      p99Ms: 3,
      maxMs: 3,
    });
    expect(snapshot.memoryMb).toEqual({
      rss: 128,
      heapUsed: 33,
      heapTotal: 64,
      external: 4,
      arrayBuffers: 2,
    });
    expect(snapshot.stageTimers.ipc_decode).toEqual({ count: 1, maxMs: 2, p95Ms: 2 });
  });
});
