import type {
  MarketDataGateway,
  ClobMarket,
  OrderBookSnapshot,
  TokenId,
  PriceLevel,
  MarketPricingSnapshot,
} from "@plankton/domain";

export class SimulationMarketDataGateway implements MarketDataGateway {
  private readonly markets = new Map<string, ClobMarket>();
  private readonly tickSizes = new Map<string, number>();
  private readonly orderBooks = new Map<string, OrderBookSnapshot>();

  async getMarkets(_onPage?: (page: number) => Promise<void> | void): Promise<ClobMarket[]> {
    return [...this.markets.values()].filter((m) => m.active);
  }

  async getMarket(conditionId: string): Promise<ClobMarket | null> {
    return this.markets.get(conditionId) ?? null;
  }

  async getOrderBook(tokenId: TokenId): Promise<OrderBookSnapshot> {
    return (
      this.orderBooks.get(tokenId) ?? {
        tokenId,
        bids: [],
        asks: [],
        bestBid: null,
        bestAsk: null,
        midPrice: null,
        spread: null,
        minOrderSize: null,
        timestamp: Date.now(),
      }
    );
  }

  async getOrderBooks(tokenIds: string[]): Promise<Map<string, OrderBookSnapshot>> {
    const result = new Map<string, OrderBookSnapshot>();
    for (const tokenId of tokenIds) {
      result.set(tokenId, await this.getOrderBook(tokenId as TokenId));
    }
    return result;
  }

  async getTickSize(tokenId: TokenId): Promise<number> {
    return this.tickSizes.get(tokenId) ?? 0.01;
  }

  async getMarketPricing(tokenIds: string[]): Promise<Map<string, MarketPricingSnapshot>> {
    const result = new Map<string, MarketPricingSnapshot>();
    for (const tokenId of tokenIds) {
      const book = this.orderBooks.get(tokenId);
      result.set(tokenId, {
        bestBid: book?.bestBid ?? null,
        bestAsk: book?.bestAsk ?? null,
        lastTradePrice: null,
        lastTradeAt: null,
        volume24h: null,
        liquidity: null,
        minOrderSize: book?.minOrderSize ?? null,
        bookSource: "simulation",
      });
    }
    return result;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }

  // ─── Test helpers ──────────────────────────────────────────────────

  /** Add or update a market in the simulation catalog. */
  addMarket(market: ClobMarket): void {
    this.markets.set(market.conditionId, market);
    for (const token of market.tokens) {
      this.tickSizes.set(token.tokenId, market.tickSize);
    }
  }

  /** Set the order book for a token. */
  setOrderBook(tokenId: TokenId, bids: PriceLevel[], asks: PriceLevel[]): void {
    const bestBid = bids.length > 0 ? bids[0]!.price : null;
    const bestAsk = asks.length > 0 ? asks[0]!.price : null;
    const midPrice = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

    this.orderBooks.set(tokenId, {
      tokenId,
      bids,
      asks,
      bestBid,
      bestAsk,
      midPrice,
      spread,
      minOrderSize: null,
      timestamp: Date.now(),
    });
  }

  /** Remove all state. */
  reset(): void {
    this.markets.clear();
    this.tickSizes.clear();
    this.orderBooks.clear();
  }
}
