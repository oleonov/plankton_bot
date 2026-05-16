import type {
  MarketPricingSnapshot,
  MarketPricingStreamUpdate,
  NormalizedMarket,
} from "@krabs/domain";
import { deriveExecutableTopOfBook } from "../../executable-price.js";

export function applyPricingSnapshot(
  market: NormalizedMarket,
  pricing: MarketPricingSnapshot,
  nowMs: number,
): NormalizedMarket {
  const topOfBook = deriveExecutableTopOfBook(
    {
      bestBid: pricing.bestBid ?? null,
      bestAsk: pricing.bestAsk ?? null,
    },
    market.tickSize,
  );
  return {
    ...market,
    bestBid: topOfBook.bestBid,
    bestAsk: topOfBook.bestAsk,
    bestBidSize: topOfBook.bestBidSize,
    bestAskSize: topOfBook.bestAskSize,
    askDepthExcludingOurs: null,
    midPrice: topOfBook.midPrice,
    spread: topOfBook.spread,
    acceptingOrders: pricing.acceptingOrders,
    enableOrderBook: pricing.enableOrderBook,
    lastTradePrice: pricing.lastTradePrice ?? null,
    lastTradeAt: pricing.lastTradeAt ?? null,
    volume24h: pricing.volume24h ?? market.volume24h ?? null,
    volume24hr: pricing.volume24hr ?? market.volume24hr ?? null,
    publicTradeCount24h: hasPricingField(pricing, "publicTradeCount24h")
      ? (pricing.publicTradeCount24h ?? null)
      : (market.publicTradeCount24h ?? null),
    liquidity: pricing.liquidity ?? market.liquidity ?? null,
    minOrderSize: pricing.minOrderSize ?? market.minOrderSize ?? null,
    bookSource: pricing.bookSource ?? market.bookSource ?? "unknown",
    snapshotTs: nowMs,
    // Only bump the feature-freshness clock when the current REST payload
    // *actually* supplied both score-feature fields (`volume24hr` and
    // `liquidity`). When Gamma omits either, the values above fall back to
    // the previous `market.*` cache — bumping the clock would mark stale
    // cached features as fresh and let soft-ranking score on hours-old data
    // (audit doc §D7).
    featuresCapturedTs:
      pricing.volume24hr != null && pricing.liquidity != null
        ? nowMs
        : (market.featuresCapturedTs ?? null),
  };
}

export function applyStreamUpdate(
  market: NormalizedMarket,
  update: MarketPricingStreamUpdate,
  nowMs: number,
): NormalizedMarket {
  const marketWithTickSize =
    update.tickSize != null
      ? {
          ...market,
          tickSize: update.tickSize,
        }
      : market;
  // Stream updates never carry fresh Gamma features (volume24hr / liquidity);
  // preserve the prior `featuresCapturedTs` so a chatty book stream cannot
  // mark hours-stale feature inputs as fresh for soft-ranking (audit §D7).
  const preservedFeaturesTs = marketWithTickSize.featuresCapturedTs ?? null;
  const pricedMarket = applyPricingSnapshot(marketWithTickSize, update.pricing, nowMs);
  const nextMarket = {
    ...pricedMarket,
    acceptingOrders: marketWithTickSize.acceptingOrders,
    enableOrderBook: marketWithTickSize.enableOrderBook,
  };
  if (!update.book) {
    return { ...nextMarket, featuresCapturedTs: preservedFeaturesTs };
  }
  const topOfBook = deriveExecutableTopOfBook(
    {
      bestBid: update.book.bestBid,
      bestAsk: update.book.bestAsk,
      bids: update.book.bids,
      asks: update.book.asks,
    },
    marketWithTickSize.tickSize,
  );
  return {
    ...nextMarket,
    bestBid: topOfBook.bestBid,
    bestAsk: topOfBook.bestAsk,
    bestBidSize: topOfBook.bestBidSize,
    bestAskSize: topOfBook.bestAskSize,
    askDepthExcludingOurs: null,
    midPrice: topOfBook.midPrice,
    spread: topOfBook.spread,
    minOrderSize: update.book.minOrderSize ?? nextMarket.minOrderSize ?? null,
    bookSource: "clob",
    snapshotTs: update.book.timestamp,
    featuresCapturedTs: preservedFeaturesTs,
  };
}

export function didMarketPricingChange(
  previous: NormalizedMarket,
  next: NormalizedMarket,
): boolean {
  return (
    previous.acceptingOrders !== next.acceptingOrders ||
    previous.enableOrderBook !== next.enableOrderBook ||
    previous.tickSize !== next.tickSize ||
    previous.bestBid !== next.bestBid ||
    previous.bestAsk !== next.bestAsk ||
    previous.bestBidSize !== next.bestBidSize ||
    previous.bestAskSize !== next.bestAskSize ||
    previous.midPrice !== next.midPrice ||
    previous.spread !== next.spread ||
    previous.lastTradePrice !== next.lastTradePrice ||
    previous.lastTradeAt !== next.lastTradeAt ||
    previous.volume24h !== next.volume24h ||
    previous.volume24hr !== next.volume24hr ||
    previous.publicTradeCount24h !== next.publicTradeCount24h ||
    previous.liquidity !== next.liquidity ||
    previous.minOrderSize !== next.minOrderSize ||
    previous.bookSource !== next.bookSource
  );
}

function hasPricingField<T extends keyof MarketPricingSnapshot>(
  pricing: MarketPricingSnapshot,
  field: T,
): boolean {
  return Object.prototype.hasOwnProperty.call(pricing, field);
}
