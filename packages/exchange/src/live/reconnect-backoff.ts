/**
 * Exponential backoff with optional full jitter for WebSocket reconnect delays.
 *
 * Full jitter: delay = random in [0, min(base * 2^attempts, max)]
 * Breaks synchronised reconnect storms when multiple shards flap together.
 */

export interface ReconnectBackoffOpts {
  baseMs: number;
  maxMs: number;
  /** "full" (default) applies random jitter; "none" is deterministic for tests. */
  jitter?: "full" | "none";
}

export function computeReconnectDelayMs(attempts: number, opts: ReconnectBackoffOpts): number {
  const { baseMs, maxMs, jitter = "full" } = opts;
  const cap = Math.min(baseMs * Math.pow(2, attempts), maxMs);
  if (jitter === "none") return cap;
  return Math.random() * cap;
}
