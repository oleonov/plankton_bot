/**
 * Resolution-tracker health watcher — surfaces tracker.healthy() to operators.
 *
 * Fail-closed semantics live in the tracker itself + BUY-admission guards.
 * This watcher is the operational signal: if the tracker is unhealthy, every
 * BUY is silently rejected with `resolution_tracker_unavailable`. Without a
 * loud signal, that degraded mode is invisible to operators.
 *
 * Two outputs:
 *   1. `entry_guard_resolution_tracker_healthy` runtime metric (0|1, latest) —
 *      cheap numerical sample for dashboards / alerting scripts.
 *   2. `infra_alert` re-emission with code=`resolution_tracker_unavailable`
 *      every `intervalMs`. The status route's lookback is 60 minutes, so a
 *      smaller interval keeps the banner sticky for as long as the tracker
 *      stays unhealthy.
 */

import type { TimerRegistry } from "../../periodic-timers.js";
import type { MarketResolutionTracker } from "./market-resolution-tracker.js";

export interface ResolutionHealthMetricsWriter {
  writeLatest: (
    metricName: string,
    value: number,
    labels?: string | null,
    capturedAt?: string,
  ) => void;
}

export interface ResolutionHealthInfraAlert {
  code: string;
  severity: "warning" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export interface StartResolutionHealthWatcherOptions {
  tracker: Pick<MarketResolutionTracker, "healthy">;
  metricsWriter: ResolutionHealthMetricsWriter;
  recordInfraAlert: (alert: ResolutionHealthInfraAlert) => void;
  /** Re-emission cadence for the `infra_alert` row + health flag refresh. */
  intervalMs: number;
  /**
   * The watcher is owned by the entrypoint, not by the supervisor, so nothing else cancels it. Its
   * tick writes to the ledger, and a write that loses the lock throws `SQLITE_BUSY` with no handler
   * above a bare interval — during teardown that kills the process while `shutdown()` is still
   * awaiting the supervisor. Registering here buys both: the tick is wrapped, and `stopAll()`
   * cancels it before the long await instead of after it.
   */
  timers: TimerRegistry;
}

export const RESOLUTION_TRACKER_HEALTHY_METRIC = "entry_guard_resolution_tracker_healthy";
export const RESOLUTION_TRACKER_UNAVAILABLE_CODE = "resolution_tracker_unavailable";

export function startResolutionHealthWatcher(opts: StartResolutionHealthWatcherOptions): {
  stop: () => void;
} {
  const emit = () => {
    const healthy = opts.tracker.healthy();
    opts.metricsWriter.writeLatest(RESOLUTION_TRACKER_HEALTHY_METRIC, healthy ? 1 : 0);
    if (!healthy) {
      opts.recordInfraAlert({
        code: RESOLUTION_TRACKER_UNAVAILABLE_CODE,
        severity: "error",
        source: "market-resolution-tracker",
        message:
          "BUY orders blocked: resolution tracker unavailable — investigate ledger DB or restart runtime",
      });
    }
  };

  // The first emission is deliberately NOT wrapped: it runs at boot, where a failing metrics write
  // means the ledger is unusable and the runtime must not come up pretending it is healthy.
  emit();
  const handle = opts.timers.every("resolution_health", opts.intervalMs, emit);
  if (typeof handle.unref === "function") handle.unref();
  return {
    stop: () => clearInterval(handle),
  };
}
