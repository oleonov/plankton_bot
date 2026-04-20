/**
 * Mappers — convert raw SDK responses to @plankton/domain types.
 *
 * All SDK → domain conversions live here. No SDK types are imported;
 * raw data arrives as Record<string, unknown> to prevent type leakage.
 */

import type {
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  ClobMarket,
  OrderBookSnapshot,
  PriceLevel,
  TokenId,
  OrderSide,
  LiquidityRole,
} from "@plankton/domain";
import { createTokenId } from "@plankton/domain";

// ─── Side mapping ────────────────────────────────────────────────────────

export function toDomainSide(sdkSide: string): OrderSide {
  const upper = sdkSide.toUpperCase();
  if (upper === "BUY") return "buy";
  if (upper === "SELL") return "sell";
  throw new Error(`Unknown order side: "${sdkSide}"`);
}

export function toSdkSide(side: OrderSide): "BUY" | "SELL" {
  return side === "buy" ? "BUY" : "SELL";
}

function toDomainLiquidityRole(value: unknown): LiquidityRole {
  const upper = typeof value === "string" ? value.toUpperCase() : "";
  if (upper === "MAKER") return "maker";
  if (upper === "TAKER") return "taker";
  return "unknown";
}

function normalizeEpochMs(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  if (abs === 0) return 0;
  return abs < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}

function toUnixMs(value: unknown, fallbackMs = Date.now()): number {
  if (typeof value === "number") {
    return normalizeEpochMs(value) ?? fallbackMs;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return fallbackMs;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return normalizeEpochMs(numeric) ?? fallbackMs;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

function sameAddress(left: unknown, right: string): boolean {
  return typeof left === "string" && left.trim().toLowerCase() === right.trim().toLowerCase();
}

function buildExchangeFill(input: {
  fillId: string;
  orderId: string;
  clientOrderId?: string;
  tokenId: string;
  side: string;
  price: unknown;
  size: unknown;
  feeRateBps: unknown;
  liquidityRole: LiquidityRole;
  timestamp: unknown;
}): ExchangeFill {
  const price = Number(input.price ?? 0);
  const size = Number(input.size ?? 0);
  const feeRateBps = Number(input.feeRateBps ?? 0);

  const fee =
    input.liquidityRole === "maker" ? 0 : size * (feeRateBps / 10_000) * price * (1 - price);

  return {
    fillId: input.fillId,
    orderId: input.orderId,
    clientOrderId: input.clientOrderId ?? "",
    tokenId: createTokenId(input.tokenId),
    side: toDomainSide(input.side),
    price,
    size,
    liquidityRole: input.liquidityRole,
    fee,
    feeRateBps,
    timestamp: toUnixMs(input.timestamp),
  };
}

// ─── TickSize mapping ────────────────────────────────────────────────────

export function toSdkTickSize(tickSize: number): string {
  // SDK expects string TickSize: "0.1" | "0.01" | "0.001" | "0.0001"
  return tickSize.toString();
}

// ─── Order mapping ───────────────────────────────────────────────────────

export function mapExchangeOrderStatus(sdkStatus: string): ExchangeOrder["status"] {
  const upper = sdkStatus.toUpperCase();
  switch (upper) {
    case "LIVE":
    case "OPEN":
      return "OPEN";
    case "MATCHED":
    case "FILLED":
      return "FILLED";
    case "PARTIALLY_FILLED":
      return "PARTIALLY_FILLED";
    case "CANCELLED":
    case "CANCELED":
      return "CANCELLED";
    case "EXPIRED":
      return "EXPIRED";
    default:
      return "OPEN";
  }
}

export function mapOpenOrder(raw: Record<string, unknown>): ExchangeOrder {
  const originalSize = Number(raw.original_size ?? raw.size ?? 0);
  const sizeMatched = Number(raw.size_matched ?? 0);

  return {
    orderId: String(raw.id ?? ""),
    clientOrderId: String(raw.client_order_id ?? raw.id ?? ""),
    tokenId: createTokenId(String(raw.asset_id ?? "")),
    side: toDomainSide(String(raw.side ?? "BUY")),
    price: Number(raw.price ?? 0),
    sizeTotal: originalSize,
    sizeFilled: sizeMatched,
    sizeRemaining: originalSize - sizeMatched,
    status: mapExchangeOrderStatus(String(raw.status ?? "OPEN")),
    createdAt: toUnixMs(raw.created_at),
  };
}

// ─── Fill / Trade mapping ────────────────────────────────────────────────

export function mapTrade(raw: Record<string, unknown>): ExchangeFill {
  return buildExchangeFill({
    fillId: String(raw.id ?? ""),
    orderId: String(raw.taker_order_id ?? ""),
    clientOrderId: String(raw.client_order_id ?? ""),
    tokenId: String(raw.asset_id ?? ""),
    side: String(raw.side ?? "BUY"),
    price: raw.price,
    size: raw.size,
    feeRateBps: raw.fee_rate_bps,
    liquidityRole: toDomainLiquidityRole(raw.trader_side),
    timestamp: raw.match_time,
  });
}

export function mapTradeToPersonalFills(
  raw: Record<string, unknown>,
  traderAddress: string,
): ExchangeFill[] {
  const fills: ExchangeFill[] = [];
  const traderSide = typeof raw.trader_side === "string" ? raw.trader_side.toUpperCase() : "";

  // For our taker fills, the top-level trade fields describe our side/asset directly.
  if (traderSide === "TAKER" && sameAddress(raw.maker_address, traderAddress)) {
    fills.push(mapTrade(raw));
  }

  // For our maker fills, our personal leg lives inside maker_orders[].
  const makerOrders = Array.isArray(raw.maker_orders)
    ? (raw.maker_orders as Array<Record<string, unknown>>)
    : [];
  makerOrders.forEach((makerOrder, index) => {
    if (!sameAddress(makerOrder.maker_address, traderAddress)) return;
    fills.push(
      buildExchangeFill({
        fillId: `${String(raw.id ?? "")}#maker:${index}`,
        orderId: String(makerOrder.order_id ?? ""),
        tokenId: String(makerOrder.asset_id ?? ""),
        side: String(makerOrder.side ?? "BUY"),
        price: makerOrder.price,
        size: makerOrder.matched_amount,
        feeRateBps: makerOrder.fee_rate_bps,
        liquidityRole: "maker",
        timestamp: raw.match_time,
      }),
    );
  });

  return fills;
}

// ─── Market mapping ──────────────────────────────────────────────────────

export function mapMarket(raw: Record<string, unknown>): ClobMarket {
  const tokens = Array.isArray(raw.tokens)
    ? (raw.tokens as Array<Record<string, unknown>>).map((t, i) => ({
        tokenId: String(t.token_id ?? ""),
        outcome: String(t.outcome ?? ""),
        outcomeIndex: i,
      }))
    : [];

  return {
    conditionId: String(raw.condition_id ?? ""),
    tokens,
    question: String(raw.question ?? ""),
    slug: String(raw.slug ?? raw.market_slug ?? ""),
    endDate: String(raw.end_date_iso ?? raw.end_date ?? ""),
    active: Boolean(raw.active),
    negRisk: Boolean(raw.neg_risk),
    tickSize: Number(raw.minimum_tick_size ?? raw.tick_size ?? 0.01),
    volume24h: raw.volume_num != null ? Number(raw.volume_num) : null,
    // CLOB endpoint returns individual markets (not event-grouped); treat as single-market event.
    eventMarketCount: 1,
  };
}

// ─── Order book mapping ──────────────────────────────────────────────────

function mapLevels(levels: unknown): PriceLevel[] {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((l: Record<string, unknown>) => ({
      price: Number(l.price ?? 0),
      size: Number(l.size ?? 0),
    }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size));
}

function sortBidLevels(levels: readonly PriceLevel[]): PriceLevel[] {
  return [...levels].sort((a, b) => b.price - a.price || b.size - a.size);
}

function sortAskLevels(levels: readonly PriceLevel[]): PriceLevel[] {
  return [...levels].sort((a, b) => a.price - b.price || b.size - a.size);
}

export function mapOrderBook(tokenId: TokenId, raw: Record<string, unknown>): OrderBookSnapshot {
  const bids = sortBidLevels(mapLevels(raw.bids));
  const asks = sortAskLevels(mapLevels(raw.asks));
  const parsedMinOrderSize =
    raw.min_order_size != null
      ? Number(raw.min_order_size)
      : raw.minOrderSize != null
        ? Number(raw.minOrderSize)
        : null;
  const minOrderSize =
    parsedMinOrderSize !== null && Number.isFinite(parsedMinOrderSize) ? parsedMinOrderSize : null;

  const bestBid = bids.length > 0 ? bids[0]!.price : null;
  const bestAsk = asks.length > 0 ? asks[0]!.price : null;
  const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  return {
    tokenId,
    bids,
    asks,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    minOrderSize,
    timestamp: toUnixMs(raw.timestamp),
  };
}

// ─── Gamma market mapping ───────────────────────────────────────────

/** Pricing snapshot extracted from a Gamma market response. */
export interface GammaPricing {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly lastTradePrice: number | null;
}

/**
 * Gamma sometimes returns arrays as JSON strings (e.g. nested event markets).
 * This handles both native arrays and stringified JSON arrays.
 */
export function parseStringOrArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed as string[];
    } catch {
      /* not valid JSON, ignore */
    }
  }
  return [];
}

/**
 * Map a Gamma API market response to the domain ClobMarket type.
 * Gamma uses flat arrays `clobTokenIds[]` and `outcomes[]` that must be
 * zipped together to form the `tokens` array.
 *
 * @param eventContext.slug - Parent event slug (null when unknown).
 * @param eventContext.marketCount - Total number of markets in the parent Gamma event.
 *   Used for STEP 2 fallback: no_match && eventMarketCount === 1 ⇒ INCLUDE.
 *   Pass `event.markets.length` at the call site.
 */
export function mapGammaMarket(
  raw: Record<string, unknown>,
  eventContext: { slug: string | null; marketCount: number } = { slug: null, marketCount: 1 },
): ClobMarket {
  const clobTokenIds = parseStringOrArray(raw.clobTokenIds);
  const outcomes = parseStringOrArray(raw.outcomes);

  const tokens = clobTokenIds.map((tokenId, i) => ({
    tokenId,
    outcome: outcomes[i] ?? "",
    outcomeIndex: i,
  }));

  return {
    conditionId: String(raw.conditionId ?? ""),
    tokens,
    question: String(raw.question ?? ""),
    slug: String(raw.slug ?? ""),
    ...(eventContext.slug != null ? { eventSlug: eventContext.slug } : {}),
    endDate: String(raw.endDate ?? ""),
    active: Boolean(raw.active),
    negRisk: Boolean(raw.negRisk),
    tickSize: Number(raw.orderPriceMinTickSize ?? 0.01),
    // Gamma exposes two distinct volume fields:
    //   • `volumeNum`  — lifetime cumulative volume (USDC)
    //   • `volume24hr` — rolling 24h window
    // Spec §0 R1 requires `trade_count > 0` (lifetime). `volumeNum > 0` is our
    // proxy — see ADR-007. `volume24hr` would false-exclude older markets
    // with no recent activity. The domain field name is kept as `volume24h`
    // for backward-compat; ADR-007 documents the semantic.
    volume24h: raw.volumeNum != null ? Number(raw.volumeNum) : null,
    eventMarketCount: eventContext.marketCount,
  };
}

/**
 * Extract pricing fields from a Gamma market response.
 * Gamma provides `bestBid`, `bestAsk` directly. `lastTradePrice` is
 * derived from `lastTradePrice` if present, otherwise null.
 */
export function mapGammaPricing(raw: Record<string, unknown>): GammaPricing {
  return {
    bestBid: raw.bestBid != null ? Number(raw.bestBid) : null,
    bestAsk: raw.bestAsk != null ? Number(raw.bestAsk) : null,
    lastTradePrice: raw.lastTradePrice != null ? Number(raw.lastTradePrice) : null,
  };
}

// ─── Balance mapping ─────────────────────────────────────────────────────

/** Polymarket CLOB SDK returns balances in atomic units (6 decimals for USDC / conditional tokens). */
export const ATOMIC_UNIT_DIVISOR = 1e6;

export function mapBalance(raw: Record<string, unknown>): ExchangeBalance {
  const rawBalance = Number(raw.balance ?? 0);
  // SDK returns balance + allowance but neither represents locked collateral.
  // Actual locked amount requires summing open order exposure — done by reconciliation,
  // not by the gateway mapper. We report 0 here to avoid fabricating data.
  return {
    asset: "USDC",
    available: rawBalance / ATOMIC_UNIT_DIVISOR,
    locked: 0,
  };
}
