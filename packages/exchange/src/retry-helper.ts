/**
 * Generic retry wrapper for exchange read calls. Shared by `getOpenOrdersResult`
 * and `getFillsResult` (DRY) so neither duplicates the retry/backoff/counter
 * logic. Retries only transient reasons; permanent (`client`) and parse failures
 * fail fast.
 */
import { describeFetchError, isRetryableReason } from "./clob-error-classifier.js";
import type { FetchReason, FetchResult } from "./fetch-result.js";

/**
 * Minimal structural logger (pino-compatible `warn(obj, msg)`). Declared here
 * rather than importing the runtime `Logger` so `packages/exchange` keeps its
 * dependency direction (no `apps/runtime` import).
 */
export interface RetryDiagnosticLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface ExecuteWithRetryConfig {
  /** Number of retries AFTER the initial attempt. Total attempts = retries + 1. */
  retries: number;
  /** Backoff (ms) before retry i. Falls back to the last entry if shorter. */
  backoffMs: number[];
  /** Injected so tests don't actually wait. */
  sleep: (ms: number) => Promise<void>;
  /** Distinguishes reliable read paths in diagnostics and metric labels. */
  source: "open_orders" | "fills" | "exact_order";
  /** Invoked once per retry — used to increment the retry counter. */
  onRetry?: (reason: FetchReason, source: "open_orders" | "fills" | "exact_order") => void;
  /**
   * Optional diagnostic sink. When an error classifies as `unknown` (the
   * conservative catch-all), the raw status/code/message are logged so the
   * operator can extend {@link classifyFetchError}'s heuristics (#36 LOW 2).
   */
  log?: RetryDiagnosticLogger | undefined;
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  classify: (err: unknown) => FetchReason,
  config: ExecuteWithRetryConfig,
): Promise<FetchResult<T>> {
  let attempts = 0;
  let lastReason: FetchReason = "unknown";

  for (let i = 0; i <= config.retries; i++) {
    attempts++;
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      const reason = classify(err);
      lastReason = reason;
      if (reason === "unknown") {
        config.log?.warn(
          { reason, source: config.source, details: describeFetchError(err) },
          "exchange fetch error classified as unknown — review classifier heuristics",
        );
      }
      if (!isRetryableReason(reason) || i === config.retries) {
        return { ok: false, reason, attempts };
      }
      config.onRetry?.(reason, config.source);
      const delay = config.backoffMs[Math.min(i, config.backoffMs.length - 1)] ?? 0;
      await config.sleep(delay);
    }
  }

  return { ok: false, reason: lastReason, attempts };
}
