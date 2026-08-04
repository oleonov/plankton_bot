import { describe, it, expect, vi, afterEach } from "vitest";
import { PeriodicTimers } from "../periodic-timers.js";
import {
  RESOLUTION_TRACKER_HEALTHY_METRIC,
  RESOLUTION_TRACKER_UNAVAILABLE_CODE,
  startResolutionHealthWatcher,
} from "../modules/resolution/resolution-health-watcher.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeTimers(): PeriodicTimers {
  const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), child: () => log } as any;
  return new PeriodicTimers(log);
}

function makeFakes(initialHealthy: boolean) {
  const tracker = { healthy: vi.fn(() => initialHealthy) };
  const metricsWriter = { writeLatest: vi.fn() };
  const recordInfraAlert = vi.fn();
  return { tracker, metricsWriter, recordInfraAlert, timers: makeTimers() };
}

describe("startResolutionHealthWatcher", () => {
  it("emits initial health=1 and no alert when tracker is healthy", () => {
    const { tracker, metricsWriter, recordInfraAlert, timers } = makeFakes(true);
    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
      timers,
    });

    expect(metricsWriter.writeLatest).toHaveBeenCalledTimes(1);
    expect(metricsWriter.writeLatest).toHaveBeenCalledWith(RESOLUTION_TRACKER_HEALTHY_METRIC, 1);
    expect(recordInfraAlert).not.toHaveBeenCalled();

    watcher.stop();
  });

  it("emits initial health=0 and an infra_alert when tracker is unhealthy", () => {
    const { tracker, metricsWriter, recordInfraAlert, timers } = makeFakes(false);
    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
      timers,
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
    const { tracker, metricsWriter, recordInfraAlert, timers } = makeFakes(false);
    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 30 * 60 * 1000,
      timers,
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
    const { tracker, metricsWriter, recordInfraAlert, timers } = makeFakes(false);
    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
      timers,
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
    const timers = makeTimers();

    const watcher = startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
      timers,
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

  it("registers its tick so teardown's stopAll() cancels it", () => {
    // Nobody keeps this watcher's handle: the entrypoint discards the returned `stop`. With a bare
    // `setInterval` the only thing that could cancel it is a call site that does not exist, so the
    // tick keeps writing to the ledger across the whole supervisor teardown — and an escaping
    // SQLITE_BUSY from that write ends the process before the final flush and `process.exit(0)`.
    vi.useFakeTimers();
    const { tracker, metricsWriter, recordInfraAlert, timers } = makeFakes(false);
    startResolutionHealthWatcher({
      tracker,
      metricsWriter,
      recordInfraAlert,
      intervalMs: 60_000,
      timers,
    });

    expect(metricsWriter.writeLatest).toHaveBeenCalledTimes(1);

    timers.stopAll();
    vi.advanceTimersByTime(60_000 * 5);

    expect(metricsWriter.writeLatest).toHaveBeenCalledTimes(1);
  });
});
