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
});
