/**
 * Dependency-latency measurement wrapper (Phase 2a, measure-only).
 *
 * `timeDepCall` times an existing outbound gateway call with a monotonic clock
 * and reports latency + ok/fail to an injected {@link DepHealthRecorder}. It is
 * transparent: it returns exactly what the wrapped call returns, propagates a
 * throw unchanged, and a `record` failure can never affect the call. With no
 * recorder it is a zero-cost pass-through (simulation/tests).
 */

import { performance } from "node:perf_hooks";
import type { DepHealthRecorder, DepKey, FetchResult } from "@krabs/domain";

interface TimeDepCallOptions<T> {
  /** Classify the resolved value as ok/fail. Default: any resolved value is ok. */
  isOk?: (value: T) => boolean;
  /**
   * Whether a resolved value should be recorded at all. Default: always. Used to
   * skip no-op calls (e.g. a redeem that found nothing to submit — no real
   * network round-trip happened, so it must not pollute the dependency's latency).
   */
  shouldRecord?: (value: T) => boolean;
}

function safeRecord(
  recorder: DepHealthRecorder,
  dep: DepKey,
  latencyMs: number,
  ok: boolean,
): void {
  try {
    recorder.record(dep, latencyMs, ok);
  } catch {
    // Telemetry must never affect the trading call.
  }
}

export async function timeDepCall<T>(
  recorder: DepHealthRecorder | null | undefined,
  dep: DepKey,
  fn: () => Promise<T>,
  options?: TimeDepCallOptions<T>,
): Promise<T> {
  if (!recorder) return fn();
  const start = performance.now();
  try {
    const value = await fn();
    if (options?.shouldRecord?.(value) ?? true) {
      safeRecord(recorder, dep, performance.now() - start, options?.isOk?.(value) ?? true);
    }
    return value;
  } catch (err) {
    // A thrown error is always a failed call.
    safeRecord(recorder, dep, performance.now() - start, false);
    throw err;
  }
}

/** ok-classifier for the reliable read paths that return a {@link FetchResult}. */
export function fetchResultOk(result: FetchResult<unknown>): boolean {
  return result.ok;
}
