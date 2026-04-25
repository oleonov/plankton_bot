import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RESOLUTION_TRACKER_HEALTHY_METRIC,
  RESOLUTION_TRACKER_UNAVAILABLE_CODE,
  startResolutionHealthWatcher,
} from "../modules/resolution/resolution-health-watcher.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeFakes(initialHealthy: boolean) {
  const tracker = { healthy: vi.fn(() => initialHealthy) };
  const metricsWriter = { writeLatest: vi.fn() };
  const recordInfraAlert = vi.fn();
  return { tracker, metricsWriter, recordInfraAlert };
}

describe("startResolutionHealthWatcher", () => {
  it("emits initial health=1 and no alert when tracker is healthy", () => {
    const { tracker, metricsWriter, recordInfraAlert } = makeFakes(true);
    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
    });

    expect(metricsWriter.writeLatest).toHaveBeenCalledTimes(1);
    expect(metricsWriter.writeLatest).toHaveBeenCalledWith(RESOLUTION_TRACKER_HEALTHY_METRIC, 1);
    expect(recordInfraAlert).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("emits initial health=0 and an infra_alert when tracker is unhealthy", () => {
    const { tracker, metricsWriter, recordInfraAlert } = makeFakes(false);
    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
    });

    expect(metricsWriter.writeLatest).toHaveBeenCalledWith(RESOLUTION_TRACKER_HEALTHY_METRIC, 0);
    expect(recordInfraAlert).toHaveBeenCalledTimes(1);
    expect(recordInfraAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: RESOLUTION_TRACKER_UNAVAILABLE_CODE,
        severity: "error",
        source: "market-resolution-tracker",
      }),
    );

    watcher.stop();
  });

  it("re-emits the alert and metric on every interval tick while unhealthy", () => {
    vi.useFakeTimers();
    const { tracker, metricsWriter, recordInfraAlert } = makeFakes(false);
    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 30 * 60 * 1000,
    });

    // 1 initial + 3 interval ticks
    vi.advanceTimersByTime(3 * 30 * 60 * 1000);

    expect(metricsWriter.writeLatest).toHaveBeenCalledTimes(4);
    expect(recordInfraAlert).toHaveBeenCalledTimes(4);
    for (const call of metricsWriter.writeLatest.mock.calls) {
      expect(call[0]).toBe(RESOLUTION_TRACKER_HEALTHY_METRIC);
      expect(call[1]).toBe(0);
    }

    watcher.stop();
  });

  it("stops emitting after stop() is called", () => {
    vi.useFakeTimers();
    const { tracker, metricsWriter, recordInfraAlert } = makeFakes(false);
    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
    });

    expect(metricsWriter.writeLatest).toHaveBeenCalledTimes(1);
    watcher.stop();

    vi.advanceTimersByTime(60_000 * 5);

    expect(metricsWriter.writeLatest).toHaveBeenCalledTimes(1);
    expect(recordInfraAlert).toHaveBeenCalledTimes(1);
  });

  it("re-reads tracker.healthy() on each tick (recovers from unhealthy → healthy)", () => {
    vi.useFakeTimers();
    let healthyState = false;
    const tracker = { healthy: vi.fn(() => healthyState) };
    const metricsWriter = { writeLatest: vi.fn() };
    const recordInfraAlert = vi.fn();

    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
    });

    // initial: unhealthy
    expect(metricsWriter.writeLatest).toHaveBeenLastCalledWith(
      RESOLUTION_TRACKER_HEALTHY_METRIC,
      0,
    );
    expect(recordInfraAlert).toHaveBeenCalledTimes(1);

    healthyState = true;
    vi.advanceTimersByTime(60_000);

    expect(metricsWriter.writeLatest).toHaveBeenLastCalledWith(
      RESOLUTION_TRACKER_HEALTHY_METRIC,
      1,
    );
    // alert NOT emitted on the recovery tick
    expect(recordInfraAlert).toHaveBeenCalledTimes(1);

    watcher.stop();
  });
});
