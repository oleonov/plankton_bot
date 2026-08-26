/**
 * Classifies CLOB read-call failures into a {@link FetchReason}, used by
 * `executeWithRetry` to decide whether to retry and by reconciliation to decide
 * whether a snapshot is reliable.
 *
 * Design (status-first), per analyst findings on `@polymarket/clob-client-v2`:
 *  - The client returns `{ error, status }` when `throwOnError=false` AND throws
 *    `ApiError`/`AxiosError`/plain `Error` otherwise — both shapes are handled.
 *  - Its built-in `isTransientAxiosError` MISSES 429/408 (they carry a response),
 *    so a rate-limit storm would disable retries. We catch 429/408 explicitly.
 *
 * Order of precedence: parse → HTTP status → socket code → message substrings
 * (permanent BEFORE transient) → unknown (conservative transient).
 */
import { FetchParseError, type FetchReason } from "./fetch-result.js";
import { TRANSIENT_NETWORK_ERROR_PATTERN, RATE_LIMIT_ERROR_PATTERN } from "./network-errors.js";
import { classifyExchangeRejectionReason } from "./exchange-rejection-classifier.js";

export { FetchParseError, type FetchReason };

// Socket-level error codes (err.code) are unambiguously transient connectivity
// faults. Reuses the shared transport pattern so the code list has one home.
const SOCKET_CODE_PATTERN = TRANSIENT_NETWORK_ERROR_PATTERN;

// Permanent business strings NOT already covered by classifyExchangeRejectionReason
// (which owns balance/min-size/post-only). Real prod strings from risk_events.
const PERMANENT_EXTRA_PATTERN =
  /invalid tick size|invalid amount|order_version_mismatch|signer is needed|api credentials are needed|invalid network|unsupported signer|unsupported order version|signature type|market is inactive|crosses book|\bnot active\b/i;

// Transient server-side strings (service degraded / not ready / 5xx text).
const SERVER_TRANSIENT_PATTERN =
  /not ready|service unavailable|bad gateway|gateway timeout|temporarily unavailable|try again|\b5\d\d\b/i;

// Transient timeout/socket strings.
const TIMEOUT_TRANSIENT_PATTERN =
  /socket hang up|timeout|timed out|fetch failed|getaddrinfo|operation was aborted/i;

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.status === "number") return e.status;
  if (typeof e.statusCode === "number") return e.statusCode;
  const resp = e.response as Record<string, unknown> | undefined;
  if (resp && typeof resp.status === "number") return resp.status;
  return undefined;
}

export function hasFetchStatus(err: unknown, expectedStatus: number): boolean {
  return extractStatus(err) === expectedStatus;
}

function extractCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (typeof e.error === "string") return e.error;
    if (typeof e.message === "string") return e.message;
  }
  return String(err);
}

// Reuse the order-rejection classifier for the business strings it already owns,
// avoiding a second copy of balance/min-size/post-only substrings.
function isPermanentBusinessRejection(message: string): boolean {
  const reason = classifyExchangeRejectionReason(message);
  return (
    reason === "rejection_balance_insufficient" ||
    reason === "rejection_min_size" ||
    reason === "rejection_post_only_cross" ||
    reason === "rejection_invalid_tick"
  );
}

export function classifyFetchError(err: unknown): FetchReason {
  if (err instanceof FetchParseError) return "parse";

  const status = extractStatus(err);
  if (status === 429 || status === 408) return "rate_limit";
  if (status !== undefined && status >= 500 && status <= 599) return "server";
  if (status !== undefined && status >= 400 && status <= 499) return "client";

  const code = extractCode(err);
  if (code && SOCKET_CODE_PATTERN.test(code)) return "timeout";

  const message = extractMessage(err);
  // Permanent BEFORE transient: a permanent business message must not be
  // re-routed to transient just because it contains a word like "timeout".
  if (isPermanentBusinessRejection(message) || PERMANENT_EXTRA_PATTERN.test(message)) {
    return "client";
  }
  if (RATE_LIMIT_ERROR_PATTERN.test(message)) return "rate_limit";
  if (SERVER_TRANSIENT_PATTERN.test(message)) return "server";
  if (TIMEOUT_TRANSIENT_PATTERN.test(message)) return "timeout";
  if (SOCKET_CODE_PATTERN.test(message)) return "timeout";

  return "unknown";
}

/** Retryable transient reasons. `client` (permanent) and `parse` (our bug) are not retried. */
export function isRetryableReason(reason: FetchReason): boolean {
  return reason !== "client" && reason !== "parse";
}

/**
 * Structured diagnostic snapshot of a fetch error. Reuses the same status/code/
 * message extraction as {@link classifyFetchError} so the operator-facing
 * "unknown reason" log carries exactly the fields the classifier inspected,
 * making it actionable for tuning the heuristics (#36 LOW 2).
 */
export function describeFetchError(err: unknown): {
  status?: number;
  code?: string;
  message: string;
} {
  const status = extractStatus(err);
  const code = extractCode(err);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    message: extractMessage(err),
  };
}
