const TRANSIENT_NETWORK_ERROR_PATTERN =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timed out|UND_ERR_|fetch failed|getaddrinfo|TimeoutError|operation was aborted due to timeout/i;
const RATE_LIMIT_ERROR_PATTERN =
  /(?:\b429\b|Too Many Requests|rate.?limit|Gamma pricing request failed: 429|Gamma API responded with 429)/i;

export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_NETWORK_ERROR_PATTERN.test(message) || RATE_LIMIT_ERROR_PATTERN.test(message);
}

export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_ERROR_PATTERN.test(message);
}
