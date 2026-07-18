// Gamma 403 (Forbidden) is treated as transient alongside 5xx: Gamma returns it for
// rate-limiting/WAF throttling. Scoped to the Gamma-prefixed message so a bare/CLOB/order
// 403 is not reclassified. A permanent 403 surfaces via the scanner staleness health check.
const TRANSIENT_NETWORK_ERROR_PATTERN =
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|timed out|UND_ERR_|fetch failed|getaddrinfo|TimeoutError|operation was aborted due to timeout|Gamma pricing request failed: (?:403|5\d\d)|Gamma API responded with (?:403|5\d\d)/i;
const RATE_LIMIT_ERROR_PATTERN =
  /(?:\b429\b|Too Many Requests|rate.?limit|Gamma pricing request failed: 429|Gamma API responded with 429)/i;
const TIMEOUT_ERROR_PATTERN =
  /ETIMEDOUT|timed out|TimeoutError|operation was aborted due to timeout|AbortError/i;
const TLS_ERROR_PATTERN = /TLS|SSL|CERT|certificate|ECONNRESET|socket hang up/i;
const DNS_ERROR_PATTERN = /ENOTFOUND|getaddrinfo|EAI_AGAIN|DNS/i;

export type HttpErrorClass =
  | "rate_limit"
  | "timeout"
  | "tls_or_socket"
  | "dns"
  | "server_5xx"
  | "client_4xx"
  | "unknown";

export function isTransientNetworkError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_NETWORK_ERROR_PATTERN.test(message) || RATE_LIMIT_ERROR_PATTERN.test(message);
}

export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return RATE_LIMIT_ERROR_PATTERN.test(message);
}

export function classifyHttpError(err: unknown): HttpErrorClass {
  const message = err instanceof Error ? err.message : String(err);
  if (RATE_LIMIT_ERROR_PATTERN.test(message)) return "rate_limit";
  if (TIMEOUT_ERROR_PATTERN.test(message)) return "timeout";
  if (TLS_ERROR_PATTERN.test(message)) return "tls_or_socket";
  if (DNS_ERROR_PATTERN.test(message)) return "dns";
  if (/\b5\d\d\b/.test(message)) return "server_5xx";
  if (/\b4\d\d\b/.test(message)) return "client_4xx";
  return "unknown";
}
