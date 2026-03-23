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
import type { OrderSide, OrderType, ExchangeErrorCode } from "./enums.js";
import type { OrderBookSnapshot } from "./types.js";

// ─── Market catalog types ─────────────────────────────────────────────────

export interface ClobMarket {
  readonly conditionId: string;
  readonly tokens: ReadonlyArray<{
    readonly tokenId: string;
    /** "Yes" | "No" as returned by the Polymarket API. */
    readonly outcome: string;
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
  readonly fee: number;
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

  /** Fetch the minimum price increment for a token. */
  getTickSize(tokenId: TokenId): Promise<number>;

  /** Validate connectivity and API credentials. */
  healthCheck(): Promise<{ readonly ok: boolean; readonly latencyMs: number }>;

  /**
   * Fetch pricing for a set of tracked tokens.
   * Returns a map of tokenId → pricing snapshot.
   * Used by the fast pricing loop (Phase 1: Gamma-backed).
   */
  getMarketPricing(
    tokenIds: string[],
  ): Promise<
    Map<
      string,
      {
        bestBid: number | null;
        bestAsk: number | null;
        lastTradePrice: number | null;
      }
    >
  >;
}

/**
 * Discovery-only gateway — finds candidate markets from an external catalog.
 * Used by the scanner module for slow-cadence market discovery.
 * Does NOT provide pricing — that is MarketDataGateway's job.
 */
export interface MarketDiscoveryGateway {
  /** Discover active markets matching configured filters. */
  discoverMarkets(): Promise<ClobMarket[]>;

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

  /** Fetch current balances and collateral. */
  getBalances(): Promise<ExchangeBalance[]>;

  /**
   * Fetch the on-chain balance for a specific conditional token (CTF ERC1155).
   * Returns the number of shares held. Used by resolution module to verify
   * positions are fully redeemed before ledger settlement.
   */
  getPositionBalance(tokenId: TokenId): Promise<number>;

  /** Validate connectivity and API credentials. */
  healthCheck(): Promise<{ readonly ok: boolean; readonly latencyMs: number }>;
}
