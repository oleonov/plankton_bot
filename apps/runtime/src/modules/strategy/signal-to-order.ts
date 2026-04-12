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
  applyOrderBookToMarket,
  type CandidateBookCache,
  type CandidateBookResolution,
} from "./candidate-book-cache.js";
import {
  buildRestingOrderSnapshot,
  evaluateMarketability,
  resolveMakerOnlyPrice,
  resolveMarketabilityPolicy,
  type MarketabilityDecision,
  type MarketabilityPolicy,
} from "./marketability.js";
import { isGammaFallbackDustEligible } from "./book-quality-policy.js";
import {
  isDustSignalReason,
  resolveQueueJumpExecutionTerms,
  shouldUseDustLane,
  type QueueJumpExecutionTerms,
} from "../hot-lane/hot-lane-policy.js";

export interface SignalToOrderBridgeDeps {
  bus: EventBus;
  log: Logger;
  rulesProvider: FamilyRulesProvider;
  orderRepo?: OrderRepository | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
  candidateBookCache?: CandidateBookCache | undefined;
}

export class SignalToOrderBridge {
  private readonly log: Logger;
  private marketCache = new Map<string, NormalizedMarket>();
  private unfilledCancelCountByToken = new Map<string, number>();
  private cooldownUntilByToken = new Map<string, number>();
  private cooldownBaselineByToken = new Map<string, CooldownBaseline>();
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
    const resolvedMarket = await this.resolveMarket(signal);
    const market = resolvedMarket.market;
    const executionMinNotionalUsdc = this.resolveExecutionMinNotionalUsdc();

    if (!market) {
      this.log.warn(
        { signalId: signal.signalId, tokenId: signal.tokenId },
        "approved signal has no cached market — cannot build order command",
      );
      await this.publishConversionSkipped(signal, "market-cache-miss", ["market-cache-miss"], {
        cacheStatus: resolvedMarket.cacheStatus,
      });
      return;
    }

    const bundle = this.deps.rulesProvider.getRule(signal.familyId);
    const queueJumpTerms = bundle
      ? resolveQueueJumpExecutionTerms({
          signal,
          market,
          bundle,
          nowMs: Date.now(),
          executionMinNotionalUsdc,
        })
      : null;
    const marketability = this.relaxQueueJumpMarketability(
      this.evaluateMarketability(signal, market, bundle),
      queueJumpTerms,
    );
    const gammaFallbackDust =
      bundle != null &&
      isGammaFallbackDustEligible({
        bundle,
        market,
        nowMs: Date.now(),
        signal,
        executionMinNotionalUsdc,
      });
    if (!marketability.approved) {
      this.log.warn(
        {
          signalId: signal.signalId,
          familyId: signal.familyId,
          tokenId: signal.tokenId,
          reasons: marketability.rejectionReasons,
          cacheStatus: resolvedMarket.cacheStatus,
          ...marketability.diagnostics,
        },
        "approved signal skipped — marketability gate rejected order",
      );
      await this.publishConversionSkipped(signal, "marketability", marketability.rejectionReasons, {
        cacheStatus: resolvedMarket.cacheStatus,
        ...marketability.diagnostics,
      });
      return;
    }

    const clientOrderId = buildClientOrderId({
      familyId: signal.familyId,
      tokenId: signal.tokenId,
      side: signal.side,
      intentEpochMs: signal.strategyTick,
      sequenceInTick: signal.sequenceInTick,
    });

    const executionTerms = this.resolveExecutionTerms(
      signal,
      market,
      bundle,
      marketability.policy,
      executionMinNotionalUsdc,
      queueJumpTerms,
    );
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
          cacheStatus: resolvedMarket.cacheStatus,
          ...marketability.diagnostics,
        },
        "approved signal skipped — unable to derive maker-safe post-only price",
      );
      await this.publishConversionSkipped(
        signal,
        "execution-terms",
        ["maker-safe-post-only-price-unavailable"],
        {
          cacheStatus: resolvedMarket.cacheStatus,
          ...marketability.diagnostics,
        },
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
        cacheStatus: resolvedMarket.cacheStatus,
        marketData: {
          bookSource: market.bookSource ?? "unknown",
          gammaFallbackDust,
        },
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

  private async resolveMarket(signal: RuntimeEventMap["SignalApproved"]["signal"]): Promise<{
    market: NormalizedMarket | null;
    cacheStatus: CandidateBookResolution["status"] | "disabled" | "base-market";
  }> {
    const market = this.marketCache.get(String(signal.tokenId));
    if (!market) {
      return { market: null, cacheStatus: "disabled" };
    }

    if (!this.deps.candidateBookCache) {
      return { market, cacheStatus: "disabled" };
    }

    const nowMs = Date.now();
    const freshEntry = this.deps.candidateBookCache.getFreshEntry(String(signal.tokenId), nowMs);
    if (freshEntry) {
      return {
        market: applyOrderBookToMarket(market, freshEntry),
        cacheStatus: "fresh-cache",
      };
    }

    if (market.bookSource === "clob") {
      return { market, cacheStatus: "base-market" };
    }

    const resolution = await this.deps.candidateBookCache.getFreshOrRefresh(
      String(signal.tokenId),
      nowMs,
    );
    if (resolution.entry) {
      return {
        market: applyOrderBookToMarket(market, resolution.entry),
        cacheStatus: resolution.status,
      };
    }

    return { market, cacheStatus: resolution.status };
  }

  private async publishConversionSkipped(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    stage: RuntimeEventMap["SignalConversionSkipped"]["stage"],
    reasons: readonly string[],
    diagnostics: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.bus.publish("SignalConversionSkipped", {
      signal,
      stage,
      reasons,
      diagnostics,
      skippedAt: Date.now(),
    });
  }

  private resolveExecutionTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    bundle: ReturnType<FamilyRulesProvider["getRule"]>,
    marketabilityPolicy: MarketabilityPolicy,
    executionMinNotionalUsdc: number | null,
    queueJumpTerms: QueueJumpExecutionTerms | null,
  ): { price: number; postOnly?: boolean } | null {
    if (this.deps.liveLiteGuard?.getWalletMode() !== "relayer") {
      return { price: signal.suggestedPrice };
    }

    if (!bundle) {
      return { price: signal.suggestedPrice };
    }

    const policy = resolveFamilyLiveTradingPolicy(bundle.identity);
    if (queueJumpTerms) {
      return queueJumpTerms;
    }
    if (!policy.requiresPostOnlyForLive) {
      return { price: signal.suggestedPrice };
    }

    const makerOnlyPrice = resolveMakerOnlyPrice({
      side: signal.side,
      suggestedPrice: signal.suggestedPrice,
      suggestedSizeUsdc: signal.suggestedSizeUsdc,
      signalReason: signal.reason,
      nowMs: Date.now(),
      executionMinNotionalUsdc,
      market,
      policy: marketabilityPolicy,
    });
    if (makerOnlyPrice == null) {
      return null;
    }

    return { price: makerOnlyPrice, postOnly: true };
  }

  private relaxQueueJumpMarketability(
    decision: MarketabilityDecision,
    queueJumpTerms: QueueJumpExecutionTerms | null,
  ): MarketabilityDecision {
    if (!queueJumpTerms || decision.approved) return decision;
    const queueJumpOverrideReasons = new Set([
      "book-one-sided",
      "spread-unavailable",
      "spread-too-wide",
    ]);
    const remainingReasons = decision.rejectionReasons.filter(
      (reason) => !queueJumpOverrideReasons.has(reason),
    );
    if (remainingReasons.length === decision.rejectionReasons.length) {
      return decision;
    }
    if (remainingReasons.length > 0) {
      return {
        ...decision,
        rejectionReasons: remainingReasons,
        approved: false,
      };
    }
    return {
      ...decision,
      approved: true,
      rejectionReasons: [],
      checksPassed: [...decision.checksPassed, "queue-jump-marketability-override"],
    };
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
    const { cooldownUntilMs, bypassReason, previousCooldownUntil } = this.resolveCooldownState(
      signal,
      market,
    );
    if (bypassReason && previousCooldownUntil != null) {
      this.cooldownUntilByToken.delete(this.cooldownKey(signal.familyId, signal.tokenId));
      this.cooldownBaselineByToken.delete(this.cooldownKey(signal.familyId, signal.tokenId));
      void this.deps.bus.publish("CooldownBypassApplied", {
        familyId: signal.familyId,
        tokenId: signal.tokenId,
        reason: bypassReason,
        previousCooldownUntil,
        appliedAt: Date.now(),
      });
    }
    return evaluateMarketability({
      signal,
      market,
      bundle,
      nowMs: Date.now(),
      restingSnapshot,
      cooldownUntilMs,
      executionMinNotionalUsdc: this.resolveExecutionMinNotionalUsdc(),
    });
  }

  private resolveExecutionMinNotionalUsdc(): number | null {
    const guard = this.deps.liveLiteGuard as
      | (typeof this.deps.liveLiteGuard & {
          getMinEntryNotionalUsdc?: () => number | null;
        })
      | undefined;
    return typeof guard?.getMinEntryNotionalUsdc === "function"
      ? (guard.getMinEntryNotionalUsdc() ?? null)
      : null;
  }

  private async handleFillReceived(payload: RuntimeEventMap["FillReceived"]): Promise<void> {
    this.filledOrderIds.add(String(payload.orderId));
    const key = this.cooldownKey(payload.familyId, payload.tokenId);
    this.unfilledCancelCountByToken.delete(key);
    this.cooldownUntilByToken.delete(key);
    this.cooldownBaselineByToken.delete(key);
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
    if (
      shouldUseDustLane(bundle) &&
      isDustSignalReason(order.signalReason) &&
      (payload.reason === "entry-reprice-cancel" || payload.reason === "entry-ttl-cancel")
    ) {
      return;
    }
    const key = this.cooldownKey(order.familyId, order.tokenId);
    const nextCount = (this.unfilledCancelCountByToken.get(key) ?? 0) + 1;
    this.unfilledCancelCountByToken.set(key, nextCount);

    if (nextCount < policy.maxUnfilledCancelsBeforeCooldown) return;

    const cooldownUntil = Date.now() + policy.unfilledCancelCooldownMs;
    this.cooldownUntilByToken.set(key, cooldownUntil);
    this.cooldownBaselineByToken.set(
      key,
      buildCooldownBaseline(this.resolveBaselineMarket(order.tokenId)),
    );
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

  private resolveBaselineMarket(tokenId: unknown): NormalizedMarket | null {
    const tokenKey = String(tokenId);
    const market = this.marketCache.get(tokenKey);
    if (!market) return null;

    const freshEntry = this.deps.candidateBookCache?.getFreshEntry(tokenKey);
    if (!freshEntry) return market;
    return applyOrderBookToMarket(market, freshEntry);
  }

  private resolveCooldownState(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
  ): {
    cooldownUntilMs: number | null;
    bypassReason: CooldownBypassReason | null;
    previousCooldownUntil: number | null;
  } {
    const key = this.cooldownKey(signal.familyId, signal.tokenId);
    const cooldownUntilMs = this.cooldownUntilByToken.get(key) ?? null;
    if (cooldownUntilMs == null || cooldownUntilMs <= Date.now()) {
      return { cooldownUntilMs: null, bypassReason: null, previousCooldownUntil: null };
    }

    const baseline = this.cooldownBaselineByToken.get(key);
    const bypassReason = baseline ? resolveCooldownBypassReason(baseline, market) : null;
    if (!bypassReason) {
      return { cooldownUntilMs, bypassReason: null, previousCooldownUntil: null };
    }

    return {
      cooldownUntilMs: null,
      bypassReason,
      previousCooldownUntil: cooldownUntilMs,
    };
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

type CooldownBypassReason =
  | "price-moved"
  | "spread-narrowed"
  | "trade-recency-improved"
  | "manual-family-fast-lane";

interface CooldownBaseline {
  readonly bestBid: number | null;
  readonly bestAsk: number | null;
  readonly spread: number | null;
  readonly tickSize: number;
  readonly snapshotTs: number;
}

function buildCooldownBaseline(market: NormalizedMarket | null): CooldownBaseline {
  return {
    bestBid: market?.bestBid ?? null,
    bestAsk: market?.bestAsk ?? null,
    spread: market?.spread ?? null,
    tickSize: market?.tickSize ?? 0.01,
    snapshotTs: market?.snapshotTs ?? Date.now(),
  };
}

function resolveCooldownBypassReason(
  baseline: CooldownBaseline,
  market: NormalizedMarket,
): CooldownBypassReason | null {
  const tickSize = Math.max(baseline.tickSize, market.tickSize, 0.001);
  if (
    hasMovedByTick(baseline.bestBid, market.bestBid, tickSize) ||
    hasMovedByTick(baseline.bestAsk, market.bestAsk, tickSize)
  ) {
    return "price-moved";
  }

  if (
    baseline.spread != null &&
    market.spread != null &&
    Number.isFinite(baseline.spread) &&
    Number.isFinite(market.spread) &&
    baseline.spread - market.spread >= tickSize / 2
  ) {
    return "spread-narrowed";
  }

  return null;
}

function hasMovedByTick(
  baselinePrice: number | null,
  currentPrice: number | null,
  tickSize: number,
): boolean {
  if (baselinePrice == null || currentPrice == null) return false;
  return Math.abs(currentPrice - baselinePrice) >= tickSize - 1e-9;
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
    speedTier: "standard",
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
