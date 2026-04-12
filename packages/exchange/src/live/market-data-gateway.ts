/**
 * Live MarketDataGateway — wraps @polymarket/clob-client for market catalog
 * and order book reads.
 *
 * The SDK ClobClient is accepted as `unknown` in the public config interface
 * to prevent SDK types from leaking into @plankton/domain consumers.
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
} from "@plankton/domain";
import { mapMarket, mapOrderBook, parseStringOrArray } from "../mappers.js";

const GAMMA_PRICING_BASE_URL = "https://gamma-api.polymarket.com/markets";
const CLOB_ORDER_BOOKS_URL = "https://clob.polymarket.com/books";
const CLOB_MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const BOOKS_BATCH_SIZE = 200;
const WS_RECONNECT_DELAY_MS = 1_000;

// Transport-safety threshold to avoid 414 URI Too Large.
// Most HTTP servers/proxies accept up to 8KB; 3500 is conservative.
const MAX_URL_LENGTH = 3500;

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
}

interface MarketDataWebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
}

function chunkItems<T>(items: readonly T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function parseOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalIsoTimestamp(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return new Date(numeric).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function extractBookTokenId(raw: Record<string, unknown>): string | null {
  if (typeof raw.asset_id === "string") return raw.asset_id;
  if (typeof raw.token_id === "string") return raw.token_id;
  return null;
}

/** Sentinel cursor returned by the Polymarket CLOB when no more pages exist. */
const END_CURSOR = "LTE=";

export class LiveMarketDataGateway implements MarketDataGateway {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly client: any;
  private readonly slugFilter: ((slug: string) => boolean) | undefined;
  private readonly createWebSocket: (url: string) => MarketDataWebSocketLike;

  constructor(config: LiveMarketDataConfig) {
    this.client = config.client;
    this.slugFilter = config.slugFilter;
    this.createWebSocket = config.createWebSocket ?? defaultWebSocketFactory;
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const page: any = await this.withTimeout(this.client.getMarkets(cursor), 30_000);
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
      const raw = await this.withTimeout(this.client.getMarket(conditionId), 10_000);
      if (!raw) return null;
      return mapMarket(raw as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  async getOrderBook(tokenId: TokenId): Promise<OrderBookSnapshot> {
    try {
      const raw = await this.withTimeout(this.client.getOrderBook(String(tokenId)), 10_000);
      return mapOrderBook(tokenId, raw as Record<string, unknown>);
    } catch {
      return mapOrderBook(tokenId, {});
    }
  }

  async getOrderBooks(tokenIds: string[]): Promise<Map<string, OrderBookSnapshot>> {
    const result = new Map<string, OrderBookSnapshot>();
    const batches = chunkItems(tokenIds, BOOKS_BATCH_SIZE);
    for (const batch of batches) {
      const response = await this.withTimeout(
        fetch(CLOB_ORDER_BOOKS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch.map((tokenId) => ({ token_id: tokenId }))),
        }),
        15_000,
      );
      if (!response.ok) {
        throw new Error(`CLOB books request failed: ${response.status} ${response.statusText}`);
      }

      const books = (await response.json()) as Array<Record<string, unknown>>;
      for (const raw of books) {
        const tokenId = extractBookTokenId(raw);
        if (!tokenId) continue;
        result.set(tokenId, mapOrderBook(createTokenId(tokenId), raw));
      }
    }
    return result;
  }

  async getTickSize(tokenId: TokenId): Promise<number> {
    try {
      const raw = await this.withTimeout(this.client.getTickSize(String(tokenId)), 10_000);
      return Number(raw);
    } catch {
      return 0.01;
    }
  }

  async getMarketPricing(tokenIds: string[]): Promise<Map<string, MarketPricingSnapshot>> {
    if (tokenIds.length === 0) return new Map();

    const result = new Map<string, MarketPricingSnapshot>();

    const batches = buildTokenIdBatches(GAMMA_PRICING_BASE_URL, tokenIds, MAX_URL_LENGTH);
    for (const batch of batches) {
      const params = batch.map((id) => `clob_token_ids=${id}`).join("&");
      const url = `${GAMMA_PRICING_BASE_URL}?${params}`;
      const response = await this.withTimeout(fetch(url), 15_000);
      if (!response.ok) {
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
      onError?: (error: unknown) => Promise<void> | void;
    }>,
  ): MarketPricingStream {
    return new LiveMarketPricingStream({
      createWebSocket: this.createWebSocket,
      handlers,
    });
  }

  private extractPricing(
    data: Array<Record<string, unknown>>,
    result: Map<string, MarketPricingSnapshot>,
  ): void {
    for (const raw of data) {
      const clobTokenIds = parseStringOrArray(raw.clobTokenIds);
      const outcomePrices = parseStringOrArray(raw.outcomePrices);
      const lastTradePrice = parseOptionalNumber(raw.lastTradePrice);
      const lastTradeAt =
        parseOptionalIsoTimestamp(raw.lastTradeAt) ??
        parseOptionalIsoTimestamp(raw.last_trade_at) ??
        parseOptionalIsoTimestamp(raw.updatedAt) ??
        parseOptionalIsoTimestamp(raw.updated_at);
      const volume24h = parseOptionalNumber(raw.volume24hr);
      const liquidity = parseOptionalNumber(raw.liquidity);

      // Gamma provides market-level bestBid/bestAsk (for the first outcome token).
      const marketBestBid = parseOptionalNumber(raw.bestBid);
      const marketBestAsk = parseOptionalNumber(raw.bestAsk);

      for (let i = 0; i < clobTokenIds.length; i++) {
        const tokenId = clobTokenIds[i]!;
        const outcomePrice =
          i < outcomePrices.length ? parseOptionalNumber(outcomePrices[i]) : null;

        // First token gets Gamma's real bestBid/bestAsk. Subsequent tokens
        // fall back to outcomePrices (Gamma only exposes top-of-book for the primary outcome).
        const bestBid =
          i === 0 && marketBestBid !== null
            ? marketBestBid
            : outcomePrice !== null
              ? outcomePrice
              : null;
        const bestAsk =
          i === 0 && marketBestAsk !== null
            ? marketBestAsk
            : outcomePrice !== null
              ? outcomePrice
              : null;

        result.set(tokenId, {
          bestBid,
          bestAsk,
          lastTradePrice,
          lastTradeAt,
          volume24h,
          liquidity,
          minOrderSize: result.get(tokenId)?.minOrderSize ?? null,
          bookSource:
            i === 0 && marketBestBid !== null && marketBestAsk !== null
              ? "gamma"
              : "gamma-fallback",
        });
      }
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.withTimeout(this.client.getOk(), 10_000);
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`request timed out after ${ms}ms`)), ms);
      promise.then(
        (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }
}

function defaultWebSocketFactory(url: string): MarketDataWebSocketLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => MarketDataWebSocketLike }).WebSocket;
  if (!ctor) {
    throw new Error("WebSocket is not available in the current runtime");
  }
  return new ctor(url);
}

class LiveMarketPricingStream implements MarketPricingStream {
  private readonly pricingByToken = new Map<string, MarketPricingSnapshot>();
  private tokenIds: string[] = [];
  private socket: MarketDataWebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly deps: Readonly<{
      createWebSocket: (url: string) => MarketDataWebSocketLike;
      handlers: Readonly<{
        onUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
        onError?: (error: unknown) => Promise<void> | void;
      }>;
    }>,
  ) {}

  setTokenIds(tokenIds: readonly string[]): void {
    const next = [...new Set(tokenIds)].filter((tokenId) => tokenId.length > 0).sort();
    if (sameTokenList(this.tokenIds, next)) return;
    this.tokenIds = next;
    if (this.tokenIds.length === 0) {
      this.closeSocket();
      return;
    }
    this.reconnect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    this.pricingByToken.clear();
  }

  private reconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
    try {
      const socket = this.deps.createWebSocket(CLOB_MARKET_WS_URL);
      this.socket = socket;
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: "market",
            assets_ids: this.tokenIds,
            custom_feature_enabled: true,
          }),
        );
      };
      socket.onmessage = (event) => {
        void this.handleMessage(event.data);
      };
      socket.onerror = (event) => {
        void this.deps.handlers.onError?.(event);
      };
      socket.onclose = () => {
        this.socket = null;
        if (this.closed || this.tokenIds.length === 0) return;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.reconnect();
        }, WS_RECONNECT_DELAY_MS);
      };
    } catch (error) {
      void this.deps.handlers.onError?.(error);
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      const text = normalizeWebSocketPayload(data);
      if (!text) return;
      const parsed = JSON.parse(text) as unknown;
      const updates = collectStreamUpdates(parsed, this.pricingByToken);
      if (updates.length === 0) return;
      await this.deps.handlers.onUpdates(updates);
    } catch (error) {
      await this.deps.handlers.onError?.(error);
    }
  }
}

function sameTokenList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function normalizeWebSocketPayload(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(data));
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  return null;
}

function collectStreamUpdates(
  payload: unknown,
  pricingByToken: Map<string, MarketPricingSnapshot>,
): MarketPricingStreamUpdate[] {
  const records = Array.isArray(payload) ? payload : [payload];
  const updates: MarketPricingStreamUpdate[] = [];

  for (const entry of records) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const eventType = typeof raw.event_type === "string" ? raw.event_type : "";
    const tokenId = extractBookTokenId(raw);
    if (!tokenId) continue;

    const current = pricingByToken.get(tokenId) ?? {
      bestBid: null,
      bestAsk: null,
      lastTradePrice: null,
      lastTradeAt: null,
      volume24h: null,
      liquidity: null,
      minOrderSize: null,
      bookSource: "clob" as const,
    };

    if (eventType === "book") {
      const book = mapOrderBook(createTokenId(tokenId), raw);
      const next: MarketPricingSnapshot = {
        ...current,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        minOrderSize: book.minOrderSize ?? current.minOrderSize ?? null,
        bookSource: "clob",
      };
      pricingByToken.set(tokenId, next);
      updates.push({ tokenId, pricing: next, book });
      continue;
    }

    if (eventType === "best_bid_ask") {
      const next: MarketPricingSnapshot = {
        ...current,
        bestBid: parseOptionalNumber(raw.best_bid),
        bestAsk: parseOptionalNumber(raw.best_ask),
        bookSource: "clob",
      };
      pricingByToken.set(tokenId, next);
      updates.push({ tokenId, pricing: next });
      continue;
    }

    if (eventType === "last_trade_price" || eventType === "price_change") {
      const next: MarketPricingSnapshot = {
        ...current,
        lastTradePrice: parseOptionalNumber(raw.price),
        lastTradeAt: parseOptionalIsoTimestamp(raw.timestamp) ?? current.lastTradeAt ?? null,
        bookSource: "clob",
      };
      pricingByToken.set(tokenId, next);
      updates.push({ tokenId, pricing: next });
    }
  }

  return updates;
}
