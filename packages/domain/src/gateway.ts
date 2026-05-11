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
    readonly bestBid?: number | null;
    readonly bestAsk?: number | null;
    readonly midPrice?: number | null;
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
  readonly liquidity?: number | null;
  /** Number of markets in the parent Gamma event; retained for telemetry/ranking. */
  readonly eventMarketCount: number;
  /**
   * Gamma `createdAt` (ISO-8601) — moment the market was created in Polymarket Gamma.
   * Distinct from `Market.createdAt`, which is the moment the row was first written
   * to our DB. Null when the source (CLOB-only path) does not expose it.
   * Source: spec §1.7 R14 (`age_at_entry` is derived from this).
   */
  readonly gammaCreatedAt: string | null;
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

export interface RedeemPositionsResult {
  readonly status: "skipped" | "submitted" | "confirmed" | "pending";
  readonly conditionIds: readonly string[];
  readonly reason?: "no_redeem_requests" | "unsupported_settlement" | null;
  readonly txHash?: string | null;
  readonly gasUsed?: number | null;
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
  /** Shares reported by the exchange and reflected in wallet position size. */
  readonly size: number;
  /** Same share quantity before any local transforms. Kept for legacy reconciliation paths. */
  readonly grossSize?: number;
  /** Cash notional paid/received, excluding taker fee. */
  readonly sizeUsdc?: number;
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
  readonly errorDetails?: Readonly<Record<string, unknown>> | null;
}

export interface CancelOrderResult {
  readonly success: boolean;
  readonly errorCode?: ExchangeErrorCode;
  readonly errorMessage?: string;
}

export interface MarketPricingSnapshot {
  bestBid: number | null;
  bestAsk: number | null;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  lastTradePrice: number | null;
  lastTradeAt?: string | null;
  volume24h?: number | null;
  /**
   * Rolling 24-hour traded volume from Gamma (`volume24hr`/`volume24hrClob`).
   * Distinct from `volume24h` (lifetime). Feeds the soft-ranking score.
   */
  volume24hr?: number | null;
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
    }
  | {
      /**
       * Emitted when the ingress queue for a shard overflows and the `drop-oldest`
       * policy is active. The `tokenIds` are extracted from the dropped message so
       * callers can trigger a poll-fallback for those tokens.
       */
      readonly type: "queue_overflow";
      readonly shardId: number;
      readonly droppedCount: number;
      readonly tokenIds: readonly string[];
      readonly timestamp: number;
    }
  | {
      /**
       * Emitted when a single shard's circuit breaker opens due to too many
       * reconnects in 60 s. Only that shard's tokens are affected; other shards
       * keep streaming. The shard will attempt a half-open reconnect after
       * `reopenAtMs`.
       */
      readonly type: "shard_circuit_open";
      readonly shardId: number;
      readonly tokenIds: readonly string[];
      readonly reopenAtMs: number;
    }
  | {
      /**
       * Emitted when a shard's circuit breaker closes after a successful half-open
       * reconnect that stayed stable for STREAM_STABLE_MS.
       */
      readonly type: "shard_circuit_closed";
      readonly shardId: number;
      readonly tokenIds: readonly string[];
    }
  | {
      /**
       * Emitted when the stream-level quorum guard opens: enough shards are in
       * breaker state simultaneously (AND: percent threshold AND absolute floor).
       * MarketDataModule degrades to poll-only until `stream_circuit_closed`.
       */
      readonly type: "stream_circuit_open";
      readonly reopenAtMs: number;
      readonly reason?: string;
    }
  | {
      /**
       * Emitted when the stream-level circuit breaker closes after quorum falls
       * below threshold and the recovered shard stays stable for STREAM_STABLE_MS.
       */
      readonly type: "stream_circuit_closed";
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
  /** Per-shard ingress queue depth at the time of snapshot (aggregate across all shards). */
  readonly queueDepth?: number;
  /** Peak queue depth observed since stream start (per-shard high-water mark, summed). */
  readonly maxQueueDepth?: number;
  /** Total number of overflow evictions across all shards since stream start. */
  readonly queueOverflows?: number;
}

export interface MarketPricingStream {
  /** Replace the active subscription set. Empty means "unsubscribe from all". */
  setTokenIds(tokenIds: readonly string[]): void;
  /**
   * Replace the full-book interest set for a single lifecycle reason.
   * Tokens not covered by any reason still receive top-of-book updates, but their
   * raw order-book depth should not be retained or exposed to execution caches.
   */
  setFullBookTokenIds?(reason: MarketPricingFullBookReason, tokenIds: readonly string[]): void;
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

export interface RedeemPositionsOptions {
  /**
   * Optional token-level allowlist for settlement-backed redeem calls.
   * Normal resolution uses this to redeem only winning outcome tokens; losing
   * outcome positions settle locally at 0 and must not be sent on-chain.
   */
  readonly redeemTokenIdsByCondition?: Readonly<Record<string, readonly TokenId[]>>;
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
   *
   * @param opts.timeoutMs - Per-request abort timeout in ms. When omitted the
   *   gateway uses its own default (45 s for live, 0 for simulation).
   *   Pass `Math.min(30_000, 5_000 + tokenIds.length * 10)` to scale timeout
   *   proportionally to batch size (Task 5).
   */
  getMarketPricing(
    tokenIds: string[],
    opts?: { timeoutMs?: number },
  ): Promise<Map<string, MarketPricingSnapshot>>;

  /**
   * Optional live pricing stream for gateways that support push-based updates.
   * Token-level hot-quote execution uses this to reduce dependence on the slow global poll.
   */
  createMarketPricingStream?(
    handlers: Readonly<{
      onUpdates: (updates: readonly MarketPricingStreamUpdate[]) => Promise<void> | void;
      onLifecycleEvents?: (events: readonly MarketPricingLifecycleEvent[]) => Promise<void> | void;
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

  /**
   * Stream markets page-by-page so the full array is never held in memory.
   *
   * The required `eventStats` arg carries per-page event-level counts (events
   * are flattened into markets at the gateway boundary, so the scanner cannot
   * reconstruct them from `markets` alone — see ADR-019 §D4 / Step 2 audit P2).
   *
   * Counter contract (must hold for every implementation):
   * - `singleMarket` = events whose nested `markets.length === 1`
   * - `multiMarket`  = events whose nested `markets.length >  1`
   * - `events`       = `singleMarket + multiMarket` (partition invariant)
   *
   * Zero-market events (`markets: []` or no `markets` field — settled or
   * malformed envelopes) MUST be excluded from all three counters so the
   * partition holds and the per-event ratio stays apples-to-apples with
   * ADR-003's 39.17 % single-market baseline. The callback MUST NOT be invoked
   * for pages whose only events are zero-market — pass through to the next
   * page instead.
   */
  forEachMarketPage(
    callback: (
      markets: ClobMarket[],
      eventStats: { events: number; singleMarket: number; multiMarket: number },
    ) => void,
  ): Promise<{ totalMarkets: number }>;

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
   * Optional fast path for gateways that can fetch fills for one order directly.
   * Execution uses this in simulation/paper immediate-fill mode to avoid scanning
   * the full fill history after every placed order.
   */
  getFillsForOrder?(orderId: string): Promise<ExchangeFill[]>;

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
   * Fetch the raw on-chain outcome-token balance (atomic units, bigint) for
   * drift detection. Kept distinct from `getPositionBalance` so the reconciler
   * can reason about bigint precision directly without floating-point rounding
   * obscuring sub-atomic-unit balances.
   */
  getOutcomeTokenBalance(tokenId: TokenId): Promise<bigint>;

  /**
   * Redeem winning shares for a list of markets (conditions).
   * Polymarket-specific: typically calls FixedProductMarketMaker.redeem()
   * or ClobClient.redeem().
   */
  redeemPositions(
    conditionIds: string[],
    options?: RedeemPositionsOptions,
  ): Promise<RedeemPositionsResult>;

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

  /**
   * Fetch V2 fee metadata for a market by condition id.
   * Returns `null` when the gateway cannot fetch (simulation) or when the
   * exchange has no fee metadata for the condition. Implementations should
   * cache the value per condition since fee metadata is static.
   */
  getMarketFeeInfo?(conditionId: string): Promise<MarketFeeInfo | null>;
}

/**
 * V2 fee metadata derived from CLOB `/clob-market/{conditionId}` `fd` block.
 *
 *   platformFeeRate = rate * (price * (1 - price))^exponent
 *
 * - `rate` (`fd.r`) — base fee multiplier (already a fraction, not bps)
 * - `exponent` (`fd.e`) — exponent applied to `price * (1 - price)`. For most
 *   categories this is `1`, which collapses to V1 fee math.
 * - `takerOnly` (`fd.to`) — when true, makers pay no fees.
 */
export interface MarketFeeInfo {
  readonly rate: number;
  readonly exponent: number;
  readonly takerOnly: boolean;
}
