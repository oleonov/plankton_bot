/**
 * Signal-to-Order bridge — converts SignalApproved into PlaceOrderRequested.
 *
 * Closes the gap in the end-to-end trading path:
 *   strategy → SignalProduced → risk → SignalApproved → [this bridge] → PlaceOrderRequested → execution
 *
 * Responsibilities:
 *  - Subscribe to SignalApproved
 *  - Resolve a live CLOB book (cache/refresh) and build hard-liveness guard
 *  - Price orders at bestBid/bestAsk (spec §7 execution policy); postOnly in relayer mode
 *  - Enforce persistent same-price cooldowns after repeated stale cancels
 *  - Publish PlaceOrderRequested with a deterministic clientOrderId
 *
 * Does NOT evaluate risk — that already happened upstream.
 */

import type {
  DeadSideGuardMode as DomainDeadSideGuardMode,
  EventBus,
  ExecutionPolicy,
  ExecutionPolicyObservation,
  ExecutionPolicyObservationRepository,
  NormalizedMarket,
  OrderRepository,
  ProfileId,
  RuntimeEventMap,
  PlaceOrderCommand,
  TokenId,
  Order,
} from "@plankton/domain";
import { canPlaceBuyOrderForMarket, createCommandId, isAlive } from "@plankton/domain";
import { DEFAULT_EXECUTION_POLICY, DEFAULT_ORDER_LIFETIME_POLICY } from "../../execution-policy.js";
import { buildClientOrderId } from "@plankton/domain/node";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import type { MarketResolutionTracker } from "../resolution/market-resolution-tracker.js";
import {
  classifyNotionalBucket,
  classifyRoundLevel,
  computePricingDeltaTicks,
  resolveBoundedMidpointPrice,
  validateExecutablePrice,
  type BoundedMidpointDiagnostics,
  type ExecutablePriceValidationFailureReason,
} from "../../executable-price.js";
import {
  applyOrderBookToMarket,
  type CandidateBookCache,
  type CandidateBookResolution,
} from "./candidate-book-cache.js";
import { isExecutableOrderSize, resolveEffectiveMinOrderSize } from "../../min-order-size.js";

const BRIDGE_WS_BOOK_WAIT_MS = 100;
// Policy epsilon: suppress only truly identical SELL prices. The tiny margin
// absorbs JS decimal representation drift while staying far below CLOB tick size.
const SELL_DEDUP_PRICE_EPSILON = 1.000001e-9;

// ADR-013 defaults exposed for callers that don't thread the policy provider
// (tests, scenario runner). Runtime always reads the live policy via
// `deps.policy()` and never the constant.
export const ENTRY_PRICE_CEILING = 0.45;
export const DEAD_SIDE_NEAR_END_ASK_CEILING = 0.02;
export const DEAD_SIDE_NEAR_END_MS = 120_000;

/** Re-export for legacy callers (tests). ADR-015 moved this into `ExecutionPolicy`. */
export type DeadSideGuardMode = DomainDeadSideGuardMode;

export interface SignalToOrderBridgeDeps {
  bus: EventBus;
  log: Logger;
  orderRepo?: OrderRepository | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
  candidateBookCache?: CandidateBookCache | undefined;
  /**
   * ADR-015 — live execution policy lookup. The bridge calls `policy()` on
   * every signal conversion so operator SQL edits take effect without
   * restart. When unset, falls back to `DEFAULT_EXECUTION_POLICY` so tests
   * and one-shot scripts still work.
   */
  policy?: () => ExecutionPolicy;
  /**
   * ADR-015 observability — append-only writer for every BUY/SELL signal
   * that reaches execution-term resolution (or is dead-side-enforce-skipped).
   * Optional so tests and scenario runs can skip the DB write.
   */
  observations?: ExecutionPolicyObservationRepository;
  /** Denormalized on each observation row for cross-profile aggregation. */
  profileId?: ProfileId;
  /**
   * Defense-in-depth BUY-side guard. Mirrors the check that
   * RiskInventoryModule.handleSignal already runs upstream, so a stale market
   * snapshot or in-flight resolution between approval and bridge cannot leak
   * a placement onto a no-longer-eligible market. Optional for tests.
   */
  resolutionTracker?: MarketResolutionTracker;
  orderLifetime?: {
    canPlaceExitOrder: (
      tokenId: TokenId,
      nowMs: number,
    ) => {
      allowed: boolean;
      reason: string | null;
      mode: string | null;
      budgetPerMinute: number | null;
      remainingBudget: number | null;
    };
  };
  samePriceCooldown?: {
    canPlaceOrder: (args: {
      tokenId: TokenId;
      side: "buy" | "sell";
      price: number;
      nowMs: number;
    }) => {
      allowed: boolean;
      reason: string | null;
      staleCancelCount: number | null;
      cooldownUntilTsUtc: number | null;
    };
  };
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
}

export class SignalToOrderBridge {
  private readonly log: Logger;
  private marketCache = new Map<string, NormalizedMarket>();
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: SignalToOrderBridgeDeps) {
    this.log = deps.log.child({ component: "signal-to-order" });
  }

  private getPolicy(): ExecutionPolicy {
    return this.deps.policy ? this.deps.policy() : DEFAULT_EXECUTION_POLICY;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * BUY-side admission re-check on the freshest snapshot the bridge owns.
   * Mirrors RiskInventoryModule.evaluateBuyAdmission — same precedence
   * (tracker availability → resolution → market lifecycle), same reason
   * codes. Returns null when the BUY is admitted.
   */
  private evaluateBuyAdmission(market: NormalizedMarket): string | null {
    const tracker = this.deps.resolutionTracker;
    if (tracker) {
      if (!tracker.healthy()) return "resolution_tracker_unavailable";
      if (tracker.isResolved(market.conditionId)) return "market_resolved";
    }
    const placement = canPlaceBuyOrderForMarket(market, this.now());
    if (!placement.allowed) return placement.reasons[0] ?? "market_not_alive";
    return null;
  }

  subscribe(): void {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
      this.deps.bus.subscribe("SignalApproved", (p) => this.handleApproved(p)),
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

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    for (const tokenId of payload.removedTokenIds) {
      this.marketCache.delete(String(tokenId));
    }
  }

  private async handleApproved(payload: RuntimeEventMap["SignalApproved"]): Promise<void> {
    const { signal, market: embeddedMarket } = payload;
    // Snapshot the policy once so the full approval flow uses a consistent view,
    // even if the provider hot-reloads mid-decision.
    const policy = this.getPolicy();

    // Primary source: the NormalizedMarket snapshot captured at signal-generation
    // time in algo-decision-module. This is the same snapshot the pre-entry
    // gate's `isAlive` already accepted, so re-running `isAlive` here cannot
    // flip state from "healthy" to "no_bid" due to a book transition between
    // `SignalProduced` and the bridge build. `marketCache.get` stays as a
    // defensive fallback for events that may be in-flight during rollout of
    // this change; it can be removed once all in-flight events drain.
    const baseMarket = embeddedMarket ?? this.marketCache.get(String(signal.tokenId));

    if (!baseMarket) {
      this.log.warn(
        { signalId: signal.signalId, tokenId: signal.tokenId },
        "approved signal has no cached market — cannot build order command",
      );
      await this.publishConversionSkipped(signal, "market-cache-miss", ["market-cache-miss"], {
        cacheStatus: "disabled",
      });
      return;
    }

    // BUY-side admission guard (defense-in-depth). RiskInventoryModule already
    // ran the same check upstream, but the bridge sees the freshest snapshot
    // (post candidate-book merge) and the resolution tracker may have flipped
    // a condition to resolved between approval and conversion.
    //
    // Prefer the cached snapshot here: NormalizedMarketUpdated may have arrived
    // after SignalApproved and flipped `active`/`tradable`/`endDate` — the
    // embedded snapshot is frozen at signal-generation time and would miss it.
    // Fall back to embedded if no cache entry exists yet.
    if (signal.side === "buy") {
      const cachedMarket = this.marketCache.get(String(signal.tokenId));
      const admissionMarket = cachedMarket ?? baseMarket;
      const cacheStatus = cachedMarket ? "fresh" : "embedded";
      const buyBlock = this.evaluateBuyAdmission(admissionMarket);
      if (buyBlock) {
        this.log.info(
          {
            signalId: signal.signalId,
            tokenId: String(signal.tokenId),
            reason: buyBlock,
            cacheStatus,
          },
          "approved BUY skipped — market not eligible for placement",
        );
        await this.publishConversionSkipped(signal, "marketability", [buyBlock], {
          conditionId: admissionMarket.conditionId,
          active: admissionMarket.active,
          tradable: admissionMarket.tradable,
          endDate: admissionMarket.endDate,
          cacheStatus,
        });
        return;
      }
    }

    // Hard-liveness on the embedded snapshot. Same function, same semantics as
    // algo-decision-module.ts:389 — eliminates the residual tail where the
    // book transitioned to `no_bid` in the gap between pre-entry and bridge.
    const embeddedLiveness = isAlive({
      acceptingOrders: baseMarket.acceptingOrders,
      enableOrderBook: baseMarket.enableOrderBook,
      bestBid: baseMarket.bestBid,
      bestAsk: baseMarket.bestAsk,
    });
    if (!embeddedLiveness.healthy) {
      const onlyExpectedFlags = embeddedLiveness.reasons.every(
        (r) => r === "not_accepting_orders" || r === "order_book_disabled",
      );
      const diag = {
        signalId: signal.signalId,
        tokenId: signal.tokenId,
        reasons: embeddedLiveness.reasons,
        cacheStatus: "embedded",
      };
      const msg = "approved signal skipped — market not live for order placement";
      if (onlyExpectedFlags) this.log.debug(diag, msg);
      else this.log.warn(diag, msg);
      await this.publishConversionSkipped(signal, "hard-liveness", embeddedLiveness.reasons, {
        acceptingOrders: baseMarket.acceptingOrders,
        enableOrderBook: baseMarket.enableOrderBook,
        bestBid: baseMarket.bestBid,
        bestAsk: baseMarket.bestAsk,
        cacheStatus: "embedded",
      });
      return;
    }

    // Pricing: optionally fold in a fresher candidate book on top of the
    // embedded base so the order price reflects the newest observed top of
    // book. If the fresh book is unavailable or disabled, fall back to the
    // embedded snapshot's bestBid/bestAsk.
    const pricing = await this.resolvePricingMarket(signal, baseMarket);
    const market = pricing.market;

    const executionTerms = this.resolveExecutionTerms(signal, market, policy);
    const canary = this.buildDeadSideCanary(signal, market, policy);

    if (executionTerms.kind === "unavailable") {
      this.log.warn(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          side: signal.side,
          bestBid: market.bestBid,
          bestAsk: market.bestAsk,
          cacheStatus: pricing.cacheStatus,
        },
        "approved signal skipped — no bestBid/bestAsk for execution price",
      );
      await this.publishConversionSkipped(
        signal,
        "execution-terms",
        ["execution-price-unavailable"],
        { cacheStatus: pricing.cacheStatus },
      );
      this.writeObservation({
        signal,
        clientOrderId: null,
        market,
        policy,
        executionTerms,
        canary,
        skippedReason: "execution-price-unavailable",
      });
      return;
    }
    if (executionTerms.kind === "invalid") {
      this.log.warn(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          side: signal.side,
          price: executionTerms.price,
          tickSize: executionTerms.tickSize,
          validationReason: executionTerms.validationReason,
          cacheStatus: pricing.cacheStatus,
        },
        "approved signal skipped — invalid execution price",
      );
      await this.publishConversionSkipped(signal, "execution-terms", ["execution-price-invalid"], {
        cacheStatus: pricing.cacheStatus,
        price: executionTerms.price,
        tickSize: executionTerms.tickSize,
        minPrice: executionTerms.minPrice,
        maxPrice: executionTerms.maxPrice,
        validationReason: executionTerms.validationReason,
      });
      this.writeObservation({
        signal,
        clientOrderId: null,
        market,
        policy,
        executionTerms,
        canary,
        skippedReason: "execution-price-invalid",
      });
      return;
    }
    if (executionTerms.kind === "skip-wide-spread" || executionTerms.kind === "skip-one-sided") {
      const reason =
        executionTerms.kind === "skip-wide-spread" ? "spread-above-cap" : "one-sided-book";
      this.log.info(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          reason,
          pricingMode: policy.pricing.mode,
          ...executionTerms.diagnostics,
          cacheStatus: pricing.cacheStatus,
        },
        "approved signal skipped — bounded-midpoint pricing guardrail",
      );
      await this.publishConversionSkipped(signal, "execution-terms", [reason], {
        cacheStatus: pricing.cacheStatus,
        pricingMode: policy.pricing.mode,
        ...executionTerms.diagnostics,
      });
      this.writeObservation({
        signal,
        clientOrderId: null,
        market,
        policy,
        executionTerms,
        canary,
        skippedReason: reason,
      });
      return;
    }

    if (signal.side === "buy" && executionTerms.price > policy.entryPriceCeiling) {
      this.log.info(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          price: executionTerms.price,
          ceiling: policy.entryPriceCeiling,
          cacheStatus: pricing.cacheStatus,
        },
        "approved signal skipped — BUY price above entry ceiling",
      );
      await this.publishConversionSkipped(
        signal,
        "execution-terms",
        ["price-above-entry-ceiling"],
        {
          cacheStatus: pricing.cacheStatus,
          price: executionTerms.price,
          ceiling: policy.entryPriceCeiling,
        },
      );
      this.writeObservation({
        signal,
        clientOrderId: null,
        market,
        policy,
        executionTerms,
        canary,
        skippedReason: "price-above-entry-ceiling",
      });
      return;
    }

    const nowMs = this.now();
    if (
      signal.side === "sell" &&
      executionTerms.kind === "ok" &&
      shouldSkipSellInsideOrderLifetimeStopWindow(market, policy, nowMs)
    ) {
      const lifetime = policy.orderLifetime ?? DEFAULT_ORDER_LIFETIME_POLICY;
      const endMs = market.endDate ? Date.parse(market.endDate) : null;
      const timeToEndMs = endMs != null && Number.isFinite(endMs) ? endMs - nowMs : null;
      this.log.info(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          endDate: market.endDate,
          timeToEndMs,
          stopWindowMs: lifetime.resolutionStopWindowMs,
        },
        "approved SELL skipped — order lifetime resolution stop window",
      );
      await this.publishConversionSkipped(
        signal,
        "execution-terms",
        ["order-lifetime-resolution-stop-window"],
        {
          endDate: market.endDate,
          timeToEndMs,
          stopWindowMs: lifetime.resolutionStopWindowMs,
        },
      );
      this.writeObservation({
        signal,
        clientOrderId: null,
        market,
        policy,
        executionTerms,
        canary,
        skippedReason: "order-lifetime-resolution-stop-window",
      });
      return;
    }

    if (
      signal.side === "sell" &&
      executionTerms.kind === "ok" &&
      shouldSkipSellBelowSignalFloor(
        signal.suggestedPrice,
        executionTerms.price,
        policy.pricing.minExitPriceSignalRatio,
      )
    ) {
      const floor = signal.suggestedPrice * policy.pricing.minExitPriceSignalRatio;
      this.log.info(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          signalPrice: signal.suggestedPrice,
          executionPrice: executionTerms.price,
          minRatio: policy.pricing.minExitPriceSignalRatio,
          floor,
          cacheStatus: pricing.cacheStatus,
        },
        "approved SELL skipped — execution price below signal-distance floor",
      );
      await this.publishConversionSkipped(
        signal,
        "execution-terms",
        ["sell-price-below-signal-floor"],
        {
          cacheStatus: pricing.cacheStatus,
          signalPrice: signal.suggestedPrice,
          executionPrice: executionTerms.price,
          minRatio: policy.pricing.minExitPriceSignalRatio,
          floor,
        },
      );
      this.writeObservation({
        signal,
        clientOrderId: null,
        market,
        policy,
        executionTerms,
        canary,
        skippedReason: "sell-price-below-signal-floor",
      });
      return;
    }

    if (canary) {
      const diagnostics = {
        ...canary,
        cacheStatus: pricing.cacheStatus,
        price: executionTerms.price,
      };
      if (policy.deadSideGuard.mode === "enforce" && canary.enforceHit) {
        this.log.info(
          { signalId: signal.signalId, tokenId: signal.tokenId, ...diagnostics },
          "approved signal skipped — BUY on dead side near endDate",
        );
        await this.publishConversionSkipped(
          signal,
          "execution-terms",
          ["dead-side-near-end"],
          diagnostics,
        );
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          skippedReason: "dead-side-near-end",
        });
        return;
      }
      // observe mode, or enforce mode but outside configured X: emit the shadow
      // canary marker so metrics can choose the enforcement X post-hoc. Covers
      // *every* BUY with bestAsk ≤ askCeiling regardless of timeToEndMs bucket.
      // Gated by policy.telemetry.deadSideCanary — enforcement always runs above.
      if (policy.telemetry.deadSideCanary) {
        this.log.info(
          { signalId: signal.signalId, tokenId: signal.tokenId, ...diagnostics },
          "dead-side-near-end canary observation",
        );
      }
    }

    const orderSize = resolveOrderSize(signal, executionTerms.price);
    const effectiveMinOrderSize = resolveEffectiveMinOrderSize(market.minOrderSize);
    if (!isExecutableOrderSize(orderSize, market.minOrderSize)) {
      this.log.info(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          side: signal.side,
          orderSize,
          minOrderSize: market.minOrderSize ?? null,
          effectiveMinOrderSize,
          cacheStatus: pricing.cacheStatus,
        },
        "approved signal skipped — order size below exchange minimum",
      );
      await this.publishConversionSkipped(signal, "execution-terms", ["order-size-below-minimum"], {
        cacheStatus: pricing.cacheStatus,
        orderSize,
        minOrderSize: market.minOrderSize ?? null,
        effectiveMinOrderSize,
      });
      this.writeObservation({
        signal,
        clientOrderId: null,
        market,
        policy,
        executionTerms,
        canary,
        skippedReason: "order-size-below-minimum",
      });
      return;
    }

    const duplicateSell = this.findSamePriceOpenSellOrder(
      signal.tokenId,
      signal.side,
      executionTerms.price,
    );
    if (duplicateSell) {
      this.log.debug(
        {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          existingOrderId: duplicateSell.orderId,
          existingPrice: duplicateSell.price,
          executionPrice: executionTerms.price,
          cacheStatus: pricing.cacheStatus,
        },
        "approved SELL skipped — same-price sell order already open",
      );
      await this.publishConversionSkipped(signal, "execution-terms", ["sell-order-already-open"], {
        cacheStatus: pricing.cacheStatus,
        existingOrderId: String(duplicateSell.orderId),
        existingPrice: duplicateSell.price,
        executionPrice: executionTerms.price,
      });
      this.writeObservation({
        signal,
        clientOrderId: null,
        market,
        policy,
        executionTerms,
        canary,
        skippedReason: "sell-order-already-open",
      });
      return;
    }

    if (signal.side === "sell" && this.deps.orderLifetime) {
      const placementDecision = this.deps.orderLifetime.canPlaceExitOrder(signal.tokenId, nowMs);
      if (!placementDecision.allowed) {
        const reason = placementDecision.reason ?? "order-lifetime-placement-blocked";
        this.log.info(
          {
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            mode: placementDecision.mode,
            budgetPerMinute: placementDecision.budgetPerMinute,
            remainingBudget: placementDecision.remainingBudget,
          },
          "approved SELL skipped — order lifetime placement gate",
        );
        await this.publishConversionSkipped(signal, "execution-terms", [reason], {
          cacheStatus: pricing.cacheStatus,
          mode: placementDecision.mode,
          budgetPerMinute: placementDecision.budgetPerMinute,
          remainingBudget: placementDecision.remainingBudget,
        });
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          skippedReason: reason,
        });
        return;
      }
    }

    if (this.deps.samePriceCooldown) {
      const placementDecision = this.deps.samePriceCooldown.canPlaceOrder({
        tokenId: signal.tokenId,
        side: signal.side,
        price: executionTerms.price,
        nowMs,
      });
      if (!placementDecision.allowed) {
        const reason = placementDecision.reason ?? "same-price-cooldown";
        this.log.info(
          {
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            side: signal.side,
            executionPrice: executionTerms.price,
            staleCancelCount: placementDecision.staleCancelCount,
            cooldownUntilTsUtc: placementDecision.cooldownUntilTsUtc,
            cacheStatus: pricing.cacheStatus,
          },
          "approved signal skipped — same-price cooldown active",
        );
        await this.publishConversionSkipped(signal, "execution-terms", [reason], {
          cacheStatus: pricing.cacheStatus,
          executionPrice: executionTerms.price,
          staleCancelCount: placementDecision.staleCancelCount,
          cooldownUntilTsUtc: placementDecision.cooldownUntilTsUtc,
        });
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          skippedReason: reason,
        });
        return;
      }
    }

    const clientOrderId = buildClientOrderId({
      signalId: signal.signalId,
      tokenId: signal.tokenId,
      side: signal.side,
    });

    const cmd: PlaceOrderCommand = {
      type: "PlaceOrderCommand",
      commandId: createCommandId(randomUUID()),
      clientOrderId,
      source: signal.reason === "operator" ? "operator" : "strategy",
      tokenId: signal.tokenId,
      conditionId: signal.conditionId,
      side: signal.side,
      size: orderSize,
      price: executionTerms.price,
      ...(executionTerms.postOnly ? { postOnly: true } : {}),
      orderType: "GTC",
      tickSize: market.tickSize,
      negRisk: market.negRisk,
      sequenceInTick: signal.sequenceInTick,
      signalReason: signal.reason,
      signalId: signal.signalId,
      decisionRuleId: signal.decisionRuleId,
      signalTimestamp: signal.generatedAt,
      metadata: {
        cacheStatus: pricing.cacheStatus,
        marketData: {
          bookSource: market.bookSource ?? "unknown",
          minOrderSize: market.minOrderSize ?? null,
          effectiveMinOrderSize,
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
        pricingMode: policy.pricing.mode,
        ...(executionTerms.pricingDiagnostics
          ? { pricingDiagnostics: executionTerms.pricingDiagnostics }
          : {}),
        ...(executionTerms.pricingShadow ? { pricingShadow: executionTerms.pricingShadow } : {}),
      },
      "signal converted to order command",
    );

    this.writeObservation({
      signal,
      clientOrderId: String(clientOrderId),
      market,
      policy,
      executionTerms,
      canary,
      skippedReason: null,
    });

    await this.deps.bus.publish("PlaceOrderRequested", {
      command: cmd,
      timestamp: Date.now(),
    });
  }

  /**
   * ADR-015 observability writer. Records one append-only row per BUY/SELL
   * signal that reached execution-term resolution — successful placements
   * plus every skip (dead-side enforce, spread caps, one-sided, invalid/
   * unavailable price, entry-ceiling) so canary analytics see the full
   * distribution. Failures are logged but never throw, so a DB hiccup
   * cannot block an order from going out.
   */
  private writeObservation(params: {
    signal: RuntimeEventMap["SignalApproved"]["signal"];
    clientOrderId: string | null;
    market: NormalizedMarket;
    policy: ExecutionPolicy;
    executionTerms: ExecutionTermsResolution;
    canary: DeadSideCanary | null;
    skippedReason: string | null;
  }): void {
    const { observations, profileId } = this.deps;
    if (!observations || !profileId) return;
    const { signal, clientOrderId, market, policy, executionTerms, canary, skippedReason } = params;
    try {
      const { selectedPrice, diagnostics, boundedOutcome } = summarizeExecutionTerms(
        executionTerms,
        policy.pricing.mode,
      );
      const pricingDeltaTicks = computePricingDeltaTicks(
        signal.side,
        selectedPrice,
        market.bestBid,
        market.bestAsk,
        market.tickSize,
      );
      const roundLevelHit = classifyRoundLevel(selectedPrice, market.tickSize);
      const row: ExecutionPolicyObservation = {
        profileId: String(profileId),
        signalId: signal.signalId,
        clientOrderId,
        decisionRuleId: signal.decisionRuleId,
        sizingRuleId: signal.sizingRuleId,
        notionalBucket: classifyNotionalBucket(signal.suggestedSizeUsdc),
        tokenId: String(signal.tokenId),
        marketSlug: market.slug ?? null,
        side: signal.side === "buy" ? "BUY" : "SELL",
        signalReason: signal.reason,
        selectedPricingMode: policy.pricing.mode,
        selectedPrice,
        edgePrice: diagnostics?.edgePrice ?? null,
        boundedPrice: diagnostics?.finalPrice ?? null,
        boundedOutcome,
        spreadTicks: diagnostics?.spreadTicks ?? null,
        improvementTicks: diagnostics?.improvementTicks ?? null,
        deadSideObserved: canary !== null,
        deadSideBucket: canary?.bucket ?? null,
        deadSideEnforceHit: canary?.enforceHit ?? false,
        deadSideX60: canary?.shadowHits.x60_000 ?? false,
        deadSideX120: canary?.shadowHits.x120_000 ?? false,
        deadSideX300: canary?.shadowHits.x300_000 ?? false,
        deadSideX900: canary?.shadowHits.x900_000 ?? false,
        timeToEndMs: canary?.timeToEndMs ?? null,
        skippedReason,
        pricingDeltaTicks,
        roundLevelHit,
      };
      observations.insert(row);
    } catch (err) {
      this.log.error(
        { err, signalId: signal.signalId, tokenId: signal.tokenId },
        "failed to write execution policy observation",
      );
    }
  }

  /**
   * Return a pricing-oriented market snapshot for a signal: the embedded
   * base (already accepted by the pre-entry hard-liveness gate) optionally
   * overlaid with a fresher `CandidateBookCache` entry for bestBid/bestAsk.
   *
   * Liveness is NOT re-checked here — that already happened on the embedded
   * snapshot upstream. This lookup is purely for order pricing freshness.
   */
  private async resolvePricingMarket(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    baseMarket: NormalizedMarket,
  ): Promise<{
    market: NormalizedMarket;
    cacheStatus: CandidateBookResolution["status"] | "disabled" | "base-market" | "embedded";
  }> {
    if (!this.deps.candidateBookCache) {
      return { market: baseMarket, cacheStatus: "disabled" };
    }

    const nowMs = Date.now();
    const freshEntry = this.deps.candidateBookCache.getFreshEntry(String(signal.tokenId), nowMs);
    if (freshEntry) {
      return {
        market: applyOrderBookToMarket(baseMarket, freshEntry),
        cacheStatus: "fresh-cache",
      };
    }

    if (canUseBaseMarketForPricing(baseMarket)) {
      return { market: baseMarket, cacheStatus: "base-market" };
    }

    const wsEntry = await this.deps.candidateBookCache.waitForFreshEntry(
      String(signal.tokenId),
      BRIDGE_WS_BOOK_WAIT_MS,
      nowMs,
    );
    if (wsEntry) {
      return {
        market: applyOrderBookToMarket(baseMarket, wsEntry),
        cacheStatus: "fresh-cache",
      };
    }

    const resolution = await this.deps.candidateBookCache.getFreshOrRefresh(
      String(signal.tokenId),
      nowMs,
    );
    if (resolution.entry) {
      return {
        market: applyOrderBookToMarket(baseMarket, resolution.entry),
        cacheStatus: resolution.status,
      };
    }

    return { market: baseMarket, cacheStatus: resolution.status };
  }

  /**
   * Dead-side shadow canary: runs on every BUY with bestAsk ≤ askCeiling and a
   * valid endDate, regardless of timeToEndMs. The returned payload tags the
   * `bucket` (from the audit spec) and a `shadowHits` map for each audited X
   * threshold (60/120/300/900 s) so the log aggregator can pick an enforcement
   * X post-hoc. `enforceHit` reflects the configured `maxTimeToEndMs` and is
   * the single bit the caller uses to decide a skip.
   *
   * Upper-bound only: `timeToEndMs ≤ X` — negative (post-end) time-to-end also
   * hits, matching the prod sample of 2 fills evaluated after endDate.
   *
   * Returns `null` when the guard is off, when the signal is not a BUY, when
   * bestAsk is absent / above the ceiling, or when endDate is unparseable.
   */
  private buildDeadSideCanary(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
  ): DeadSideCanary | null {
    const guard = policy.deadSideGuard;
    if (guard.mode === "off") return null;
    if (signal.side !== "buy") return null;
    if (market.bestAsk == null) return null;
    if (market.bestAsk > guard.askCeiling) return null;
    if (market.endDate == null) return null;
    const endMs = Date.parse(market.endDate);
    if (!Number.isFinite(endMs)) return null;
    const nowMs = Date.now();
    const timeToEndMs = endMs - nowMs;
    const enforceX = guard.maxTimeToEndMs;
    return {
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      endDate: market.endDate,
      timeToEndMs,
      secondsToEnd: Math.round(timeToEndMs / 1000),
      bucket: bucketForTimeToEndMs(timeToEndMs),
      shadowHits: {
        x60_000: timeToEndMs <= 60_000,
        x120_000: timeToEndMs <= 120_000,
        x300_000: timeToEndMs <= 300_000,
        x900_000: timeToEndMs <= 900_000,
      },
      askCeiling: guard.askCeiling,
      enforceX,
      xMs: enforceX,
      enforceHit: timeToEndMs <= enforceX,
      guardMode: guard.mode,
    };
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

  /**
   * ADR-006 D1 (edge mode): BUY = bestBid, SELL = bestAsk.
   * ADR-014 (bounded-midpoint mode): price improves toward midpoint, bounded by
   * spread cap + improvement cap + no-cross clamp. Single formula for all runtime
   * modes; mode selector is `policy.pricing.mode`. Postonly remains relayer-only (D2).
   */
  private resolveExecutionTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
  ): ExecutionTermsResolution {
    const isRelayer = this.deps.liveLiteGuard?.getWalletMode() === "relayer";
    const pricing = policy.pricing;
    const ladderTargetPrice =
      signal.side === "buy" && signal.ladderTargetPrice != null ? signal.ladderTargetPrice : null;

    if (ladderTargetPrice != null) {
      if (
        market.bestAsk != null &&
        Number.isFinite(market.bestAsk) &&
        ladderTargetPrice >= market.bestAsk
      ) {
        return { kind: "unavailable" };
      }
      if (
        !Number.isFinite(ladderTargetPrice) ||
        ladderTargetPrice <= 0 ||
        !Number.isFinite(market.tickSize)
      ) {
        return { kind: "unavailable" };
      }
      const validation = validateExecutablePrice(ladderTargetPrice, market.tickSize);
      if (!validation.ok) {
        this.log.warn(
          {
            signalId: signal.signalId,
            tokenId: String(signal.tokenId),
            ladderTargetPrice,
            tickSize: market.tickSize,
            validationReason: validation.reason,
          },
          "ladder target price failed executable-price validation",
        );
        return {
          kind: "invalid",
          price: ladderTargetPrice,
          tickSize: validation.tickSize,
          minPrice: validation.minPrice,
          maxPrice: validation.maxPrice,
          validationReason: validation.reason,
        };
      }
      return isRelayer
        ? { kind: "ok", price: ladderTargetPrice, postOnly: true }
        : { kind: "ok", price: ladderTargetPrice };
    }

    if (pricing.mode === "bounded-midpoint") {
      const maxSpreadTicks =
        signal.side === "buy" ? pricing.maxEntrySpreadTicks : pricing.maxExitSpreadTicks;
      const outcome = resolveBoundedMidpointPrice({
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        tickSize: market.tickSize,
        side: signal.side,
        maxSpreadTicks,
        maxImprovementTicks: pricing.maxImprovementTicks,
        wideSpreadPolicy: pricing.wideSpreadPolicy,
        oneSidedPolicy: pricing.oneSidedPolicy,
      });
      if (outcome.kind === "skip") {
        return outcome.reason === "wide-spread"
          ? { kind: "skip-wide-spread", diagnostics: outcome.diagnostics }
          : { kind: "skip-one-sided", diagnostics: outcome.diagnostics };
      }
      if (outcome.kind === "invalid") {
        const validation = validateExecutablePrice(outcome.price, market.tickSize);
        return {
          kind: "invalid",
          price: outcome.price,
          tickSize: validation.tickSize,
          minPrice: validation.minPrice,
          maxPrice: validation.maxPrice,
          validationReason: outcome.reason,
        };
      }
      return isRelayer
        ? {
            kind: "ok",
            price: outcome.price,
            postOnly: true,
            pricingDiagnostics: outcome.diagnostics,
          }
        : { kind: "ok", price: outcome.price, pricingDiagnostics: outcome.diagnostics };
    }

    // Edge mode (ADR-006 D1).
    const price = signal.side === "buy" ? market.bestBid : market.bestAsk;
    if (price == null || !Number.isFinite(price) || price <= 0) return { kind: "unavailable" };
    const validation = validateExecutablePrice(price, market.tickSize);
    if (!validation.ok) {
      return {
        kind: "invalid",
        price,
        tickSize: validation.tickSize,
        minPrice: validation.minPrice,
        maxPrice: validation.maxPrice,
        validationReason: validation.reason,
      };
    }
    // ADR-014 canary: in edge mode still compute the bounded-midpoint candidate
    // and attach its diagnostics as `pricingShadow`. Enables a non-regression
    // A/B read (edge vs shadow) before flipping `EXECUTION_PRICING_MODE` to
    // `bounded-midpoint`. Skip/invalid shadow outcomes are logged the same way
    // so canary analysis can see them. Gated by policy.telemetry.pricingShadow.
    const pricingShadow = policy.telemetry.pricingShadow
      ? this.computePricingShadow(signal, market, policy)
      : undefined;
    const ok: ExecutionTermsResolution = isRelayer
      ? { kind: "ok", price, postOnly: true }
      : { kind: "ok", price };
    if (pricingShadow && ok.kind === "ok") {
      ok.pricingShadow = pricingShadow;
    }
    return ok;
  }

  private computePricingShadow(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
  ): BoundedMidpointDiagnostics | undefined {
    const pricing = policy.pricing;
    const maxSpreadTicks =
      signal.side === "buy" ? pricing.maxEntrySpreadTicks : pricing.maxExitSpreadTicks;
    const outcome = resolveBoundedMidpointPrice({
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      tickSize: market.tickSize,
      side: signal.side,
      maxSpreadTicks,
      maxImprovementTicks: pricing.maxImprovementTicks,
      wideSpreadPolicy: pricing.wideSpreadPolicy,
      oneSidedPolicy: pricing.oneSidedPolicy,
    });
    return outcome.diagnostics;
  }

  private findSamePriceOpenSellOrder(
    tokenId: TokenId,
    side: "buy" | "sell",
    executionPrice: number,
  ): Order | null {
    if (side !== "sell" || !this.deps.orderRepo) return null;
    const orders = this.deps.orderRepo.findByTokenId(tokenId);
    return (
      orders.find(
        (order) =>
          order.side === "sell" &&
          isOpenOrderStatus(order.status) &&
          Math.abs(order.price - executionPrice) <= SELL_DEDUP_PRICE_EPSILON,
      ) ?? null
    );
  }
}

function canUseBaseMarketForPricing(market: NormalizedMarket): boolean {
  return market.bookSource === "clob" || market.bookSource === "simulation";
}

function resolveOrderSize(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  executionPrice: number,
): number {
  if (signal.side !== "buy") return signal.suggestedSize;
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return signal.suggestedSize;
  return signal.suggestedSizeUsdc / executionPrice;
}

function isOpenOrderStatus(status: Order["status"]): boolean {
  return status === "pending" || status === "open" || status === "partially-filled";
}

type ExecutionTermsResolution =
  | {
      kind: "ok";
      price: number;
      postOnly?: boolean;
      pricingDiagnostics?: BoundedMidpointDiagnostics;
      pricingShadow?: BoundedMidpointDiagnostics;
    }
  | { kind: "unavailable" }
  | {
      kind: "invalid";
      price: number;
      tickSize: number;
      minPrice: number;
      maxPrice: number;
      validationReason: ExecutablePriceValidationFailureReason;
    }
  | { kind: "skip-wide-spread"; diagnostics: BoundedMidpointDiagnostics }
  | { kind: "skip-one-sided"; diagnostics: BoundedMidpointDiagnostics };

export type DeadSideBucket = "<0" | "<1m" | "1-5m" | "5-15m" | "15-60m" | "1-4h" | ">4h";

export interface DeadSideCanary {
  bestBid: number | null;
  bestAsk: number | null;
  endDate: string;
  timeToEndMs: number;
  secondsToEnd: number;
  bucket: DeadSideBucket;
  shadowHits: {
    x60_000: boolean;
    x120_000: boolean;
    x300_000: boolean;
    x900_000: boolean;
  };
  askCeiling: number;
  enforceX: number;
  /** Alias of enforceX preserved for existing log consumers. */
  xMs: number;
  enforceHit: boolean;
  guardMode: DeadSideGuardMode;
}

/**
 * Collapse an ExecutionTermsResolution into the fields the observation row
 * needs: selectedPrice (null when no price was chosen), pricing diagnostics
 * (bounded-midpoint details when available), and `boundedOutcome` bucket.
 *
 * `ok` → selectedPrice + diagnostics (live pricing or shadow); outcome derived
 *        from diagnostics (ok/edge-fallback/not-computed).
 * `invalid` → selectedPrice = the rejected price; outcome = "invalid".
 * `unavailable` → selectedPrice = null; outcome = "not-computed".
 * `skip-*` → selectedPrice = null; diagnostics from bounded-midpoint resolver;
 *            outcome = "skip".
 */
function summarizeExecutionTerms(
  terms: ExecutionTermsResolution,
  mode: ExecutionPolicy["pricing"]["mode"],
): {
  selectedPrice: number | null;
  diagnostics: BoundedMidpointDiagnostics | null;
  boundedOutcome: ExecutionPolicyObservation["boundedOutcome"];
} {
  if (terms.kind === "ok") {
    const diagnostics = terms.pricingDiagnostics ?? terms.pricingShadow ?? null;
    return {
      selectedPrice: terms.price,
      diagnostics,
      boundedOutcome: deriveOkBoundedOutcome(mode, diagnostics),
    };
  }
  if (terms.kind === "invalid") {
    return { selectedPrice: terms.price, diagnostics: null, boundedOutcome: "invalid" };
  }
  if (terms.kind === "skip-wide-spread" || terms.kind === "skip-one-sided") {
    return { selectedPrice: null, diagnostics: terms.diagnostics, boundedOutcome: "skip" };
  }
  return { selectedPrice: null, diagnostics: null, boundedOutcome: "not-computed" };
}

function deriveOkBoundedOutcome(
  _mode: ExecutionPolicy["pricing"]["mode"],
  diagnostics: BoundedMidpointDiagnostics | null,
): ExecutionPolicyObservation["boundedOutcome"] {
  if (!diagnostics) return "not-computed";
  if (diagnostics.finalPrice == null) return "skip";
  if (diagnostics.improvementTicks != null && Math.abs(diagnostics.improvementTicks) >= 1 - 1e-9) {
    return "ok";
  }
  return "edge-fallback";
}

function shouldSkipSellBelowSignalFloor(
  signalPrice: number,
  executionPrice: number,
  minRatio: number,
): boolean {
  if (!Number.isFinite(minRatio) || minRatio <= 0) return false;
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return false;
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return false;
  return executionPrice < signalPrice * minRatio;
}

function shouldSkipSellInsideOrderLifetimeStopWindow(
  market: Pick<NormalizedMarket, "endDate">,
  policy: ExecutionPolicy,
  nowMs: number,
): boolean {
  const lifetime = policy.orderLifetime ?? DEFAULT_ORDER_LIFETIME_POLICY;
  if (!lifetime.enabled || lifetime.enforcement !== "enforce") return false;
  if (!market.endDate) return false;
  const endMs = Date.parse(market.endDate);
  if (!Number.isFinite(endMs)) return false;
  return endMs - nowMs <= lifetime.resolutionStopWindowMs;
}

function bucketForTimeToEndMs(timeToEndMs: number): DeadSideBucket {
  if (timeToEndMs < 0) return "<0";
  if (timeToEndMs <= 60_000) return "<1m";
  if (timeToEndMs <= 5 * 60_000) return "1-5m";
  if (timeToEndMs <= 15 * 60_000) return "5-15m";
  if (timeToEndMs <= 60 * 60_000) return "15-60m";
  if (timeToEndMs <= 4 * 60 * 60_000) return "1-4h";
  return ">4h";
}
