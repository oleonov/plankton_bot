/**
 * Live MarketDataGateway — wraps @polymarket/clob-client-v2 for market catalog
 * and order book reads.
 *
 * The SDK ClobClient is accepted as `unknown` in the public config interface
 * to prevent SDK types from leaking into @krabs/domain consumers.
 */

import {
  createTokenId,
  type MarketDataGateway,
  type MarketPricingSnapshot,
  type MarketPricingStream,
  type MarketPricingStreamUpdate,
  type ClobMarket,
  type OrderBookSnapshot,
  type TokenId,
  type DepHealthRecorder,
  type TokenMinimumAuthority,
} from "@krabs/domain";
import { timeDepCall } from "../dep-health.js";
import { mapMarket, mapOrderBook, parseStringOrArray } from "../mappers.js";
import { isTransientNetworkError, sleep } from "../network-errors.js";
import { SharedMarketPricingStreamHub } from "./market-pricing-stream-hub.js";
import {
  defaultMarketDataWebSocketFactory,
  extractBookTokenId,
  parseOptionalIsoTimestamp,
  parseOptionalNumber,
  type MarketDataWebSocketLike,
} from "./market-data-stream-shared.js";

const GAMMA_PRICING_BASE_URL = "https://gamma-api.polymarket.com/markets";
const DEFAULT_CLOB_HOST = "https://clob.polymarket.com";
const BOOKS_PATH = "/books";
const BOOKS_BATCH_SIZE = 200;

function validBookIdentity(raw: unknown, tokenId: string, allowAbsent: boolean): boolean {
  if (!raw || typeof raw !== "object") return false;
  const book = raw as Record<string, unknown>;
  const supplied = ["asset_id", "token_id"].filter((key) => key in book);
  return supplied.length === 0 ? allowAbsent : supplied.every((key) => book[key] === tokenId);
}

// Transport-safety threshold to avoid 414 URI Too Large.
// Most HTTP servers/proxies accept up to 8KB; 3500 is conservative.
const MAX_URL_LENGTH = 3500;
const FETCH_MAX_RETRIES = 2;
const FETCH_RETRY_DELAY_MS = 250;
const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);

const PARAM_NAME = "clob_token_ids";
// "&clob_token_ids=" for subsequent params, "?clob_token_ids=" for the first
const PARAM_OVERHEAD = 1 + PARAM_NAME.length + 1; // separator + name + "="

/**
 * Splits token IDs into batches so that each resulting URL stays under maxUrlLength.
 * Assumes token IDs contain only URL-safe characters (digits for Polymarket),
 * so raw string length equals encoded length. If a single token ID exceeds
 * the limit on its own, it is sent as a solo batch (may exceed maxUrlLength).
 * Exported for testing.
 */
export function buildTokenIdBatches(
  baseUrl: string,
  tokenIds: string[],
  maxUrlLength: number,
): string[][] {
  if (tokenIds.length === 0) return [];

  const batches: string[][] = [];
  let current: string[] = [];
  // "baseUrl?" = base + 1
  let currentLen = baseUrl.length + 1;

  for (const id of tokenIds) {
    // First param uses "?", subsequent use "&" — both are 1 char, accounted for by PARAM_OVERHEAD
    const addition = PARAM_OVERHEAD + id.length;

    if (current.length > 0 && currentLen + addition > maxUrlLength) {
      batches.push(current);
      current = [];
      currentLen = baseUrl.length + 1;
    }

    // Single token exceeds limit on its own — send it alone rather than dropping it
    if (current.length === 0 && baseUrl.length + 1 + PARAM_OVERHEAD + id.length > maxUrlLength) {
      batches.push([id]);
      continue;
    }

    current.push(id);
    currentLen += addition;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export interface LiveMarketDataConfig {
  /** ClobClient instance — typed as unknown to avoid SDK type leakage. */
  client: unknown;
  /**
   * Optional slug filter — when provided, only markets whose slug matches
   * at least one pattern are kept during pagination. Reduces memory from
   * the full 40k+ catalog down to the relevant subset.
   */
  slugFilter?: ((slug: string) => boolean) | undefined;
  createWebSocket?: ((url: string) => MarketDataWebSocketLike) | undefined;
  /** Optional Phase-2 dependency-latency recorder (measure-only; no-op when absent). */
  depHealthRecorder?: DepHealthRecorder | null;
  /**
   * Target tradable-universe size (MARKET_DATA_MAX_TRACKED_TOKENS). Combined
   * with `maxWsShards` to derive per-shard subscription size:
   * `min(500, ceil(maxTokens / maxShards))`. If omitted, the stream falls
   * back to the internal 500/shard default.
   */
  maxTokens?: number | undefined;
  /** Hard cap on concurrent WS shards. Default: 20. */
  maxWsShards?: number | undefined;
  /** Max items in the per-shard ingress queue. Default: 256. */
  queueMax?: number | undefined;
  /** Emit a lag warning when drain-to-empty takes longer than this (ms). Default: 2000. */
  lagWarnMs?: number | undefined;
  /** Overflow policy on full queue. Default: "drop-oldest". */
  overflowPolicy?: "drop-oldest" | "reconnect" | undefined;
  /** Base reconnect delay ms. Default: 1000. */
  reconnectBaseMs?: number | undefined;
  /** Max reconnect delay ms cap. Default: 30000. */
  reconnectMaxMs?: number | undefined;
  /** Per-shard breaker: max reconnects per 60s window before opening. Default: 10. */
  shardBreakerReconnectsPerMin?: number | undefined;
  /** Per-shard breaker initial open window ms. Default: 120000. */
  shardBreakerOpenMs?: number | undefined;
  /** Per-shard breaker max open window ms (exponential cap). Default: 600000. */
  shardBreakerOpenMaxMs?: number | undefined;
  /** Stream-level quorum percent threshold (0–100). Default: 50. */
  circuitShardOpenPercent?: number | undefined;
  /** Stream-level quorum absolute floor of open shards required. Default: 3. */
  circuitOpenShardFloor?: number | undefined;
  /** Stream-level circuit open duration ms. Default: 120000. */
  circuitOpenMs?: number | undefined;
  /** Stable uptime ms before a breaker closes. Default: 30000. */
  streamStableMs?: number | undefined;
  /** Enable worker-backed market WS shards. Defaults to true for production sockets. */
  useWorkerShards?: boolean | undefined;
  /** Max number of dedicated WS workers; workers can own multiple shard sockets. */
  wsWorkerCount?: number | undefined;
}

/**
 * Derives the per-shard subscription ceiling from config:
 * `min(500, ceil(maxTokens / maxShards))`. The 500/shard ceiling is
 * Polymarket's documented per-socket cap and is preserved inside the stream
 * so a misconfigured env cannot put 5k tokens on one socket.
 * Returns undefined when neither knob is supplied — stream keeps its default.
 */
export function deriveMaxSubscriptionsPerConnection(
  maxTokens: number | undefined,
  maxWsShards: number | undefined,
): number | undefined {
  if (maxTokens === undefined || maxWsShards === undefined) return undefined;
  if (maxTokens <= 0 || maxWsShards <= 0) return undefined;
  const target = Math.ceil(maxTokens / maxWsShards);
  return Math.min(500, Math.max(1, target));
}

function chunkItems<T>(items: readonly T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

/** Sentinel cursor returned by the Polymarket CLOB when no more pages exist. */
const END_CURSOR = "LTE=";

export class LiveMarketDataGateway implements MarketDataGateway {
  private tokenMinimum: TokenMinimumAuthority | undefined;
  setTokenMinimumAuthority(authority: TokenMinimumAuthority): void {
    this.tokenMinimum = authority;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly clobHost: string;
  private readonly slugFilter: ((slug: string) => boolean) | undefined;
  private readonly createWebSocket: (url: string) => MarketDataWebSocketLike;
  private readonly sharedMarketStreamHub: SharedMarketPricingStreamHub;
  private readonly depHealthRecorder: DepHealthRecorder | null;

  constructor(config: LiveMarketDataConfig) {
    this.client = config.client;
    this.depHealthRecorder = config.depHealthRecorder ?? null;
    const clientHost =
      typeof (config.client as { host?: unknown } | null)?.host === "string"
        ? (config.client as { host: string }).host
        : undefined;
    this.clobHost = (clientHost ?? DEFAULT_CLOB_HOST).replace(/\/+$/, "");
    this.slugFilter = config.slugFilter;
    this.createWebSocket = config.createWebSocket ?? defaultMarketDataWebSocketFactory;
    const derivedChunkSize = deriveMaxSubscriptionsPerConnection(
      config.maxTokens,
      config.maxWsShards,
    );
    this.sharedMarketStreamHub = new SharedMarketPricingStreamHub({
      createWebSocket: this.createWebSocket,
      ...(derivedChunkSize !== undefined
        ? { maxSubscriptionsPerConnection: derivedChunkSize }
        : {}),
      ...(config.queueMax !== undefined ? { queueMax: config.queueMax } : {}),
      ...(config.lagWarnMs !== undefined ? { lagWarnMs: config.lagWarnMs } : {}),
      ...(config.overflowPolicy !== undefined ? { overflowPolicy: config.overflowPolicy } : {}),
      ...(config.reconnectBaseMs !== undefined ? { reconnectBaseMs: config.reconnectBaseMs } : {}),
      ...(config.reconnectMaxMs !== undefined ? { reconnectMaxMs: config.reconnectMaxMs } : {}),
      ...(config.shardBreakerReconnectsPerMin !== undefined
        ? { shardBreakerReconnectsPerMin: config.shardBreakerReconnectsPerMin }
        : {}),
      ...(config.shardBreakerOpenMs !== undefined
        ? { shardBreakerOpenMs: config.shardBreakerOpenMs }
        : {}),
      ...(config.shardBreakerOpenMaxMs !== undefined
        ? { shardBreakerOpenMaxMs: config.shardBreakerOpenMaxMs }
        : {}),
      ...(config.circuitShardOpenPercent !== undefined
        ? { circuitShardOpenPercent: config.circuitShardOpenPercent }
        : {}),
      ...(config.circuitOpenShardFloor !== undefined
        ? { circuitOpenShardFloor: config.circuitOpenShardFloor }
        : {}),
      ...(config.circuitOpenMs !== undefined ? { circuitOpenMs: config.circuitOpenMs } : {}),
      ...(config.streamStableMs !== undefined ? { streamStableMs: config.streamStableMs } : {}),
      useWorkerShards: config.useWorkerShards ?? config.createWebSocket === undefined,
      ...(config.wsWorkerCount !== undefined ? { wsWorkerCount: config.wsWorkerCount } : {}),
    });
  }

  /**
   * Fetches all active markets, paginating through the CLOB API.
   * Errors (including timeouts) propagate to the caller — this is intentional
   * so that `MarketDataModule.poll()` can distinguish "no markets" from "network failure".
   */
  async getMarkets(onPage?: (page: number) => Promise<void> | void): Promise<ClobMarket[]> {
    const markets: ClobMarket[] = [];
    let cursor: string | undefined;
    let pageNum = 0;

    do {
      // Timeout enforced by axios.defaults.timeout (45 s, set in apps/runtime/src/index.ts).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = await timeDepCall(
        this.depHealthRecorder,
        "clob",
        () => this.client.getMarkets(cursor),
        {
          // The SDK returns { error } instead of throwing — classify that as a failed call.
          isOk: (p: { error?: unknown; data?: unknown }) =>
            !(p?.error !== undefined && p?.data === undefined),
        },
      );
      pageNum++;
      // The SDK swallows axios errors and returns { error: "..." } instead of throwing.
      // Detect this and surface it so the poll is treated as a failure.
      if (page?.error !== undefined && page?.data === undefined) {
        throw new Error(`CLOB SDK error: ${page.error}`);
      }
      await onPage?.(pageNum);
      const data = Array.isArray(page) ? page : (page?.data ?? []);
      for (const raw of data) {
        const market = mapMarket(raw as Record<string, unknown>);
        if (!market.active) continue;
        if (this.slugFilter && !this.slugFilter(market.slug)) continue;
        markets.push(market);
      }
      cursor = page?.next_cursor;
    } while (cursor && cursor !== END_CURSOR);

    return markets;
  }

  async getMarket(conditionId: string): Promise<ClobMarket | null> {
    try {
      const raw = await this.client.getMarket(conditionId);
      if (!raw) return null;
      return mapMarket(raw as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  async getOrderBook(tokenId: TokenId): Promise<OrderBookSnapshot> {
    const request = this.tokenMinimum?.begin([String(tokenId)]);
    let minimum: number | null = null;
    try {
      const raw = await timeDepCall(this.depHealthRecorder, "clob", () =>
        this.client.getOrderBook(String(tokenId)),
      );
      const valid = validBookIdentity(raw, String(tokenId), true);
      const book = mapOrderBook(tokenId, valid ? (raw as Record<string, unknown>) : {});
      minimum = book.minOrderSize ?? null;
      return book;
    } catch {
      return mapOrderBook(tokenId, {});
    } finally {
      if (request) this.tokenMinimum?.complete(request, new Map([[String(tokenId), minimum]]));
    }
  }

  async getOrderBooks(tokenIds: string[]): Promise<Map<string, OrderBookSnapshot>> {
    const result = new Map<string, OrderBookSnapshot>();
    const batches = chunkItems(tokenIds, BOOKS_BATCH_SIZE);
    const url = `${this.clobHost}${BOOKS_PATH}`;
    for (const batch of batches) {
      const request = this.tokenMinimum?.begin(batch);
      const outcomes = new Map<string, number | null>(batch.map((id) => [id, null]));
      try {
        const response = await this.fetchWithRetry(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batch.map((tokenId) => ({ token_id: tokenId }))),
          },
          15_000,
        );
        if (!response.ok) {
          await drainResponseBody(response);
          throw new Error(`CLOB books request failed: ${response.status} ${response.statusText}`);
        }

        const books = (await response.json()) as Array<Record<string, unknown>>;
        const seen = new Set<string>();
        for (const raw of books) {
          const tokenId = extractBookTokenId(raw);
          const aliases = [raw.asset_id, raw.token_id].filter(
            (id): id is string => typeof id === "string" && batch.includes(id),
          );
          if (!tokenId || !batch.includes(tokenId) || !validBookIdentity(raw, tokenId, false)) {
            for (const id of aliases) {
              seen.add(id);
              outcomes.set(id, null);
              result.delete(id);
            }
            continue;
          }
          const book = mapOrderBook(createTokenId(tokenId), raw);
          const minimum = book.minOrderSize ?? null;
          if (seen.has(tokenId) && outcomes.get(tokenId) !== minimum) {
            outcomes.set(tokenId, null);
            result.delete(tokenId);
            continue;
          }
          seen.add(tokenId);
          outcomes.set(tokenId, minimum);
          result.set(tokenId, book);
        }
      } catch (error) {
        for (const id of batch) outcomes.set(id, null);
        throw error;
      } finally {
        if (request) this.tokenMinimum?.complete(request, outcomes);
      }
    }
    return result;
  }

  async getTickSize(tokenId: TokenId): Promise<number> {
    try {
      const raw = await timeDepCall(this.depHealthRecorder, "clob", () =>
        this.client.getTickSize(String(tokenId)),
      );
      return Number(raw);
    } catch {
      return 0.01;
    }
  }

  async getMarketPricing(
    tokenIds: string[],
    opts?: { timeoutMs?: number },
  ): Promise<Map<string, MarketPricingSnapshot>> {
    if (tokenIds.length === 0) return new Map();

    const result = new Map<string, MarketPricingSnapshot>();
    // Default to 15 s (legacy behaviour) when no caller-supplied timeout.
    const timeoutMs = opts?.timeoutMs ?? 15_000;

    const batches = buildTokenIdBatches(GAMMA_PRICING_BASE_URL, tokenIds, MAX_URL_LENGTH);
    for (const batch of batches) {
      const params = batch.map((id) => `clob_token_ids=${id}`).join("&");
      const url = `${GAMMA_PRICING_BASE_URL}?${params}`;
      const response = await this.fetchPricingBatchWithRetry(url, timeoutMs);
      if (!response.ok) {
        await drainResponseBody(response);
        throw new Error(`Gamma pricing request failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as Array<Record<string, unknown>>;
      this.extractPricing(data, result);
    }

    return result;
  }

  createMarketPricingStream(
    handlers: Readonly<{
      onUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
      onLifecycleEvents?: (
        events: readonly import("@krabs/domain").MarketPricingLifecycleEvent[],
      ) => Promise<void> | void;
      onError?: (error: unknown) => Promise<void> | void;
      onGapDetected?: (
        info: Readonly<{
          reason: "socket-closed" | "invalid-payload" | "connect-failed" | "pong-timeout";
          timestamp: number;
          tokenIds?: readonly string[];
        }>,
      ) => Promise<void> | void;
    }>,
  ): MarketPricingStream {
    return this.sharedMarketStreamHub.createStream(handlers);
  }

  private extractPricing(
    data: Array<Record<string, unknown>>,
    result: Map<string, MarketPricingSnapshot>,
  ): void {
    for (const raw of data) {
      const clobTokenIds = parseStringOrArray(raw.clobTokenIds);
      const lastTradePrice = parseOptionalNumber(raw.lastTradePrice);
      const lastTradeAt =
        parseOptionalIsoTimestamp(raw.lastTradeAt) ??
        parseOptionalIsoTimestamp(raw.last_trade_at) ??
        parseOptionalIsoTimestamp(raw.updatedAt) ??
        parseOptionalIsoTimestamp(raw.updated_at);
      // ADR-007: Historical Universe Filter uses lifetime volume as the
      // `trade_count > 0` proxy. Gamma exposes:
      //   • `volumeNum`  — lifetime cumulative (use this)
      //   • `volume24hr` — rolling 24h (would false-exclude dormant markets)
      // Domain field name kept as `volume24h` for backward-compat; see ADR-007.
      const volume24h = parseOptionalNumber(raw.volumeNum);
      // Step 3 (soft-ranking) needs rolling-24h volume, distinct from the
      // lifetime field above. Prefer `volume24hr`; fall back to
      // `volume24hrClob` (mirrors the training-side aliases — see
      // `research_plankton/soft_ranking_score_analysis.py:545`).
      const volume24hr =
        parseOptionalNumber(raw.volume24hr) ?? parseOptionalNumber(raw.volume24hrClob);
      const liquidity = parseOptionalNumber(raw.liquidity);

      // Gamma provides market-level bestBid/bestAsk (for the first outcome token).
      const marketBestBid = parseOptionalNumber(raw.bestBid);
      const marketBestAsk = parseOptionalNumber(raw.bestAsk);

      // Fail-closed: undefined/null/non-boolean collapses to false.
      const acceptingOrders = raw.acceptingOrders === true;
      const enableOrderBook = raw.enableOrderBook === true;

      for (let i = 0; i < clobTokenIds.length; i++) {
        const tokenId = clobTokenIds[i]!;

        // Gamma's market-level bestBid/bestAsk represent the primary outcome.
        // Secondary outcomePrices are mid/probability hints, not executable
        // book edges, so leave bid/ask null until CLOB book data supplies them.
        const bestBid = i === 0 ? marketBestBid : null;
        const bestAsk = i === 0 ? marketBestAsk : null;

        result.set(tokenId, {
          bestBid,
          bestAsk,
          lastTradePrice,
          lastTradeAt,
          volume24h,
          volume24hr,
          liquidity,
          minOrderSize: result.get(tokenId)?.minOrderSize ?? null,
          bookSource:
            i === 0 && marketBestBid !== null && marketBestAsk !== null
              ? "gamma"
              : "gamma-fallback",
          acceptingOrders,
          enableOrderBook,
        });
      }
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.getOk();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  private async fetchWithRetry(
    input: string,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    for (let attempt = 1; attempt <= FETCH_MAX_RETRIES; attempt++) {
      try {
        // AbortSignal.timeout aborts the underlying undici request so the
        // TCP socket is released on timeout. Promise.race leaves it orphaned
        // with the response body stuck in Recv-Q until kernel GC — see
        // CLOSE-WAIT leak investigation 2026-04-22.
        return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt === FETCH_MAX_RETRIES || !isTransientNetworkError(err)) {
          throw err;
        }
        await sleep(FETCH_RETRY_DELAY_MS * attempt);
      }
    }
    throw new Error("unreachable");
  }

  private async fetchPricingBatchWithRetry(input: string, timeoutMs: number): Promise<Response> {
    for (let attempt = 1; attempt <= FETCH_MAX_RETRIES; attempt++) {
      const response = await this.fetchWithRetry(input, undefined, timeoutMs);
      if (
        response.ok ||
        !RETRYABLE_HTTP_STATUSES.has(response.status) ||
        attempt === FETCH_MAX_RETRIES
      ) {
        return response;
      }
      await drainResponseBody(response);
      await sleep(FETCH_RETRY_DELAY_MS * attempt);
    }
    throw new Error("unreachable");
  }
}

/**
 * Drain a Response body so its underlying socket is released back to the pool
 * instead of sitting in CLOSE-WAIT with unread bytes in the kernel Recv-Q.
 * Call before throwing / returning early on a non-OK response.
 */
export async function drainResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Ignore — the socket will be reclaimed when the Response is GC'd, the
    // cancel() just speeds it up. Don't let a drain failure mask the real
    // response error.
  }
}
