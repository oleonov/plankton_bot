/**
 * Gateway interfaces — pure abstractions over exchange I/O.
 *
 * Split into two interfaces per structural decision F2:
 *  - MarketDataGateway: read-only catalog and pricing (consumed by market-data module)
 *  - ExchangeGateway:   order lifecycle (consumed by execution engine and reconciliation)
 *
 * Rules:
 *  - All methods return Promises. No synchronous exchange calls.
 *  - Gateway methods never throw — errors are encoded in result objects.
 *  - tickSize and negRisk are mandatory on PlaceOrderParams (F2 decision).
 */

import type { TokenId } from "./ids.js";
import type { OrderSide, OrderType, ExchangeErrorCode, LiquidityRole } from "./enums.js";
import type { MarketBookSource, OrderBookSnapshot } from "./types.js";

// ─── Market catalog types ─────────────────────────────────────────────────

export interface ClobMarket {
  readonly conditionId: string;
  readonly tokens: ReadonlyArray<{
    readonly tokenId: string;
    /** "Yes" | "No" as returned by the Polymarket API. */
    readonly outcome: string;
    readonly outcomeIndex?: number;
  }>;
  readonly question: string;
  readonly slug: string;
  /** Event-level slug for Polymarket URL (e.g. "bitcoin-above-on-march-19"). */
  readonly eventSlug?: string;
  readonly endDate: string;
  readonly active: boolean;
  readonly negRisk: boolean;
  /** Minimum price increment (e.g., 0.01). */
  readonly tickSize: number;
  /** 24-hour trading volume in USD. Null when unavailable. */
  readonly volume24h: number | null;
}

// ─── Exchange order param / result types ──────────────────────────────────

export interface PlaceOrderParams {
  readonly clientOrderId: string;
  readonly tokenId: TokenId;
  readonly side: OrderSide;
  /** Share quantity. */
  readonly size: number;
  /** Limit price in [0, 1] range for binary markets. */
  readonly price: number;
  /** When true, the order must rest on the book and never cross as taker. */
  readonly postOnly?: boolean;
  readonly orderType: OrderType;
  /** Minimum price increment — required by Polymarket CLOB order signing. */
  readonly tickSize: number;
  /** Neg-risk flag — required by Polymarket CLOB order signing. */
  readonly negRisk: boolean;
  /** Unix seconds. Only used when orderType is "GTD". */
  readonly expiration?: number;
}

export interface CancelOrderParams {
  /** Exchange-assigned order ID. */
  readonly orderId: string;
}

export interface ExchangeOrder {
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly tokenId: TokenId;
  readonly side: OrderSide;
  readonly price: number;
  readonly sizeTotal: number;
  readonly sizeFilled: number;
  readonly sizeRemaining: number;
  readonly status: "OPEN" | "FILLED" | "PARTIALLY_FILLED" | "CANCELLED" | "EXPIRED";
  /** Unix milliseconds. */
  readonly createdAt: number;
}

export interface ExchangeFill {
  readonly fillId: string;
  readonly orderId: string;
  readonly clientOrderId: string;
  readonly tokenId: TokenId;
  readonly side: OrderSide;
  readonly price: number;
  readonly size: number;
  readonly liquidityRole: LiquidityRole;
  readonly fee: number;
  readonly feeRateBps: number;
  /** Unix milliseconds. */
  readonly timestamp: number;
}

export interface ExchangeBalance {
  /** "USDC" or a token ID. */
  readonly asset: string;
  readonly available: number;
  readonly locked: number;
}

export interface PlaceOrderResult {
  readonly success: boolean;
  readonly orderId?: string;
  readonly errorCode?: ExchangeErrorCode;
  readonly errorMessage?: string;
}

export interface CancelOrderResult {
  readonly success: boolean;
  readonly errorCode?: ExchangeErrorCode;
  readonly errorMessage?: string;
}

export interface MarketPricingSnapshot {
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  lastTradeAt?: string | null;
  volume24h?: number | null;
  liquidity?: number | null;
  minOrderSize?: number | null;
  bookSource?: MarketBookSource | null;
}

export interface MarketPricingStreamUpdate {
  readonly tokenId: string;
  readonly pricing: MarketPricingSnapshot;
  readonly book?: OrderBookSnapshot | null;
  readonly tickSize?: number | null;
}

export type MarketPricingFullBookReason =
  | "hot-set"
  | "open-order"
  | "open-position"
  | "bridge-candidate";

export type MarketPricingLifecycleEvent =
  | {
      readonly type: "market_resolved";
      readonly conditionId: string;
      readonly marketId: string | null;
      readonly slug: string | null;
      readonly tokenIds: readonly TokenId[];
      readonly winningTokenId: TokenId | null;
      readonly timestamp: number;
    }
  | {
      readonly type: "new_market";
      readonly conditionId: string;
      readonly marketId: string | null;
      readonly slug: string;
      readonly question: string | null;
      readonly active: boolean;
      readonly tokenIds: readonly TokenId[];
      readonly timestamp: number;
    };

export interface MarketPricingStreamLatencySummary {
  readonly count: number;
  readonly avgMs: number;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export interface MarketPricingStreamMetricsSnapshot {
  readonly windowStartMs: number;
  readonly wsEventsReceived: number;
  readonly wsEventsReceivedPerSec: number;
  readonly wsUpdatesApplied: number;
  readonly trackedTokenCount: number;
  readonly shardCount: number;
  readonly reconnectCount: number;
  readonly wsEventGapDetected: number;
  readonly wsLatencyMs: MarketPricingStreamLatencySummary | null;
  readonly fullBookTokenCount?: number;
  readonly bookEventsReceived?: number;
  readonly narrowSubscribeCount?: number;
  readonly narrowUnsubscribeCount?: number;
  readonly narrowRefCountLeaks?: number;
  readonly marketResolvedEvents?: number;
  readonly newMarketEvents?: number;
}

export interface MarketPricingStream {
  /** Replace the active subscription set. Empty means "unsubscribe from all". */
  setTokenIds(tokenIds: readonly string[]): void;
  /**
   * Replace the full-book interest set for a single lifecycle reason.
   * Tokens not covered by any reason still receive top-of-book updates, but their
   * raw order-book depth should not be retained or exposed to execution caches.
   */
  setFullBookTokenIds?(
    reason: MarketPricingFullBookReason,
    tokenIds: readonly string[],
  ): void;
  /** Close the stream and release all resources. Idempotent. */
  close(): void;
  /** Optional diagnostics for stream-capable gateways. */
  getMetricsSnapshot?(): MarketPricingStreamMetricsSnapshot;
}

export interface ExchangeUserTradeEvent {
  readonly type: "trade";
  readonly tradeId: string;
  readonly status: string;
  readonly fills: readonly ExchangeFill[];
  /** Unix milliseconds when the exchange emitted the event, when available. */
  readonly timestamp: number;
}

export interface ExchangeUserOrderEvent {
  readonly type: "order";
  readonly event: "PLACEMENT" | "UPDATE" | "CANCELLATION";
  readonly orderId: string;
  readonly clientOrderId: string | null;
  readonly tokenId: TokenId | null;
  readonly side: OrderSide | null;
  readonly sizeTotal: number | null;
  readonly sizeFilled: number | null;
  readonly sizeRemaining: number | null;
  readonly status: ExchangeOrder["status"] | null;
  /** Unix milliseconds when the exchange emitted the event, when available. */
  readonly timestamp: number;
}

export interface ExchangeUserEventStream {
  /** Replace the active market subscription set (condition IDs). */
  setConditionIds(conditionIds: readonly string[]): void;
  /** Close the stream and release all resources. Idempotent. */
  close(): void;
}

// ─── Gateway interfaces ───────────────────────────────────────────────────

/**
 * Read-only market catalog and pricing.
 * Consumed by the market-data module and normalization layer.
 * The execution engine never calls this interface directly.
 */
export interface MarketDataGateway {
  /** Fetch all active markets from the CLOB. Optional per-page progress callback. */
  getMarkets(onPage?: (page: number) => Promise<void> | void): Promise<ClobMarket[]>;

  /** Fetch a single market by condition ID. Resolves to null if not found. */
  getMarket(conditionId: string): Promise<ClobMarket | null>;

  /** Fetch the current order book / top-of-book for a token. */
  getOrderBook(tokenId: TokenId): Promise<OrderBookSnapshot>;

  /**
   * Fetch order books for several tokens in one request when the gateway supports it.
   * Strategy uses this for outcome-level entry selection; the market-data loop may
   * also use it to replace Gamma fallback pricing with CLOB top-of-book.
   */
  getOrderBooks?(tokenIds: string[]): Promise<Map<string, OrderBookSnapshot>>;

  /** Fetch the minimum price increment for a token. */
  getTickSize(tokenId: TokenId): Promise<number>;

  /** Validate connectivity and API credentials. */
  healthCheck(): Promise<{ readonly ok: boolean; readonly latencyMs: number }>;

  /**
   * Fetch pricing for a set of tracked tokens.
   * Returns a map of tokenId → pricing snapshot.
   * Used by the fast pricing loop (Phase 1: Gamma-backed).
   */
  getMarketPricing(tokenIds: string[]): Promise<Map<string, MarketPricingSnapshot>>;

  /**
   * Optional live pricing stream for gateways that support push-based updates.
   * Hot-family execution uses this to reduce dependence on the slow global poll.
   */
  createMarketPricingStream?(
    handlers: Readonly<{
      onUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
      onLifecycleEvents?: (
        events: readonly MarketPricingLifecycleEvent[],
      ) => Promise<void> | void;
      onError?: (error: unknown) => Promise<void> | void;
      onGapDetected?: (
        gap: Readonly<{
          reason: "socket-closed" | "invalid-payload" | "connect-failed";
          timestamp: number;
          tokenIds?: readonly string[];
        }>,
      ) => Promise<void> | void;
    }>,
  ): MarketPricingStream;
}

/**
 * Discovery-only gateway — finds candidate markets from an external catalog.
 * Used by the scanner module for slow-cadence market discovery.
 * Does NOT provide pricing — that is MarketDataGateway's job.
 */
export interface MarketDiscoveryGateway {
  /** Discover active markets matching configured filters. */
  discoverMarkets(): Promise<ClobMarket[]>;

  /** Stream markets page-by-page so the full array is never held in memory. */
  forEachMarketPage(callback: (markets: ClobMarket[]) => void): Promise<{ totalMarkets: number }>;

  /** Validate connectivity. */
  healthCheck(): Promise<{ readonly ok: boolean; readonly latencyMs: number }>;
}

/**
 * Order lifecycle — place, cancel, query orders, fetch fills and balances.
 *
 * Consumed exclusively by the execution engine and reconciliation module.
 * No other module may call order-mutation methods (placeOrder, cancelOrder,
 * cancelAllOrders). This boundary is a non-negotiable runtime invariant.
 */
export interface ExchangeGateway {
  /** Place a limit order. Never throws — errors are encoded in PlaceOrderResult. */
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult>;

  /** Cancel a single order by exchange-assigned ID. */
  cancelOrder(params: CancelOrderParams): Promise<CancelOrderResult>;

  /** Cancel all open orders across all tokens. */
  cancelAllOrders(): Promise<CancelOrderResult>;

  /** Fetch all currently open orders across all tokens. */
  getOpenOrders(): Promise<ExchangeOrder[]>;

  /** Fetch open orders for a specific token. */
  getOpenOrdersForToken(tokenId: TokenId): Promise<ExchangeOrder[]>;

  /** Fetch fills since a given Unix millisecond timestamp. */
  getFills(sinceMs: number): Promise<ExchangeFill[]>;

  /**
   * Optional authenticated user stream for order lifecycle and fills.
   * Runtime uses this as the realtime path while keeping polling as fallback.
   */
  createUserEventStream?(
    handlers: Readonly<{
      onTradeEvents: (events: readonly ExchangeUserTradeEvent[]) => Promise<void> | void;
      onOrderEvents: (events: readonly ExchangeUserOrderEvent[]) => Promise<void> | void;
      onGapDetected?: (
        info: Readonly<{ reason: string; timestamp: number }>,
      ) => Promise<void> | void;
      onError?: (error: unknown) => Promise<void> | void;
    }>,
  ): ExchangeUserEventStream;

  /** Fetch current balances and collateral. */
  getBalances(): Promise<ExchangeBalance[]>;

  /**
   * Fetch the on-chain balance for a specific conditional token (CTF ERC1155).
   * Returns the number of shares held. Used by resolution module to verify
   * positions are fully redeemed before ledger settlement.
   */
  getPositionBalance(tokenId: TokenId): Promise<number>;

  /**
   * Redeem winning shares for a list of markets (conditions).
   * Polymarket-specific: typically calls FixedProductMarketMaker.redeem()
   * or ClobClient.redeem().
   */
  redeemPositions(conditionIds: string[]): Promise<void>;

  /**
   * Optional hint for asynchronous settlement paths (for example relayer-backed
   * redeem submissions). When true, callers should defer immediate balance
   * verification and retry on the next resolution tick.
   */
  hasPendingRedeemSubmission?(conditionId: string): boolean;

  /**
   * Merge opposing shares (YES + NO) into collateral (USDC).
   * Polymarket-specific: calls ConditionalTokens.merge().
   */
  mergePositions(merges: { conditionId: string; amount: number }[]): Promise<void>;

  /** Validate connectivity and API credentials. */
  healthCheck(): Promise<{ readonly ok: boolean; readonly latencyMs: number }>;
}
