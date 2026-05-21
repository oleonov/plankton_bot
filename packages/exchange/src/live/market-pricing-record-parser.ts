import {
  createTokenId,
  type MarketPricingLifecycleEvent,
  type MarketPricingSnapshot,
  type MarketPricingStreamUpdate,
  type TradingNoopSuppressionCounts,
} from "@krabs/domain";
import { mapOrderBook } from "../mappers.js";
import {
  extractBookTokenId,
  parseOptionalIsoTimestamp,
  parseOptionalNumber,
} from "./market-data-stream-shared.js";
import { noteLatencySample } from "./market-pricing-ws-protocol.js";

type MutableSuppressionCounts = {
  -readonly [K in keyof TradingNoopSuppressionCounts]: TradingNoopSuppressionCounts[K];
};

export interface CollectStreamUpdatesResult {
  readonly rawRecordCount: number;
  readonly updates: readonly MarketPricingStreamUpdate[];
  readonly lifecycleEvents: readonly MarketPricingLifecycleEvent[];
  readonly eventCount: number;
  readonly parsedUpdateCount: number;
  readonly emittedUpdateCount: number;
  readonly noopUpdateCount: number;
  readonly suppressedTradingNoopCount: number;
  readonly suppressedTradingNoopByReason: TradingNoopSuppressionCounts;
  readonly bookEventCount: number;
  readonly marketResolvedEventCount: number;
  readonly newMarketEventCount: number;
  readonly latencySamplesMs: readonly number[];
}

export function collectStreamUpdates(
  records: readonly unknown[],
  pricingByToken: Map<string, MarketPricingSnapshot>,
  nowMs: number,
): CollectStreamUpdatesResult {
  const updates: MarketPricingStreamUpdate[] = [];
  const lifecycleEvents: MarketPricingLifecycleEvent[] = [];
  const latencySamplesMs: number[] = [];
  let eventCount = 0;
  let parsedUpdateCount = 0;
  let noopUpdateCount = 0;
  let suppressedTradingNoopCount = 0;
  const suppressedTradingNoopByReason = createEmptySuppressionCounts();
  let bookEventCount = 0;
  let marketResolvedEventCount = 0;
  let newMarketEventCount = 0;

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const raw = record as Record<string, unknown>;
    const eventType = typeof raw.event_type === "string" ? raw.event_type : "";

    if (eventType === "price_change" && Array.isArray(raw.price_changes)) {
      for (const priceChange of raw.price_changes) {
        if (!priceChange || typeof priceChange !== "object") continue;
        const priceChangeRaw = priceChange as Record<string, unknown>;
        const tokenId = extractBookTokenId(priceChangeRaw) ?? extractBookTokenId(raw);
        if (!tokenId) continue;
        const current = getCurrentPricing(pricingByToken, tokenId);
        const next: MarketPricingSnapshot = {
          ...current,
          bestBid: parseOptionalNumber(priceChangeRaw.best_bid) ?? current.bestBid,
          bestAsk: parseOptionalNumber(priceChangeRaw.best_ask) ?? current.bestAsk,
          lastTradePrice: current.lastTradePrice,
          lastTradeAt: parseOptionalIsoTimestamp(raw.timestamp) ?? current.lastTradeAt ?? null,
          bookSource: "clob",
        };
        const update = { tokenId, pricing: next };
        eventCount++;
        parsedUpdateCount++;
        if (recordParsedUpdate(pricingByToken, tokenId, current, next, update)) {
          updates.push(update);
        } else {
          suppressedTradingNoopCount++;
          incrementSuppressionReason(
            suppressedTradingNoopByReason,
            eventType,
            current,
            next,
            update,
          );
        }
        if (isNoopTopOfBookUpdate(current, next)) noopUpdateCount++;
        noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      }
      continue;
    }

    if (eventType === "market_resolved") {
      const tokenIds = extractLifecycleTokenIds(raw);
      if (tokenIds.length === 0) continue;
      lifecycleEvents.push({
        type: "market_resolved",
        conditionId: resolveLifecycleConditionId(raw),
        marketId: typeof raw.market === "string" ? raw.market : null,
        slug: typeof raw.slug === "string" ? raw.slug : null,
        tokenIds,
        winningTokenId: resolveWinningTokenId(raw),
        timestamp: resolveEventTimestamp(raw, nowMs),
      });
      eventCount++;
      marketResolvedEventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "new_market") {
      const tokenIds = extractLifecycleTokenIds(raw);
      const slug = typeof raw.slug === "string" ? raw.slug : null;
      if (!slug) continue;
      lifecycleEvents.push({
        type: "new_market",
        conditionId: resolveLifecycleConditionId(raw),
        marketId: typeof raw.market === "string" ? raw.market : null,
        slug,
        question: typeof raw.question === "string" ? raw.question : null,
        active: raw.active !== false,
        tokenIds,
        timestamp: resolveEventTimestamp(raw, nowMs),
      });
      eventCount++;
      newMarketEventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    const tokenId = extractBookTokenId(raw);
    if (!tokenId) continue;
    const current = getCurrentPricing(pricingByToken, tokenId);

    if (eventType === "book") {
      const book = mapOrderBook(createTokenId(tokenId), raw);
      const next: MarketPricingSnapshot = {
        ...current,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        minOrderSize: book.minOrderSize ?? current.minOrderSize ?? null,
        bookSource: "clob",
      };
      const update = { tokenId, pricing: next, book };
      eventCount++;
      parsedUpdateCount++;
      if (recordParsedUpdate(pricingByToken, tokenId, current, next, update)) {
        updates.push(update);
      } else {
        suppressedTradingNoopCount++;
        incrementSuppressionReason(suppressedTradingNoopByReason, eventType, current, next, update);
      }
      if (isNoopTopOfBookUpdate(current, next)) noopUpdateCount++;
      bookEventCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "best_bid_ask") {
      const next: MarketPricingSnapshot = {
        ...current,
        bestBid: parseOptionalNumber(raw.best_bid),
        bestAsk: parseOptionalNumber(raw.best_ask),
        bookSource: "clob",
      };
      const update = { tokenId, pricing: next };
      eventCount++;
      parsedUpdateCount++;
      if (recordParsedUpdate(pricingByToken, tokenId, current, next, update)) {
        updates.push(update);
      } else {
        suppressedTradingNoopCount++;
        incrementSuppressionReason(suppressedTradingNoopByReason, eventType, current, next, update);
      }
      if (isNoopTopOfBookUpdate(current, next)) noopUpdateCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "last_trade_price") {
      const next: MarketPricingSnapshot = {
        ...current,
        lastTradePrice: parseOptionalNumber(raw.price ?? raw.last_trade_price),
        lastTradeAt: parseOptionalIsoTimestamp(raw.timestamp) ?? current.lastTradeAt ?? null,
        bookSource: "clob",
      };
      const update = { tokenId, pricing: next };
      eventCount++;
      parsedUpdateCount++;
      if (recordParsedUpdate(pricingByToken, tokenId, current, next, update)) {
        updates.push(update);
      } else {
        suppressedTradingNoopCount++;
        incrementSuppressionReason(suppressedTradingNoopByReason, eventType, current, next, update);
      }
      if (isNoopTopOfBookUpdate(current, next)) noopUpdateCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "tick_size_change") {
      const nextTickSize =
        parseOptionalNumber(raw.new_tick_size) ?? parseOptionalNumber(raw.tick_size);
      updates.push({
        tokenId,
        pricing: current,
        tickSize: nextTickSize,
      });
      eventCount++;
      parsedUpdateCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
      continue;
    }

    if (eventType === "price_change") {
      const next: MarketPricingSnapshot = {
        ...current,
        bestBid: parseOptionalNumber(raw.best_bid) ?? current.bestBid,
        bestAsk: parseOptionalNumber(raw.best_ask) ?? current.bestAsk,
        bookSource: "clob",
      };
      const update = { tokenId, pricing: next };
      eventCount++;
      parsedUpdateCount++;
      if (recordParsedUpdate(pricingByToken, tokenId, current, next, update)) {
        updates.push(update);
      } else {
        suppressedTradingNoopCount++;
        incrementSuppressionReason(suppressedTradingNoopByReason, eventType, current, next, update);
      }
      if (isNoopTopOfBookUpdate(current, next)) noopUpdateCount++;
      noteLatencySample(latencySamplesMs, raw.timestamp, nowMs);
    }
  }

  return {
    rawRecordCount: records.length,
    updates,
    lifecycleEvents,
    eventCount,
    parsedUpdateCount,
    emittedUpdateCount: updates.length,
    noopUpdateCount,
    suppressedTradingNoopCount,
    suppressedTradingNoopByReason,
    bookEventCount,
    marketResolvedEventCount,
    newMarketEventCount,
    latencySamplesMs,
  };
}

function recordParsedUpdate(
  pricingByToken: Map<string, MarketPricingSnapshot>,
  tokenId: string,
  current: MarketPricingSnapshot,
  next: MarketPricingSnapshot,
  update: MarketPricingStreamUpdate,
): boolean {
  pricingByToken.set(tokenId, next);
  return !isTradingSemanticNoop(current, next, update);
}

export function isTradingSemanticNoop(
  prev: MarketPricingSnapshot,
  next: MarketPricingSnapshot,
  update: MarketPricingStreamUpdate,
): boolean {
  if (update.tickSize != null) return false;
  if (update.book != null) return false;
  if (prev.bestBid !== next.bestBid) return false;
  if (prev.bestAsk !== next.bestAsk) return false;
  if (prev.acceptingOrders !== next.acceptingOrders) return false;
  if (prev.enableOrderBook !== next.enableOrderBook) return false;
  if (prev.minOrderSize !== next.minOrderSize) return false;
  if (prev.bookSource !== next.bookSource) return false;
  return true;
}

function isNoopTopOfBookUpdate(
  current: MarketPricingSnapshot,
  next: MarketPricingSnapshot,
): boolean {
  return current.bestBid === next.bestBid && current.bestAsk === next.bestAsk;
}

function createEmptySuppressionCounts(): MutableSuppressionCounts {
  return {
    topOfBookOnly: 0,
    bookOnly: 0,
    lastTradeOnly: 0,
    tickSizeOnly: 0,
    mixedNonCritical: 0,
  };
}

function incrementSuppressionReason(
  counts: MutableSuppressionCounts,
  eventType: string,
  current: MarketPricingSnapshot,
  next: MarketPricingSnapshot,
  update: MarketPricingStreamUpdate,
): void {
  counts[classifySuppressedTradingNoopReason(eventType, current, next, update)]++;
}

export function classifySuppressedTradingNoopReason(
  eventType: string,
  current: MarketPricingSnapshot,
  next: MarketPricingSnapshot,
  update: MarketPricingStreamUpdate,
): keyof TradingNoopSuppressionCounts {
  if (update.tickSize != null || eventType === "tick_size_change") return "tickSizeOnly";
  if (update.book != null || eventType === "book") return "bookOnly";

  const topOfBookChanged = current.bestBid !== next.bestBid || current.bestAsk !== next.bestAsk;
  const lastTradeChanged =
    current.lastTradePrice !== next.lastTradePrice || current.lastTradeAt !== next.lastTradeAt;
  const topOfBookEvent = eventType === "best_bid_ask" || eventType === "price_change";

  if (lastTradeChanged && (topOfBookChanged || topOfBookEvent)) return "mixedNonCritical";
  if (lastTradeChanged || eventType === "last_trade_price") return "lastTradeOnly";
  if (topOfBookChanged || topOfBookEvent) return "topOfBookOnly";
  return "mixedNonCritical";
}

function getCurrentPricing(
  pricingByToken: Map<string, MarketPricingSnapshot>,
  tokenId: string,
): MarketPricingSnapshot {
  return (
    pricingByToken.get(tokenId) ?? {
      bestBid: null,
      bestAsk: null,
      lastTradePrice: null,
      lastTradeAt: null,
      volume24h: null,
      volume24hr: null,
      liquidity: null,
      minOrderSize: null,
      bookSource: "clob",
      acceptingOrders: false,
      enableOrderBook: false,
    }
  );
}

function extractLifecycleTokenIds(raw: Record<string, unknown>) {
  const tokenIds = raw.token_ids ?? raw.assets_ids ?? raw.clob_token_ids ?? raw.asset_ids;
  if (!Array.isArray(tokenIds)) return [];
  return tokenIds
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => createTokenId(value.trim()));
}

function resolveLifecycleConditionId(raw: Record<string, unknown>): string {
  const candidates = [raw.condition_id, raw.conditionId, raw.condition, raw.market];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return "";
}

function resolveWinningTokenId(raw: Record<string, unknown>) {
  const candidates = [
    raw.winning_token_id,
    raw.winningTokenId,
    raw.winner_token_id,
    raw.winning_asset_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return createTokenId(candidate.trim());
    }
  }
  return null;
}

function resolveEventTimestamp(raw: Record<string, unknown>, fallbackMs: number): number {
  const eventAt = parseOptionalIsoTimestamp(raw.timestamp ?? raw.created_at ?? raw.updated_at);
  if (!eventAt) return fallbackMs;
  const parsed = Date.parse(eventAt);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}
