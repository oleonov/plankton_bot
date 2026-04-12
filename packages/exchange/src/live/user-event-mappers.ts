import type { ExchangeUserOrderEvent, ExchangeUserTradeEvent } from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import {
  mapExchangeOrderStatus,
  mapTrade,
  mapTradeToPersonalFills,
  toDomainSide,
} from "../mappers.js";

function toUnixMs(value: unknown, fallbackMs = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return fallbackMs;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return Math.abs(numeric) < 1_000_000_000_000
        ? Math.trunc(numeric * 1000)
        : Math.trunc(numeric);
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

function toOptionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOrderEventType(value: unknown): ExchangeUserOrderEvent["event"] | null {
  const upper = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (upper === "PLACEMENT" || upper === "UPDATE" || upper === "CANCELLATION") {
    return upper as ExchangeUserOrderEvent["event"];
  }
  return null;
}

export function mapUserTradeEvent(
  raw: Record<string, unknown>,
  traderAddress: string | null,
): ExchangeUserTradeEvent | null {
  if (String(raw.event_type ?? "").toLowerCase() !== "trade") return null;

  const fills =
    traderAddress != null ? mapTradeToPersonalFills(raw, traderAddress) : [mapTrade(raw)];
  if (fills.length === 0) return null;

  return {
    type: "trade",
    tradeId: String(raw.id ?? ""),
    status: String(raw.status ?? "UNKNOWN").toUpperCase(),
    fills,
    timestamp: toUnixMs(raw.timestamp ?? raw.last_update ?? raw.matchtime ?? raw.match_time),
  };
}

export function mapUserOrderEvent(raw: Record<string, unknown>): ExchangeUserOrderEvent | null {
  if (String(raw.event_type ?? "").toLowerCase() !== "order") return null;

  const event = normalizeOrderEventType(raw.type);
  if (!event) return null;

  const sideRaw = typeof raw.side === "string" ? raw.side : null;
  const side = sideRaw ? toDomainSide(sideRaw) : null;
  const sizeTotal = toOptionalNumber(raw.original_size ?? raw.size);
  const sizeFilled = toOptionalNumber(raw.size_matched);
  const sizeRemaining =
    sizeTotal != null && sizeFilled != null ? Math.max(0, sizeTotal - sizeFilled) : null;
  const tokenIdRaw = typeof raw.asset_id === "string" && raw.asset_id.length > 0 ? raw.asset_id : null;

  return {
    type: "order",
    event,
    orderId: String(raw.id ?? ""),
    clientOrderId:
      typeof raw.client_order_id === "string" && raw.client_order_id.length > 0
        ? raw.client_order_id
        : null,
    tokenId: tokenIdRaw ? createTokenId(tokenIdRaw) : null,
    side,
    sizeTotal,
    sizeFilled,
    sizeRemaining,
    status:
      typeof raw.status === "string" && raw.status.length > 0
        ? mapExchangeOrderStatus(raw.status)
        : null,
    timestamp: toUnixMs(raw.timestamp ?? raw.created_at),
  };
}
