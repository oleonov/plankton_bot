// Transport-layer error patterns shared inside the exchange package.
//
// A richer copy of these patterns lives in `apps/runtime/src/network-errors.ts`.
// The runtime copy cannot be imported here (apps/runtime is a higher layer than
// packages/exchange), so this module is the canonical pattern source for the
// exchange layer and is reused by `clob-error-classifier.ts`. Consolidating the
// two copies into a shared package is tracked as a separate cleanup task (OQ10).
export const TRANSIENT_NETWORK_ERROR_PATTERN =
  /ECONNRESET|ECONNABORTED|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|ETIMEDOUT|ENOTFOUND|socket hang up|timed out|operation was aborted|UND_ERR_|fetch failed|getaddrinfo|TimeoutError/i;

// 429/408 carry an HTTP response, so the CLOB client's built-in
// `isTransientAxiosError` misses them. We treat them as transient explicitly.
export const RATE_LIMIT_ERROR_PATTERN = /(?:\b429\b|too many requests|rate.?limit)/i;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isTransientNetworkError(err: unknown): boolean {
  return TRANSIENT_NETWORK_ERROR_PATTERN.test(messageOf(err));
}

export function isRateLimitError(err: unknown): boolean {
  return RATE_LIMIT_ERROR_PATTERN.test(messageOf(err));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
