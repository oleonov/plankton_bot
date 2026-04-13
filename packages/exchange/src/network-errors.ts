const TRANSIENT_NETWORK_ERROR_PATTERN =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timed out|UND_ERR_|fetch failed|getaddrinfo|TimeoutError/i;

export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_NETWORK_ERROR_PATTERN.test(message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
