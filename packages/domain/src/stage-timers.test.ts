import { describe, expect, it } from "vitest";
import {
  recordStageDuration,
  resetStageTimers,
  snapshotAndResetStageTimers,
  snapshotStageTimers,
} from "./stage-timers.js";

describe("stage timers", () => {
  it("captures max and p95 estimates and resets synchronously", () => {
    resetStageTimers();
    recordStageDuration("ipc_decode", 1);
    recordStageDuration("ipc_decode", 10);
    recordStageDuration("ipc_decode", 100);

    const beforeReset = snapshotAndResetStageTimers();

    expect(beforeReset.ipc_decode.count).toBe(3);
    expect(beforeReset.ipc_decode.maxMs).toBe(100);
    expect(beforeReset.ipc_decode.p95Ms).toBe(10);
    expect(snapshotStageTimers().ipc_decode.count).toBe(0);
  });

  it("ignores invalid durations", () => {
    resetStageTimers();
    recordStageDuration("hub_dispatch", -1);
    recordStageDuration("hub_dispatch", Number.NaN);

    expect(snapshotStageTimers().hub_dispatch.count).toBe(0);
  });

  it("exposes R75 timer groups in the same reset registry", () => {
    resetStageTimers();
    recordStageDuration("metrics_flush_total", 12);
    recordStageDuration("risk_signal_approval", 3);
    recordStageDuration("worker_non_update_events", 1);
    recordStageDuration("signal_path_aggregate", 2);
    recordStageDuration("cooldown_registry_sweep", 4);

    const snapshot = snapshotAndResetStageTimers();

    expect(snapshot.metrics_flush_total.maxMs).toBe(12);
    expect(snapshot.risk_signal_approval.count).toBe(1);
    expect(snapshot.worker_non_update_events.p95Ms).toBe(1);
    expect(snapshot.signal_path_aggregate.maxMs).toBe(2);
    expect(snapshot.cooldown_registry_sweep.maxMs).toBe(4);
    expect(snapshotStageTimers().metrics_flush_total.count).toBe(0);
  });
});
