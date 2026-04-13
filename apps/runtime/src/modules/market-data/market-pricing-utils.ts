import type {
  MarketPricingSnapshot,
  MarketPricingStreamUpdate,
  NormalizedMarket,
} from "@plankton/domain";

export function applyPricingSnapshot(
  market: NormalizedMarket,
  pricing: MarketPricingSnapshot,
  nowMs: number,
): NormalizedMarket {
  const bestBid = pricing.bestBid ?? null;
  const bestAsk = pricing.bestAsk ?? null;
  const midPrice = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  return {
    ...market,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    lastTradePrice: pricing.lastTradePrice ?? null,
    lastTradeAt: pricing.lastTradeAt ?? null,
    volume24h: pricing.volume24h ?? market.volume24h ?? null,
    liquidity: pricing.liquidity ?? market.liquidity ?? null,
    minOrderSize: pricing.minOrderSize ?? market.minOrderSize ?? null,
    bookSource: pricing.bookSource ?? market.bookSource ?? "unknown",
    snapshotTs: nowMs,
  };
}

export function applyStreamUpdate(
  market: NormalizedMarket,
  update: MarketPricingStreamUpdate,
  nowMs: number,
): NormalizedMarket {
  const nextMarket = applyPricingSnapshot(market, update.pricing, nowMs);
  const marketWithTickSize =
    update.tickSize != null
      ? {
          ...nextMarket,
          tickSize: update.tickSize,
        }
      : nextMarket;
  if (!update.book) return marketWithTickSize;
  return {
    ...marketWithTickSize,
    bestBid: update.book.bestBid,
    bestAsk: update.book.bestAsk,
    midPrice: update.book.midPrice,
    spread: update.book.spread,
    minOrderSize: update.book.minOrderSize ?? marketWithTickSize.minOrderSize ?? null,
    bookSource: "clob",
    snapshotTs: update.book.timestamp,
  };
}

export function didMarketPricingChange(
  previous: NormalizedMarket,
  next: NormalizedMarket,
): boolean {
  return (
    previous.tickSize !== next.tickSize ||
    previous.bestBid !== next.bestBid ||
    previous.bestAsk !== next.bestAsk ||
    previous.midPrice !== next.midPrice ||
    previous.spread !== next.spread ||
    previous.lastTradePrice !== next.lastTradePrice ||
    previous.lastTradeAt !== next.lastTradeAt ||
    previous.volume24h !== next.volume24h ||
    previous.liquidity !== next.liquidity ||
    previous.minOrderSize !== next.minOrderSize ||
    previous.bookSource !== next.bookSource
  );
}
