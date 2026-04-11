/**
 * Signal-to-Order bridge — converts SignalApproved into PlaceOrderRequested.
 *
 * Closes the gap in the end-to-end trading path:
 *   strategy → SignalProduced → risk → SignalApproved → [this bridge] → PlaceOrderRequested → execution
 *
 * Responsibilities:
 *  - Subscribe to SignalApproved
 *  - Look up market metadata (tickSize, negRisk) from the cached market snapshot
 *  - Build a PlaceOrderCommand with deterministic clientOrderId
 *  - Publish PlaceOrderRequested for the execution module
 *
 * Does NOT evaluate risk — that already happened upstream.
 */

import type {
  EventBus,
  FamilyRulesProvider,
  NormalizedMarket,
  OrderRepository,
  RuntimeEventMap,
  PlaceOrderCommand,
} from "@plankton/domain";
import { createCommandId, ENTRY_REASONS, resolveFamilyLiveTradingPolicy } from "@plankton/domain";
import { buildClientOrderId } from "@plankton/domain/node";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import {
  buildRestingOrderSnapshot,
  evaluateMarketability,
  resolveMakerOnlyPrice,
  resolveMarketabilityPolicy,
  type MarketabilityDecision,
  type MarketabilityPolicy,
} from "./marketability.js";

export interface SignalToOrderBridgeDeps {
  bus: EventBus;
  log: Logger;
  rulesProvider: FamilyRulesProvider;
  orderRepo?: OrderRepository | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
}

export class SignalToOrderBridge {
  private readonly log: Logger;
  private marketCache = new Map<string, NormalizedMarket>();
  private unfilledCancelCountByToken = new Map<string, number>();
  private cooldownUntilByToken = new Map<string, number>();
  private filledOrderIds = new Set<string>();
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: SignalToOrderBridgeDeps) {
    this.log = deps.log.child({ component: "signal-to-order" });
  }

  subscribe(): void {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("SignalApproved", (p) => this.handleApproved(p)),
      this.deps.bus.subscribe("FillReceived", (p) => this.handleFillReceived(p)),
      this.deps.bus.subscribe("OrderCancelled", (p) => this.handleOrderCancelled(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const m of payload.markets) {
      this.marketCache.set(String(m.tokenId), m);
    }
  }

  private async handleApproved(payload: RuntimeEventMap["SignalApproved"]): Promise<void> {
    const { signal } = payload;
    const market = this.marketCache.get(String(signal.tokenId));

    if (!market) {
      this.log.warn(
        { signalId: signal.signalId, tokenId: signal.tokenId },
        "approved signal has no cached market — cannot build order command",
      );
      return;
    }

    const bundle = this.deps.rulesProvider.getRule(signal.familyId);
    const marketability = this.evaluateMarketability(signal, market, bundle);
    if (!marketability.approved) {
      this.log.warn(
        {
          signalId: signal.signalId,
          familyId: signal.familyId,
          tokenId: signal.tokenId,
          reasons: marketability.rejectionReasons,
          ...marketability.diagnostics,
        },
        "approved signal skipped — marketability gate rejected order",
      );
      return;
    }

    const clientOrderId = buildClientOrderId({
      familyId: signal.familyId,
      tokenId: signal.tokenId,
      side: signal.side,
      intentEpochMs: signal.strategyTick,
      sequenceInTick: signal.sequenceInTick,
    });

    const executionTerms = this.resolveExecutionTerms(signal, market, bundle, marketability.policy);
    if (!executionTerms) {
      this.log.warn(
        {
          signalId: signal.signalId,
          familyId: signal.familyId,
          tokenId: signal.tokenId,
          side: signal.side,
          suggestedPrice: signal.suggestedPrice,
          bestBid: market.bestBid,
          bestAsk: market.bestAsk,
          spread: market.spread,
          ...marketability.diagnostics,
        },
        "approved signal skipped — unable to derive maker-safe post-only price",
      );
      return;
    }

    const cmd: PlaceOrderCommand = {
      type: "PlaceOrderCommand",
      commandId: createCommandId(randomUUID()),
      clientOrderId,
      source: signal.reason === "operator" ? "operator" : "strategy",
      tokenId: signal.tokenId,
      side: signal.side,
      size: resolveOrderSize(signal, executionTerms.price),
      price: executionTerms.price,
      ...(executionTerms.postOnly ? { postOnly: true } : {}),
      orderType: "GTC",
      tickSize: market.tickSize,
      negRisk: market.negRisk,
      familyId: signal.familyId,
      sequenceInTick: signal.sequenceInTick,
      signalReason: signal.reason,
      metadata: {
        marketability: marketability.diagnostics,
        postOnlyPolicy: executionTerms.postOnly === true ? "maker-only" : "limit",
      },
    };

    this.log.info(
      {
        signalId: signal.signalId,
        clientOrderId: String(clientOrderId),
        side: signal.side,
        price: cmd.price,
        size: cmd.size,
        postOnly: cmd.postOnly === true,
        postOnlyPolicy: executionTerms.postOnly === true ? "maker-only" : "limit",
        ...marketability.diagnostics,
      },
      "signal converted to order command",
    );

    await this.deps.bus.publish("PlaceOrderRequested", {
      command: cmd,
      timestamp: Date.now(),
    });
  }

  private resolveExecutionTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    bundle: ReturnType<FamilyRulesProvider["getRule"]>,
    marketabilityPolicy: MarketabilityPolicy,
  ): { price: number; postOnly?: boolean } | null {
    if (this.deps.liveLiteGuard?.getWalletMode() !== "relayer") {
      return { price: signal.suggestedPrice };
    }

    if (!bundle) {
      return { price: signal.suggestedPrice };
    }

    const policy = resolveFamilyLiveTradingPolicy(bundle.identity);
    if (!policy.requiresPostOnlyForLive) {
      return { price: signal.suggestedPrice };
    }

    const makerOnlyPrice = resolveMakerOnlyPrice({
      side: signal.side,
      suggestedPrice: signal.suggestedPrice,
      market,
      policy: marketabilityPolicy,
    });
    if (makerOnlyPrice == null) {
      return null;
    }

    return { price: makerOnlyPrice, postOnly: true };
  }

  private evaluateMarketability(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    bundle: ReturnType<FamilyRulesProvider["getRule"]>,
  ): MarketabilityDecision {
    if (!this.deps.liveLiteGuard || !bundle) {
      return {
        approved: true,
        rejectionReasons: [],
        checksPassed: ["marketability-disabled"],
        policy: bundle ? resolveMarketabilityPolicy(bundle) : resolveMarketabilityPolicyFallback(),
        diagnostics: {},
      };
    }

    const restingSnapshot = this.deps.orderRepo
      ? buildRestingOrderSnapshot(this.deps.orderRepo.findOpen(), this.marketCache)
      : null;
    return evaluateMarketability({
      signal,
      market,
      bundle,
      nowMs: Date.now(),
      restingSnapshot,
      cooldownUntilMs:
        this.cooldownUntilByToken.get(this.cooldownKey(signal.familyId, signal.tokenId)) ?? null,
    });
  }

  private async handleFillReceived(payload: RuntimeEventMap["FillReceived"]): Promise<void> {
    this.filledOrderIds.add(String(payload.orderId));
    const key = this.cooldownKey(payload.familyId, payload.tokenId);
    this.unfilledCancelCountByToken.delete(key);
    this.cooldownUntilByToken.delete(key);
    this.pruneFilledOrderIds();
  }

  private async handleOrderCancelled(payload: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    if (!this.deps.orderRepo || this.filledOrderIds.has(String(payload.orderId))) return;

    const order = this.deps.orderRepo.findById(payload.orderId);
    if (
      !order ||
      order.side !== "buy" ||
      order.signalReason == null ||
      !isEntryReason(order.signalReason)
    ) {
      return;
    }

    const bundle = this.deps.rulesProvider.getRule(order.familyId);
    if (!bundle) return;

    const policy = resolveMarketabilityPolicy(bundle);
    const key = this.cooldownKey(order.familyId, order.tokenId);
    const nextCount = (this.unfilledCancelCountByToken.get(key) ?? 0) + 1;
    this.unfilledCancelCountByToken.set(key, nextCount);

    if (nextCount < policy.maxUnfilledCancelsBeforeCooldown) return;

    const cooldownUntil = Date.now() + policy.unfilledCancelCooldownMs;
    this.cooldownUntilByToken.set(key, cooldownUntil);
    this.log.warn(
      {
        orderId: payload.orderId,
        familyId: order.familyId,
        tokenId: order.tokenId,
        unfilledCancels: nextCount,
        cooldownUntil,
      },
      "entry token cooled down after repeated cancel-without-fill",
    );
  }

  private cooldownKey(familyId: unknown, tokenId: unknown): string {
    return `${String(familyId)}|${String(tokenId)}`;
  }

  private pruneFilledOrderIds(): void {
    if (this.filledOrderIds.size <= 10_000) return;
    const targetSize = 5_000;
    const iterator = this.filledOrderIds.values();
    while (this.filledOrderIds.size > targetSize) {
      const next = iterator.next();
      if (next.done) break;
      this.filledOrderIds.delete(next.value);
    }
  }
}

function resolveOrderSize(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  executionPrice: number,
): number {
  if (signal.side !== "buy") return signal.suggestedSize;
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return signal.suggestedSize;
  return signal.suggestedSizeUsdc / executionPrice;
}

function isEntryReason(reason: string): boolean {
  return ENTRY_REASONS.has(reason);
}

function resolveMarketabilityPolicyFallback(): MarketabilityPolicy {
  return {
    tier: "fallback",
    maxBookAgeMs: 15_000,
    hardMaxBookAgeMs: 60_000,
    maxEntrySpreadCents: 0.005,
    maxWideEntrySpreadCents: 0.01,
    minWideSpreadVolume24h: 25_000,
    minEntryVolume24h: 5_000,
    maxPriceImprovementCents: 0.005,
    makerImprovementTicks: 1,
    maxRestingBuyReservationUsdc: 5,
    maxUnfilledOrdersPerToken: 1,
    maxUnfilledOrdersPerMarket: 2,
    maxUnfilledCancelsBeforeCooldown: 1,
    unfilledCancelCooldownMs: 10 * 60_000,
    allowOneSidedBooks: false,
  };
}
