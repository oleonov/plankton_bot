import { describe, expect, it } from "vitest";
import { SlidingLatencyWindow, SustainedThresholdAlert } from "../decision-metrics.js";

describe("decision metrics helpers", () => {
  it("computes sliding-window latency percentiles", () => {
    const window = new SlidingLatencyWindow(5);
    for (const value of [10, 20, 30, 40, 50]) window.record(value);

    expect(window.snapshot()).toEqual({
      count: 5,
      latestMs: 50,
      p50Ms: 30,
      p95Ms: 50,
      p99Ms: 50,
      maxMs: 50,
    });

    window.record(60);

    expect(window.snapshot()).toMatchObject({
      count: 5,
      latestMs: 60,
      p50Ms: 40,
      p95Ms: 60,
      maxMs: 60,
    });
  });

  it("alerts only after sustained threshold breach and respects cooldown", () => {
    const alert = new SustainedThresholdAlert(30_000, 5 * 60_000, 15 * 60_000);

    expect(alert.observe(30_001, 0)).toBe(false);
    expect(alert.observe(30_001, 4 * 60_000)).toBe(false);
    expect(alert.observe(30_001, 5 * 60_000)).toBe(true);
    expect(alert.observe(30_001, 10 * 60_000)).toBe(false);
    expect(alert.observe(30_001, 20 * 60_000)).toBe(true);
  });

  it("resets sustained breach tracking when latency recovers", () => {
    const alert = new SustainedThresholdAlert(30_000, 5 * 60_000, 15 * 60_000);

    expect(alert.observe(30_001, 0)).toBe(false);
    expect(alert.observe(20_000, 4 * 60_000)).toBe(false);
    expect(alert.observe(30_001, 6 * 60_000)).toBe(false);
    expect(alert.observe(30_001, 10 * 60_000)).toBe(false);
    expect(alert.observe(30_001, 11 * 60_000)).toBe(true);
  });
});
