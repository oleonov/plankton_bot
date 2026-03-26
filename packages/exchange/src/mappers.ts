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

// ─── TickSize mapping ────────────────────────────────────────────────────

export function toSdkTickSize(tickSize: number): string {
  // SDK expects string TickSize: "0.1" | "0.01" | "0.001" | "0.0001"
  return tickSize.toString();
}

// ─── Order mapping ───────────────────────────────────────────────────────

function mapOrderStatus(sdkStatus: string): ExchangeOrder["status"] {
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
    status: mapOrderStatus(String(raw.status ?? "OPEN")),
    createdAt: typeof raw.created_at === "number" ? raw.created_at : Date.now(),
  };
}

// ─── Fill / Trade mapping ────────────────────────────────────────────────

export function mapTrade(raw: Record<string, unknown>): ExchangeFill {
  const price = Number(raw.price ?? 0);
  const size = Number(raw.size ?? 0);
  const feeRateBps = Number(raw.fee_rate_bps ?? 0);
  const fee = size * price * (feeRateBps / 10_000);

  return {
    fillId: String(raw.id ?? ""),
    orderId: String(raw.taker_order_id ?? ""),
    clientOrderId: String(raw.client_order_id ?? ""),
    tokenId: createTokenId(String(raw.asset_id ?? "")),
    side: toDomainSide(String(raw.side ?? "BUY")),
    price,
    size,
    fee,
    timestamp: raw.match_time ? new Date(String(raw.match_time)).getTime() : Date.now(),
  };
}

// ─── Market mapping ──────────────────────────────────────────────────────

export function mapMarket(raw: Record<string, unknown>): ClobMarket {
  const tokens = Array.isArray(raw.tokens)
    ? (raw.tokens as Array<Record<string, unknown>>).map((t) => ({
        tokenId: String(t.token_id ?? ""),
        outcome: String(t.outcome ?? ""),
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
  };
}

// ─── Order book mapping ──────────────────────────────────────────────────

function mapLevels(levels: unknown): PriceLevel[] {
  if (!Array.isArray(levels)) return [];
  return levels.map((l: Record<string, unknown>) => ({
    price: Number(l.price ?? 0),
    size: Number(l.size ?? 0),
  }));
}

export function mapOrderBook(tokenId: TokenId, raw: Record<string, unknown>): OrderBookSnapshot {
  const bids = mapLevels(raw.bids);
  const asks = mapLevels(raw.asks);

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
    timestamp: raw.timestamp ? new Date(String(raw.timestamp)).getTime() : Date.now(),
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
 */
export function mapGammaMarket(raw: Record<string, unknown>, eventSlug?: string): ClobMarket {
  const clobTokenIds = parseStringOrArray(raw.clobTokenIds);
  const outcomes = parseStringOrArray(raw.outcomes);

  const tokens = clobTokenIds.map((tokenId, i) => ({
    tokenId,
    outcome: outcomes[i] ?? "",
  }));

  return {
    conditionId: String(raw.conditionId ?? ""),
    tokens,
    question: String(raw.question ?? ""),
    slug: String(raw.slug ?? ""),
    ...(eventSlug != null ? { eventSlug } : {}),
    endDate: String(raw.endDate ?? ""),
    active: Boolean(raw.active),
    negRisk: Boolean(raw.negRisk),
    tickSize: Number(raw.orderPriceMinTickSize ?? 0.01),
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

export function mapBalance(raw: Record<string, unknown>): ExchangeBalance {
  const balance = Number(raw.balance ?? 0);
  // SDK returns balance + allowance but neither represents locked collateral.
  // Actual locked amount requires summing open order exposure — done by reconciliation,
  // not by the gateway mapper. We report 0 here to avoid fabricating data.
  return {
    asset: "USDC",
    available: balance,
    locked: 0,
  };
}
