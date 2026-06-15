import { describe, expect, it, vi } from "vitest";

import { ExecutionProfileAnomalyDetector } from "../execution-profile-anomaly-detector.js";

const NOW = Date.parse("2026-06-14T00:00:00.000Z");

describe("ExecutionProfileAnomalyDetector", () => {
  it("honors dark default and cooldown for repeated anomalies", () => {
    let now = NOW;
    const riskEvents = { insert: vi.fn() };
    const metrics = { writeCounter: vi.fn() };
    const detector = new ExecutionProfileAnomalyDetector({
      riskEvents,
      metrics,
      policy: () => ({ enabled: true, cooldownMs: 3_600_000 }),
      now: () => now,
    });

    detector.record({
      component: "scale_in",
      reason: "stuck_pending_scale_in",
      profile: "medium",
      details: { pendingCount: 3 },
    });
    detector.record({
      component: "scale_in",
      reason: "stuck_pending_scale_in",
      profile: "medium",
      details: { pendingCount: 4 },
    });
    now += 3_600_001;
    detector.record({
      component: "scale_in",
      reason: "stuck_pending_scale_in",
      profile: "medium",
      details: { pendingCount: 5 },
    });

    expect(riskEvents.insert).toHaveBeenCalledTimes(2);
    expect(metrics.writeCounter).toHaveBeenCalledTimes(2);
  });

  it("does nothing while anomaly detection is disabled", () => {
    const riskEvents = { insert: vi.fn() };
    const detector = new ExecutionProfileAnomalyDetector({
      riskEvents,
      metrics: { writeCounter: vi.fn() },
      policy: () => ({ enabled: false, cooldownMs: 3_600_000 }),
      now: () => NOW,
    });

    detector.record({
      component: "profile_resolver",
      reason: "rapid_reclassification",
      profile: "cheap",
      details: {},
    });

    expect(riskEvents.insert).not.toHaveBeenCalled();
  });
});
