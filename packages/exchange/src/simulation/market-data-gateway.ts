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
  private livenessOverrides = new Map<
    string,
    { acceptingOrders?: boolean; enableOrderBook?: boolean }
  >();

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

  async getMarketPricing(
    tokenIds: string[],
    _opts?: { timeoutMs?: number },
  ): Promise<Map<string, MarketPricingSnapshot>> {
    const result = new Map<string, MarketPricingSnapshot>();
    for (const tokenId of tokenIds) {
      const book = this.orderBooks.get(tokenId);
      const override = this.livenessOverrides.get(tokenId);
      // Step 3 (audit doc §P0 step 1.4 / §F4): simulation/paper paths must
      // produce populated soft-ranking feature inputs so the scorer is
      // exercised end-to-end, not silently skipped as missing-features.
      // Derive deterministic plausible values from the tokenId hash so the
      // same simulated token always yields the same liquidity/volume —
      // tests that depend on bestBid/bestAsk are unaffected because we only
      // populate the previously-null feature fields.
      const seed = simulationFeatureSeed(tokenId);
      result.set(tokenId, {
        bestBid: book?.bestBid ?? null,
        bestAsk: book?.bestAsk ?? null,
        acceptingOrders: override?.acceptingOrders ?? true,
        enableOrderBook: override?.enableOrderBook ?? true,
        lastTradePrice: null,
        lastTradeAt: null,
        volume24h: seed.volume24h,
        volume24hr: seed.volume24hr,
        liquidity: seed.liquidity,
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

  /** Override liveness flags for a token — test-only. Unset keys default to true. */
  setLivenessOverride(
    tokenId: TokenId,
    patch: { acceptingOrders?: boolean; enableOrderBook?: boolean },
  ): void {
    const existing = this.livenessOverrides.get(String(tokenId)) ?? {};
    this.livenessOverrides.set(String(tokenId), { ...existing, ...patch });
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
    this.livenessOverrides.clear();
  }
}

function simulationFeatureSeed(tokenId: string): {
  volume24h: number;
  volume24hr: number;
  liquidity: number;
} {
  // FNV-1a 32-bit — tiny deterministic hash, no crypto needed.
  let hash = 0x811c9dc5;
  for (let i = 0; i < tokenId.length; i += 1) {
    hash ^= tokenId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Spread the same hash across two ranges so volume and liquidity are not
  // perfectly correlated (the LR scorer would otherwise see one redundant
  // axis). Bounded to 100..50_000 so all feature transforms stay finite.
  const volumeBucket = (hash >>> 0) % 49_900;
  const liquidityBucket = ((hash >>> 8) >>> 0) % 49_900;
  const volume24hr = 100 + volumeBucket;
  const liquidity = 100 + liquidityBucket;
  return {
    volume24h: volume24hr * 2,
    volume24hr,
    liquidity,
  };
}
