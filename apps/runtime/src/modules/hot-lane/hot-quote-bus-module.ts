import type {
  EventBus,
  FamilyRulesProvider,
  NormalizedMarket,
  OrderRepository,
  RuntimeEventMap,
  RuntimeModule,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { CandidateBookCache } from "../strategy/candidate-book-cache.js";
import { DEFAULT_HOT_LANE_POLICY, type HotLanePolicy } from "./hot-lane-policy.js";
import { shouldUseHotQuoteLane } from "./hot-lane-policy.js";
import { dedupeHotFamilyIds, selectHotMarkets } from "./hot-market-selection.js";

const DEFAULT_EVENT_DRIVEN_FLUSH_MS = 50;

export interface HotQuoteBusModuleDeps {
  readonly bus: EventBus;
  readonly rulesProvider: FamilyRulesProvider;
  readonly orderRepo: OrderRepository;
  readonly candidateBookCache: CandidateBookCache;
  readonly log: Logger;
  readonly policy?: Partial<HotLanePolicy>;
}

export class HotQuoteBusModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly policy: HotLanePolicy;
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly pendingTokenIds = new Set<string>();
  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private running = false;

  constructor(private readonly deps: HotQuoteBusModuleDeps) {
    this.log = deps.log.child({ module: "hot-quote-bus" });
    this.policy = { ...DEFAULT_HOT_LANE_POLICY, ...deps.policy };
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (payload) =>
        this.handleMarketUpdate(payload),
      ),
      this.deps.bus.subscribe("OrderPlaced", (payload) =>
        this.handleOrderLifecycle(String(payload.tokenId)),
      ),
      this.deps.bus.subscribe("OrderCancelled", (payload) =>
        this.handleOrderLifecycleByFamily(String(payload.familyId)),
      ),
      this.deps.bus.subscribe("FillReceived", (payload) =>
        this.handleOrderLifecycle(String(payload.tokenId)),
      ),
    );
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.log.error({ err }, "hot quote bus tick error"));
    }, this.policy.hotQuoteRefreshIntervalMs);
    this.started = true;
    this.log.info(
      {
        intervalMs: this.policy.hotQuoteRefreshIntervalMs,
        maxTokensPerCycle: this.policy.maxTokensPerCycle,
      },
      "hot quote bus module started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.pendingTokenIds.clear();
    this.started = false;
    this.log.info("hot quote bus module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: this.started,
      detail: this.started ? `markets=${this.marketCache.size}` : "not started",
    };
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of payload.markets) {
      this.marketCache.set(String(market.tokenId), market);
      const bundle = market.familyId ? this.deps.rulesProvider.getRule(market.familyId) : null;
      if (bundle && shouldUseHotQuoteLane(bundle) && bundle.rules.universe.action === "trade") {
        this.pendingTokenIds.add(String(market.tokenId));
      }
    }
    this.scheduleFlush();
  }

  private async handleOrderLifecycle(tokenKey: string): Promise<void> {
    if (this.marketCache.has(tokenKey)) {
      this.pendingTokenIds.add(tokenKey);
      this.scheduleFlush();
    }
  }

  private async handleOrderLifecycleByFamily(familyKey: string): Promise<void> {
    let touched = false;
    for (const market of this.marketCache.values()) {
      if (String(market.familyId ?? "") !== familyKey) continue;
      this.pendingTokenIds.add(String(market.tokenId));
      touched = true;
    }
    if (touched) this.scheduleFlush();
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
      if (hotMarkets.length === 0) return;
      for (const market of hotMarkets) {
        this.pendingTokenIds.add(String(market.tokenId));
      }
      await this.flushPendingRefreshes(nowMs);
    } finally {
      this.running = false;
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(
      () => {
        this.flushTimer = null;
        void this.flushPendingRefreshes().catch((err) =>
          this.log.error({ err }, "hot quote bus event-driven refresh error"),
        );
      },
      Math.min(DEFAULT_EVENT_DRIVEN_FLUSH_MS, this.policy.hotQuoteRefreshIntervalMs),
    );
  }

  private async flushPendingRefreshes(nowMs = Date.now()): Promise<void> {
    const tokenIds = [...this.pendingTokenIds];
    this.pendingTokenIds.clear();
    if (tokenIds.length === 0) return;

    const candidateMarkets = tokenIds
      .map((tokenId) => this.marketCache.get(tokenId) ?? null)
      .filter((market): market is NormalizedMarket => market != null);
    if (candidateMarkets.length === 0) return;

    const hotMarkets = selectHotMarkets({
      nowMs,
      rulesProvider: this.deps.rulesProvider,
      markets: candidateMarkets,
      openOrders: this.deps.orderRepo.findOpen(),
      maxTokens: this.policy.maxTokensPerCycle,
    });
    if (hotMarkets.length === 0) return;

    const tokenIdsNeedingRefresh = hotMarkets
      .map((market) => String(market.tokenId))
      .filter((tokenId) => this.deps.candidateBookCache.getFreshEntry(tokenId, nowMs) == null);
    if (tokenIdsNeedingRefresh.length > 0) {
      await this.deps.candidateBookCache.prime(tokenIdsNeedingRefresh);
    }
    await this.deps.bus.publish("HotQuoteUpdated", {
      tokenIds: hotMarkets.map((market) => market.tokenId),
      familyIds: dedupeHotFamilyIds(hotMarkets),
      refreshedAt: nowMs,
    });
  }
}
