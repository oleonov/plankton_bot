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
  });
});
