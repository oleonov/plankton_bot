import type {
  EventBus,
  FamilyRulesProvider,
  NormalizedMarket,
  OrderRepository,
  PositionRepository,
  RuntimeEventMap,
  RuntimeModule,
  Signal,
} from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { applyOrderBookToMarket, CandidateBookCache } from "../strategy/candidate-book-cache.js";
import {
  resolveDustExitSignalIntervalMs,
  shouldUseDustLane,
  shouldUseHotQuoteLane,
  type HotLanePolicy,
  DEFAULT_HOT_LANE_POLICY,
} from "./hot-lane-policy.js";

export interface FastExitCleanupModuleDeps {
  readonly bus: EventBus;
  readonly rulesProvider: FamilyRulesProvider;
  readonly positionRepo: PositionRepository;
  readonly orderRepo: OrderRepository;
  readonly candidateBookCache: CandidateBookCache;
  readonly log: Logger;
  readonly policy?: Partial<HotLanePolicy>;
}

const DEFAULT_EXIT_TICK_FLOOR_MS = 2_000;

export class FastExitCleanupModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly policy: HotLanePolicy;
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly lastExitSignalAtByToken = new Map<string, number>();
  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private running = false;

  constructor(private readonly deps: FastExitCleanupModuleDeps) {
    this.log = deps.log.child({ module: "fast-exit-cleanup" });
    this.policy = { ...DEFAULT_HOT_LANE_POLICY, ...deps.policy };
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (payload) =>
        this.handleMarketUpdate(payload),
      ),
      this.deps.bus.subscribe("HotQuoteUpdated", () => this.tick()),
      this.deps.bus.subscribe("FillReceived", () => this.tick()),
      this.deps.bus.subscribe("OrderPlaced", (payload) => this.handleOrderPlaced(payload)),
    );
    this.timer = setInterval(
      () => {
        void this.tick().catch((err) => this.log.error({ err }, "fast exit cleanup tick error"));
      },
      Math.max(500, Math.min(this.policy.hotQuoteRefreshIntervalMs, DEFAULT_EXIT_TICK_FLOOR_MS)),
    );
    this.started = true;
    this.log.info("fast exit cleanup module started");
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("fast exit cleanup module stopped");
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
    }
  }

  private async handleOrderPlaced(payload: RuntimeEventMap["OrderPlaced"]): Promise<void> {
    if (payload.signalReason !== "repricing-exit") return;
    this.lastExitSignalAtByToken.set(String(payload.tokenId), payload.timestamp);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowMs = Date.now();
      const openSellTokens = new Set(
        this.deps.orderRepo
          .findOpen()
          .filter((order) => order.side === "sell")
          .map((order) => String(order.tokenId)),
      );
      const positions = this.deps.positionRepo.findOpen();
      for (const position of positions) {
        if (position.entryStyle !== "spray") continue;
        const tokenKey = String(position.tokenId);
        if (openSellTokens.has(tokenKey)) continue;
        const market = this.resolveMarket(tokenKey, nowMs);
        if (!market || !market.familyId) continue;
        const bundle = this.deps.rulesProvider.getRule(market.familyId);
        if (!bundle || !shouldUseHotQuoteLane(bundle) || !shouldUseDustLane(bundle)) continue;
        if (bundle.rules.universe.action !== "trade") continue;
        const exitSignalIntervalMs = resolveDustExitSignalIntervalMs(bundle, this.policy);
        if ((this.lastExitSignalAtByToken.get(tokenKey) ?? 0) + exitSignalIntervalMs > nowMs) {
          continue;
        }

        const suggestedPrice = market.lastTradePrice ?? market.midPrice ?? market.bestBid ?? null;
        if (suggestedPrice == null || suggestedPrice <= 0) continue;

        const signal: Signal = {
          signalId: `fast-exit-${tokenKey}-${nowMs}`,
          familyId: position.familyId,
          tokenId: createTokenId(tokenKey),
          side: "sell",
          suggestedPrice,
          suggestedSize: position.size,
          suggestedSizeUsdc: position.size * suggestedPrice,
          reason: "repricing-exit",
          strategyTick: nowMs,
          sequenceInTick: 0,
          decisionRuleId: null,
          generatedAt: new Date(nowMs).toISOString(),
        };
        this.lastExitSignalAtByToken.set(tokenKey, nowMs);
        await this.deps.bus.publish("SignalProduced", { signal });
      }
    } finally {
      this.running = false;
    }
  }

  private resolveMarket(tokenKey: string, nowMs: number): NormalizedMarket | null {
    const baseMarket = this.marketCache.get(tokenKey) ?? null;
    if (!baseMarket) return null;
    const cachedBook = this.deps.candidateBookCache.getFreshEntry(tokenKey, nowMs);
    return cachedBook ? applyOrderBookToMarket(baseMarket, cachedBook) : baseMarket;
  }
}
