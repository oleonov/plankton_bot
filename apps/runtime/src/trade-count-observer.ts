/**
 * Observer factory for DataApiTradeCountProvider.
 *
 * Emits `runtime_metrics` events for both successful and failed fetches so
 * operators can compute the true error rate as
 *   err / (ok + err)
 * over any time window. Without the success counter the bot logs only
 * `trade_count_fetch_error` warns, leaving the denominator unknown.
 *
 * Cache hits/misses are deliberately ignored — they describe demand, not
 * provider health.
 *
 * Side-effect failures (SQLite SQLITE_BUSY, I/O error on the metrics writer,
 * a logger throwing under disk-pressure) MUST NOT propagate. The observer is
 * called from DataApiTradeCountProvider's hot path; if a throw escapes here,
 * `prefetch`'s `Promise.all` rejects and AlgoDecisionModule's continuation
 * sweep fails. The provider contract is that errors collapse to `null`, not
 * propagate — observers that mutate persistent state must honor that.
 */
import type { TradeCountFetchEvent, TradeCountObserver } from "@krabs/exchange";
import type { Logger } from "./logger.js";
import { classifyHttpError } from "./network-errors.js";
import type { RuntimeMetricWriter } from "./runtime-metric-writer.js";
import { consumeWarnThrottle, createWarnThrottleState } from "./warn-throttle.js";

const TRADE_COUNT_FETCH_ERROR_WARN_THROTTLE_MS = 10 * 60_000;

export interface TradeCountObserverDeps {
  log: Logger;
  metrics: RuntimeMetricWriter;
  now?: () => number;
  warnThrottleMs?: number;
}

export function buildTradeCountObserver(deps: TradeCountObserverDeps): TradeCountObserver {
  const { log, metrics } = deps;
  const now = deps.now ?? Date.now;
  const warnThrottleMs = deps.warnThrottleMs ?? TRADE_COUNT_FETCH_ERROR_WARN_THROTTLE_MS;
  const fetchErrorWarn = createWarnThrottleState();
  const writeMetric = (name: string, labels: string): void => {
    try {
      metrics.writeEvent(name, 1, labels);
    } catch (err) {
      try {
        log.warn(
          { metric: name, error: err instanceof Error ? err.message : String(err) },
          "trade_count_observer_metric_write_failed",
        );
      } catch {
        // Logger itself failed — swallow so the provider hot path stays alive.
      }
    }
  };
  const warnFetchError = (event: TradeCountFetchEvent): void => {
    const suppressedCount = consumeWarnThrottle(fetchErrorWarn, now(), warnThrottleMs);
    if (suppressedCount == null) return;
    try {
      log.warn(
        {
          conditionId: event.conditionId,
          error: event.error,
          latencyMs: event.latencyMs,
          suppressedCount,
        },
        "trade_count_fetch_error",
      );
    } catch {
      // Logger throw must not mask metric emission by the caller.
    }
  };
  return (event: TradeCountFetchEvent): void => {
    if (event.type === "fetch_ok") {
      writeMetric("trade_count_fetch_ok", JSON.stringify({ latencyMs: event.latencyMs ?? null }));
      return;
    }
    if (event.type === "fetch_error") {
      warnFetchError(event);
      writeMetric(
        "trade_count_fetch_err",
        JSON.stringify({ latencyMs: event.latencyMs ?? null, error: event.error ?? "unknown" }),
      );
      try {
        metrics.writeCounter(
          "http_error_class",
          1,
          JSON.stringify({
            source: "data-api-trade-count",
            errorClass: classifyHttpError(event.error ?? "unknown"),
          }),
        );
      } catch {
        // Same contract as writeMetric: observer failures cannot affect provider behavior.
      }
    }
  };
}
