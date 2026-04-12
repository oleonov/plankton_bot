import type {
  EventBus,
  FamilyRulesProvider,
  MarketDataGateway,
  MarketPricingSnapshot,
  NormalizedMarket,
  OrderRepository,
  OrderBookSnapshot,
  RuntimeEventMap,
  RuntimeModule,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { CandidateBookCache } from "../strategy/candidate-book-cache.js";
import { DEFAULT_HOT_LANE_POLICY, type HotLanePolicy } from "./hot-lane-policy.js";
import { selectHotMarkets } from "./hot-market-selection.js";

export interface HotMarketDataModuleDeps {
  readonly bus: EventBus;
  readonly gateway: MarketDataGateway;
  readonly rulesProvider: FamilyRulesProvider;
  readonly orderRepo: OrderRepository;
  readonly log: Logger;
  readonly candidateBookCache?: CandidateBookCache;
  readonly policy?: Partial<HotLanePolicy>;
}

interface HotMarketPricingStreamUpdate {
  readonly tokenId: string;
  readonly pricing: MarketPricingSnapshot;
  readonly book?: OrderBookSnapshot | null;
}

interface HotMarketPricingStream {
  setTokenIds(tokenIds: readonly string[]): void;
  close(): void;
}

interface StreamCapableMarketDataGateway extends MarketDataGateway {
  createMarketPricingStream?: (
    handlers: Readonly<{
      onUpdates: (updates: readonly HotMarketPricingStreamUpdate[]) => Promise<void> | void;
      onError?: (error: unknown) => Promise<void> | void;
    }>,
  ) => HotMarketPricingStream;
}

const HOT_MARKET_DATA_MIN_INTERVAL_MS = 500;

export class HotMarketDataModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly policy: HotLanePolicy;
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly lastFastUpdateAtByToken = new Map<string, number>();
  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stream: HotMarketPricingStream | null = null;
  private started = false;
  private running = false;

  constructor(private readonly deps: HotMarketDataModuleDeps) {
    this.log = deps.log.child({ module: "hot-market-data" });
    this.policy = { ...DEFAULT_HOT_LANE_POLICY, ...deps.policy };
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (payload) =>
        this.handleMarketUpdate(payload),
      ),
    );
    const streamGateway = this.deps.gateway as StreamCapableMarketDataGateway;
    if (streamGateway.createMarketPricingStream) {
      this.stream = streamGateway.createMarketPricingStream({
        onUpdates: (updates) => this.handleStreamUpdates(updates),
        onError: (error) => {
          this.log.warn({ err: error }, "hot market-data stream error");
        },
      });
    }
    const intervalMs = Math.max(
      HOT_MARKET_DATA_MIN_INTERVAL_MS,
      this.policy.hotQuoteRefreshIntervalMs,
    );
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.log.error({ err }, "hot market-data tick error"));
    }, intervalMs);
    this.started = true;
    this.log.info(
      {
        intervalMs,
        maxTokensPerCycle: this.policy.maxTokensPerCycle,
      },
      "hot market-data module started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.close();
    this.stream = null;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("hot market-data module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: this.started,
      detail: this.started
        ? `markets=${this.marketCache.size} stream=${this.stream ? "on" : "off"}`
        : "not started",
    };
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of payload.markets) {
      this.marketCache.set(String(market.tokenId), market);
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowMs = Date.now();
      const hotMarkets = selectHotMarkets({
        nowMs,
        rulesProvider: this.deps.rulesProvider,
        markets: [...this.marketCache.values()],
        openOrders: this.deps.orderRepo.findOpen(),
        maxTokens: this.policy.maxTokensPerCycle,
      });
      if (hotMarkets.length === 0) {
        this.stream?.setTokenIds([]);
        return;
      }
      const hotTokenIds = hotMarkets.map((market) => String(market.tokenId));
      this.stream?.setTokenIds(hotTokenIds);

      const staleCutoffMs =
        nowMs -
        Math.max(HOT_MARKET_DATA_MIN_INTERVAL_MS, this.policy.hotQuoteRefreshIntervalMs * 3);
      const tokenIdsToPoll =
        this.stream == null
          ? hotTokenIds
          : hotTokenIds.filter(
              (tokenId) => (this.lastFastUpdateAtByToken.get(tokenId) ?? 0) < staleCutoffMs,
            );
      if (tokenIdsToPoll.length === 0) return;

      const pricingMap = await this.deps.gateway.getMarketPricing(tokenIdsToPoll);
      const changedMarkets: NormalizedMarket[] = [];
      for (const market of hotMarkets) {
        if (!tokenIdsToPoll.includes(String(market.tokenId))) continue;
        const pricing = pricingMap.get(String(market.tokenId));
        if (!pricing) continue;
        const nextMarket = applyPricingSnapshot(market, pricing, nowMs);
        if (!didHotMarketPricingChange(market, nextMarket)) continue;
        this.marketCache.set(String(nextMarket.tokenId), nextMarket);
        this.lastFastUpdateAtByToken.set(String(nextMarket.tokenId), nowMs);
        changedMarkets.push(nextMarket);
      }

      if (changedMarkets.length === 0) return;
      await this.deps.bus.publish("NormalizedMarketUpdated", {
        markets: changedMarkets,
        timestamp: nowMs,
      });
    } finally {
      this.running = false;
    }
  }

  private async handleStreamUpdates(
    updates: readonly HotMarketPricingStreamUpdate[],
  ): Promise<void> {
    if (updates.length === 0) return;
    const nowMs = Date.now();
    const changedMarkets: NormalizedMarket[] = [];
    const books = new Map<string, OrderBookSnapshot>();

    for (const update of updates) {
      const tokenKey = String(update.tokenId);
      const current = this.marketCache.get(tokenKey);
      if (!current) continue;
      const nextMarket = applyStreamUpdate(current, update, nowMs);
      this.lastFastUpdateAtByToken.set(tokenKey, nowMs);
      if (update.book) books.set(tokenKey, update.book);
      if (!didHotMarketPricingChange(current, nextMarket)) continue;
      this.marketCache.set(tokenKey, nextMarket);
      changedMarkets.push(nextMarket);
    }

    if (books.size > 0) {
      this.deps.candidateBookCache?.upsertBooks(books, nowMs);
    }
    if (changedMarkets.length === 0) return;
    await this.deps.bus.publish("NormalizedMarketUpdated", {
      markets: changedMarkets,
      timestamp: nowMs,
    });
  }
}

function applyPricingSnapshot(
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

function didHotMarketPricingChange(prev: NormalizedMarket, next: NormalizedMarket): boolean {
  return (
    prev.bestBid !== next.bestBid ||
    prev.bestAsk !== next.bestAsk ||
    prev.midPrice !== next.midPrice ||
    prev.spread !== next.spread ||
    prev.lastTradePrice !== next.lastTradePrice ||
    prev.lastTradeAt !== next.lastTradeAt ||
    prev.volume24h !== next.volume24h ||
    prev.liquidity !== next.liquidity ||
    prev.minOrderSize !== next.minOrderSize ||
    prev.bookSource !== next.bookSource
  );
}

function applyStreamUpdate(
  market: NormalizedMarket,
  update: HotMarketPricingStreamUpdate,
  nowMs: number,
): NormalizedMarket {
  const nextMarket = applyPricingSnapshot(market, update.pricing, nowMs);
  if (!update.book) return nextMarket;
  return {
    ...nextMarket,
    bestBid: update.book.bestBid,
    bestAsk: update.book.bestAsk,
    midPrice: update.book.midPrice,
    spread: update.book.spread,
    minOrderSize: update.book.minOrderSize ?? nextMarket.minOrderSize ?? null,
    bookSource: "clob",
    snapshotTs: update.book.timestamp,
  };
}
