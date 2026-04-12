import type {
  EventBus,
  FamilyRulesProvider,
  NormalizedMarket,
  OrderRepository,
  RuntimeEventMap,
  RuntimeModule,
} from "@plankton/domain";
import { createCommandId, ENTRY_REASONS } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import {
  applyOrderBookToMarket,
  CandidateBookCache,
} from "../strategy/candidate-book-cache.js";
import {
  captureQueueDepthBaseline,
  DEFAULT_HOT_LANE_POLICY,
  planHotLaneOrderAction,
  shouldUseDustLane,
  shouldUseHotQuoteLane,
  type HotLanePolicy,
} from "./hot-lane-policy.js";
import { selectHotMarkets } from "./hot-market-selection.js";

export interface HotFamilyExecutionModuleDeps {
  readonly bus: EventBus;
  readonly rulesProvider: FamilyRulesProvider;
  readonly orderRepo: OrderRepository;
  readonly candidateBookCache: CandidateBookCache;
  readonly log: Logger;
  readonly intervalMs?: number;
  readonly policy?: Partial<HotLanePolicy>;
}

export class HotFamilyExecutionModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly policy: HotLanePolicy;
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly pendingCancelOrderIds = new Set<string>();
  private readonly quickCancelCountByToken = new Map<string, number>();
  private readonly suppressedUntilByToken = new Map<string, number>();
  private readonly lastRepriceCancelAtByToken = new Map<string, number>();
  private readonly lastMaintenanceAtByOrderId = new Map<string, number>();
  private readonly queueBaselineByOrderId = new Map<string, ReturnType<typeof captureQueueDepthBaseline>>();
  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private running = false;

  constructor(private readonly deps: HotFamilyExecutionModuleDeps) {
    this.log = deps.log.child({ module: "hot-family-execution" });
    this.policy = { ...DEFAULT_HOT_LANE_POLICY, ...deps.policy };
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (payload) => this.handleMarketUpdate(payload)),
      this.deps.bus.subscribe("FillReceived", (payload) => this.handleFill(payload)),
      this.deps.bus.subscribe("OrderCancelled", (payload) => this.handleCancel(payload)),
      this.deps.bus.subscribe("OrderPlaced", (payload) => this.handlePlaced(payload)),
    );
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.log.error({ err }, "hot-family execution tick error"));
    }, this.policy.hotQuoteRefreshIntervalMs);
    this.started = true;
    this.log.info(
      {
        intervalMs: this.policy.hotQuoteRefreshIntervalMs,
        maxTokensPerCycle: this.policy.maxTokensPerCycle,
      },
      "hot-family execution module started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.pendingCancelOrderIds.clear();
    this.queueBaselineByOrderId.clear();
    this.lastRepriceCancelAtByToken.clear();
    this.started = false;
    this.log.info("hot-family execution module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: this.started,
      detail: this.started
        ? `markets=${this.marketCache.size} pendingCancels=${this.pendingCancelOrderIds.size}`
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

  private async handleFill(payload: RuntimeEventMap["FillReceived"]): Promise<void> {
    const tokenKey = String(payload.tokenId);
    this.quickCancelCountByToken.delete(tokenKey);
    this.suppressedUntilByToken.delete(tokenKey);
    this.lastRepriceCancelAtByToken.delete(tokenKey);
    this.pendingCancelOrderIds.delete(String(payload.orderId));
    this.lastMaintenanceAtByOrderId.delete(String(payload.orderId));
    this.queueBaselineByOrderId.delete(String(payload.orderId));
  }

  private async handleCancel(payload: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    this.pendingCancelOrderIds.delete(String(payload.orderId));
    this.lastMaintenanceAtByOrderId.delete(String(payload.orderId));
    this.queueBaselineByOrderId.delete(String(payload.orderId));
  }

  private async handlePlaced(payload: RuntimeEventMap["OrderPlaced"]): Promise<void> {
    if (!ENTRY_REASONS.has(payload.signalReason ?? "") && payload.signalReason !== "repricing-exit") {
      return;
    }
    const orderIdKey = String(payload.orderId);
    this.lastMaintenanceAtByOrderId.set(orderIdKey, payload.timestamp);
    const cachedBook = this.deps.candidateBookCache.getFreshEntry(String(payload.tokenId), payload.timestamp);
    if (cachedBook) {
      this.queueBaselineByOrderId.set(
        orderIdKey,
        captureQueueDepthBaseline(payload.side, cachedBook.book, payload.price),
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const nowMs = Date.now();
      const hotMarkets = this.collectHotMarkets(nowMs);
      if (hotMarkets.length === 0) return;

      const openOrders = this.deps.orderRepo.findOpen();
      const openOrderIds = new Set(openOrders.map((order) => String(order.orderId)));
      for (const pending of [...this.pendingCancelOrderIds]) {
        if (!openOrderIds.has(pending)) this.pendingCancelOrderIds.delete(pending);
      }

      for (const order of openOrders) {
        if (
          order.signalReason !== "spray-entry" &&
          !(order.side === "sell" && order.signalReason === "repricing-exit")
        ) {
          continue;
        }
        const orderIdKey = String(order.orderId);
        if (this.pendingCancelOrderIds.has(orderIdKey)) continue;

        const bundle = this.deps.rulesProvider.getRule(order.familyId);
        if (!bundle) continue;
        if (
          order.signalReason === "spray-entry" &&
          !shouldUseDustLane(bundle)
        ) {
          continue;
        }
        if (
          order.signalReason === "repricing-exit" &&
          !shouldUseHotQuoteLane(bundle)
        ) {
          continue;
        }

        const tokenKey = String(order.tokenId);
        const suppressedUntil = this.suppressedUntilByToken.get(tokenKey) ?? 0;
        if (suppressedUntil > nowMs) continue;

        const baseMarket = this.marketCache.get(tokenKey) ?? null;
        const cachedBook = this.deps.candidateBookCache.getFreshEntry(tokenKey, nowMs);
        const market =
          baseMarket && cachedBook ? applyOrderBookToMarket(baseMarket, cachedBook) : baseMarket;
        const action = planHotLaneOrderAction({
          order,
          market,
          book: cachedBook?.book ?? null,
          bundle,
          nowMs,
          lastMaintenanceAtMs: this.lastMaintenanceAtByOrderId.get(orderIdKey) ?? null,
          quickCancelCount: this.quickCancelCountByToken.get(tokenKey) ?? 0,
          queueBaseline: this.queueBaselineByOrderId.get(orderIdKey) ?? null,
          policy: this.policy,
        });
        if (action.type !== "cancel" || !action.reason) continue;
        if (
          isRepriceCancelReason(action.reason) &&
          nowMs - (this.lastRepriceCancelAtByToken.get(tokenKey) ?? 0) <
            this.policy.minRepriceCancelIntervalMs
        ) {
          continue;
        }

        this.pendingCancelOrderIds.add(orderIdKey);
        this.lastMaintenanceAtByOrderId.set(orderIdKey, nowMs);
        if (isRepriceCancelReason(action.reason)) {
          this.lastRepriceCancelAtByToken.set(tokenKey, nowMs);
        }
        if (action.reason === "entry-reprice-cancel" || action.reason === "entry-ttl-cancel") {
          this.quickCancelCountByToken.set(tokenKey, (this.quickCancelCountByToken.get(tokenKey) ?? 0) + 1);
        } else if (action.reason === "entry-suppress-cancel") {
          this.quickCancelCountByToken.set(tokenKey, 0);
          this.suppressedUntilByToken.set(tokenKey, nowMs + 60_000);
        }

        await this.deps.bus.publish("HotLaneActionApplied", {
          familyId: order.familyId,
          tokenId: order.tokenId,
          orderId: order.orderId,
          signalReason: order.signalReason ?? null,
          action: action.reason,
          timestamp: nowMs,
        });
        await this.deps.bus.publish("CancelOrderRequested", {
          command: {
            type: "CancelOrderCommand",
            commandId: createCommandId(`hot-lane-${String(order.orderId)}-${nowMs}`),
            orderId: order.orderId,
            reason: action.reason,
            familyId: order.familyId,
          },
          timestamp: nowMs,
        });
      }
    } finally {
      this.running = false;
    }
  }

  private collectHotMarkets(nowMs: number): NormalizedMarket[] {
    return selectHotMarkets({
      nowMs,
      rulesProvider: this.deps.rulesProvider,
      markets: [...this.marketCache.values()],
      openOrders: this.deps.orderRepo.findOpen(),
      suppressedUntilByToken: this.suppressedUntilByToken,
      maxTokens: this.policy.maxTokensPerCycle,
    });
  }
}

function isRepriceCancelReason(reason: string): boolean {
  return reason === "entry-reprice-cancel" || reason === "exit-reprice-cancel";
}
