import { describe, expect, it } from "vitest";

import { SignalPathTelemetry } from "./signal-path-telemetry.js";

describe("SignalPathTelemetry cooldown diagnostics", () => {
  it("deduplicates early and late cooldown phases by signal id per window", () => {
    const telemetry = new SignalPathTelemetry();

    telemetry.recordEarlyCooldown("early-only-1");
    telemetry.recordEarlyCooldown("early-only-2");
    telemetry.recordLateCooldown("late-only-1");
    telemetry.recordEarlyCooldown("both-1");
    telemetry.recordLateCooldown("both-1");
    telemetry.recordEarlyCooldown("early-only-1");
    telemetry.recordLateCooldown("late-only-1");

    const snapshot = telemetry.snapshotAndReset();

    expect(snapshot.signalsSkippedEarlyCooldown).toBe(4);
    expect(snapshot.signalsSkippedLateCooldown).toBe(3);
    expect(snapshot.cooldownSignalDedupe).toEqual({
      total: 4,
      earlyOnly: 2,
      lateOnly: 1,
      earlyAndLate: 1,
      duplicateEarly: 1,
      duplicateLate: 1,
    });
  });

  it("resets cooldown dedupe state with the aggregate window", () => {
    const telemetry = new SignalPathTelemetry();

    telemetry.recordEarlyCooldown("signal-1");
    telemetry.recordLateCooldown("signal-2");

    expect(telemetry.snapshotAndReset().cooldownSignalDedupe.total).toBe(2);
    expect(telemetry.snapshotAndReset().cooldownSignalDedupe).toEqual({
      total: 0,
      earlyOnly: 0,
      lateOnly: 0,
      earlyAndLate: 0,
      duplicateEarly: 0,
      duplicateLate: 0,
    });
  });
});
