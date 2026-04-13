import type {
  EventBus,
  FamilyRulesProvider,
  MarketDataGateway,
  MarketPricingSnapshot,
  MarketPricingFullBookReason,
  NormalizedMarket,
  OrderRepository,
  OrderBookSnapshot,
  PositionRepository,
  RuntimeEventMap,
  RuntimeModule,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { CandidateBookCache } from "../strategy/candidate-book-cache.js";
import {
  applyPricingSnapshot,
  applyStreamUpdate,
  didMarketPricingChange,
} from "../market-data/market-pricing-utils.js";
import { DEFAULT_HOT_LANE_POLICY, type HotLanePolicy } from "./hot-lane-policy.js";
import { StableHotMarketSelector } from "./hot-market-selection.js";

export interface HotMarketDataModuleDeps {
  readonly bus: EventBus;
  readonly gateway: MarketDataGateway;
  readonly rulesProvider: FamilyRulesProvider;
  readonly orderRepo: OrderRepository;
  readonly positionRepo: PositionRepository;
  readonly log: Logger;
  readonly candidateBookCache?: CandidateBookCache;
  readonly policy?: Partial<HotLanePolicy>;
}

interface HotMarketPricingStreamUpdate {
  readonly tokenId: string;
  readonly pricing: MarketPricingSnapshot;
  readonly book?: OrderBookSnapshot | null;
  readonly tickSize?: number | null;
}

interface HotMarketPricingStream {
  setTokenIds(tokenIds: readonly string[]): void;
  setFullBookTokenIds?(reason: MarketPricingFullBookReason, tokenIds: readonly string[]): void;
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
const BRIDGE_CANDIDATE_HOLD_MS = 3_000;

export class HotMarketDataModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly policy: HotLanePolicy;
  private readonly hotSelector = new StableHotMarketSelector();
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly lastFastUpdateAtByToken = new Map<string, number>();
  private readonly bridgeCandidateExpiryByToken = new Map<string, number>();
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
      this.deps.bus.subscribe("SignalApproved", (payload) => this.handleSignalApproved(payload)),
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
    this.hotSelector.reset();
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

  private async handleSignalApproved(payload: RuntimeEventMap["SignalApproved"]): Promise<void> {
    this.bridgeCandidateExpiryByToken.set(
      String(payload.signal.tokenId),
      Date.now() + BRIDGE_CANDIDATE_HOLD_MS,
    );
    this.syncInterestSet(Date.now());
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowMs = Date.now();
      const { hotMarkets, subscribedTokenIds } = this.syncInterestSet(nowMs);
      if (subscribedTokenIds.length === 0) return;

      const staleCutoffMs =
        nowMs -
        Math.max(HOT_MARKET_DATA_MIN_INTERVAL_MS, this.policy.hotQuoteRefreshIntervalMs * 3);
      const tokenIdsToPoll =
        this.stream == null
          ? subscribedTokenIds
          : subscribedTokenIds.filter(
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
        if (!didMarketPricingChange(market, nextMarket)) continue;
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
      if (!didMarketPricingChange(current, nextMarket)) continue;
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

  private syncInterestSet(nowMs: number): {
    hotMarkets: NormalizedMarket[];
    subscribedTokenIds: string[];
  } {
    this.pruneBridgeCandidates(nowMs);
    const openOrders = this.deps.orderRepo.findOpen();
    const hotMarkets = this.hotSelector.select({
      nowMs,
      rulesProvider: this.deps.rulesProvider,
      markets: [...this.marketCache.values()],
      openOrders,
      maxTokens: this.policy.maxTokensPerCycle,
      holdWindowMs: this.policy.hotSetHoldWindowMs,
    });
    const hotTokenIds = hotMarkets.map((market) => String(market.tokenId));
    const openOrderTokenIds = [...new Set(openOrders.map((order) => String(order.tokenId)))];
    const openPositionTokenIds = [
      ...new Set(this.deps.positionRepo.findOpen().map((position) => String(position.tokenId))),
    ];
    const bridgeCandidateTokenIds = [...this.bridgeCandidateExpiryByToken.keys()];
    const subscribedTokenIds = [
      ...new Set([
        ...hotTokenIds,
        ...openOrderTokenIds,
        ...openPositionTokenIds,
        ...bridgeCandidateTokenIds,
      ]),
    ].sort();
    this.stream?.setTokenIds(subscribedTokenIds);
    this.stream?.setFullBookTokenIds?.("hot-set", hotTokenIds);
    this.stream?.setFullBookTokenIds?.("open-order", openOrderTokenIds);
    this.stream?.setFullBookTokenIds?.("open-position", openPositionTokenIds);
    this.stream?.setFullBookTokenIds?.("bridge-candidate", bridgeCandidateTokenIds);
    return { hotMarkets, subscribedTokenIds };
  }

  private pruneBridgeCandidates(nowMs: number): void {
    for (const [tokenId, expiresAtMs] of this.bridgeCandidateExpiryByToken.entries()) {
      if (expiresAtMs > nowMs) continue;
      this.bridgeCandidateExpiryByToken.delete(tokenId);
    }
  }
}
