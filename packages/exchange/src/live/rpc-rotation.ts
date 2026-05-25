/**
 * Shared Polygon read-path RPC rotator.
 *
 * Round-robin across `primaryUrls` (Alchemy keys), failing over to the next
 * endpoint on HTTP 429 within a single call. The `fallbackUrls` tier (e.g. dRPC)
 * sits OUTSIDE the round-robin circle: it is tried only after every primary in
 * the current call returned 429, and the round-robin cursor never lands on it.
 *
 * The cursor is reserved (advanced) synchronously before the network await so
 * concurrent calls fan out across endpoints; on success it advances past the
 * endpoint that actually served the request.
 */

export interface RpcRotatorOptions {
  primaryUrls: readonly string[];
  fallbackUrls?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  logger?: {
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export interface EthCallContext {
  /** Caller label threaded into structured logs (and, later, metric labels). */
  source: string;
}

export interface RpcRotator {
  ethCall(to: string, data: string, ctx: EthCallContext): Promise<`0x${string}`>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /(?:\b429\b|too many requests|rate limit|quota exceeded)/i.test(message);
}

export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/");
    const last = parts.at(-1);
    // segments ≤8 chars are path components (e.g. /v2), not API keys
    if (last && last.length > 8)
      parts[parts.length - 1] = `${last.slice(0, 4)}...${last.slice(-4)}`;
    parsed.pathname = parts.join("/");
    parsed.search = "";
    return parsed.toString();
  } catch {
    return "<invalid-rpc-url>";
  }
}

/** Single eth_call against one endpoint; also exported for callers that want single-endpoint semantics (no rotation). */
export async function ethCallOnce(
  rpcUrl: string,
  to: string,
  data: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<`0x${string}`> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`RPC HTTP ${response.status}: ${response.statusText}${body ? ` ${body}` : ""}`);
  }
  const json = (await response.json()) as { result?: string; error?: { message?: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message ?? "unknown"}`);
  if (typeof json.result !== "string" || !json.result.startsWith("0x")) {
    throw new Error(`RPC returned unexpected result: ${JSON.stringify(json.result)}`);
  }
  return json.result as `0x${string}`;
}

export function createRpcRotator(opts: RpcRotatorOptions): RpcRotator {
  const primaryUrls = [...opts.primaryUrls];
  if (primaryUrls.length === 0) {
    throw new Error("createRpcRotator requires at least one primary RPC URL");
  }
  const fallbackUrls = [...(opts.fallbackUrls ?? [])];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger = opts.logger ?? {
    // eslint-disable-next-line no-console
    warn: (m, meta) => console.warn(m, meta),
  };
  let cursor = 0;

  async function tryTier(
    urls: readonly string[],
    startOffset: number,
    to: string,
    data: string,
    ctx: EthCallContext,
    onSuccess: (index: number) => void,
  ): Promise<{ ok: true; result: `0x${string}` } | { ok: false; lastErr: unknown }> {
    let lastErr: unknown;
    for (let offset = 0; offset < urls.length; offset += 1) {
      const index = (startOffset + offset) % urls.length;
      const url = urls[index]!; // index ∈ [0, urls.length) by construction
      try {
        const result = await ethCallOnce(url, to, data, fetchImpl, timeoutMs);
        onSuccess(index);
        return { ok: true, result };
      } catch (err) {
        if (!isRateLimitError(err)) throw err; // non-429 propagates immediately
        lastErr = err; // only reached for 429s
        logger.warn("rpc-rotation: endpoint rate limited, trying next", {
          source: ctx.source,
          rpcUrl: redactRpcUrl(url),
        });
      }
    }
    return { ok: false, lastErr };
  }

  return {
    async ethCall(to, data, ctx) {
      // Reserve a start index synchronously (before any await) so concurrent
      // callers fan out across primaries instead of all reading the same cursor.
      const start = cursor;
      cursor = (start + 1) % primaryUrls.length;

      const primary = await tryTier(primaryUrls, start, to, data, ctx, (index) => {
        // Advance past the endpoint that actually served the call so the next
        // sequential call skips it (covers the in-call 429-failover edge case).
        cursor = (index + 1) % primaryUrls.length;
      });
      if (primary.ok) return primary.result;

      // All primaries returned 429 → last-resort fallback tier (not in the circle).
      if (fallbackUrls.length > 0) {
        const fb = await tryTier(fallbackUrls, 0, to, data, ctx, () => {});
        if (fb.ok) return fb.result;
        throw fb.lastErr instanceof Error ? fb.lastErr : new Error(String(fb.lastErr));
      }
      throw primary.lastErr instanceof Error ? primary.lastErr : new Error(String(primary.lastErr));
    },
  };
}
