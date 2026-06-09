/**
 * Signal-to-Order bridge — converts SignalApproved into PlaceOrderRequested.
 *
 * Closes the gap in the end-to-end trading path:
 *   strategy → SignalProduced → risk → SignalApproved → [this bridge] → PlaceOrderRequested → execution
 *
 * Responsibilities:
 *  - Subscribe to SignalApproved
 *  - Resolve a live CLOB book (cache/refresh) and build hard-liveness guard
 *  - Price orders from the configured edge/exit policy; postOnly in relayer mode
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
  PositionRepository,
  ProfileId,
  RuntimeEventMap,
  PlaceOrderCommand,
  TokenId,
  Order,
  SellShadowAvgEntrySource,
} from "@krabs/domain";
import {
  canPlaceBuyOrderForMarket,
  createCommandId,
  isAlive,
  isSellTimeoutReplacement,
  recordStageDuration,
} from "@krabs/domain";
import { DEFAULT_EXECUTION_POLICY } from "../../execution-policy.js";
import { buildClientOrderId } from "@krabs/domain/node";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { MarketResolutionTracker } from "../resolution/market-resolution-tracker.js";
import {
  classifyNotionalBucket,
  classifyRoundLevel,
  computePricingDeltaTicks,
  floorToTick,
  resolveBoundedMidpointPrice,
  roundToTick,
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
import type { SignalPathTelemetry } from "./signal-path-telemetry.js";

const BRIDGE_WS_BOOK_WAIT_MS = 25;
const MIN_SIZE_EPSILON = 1e-9;
const MIN_NOTIONAL_EPSILON = 1e-9;
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
  positionRepo?: PositionRepository | undefined;
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
  /** Runtime observability for pricing-mode and opportunistic-taker decisions. */
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  signalPathTelemetry?: SignalPathTelemetry | undefined;
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
  private lastTakerInfoLogDay: string | null = null;
  private readonly observationQueue: ExecutionPolicyObservation[] = [];
  private observationFlushScheduled = false;

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
    this.flushObservationQueue();
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
    const bridgeStartMs = performance.now();
    try {
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

      const rawExecutionTerms = this.resolveExecutionTerms(signal, market, policy);
      const canary = this.buildDeadSideCanary(signal, market, policy);
      // F2: shadow telemetry measures the raw (pre-cap) anchor; the cap only
      // governs the price that is actually placed.
      const sellPricingShadow = this.computeSellPricingShadow(signal, rawExecutionTerms, policy);
      const executionTerms = this.applySellPriceCap(rawExecutionTerms, signal, market);

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
          sellPricingShadow,
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
        await this.publishConversionSkipped(
          signal,
          "execution-terms",
          ["execution-price-invalid"],
          {
            cacheStatus: pricing.cacheStatus,
            price: executionTerms.price,
            tickSize: executionTerms.tickSize,
            minPrice: executionTerms.minPrice,
            maxPrice: executionTerms.maxPrice,
            validationReason: executionTerms.validationReason,
          },
        );
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          sellPricingShadow,
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
          sellPricingShadow,
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
          sellPricingShadow,
          skippedReason: "price-above-entry-ceiling",
        });
        return;
      }

      const nowMs = this.now();

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
          sellPricingShadow,
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
            sellPricingShadow,
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
        await this.publishConversionSkipped(
          signal,
          "execution-terms",
          ["order-size-below-minimum"],
          {
            cacheStatus: pricing.cacheStatus,
            orderSize,
            minOrderSize: market.minOrderSize ?? null,
            effectiveMinOrderSize,
          },
        );
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          sellPricingShadow,
          skippedReason: "order-size-below-minimum",
        });
        return;
      }

      const duplicateSell = this.findSamePriceOpenSellOrder(
        signal.tokenId,
        signal.side,
        executionTerms.price,
        market.tickSize,
        policy,
      );
      if (duplicateSell) {
        const timedOutSizeReplacement = isSellTimeoutReplacement({
          existingOrder: duplicateSell,
          requestedSize: orderSize,
          nowMs,
          sellTimeoutMs: policy.sellTimeoutMs,
        });
        if (timedOutSizeReplacement) {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              existingOrderId: duplicateSell.orderId,
              existingSize: duplicateSell.size,
              requestedSize: orderSize,
              existingPrice: duplicateSell.price,
              executionPrice: executionTerms.price,
            },
            "approved SELL continuing — timed-out sell size escalation",
          );
        } else {
          this.log.debug(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              existingOrderId: duplicateSell.orderId,
              existingPrice: duplicateSell.price,
              executionPrice: executionTerms.price,
              cacheStatus: pricing.cacheStatus,
            },
            "approved SELL skipped — acceptable-price sell order already open",
          );
          await this.publishConversionSkipped(
            signal,
            "execution-terms",
            ["sell-order-acceptable-price-already-open"],
            {
              cacheStatus: pricing.cacheStatus,
              existingOrderId: String(duplicateSell.orderId),
              existingPrice: duplicateSell.price,
              executionPrice: executionTerms.price,
            },
          );
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: "sell-order-acceptable-price-already-open",
          });
          return;
        }
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
            sellPricingShadow,
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
          const sample =
            this.deps.signalPathTelemetry?.recordLateCooldown(
              signal.signalId,
              String(signal.tokenId),
              signal.side === "buy" ? "BUY" : "SELL",
              executionTerms.price,
              market.tickSize,
            ) ?? false;
          if (sample) {
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
              "signal_debug_sample",
            );
          }
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
            sellPricingShadow,
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
        ...(executionTerms.postOnly !== undefined ? { postOnly: executionTerms.postOnly } : {}),
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
          postOnly: cmd.postOnly ?? null,
          pricingMode: policy.pricing.mode,
          executionPricingMode: executionTerms.pricedMode,
          ...(executionTerms.pricingDiagnostics
            ? { pricingDiagnostics: executionTerms.pricingDiagnostics }
            : {}),
          ...(executionTerms.pricingShadow ? { pricingShadow: executionTerms.pricingShadow } : {}),
        },
        "signal converted to order command",
      );
      this.recordPricingMetrics(signal, executionTerms);

      this.writeObservation({
        signal,
        clientOrderId: String(clientOrderId),
        market,
        policy,
        executionTerms,
        canary,
        sellPricingShadow,
        skippedReason: null,
      });

      await this.deps.bus.publish("PlaceOrderRequested", {
        command: cmd,
        timestamp: Date.now(),
      });
    } finally {
      recordStageDuration("signal_to_order_bridge", performance.now() - bridgeStartMs);
    }
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
    sellPricingShadow: SellPricingShadow | null;
    skippedReason: string | null;
  }): void {
    const { observations, profileId } = this.deps;
    if (!observations || !profileId) return;
    const {
      signal,
      clientOrderId,
      market,
      policy,
      executionTerms,
      canary,
      sellPricingShadow,
      skippedReason,
    } = params;
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
        sellShadowAvgEntry: sellPricingShadow?.avgEntry ?? null,
        sellShadowAvgEntrySource: sellPricingShadow?.avgEntrySource ?? null,
        sellShadowSignalPrice: sellPricingShadow?.signalPrice ?? null,
        sellShadowExecutionPrice: sellPricingShadow?.executionPrice ?? null,
        sellShadowExecutionVsSignalRatio: sellPricingShadow?.executionVsSignalRatio ?? null,
        sellShadowExecutionVsAvgEntryRatio: sellPricingShadow?.executionVsAvgEntryRatio ?? null,
        sellShadowCap5Violation: sellPricingShadow?.cap5Violation ?? null,
        sellShadowCap10Violation: sellPricingShadow?.cap10Violation ?? null,
        sellShadowExitPricingMode: sellPricingShadow?.exitPricingMode ?? null,
        sellShadowExitAnchorMode: sellPricingShadow?.exitAnchorMode ?? null,
      };
      this.enqueueObservation(row, signal);
    } catch (err) {
      this.log.error(
        { err, signalId: signal.signalId, tokenId: signal.tokenId },
        "failed to write execution policy observation",
      );
    }
  }

  private enqueueObservation(
    row: ExecutionPolicyObservation,
    signal: RuntimeEventMap["SignalApproved"]["signal"],
  ): void {
    this.observationQueue.push(row);
    if (this.observationFlushScheduled) return;
    this.observationFlushScheduled = true;
    setImmediate(() => {
      try {
        this.flushObservationQueue();
      } catch (err) {
        this.log.error(
          { err, signalId: signal.signalId, tokenId: signal.tokenId },
          "failed to flush execution policy observation queue",
        );
      }
    }).unref?.();
  }

  private flushObservationQueue(): void {
    const { observations } = this.deps;
    if (!observations) return;
    this.observationFlushScheduled = false;
    const rows = this.observationQueue.splice(0, this.observationQueue.length);
    for (const row of rows) {
      try {
        observations.insert(row);
      } catch (err) {
        this.log.error(
          { err, signalId: row.signalId, tokenId: row.tokenId },
          "failed to write execution policy observation",
        );
      }
    }
    if (this.observationQueue.length > 0) {
      this.observationFlushScheduled = true;
      setImmediate(() => this.flushObservationQueue()).unref?.();
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

  private computeSellPricingShadow(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    executionTerms: ExecutionTermsResolution,
    policy: ExecutionPolicy,
  ): SellPricingShadow | null {
    if (signal.side !== "sell") return null;
    const executionPrice = resolveShadowExecutionPrice(executionTerms);
    const signalPrice = finitePositiveOrNull(signal.suggestedPrice);
    const avgEntry = this.resolveSellShadowAvgEntry(signal);
    const executionVsSignalRatio = computePositiveRatio(executionPrice, signalPrice);
    const executionVsAvgEntryRatio = computePositiveRatio(executionPrice, avgEntry.value);

    return {
      avgEntry: avgEntry.value,
      avgEntrySource: avgEntry.source,
      signalPrice,
      executionPrice,
      executionVsSignalRatio,
      executionVsAvgEntryRatio,
      cap5Violation: executionVsAvgEntryRatio == null ? null : executionVsAvgEntryRatio > 5,
      cap10Violation: executionVsAvgEntryRatio == null ? null : executionVsAvgEntryRatio > 10,
      exitPricingMode: policy.exitPricingMode,
      exitAnchorMode: resolveShadowExitAnchorMode(executionTerms),
    };
  }

  private resolveSellShadowAvgEntry(signal: RuntimeEventMap["SignalApproved"]["signal"]): {
    value: number | null;
    source: SellShadowAvgEntrySource;
  } {
    const repo = this.deps.positionRepo;
    if (!repo) return { value: null, source: "missing_position_repo" };
    try {
      const position = repo.findByTokenId(signal.tokenId);
      if (!position) return { value: null, source: "missing_position" };
      const avgEntry = finitePositiveOrNull(position.avgEntryPrice);
      if (avgEntry == null) return { value: null, source: "invalid_avg_entry" };
      return { value: avgEntry, source: "position_repo" };
    } catch (err) {
      this.log.warn(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "SELL shadow telemetry could not read avg entry",
      );
      return { value: null, source: "error" };
    }
  }

  /**
   * Track P F2 — clamp a resolved SELL execution price to the Plankton tier cap
   * (avgEntry * markup, ceiling 0.97). Applied after the SELL pricing shadow is
   * computed so the observe-only telemetry keeps measuring the raw (pre-cap)
   * anchor. BUY orders and non-`ok` resolutions pass through untouched.
   */
  private applySellPriceCap(
    resolution: ExecutionTermsResolution,
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
  ): ExecutionTermsResolution {
    if (signal.side !== "sell" || resolution.kind !== "ok") return resolution;
    const avgEntry = this.resolveSellShadowAvgEntry(signal).value;
    const capped = capSellPriceToPlanktonTier(resolution.price, avgEntry, market.tickSize);
    if (capped === resolution.price) return resolution;
    return { ...resolution, price: capped };
  }

  /**
   * ADR-006 D1 (edge mode): BUY = bestBid, SELL = bestAsk.
   * R93 sell-exit guard: default SELL exits are midpoint-anchored while
   * bid-anchored remains available for config rollback.
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
        ? { kind: "ok", price: ladderTargetPrice, postOnly: true, pricedMode: "ladder" }
        : { kind: "ok", price: ladderTargetPrice, pricedMode: "ladder" };
    }

    // Tight-spread taker mode intentionally wins over bounded-midpoint: both
    // price at/near the opposite top of book, but this path explicitly disables
    // postOnly to copy R51's observed taker fills.
    const takerTerms = this.resolveOpportunisticTakerTerms(signal, market, policy);
    if (takerTerms) return takerTerms;

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
            pricedMode: "bounded-midpoint",
            pricingDiagnostics: outcome.diagnostics,
          }
        : {
            kind: "ok",
            price: outcome.price,
            pricedMode: "bounded-midpoint",
            pricingDiagnostics: outcome.diagnostics,
          };
    }

    const priced = this.resolveEdgeExecutionPrice(signal, market, policy);
    const price = priced?.price ?? null;
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
      ? { kind: "ok", price, postOnly: true, pricedMode: priced?.mode ?? "edge" }
      : { kind: "ok", price, pricedMode: priced?.mode ?? "edge" };
    if (priced?.anchorTicksUsed !== undefined) {
      ok.anchorTicksUsed = priced.anchorTicksUsed;
    }
    if (priced?.exitAnchorMode !== undefined) {
      ok.exitAnchorMode = priced.exitAnchorMode;
    }
    if (pricingShadow && ok.kind === "ok") {
      ok.pricingShadow = pricingShadow;
    }
    return ok;
  }

  private resolveEdgeExecutionPrice(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
  ): {
    price: number;
    mode: OrderPricedMode;
    anchorTicksUsed?: number;
    exitAnchorMode?: ExitAnchorMode;
  } | null {
    if (signal.side === "sell" && policy.exitPricingMode === "midpoint-anchored") {
      const midpointPrice = resolveMidpointAnchoredSellPriceWithMode(
        market.bestBid,
        market.bestAsk,
        market.tickSize,
        policy.exitMidpointAnchorTicks,
      );
      if (midpointPrice != null) {
        return {
          price: midpointPrice.price,
          mode: "midpoint-anchored",
          anchorTicksUsed: policy.exitMidpointAnchorTicks,
          exitAnchorMode: midpointPrice.anchorMode,
        };
      }
    }

    if (signal.side === "sell" && policy.exitPricingMode === "bid-anchored") {
      if (
        market.bestBid == null ||
        !Number.isFinite(market.bestBid) ||
        !Number.isFinite(market.tickSize) ||
        market.tickSize <= 0
      ) {
        return null;
      }
      return {
        price: resolveBidAnchoredSellPrice(
          market.bestBid,
          market.bestAsk,
          market.tickSize,
          policy.exitBidAnchorTicks,
        ),
        mode: "bid-anchored",
        anchorTicksUsed: policy.exitBidAnchorTicks,
      };
    }
    const price = signal.side === "buy" ? market.bestBid : market.bestAsk;
    return price == null ? null : { price, mode: "edge" };
  }

  private resolveOpportunisticTakerTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
  ): ExecutionTermsResolution | null {
    const taker = policy.opportunisticTaker;
    if (!taker) return null;
    if (!taker.enabled || !taker.sides.includes(signal.side)) return null;
    if (
      market.bestBid == null ||
      market.bestAsk == null ||
      !Number.isFinite(market.bestBid) ||
      !Number.isFinite(market.bestAsk) ||
      !Number.isFinite(market.tickSize) ||
      market.tickSize <= 0
    ) {
      return null;
    }
    const spread = market.bestAsk - market.bestBid;
    if (!Number.isFinite(spread) || spread < 0) return null;
    const spreadTicks = Math.round(spread / market.tickSize);
    if (spreadTicks > taker.maxSpreadTicks) return null;

    const price = signal.side === "buy" ? market.bestAsk : market.bestBid;
    const minSizeBlock = this.resolveTakerMinSizeBlock(signal, market, price, taker);
    if (minSizeBlock) {
      this.recordTakerMinSizeDisabledMetric(signal, minSizeBlock);
      return null;
    }

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
    return { kind: "ok", price, postOnly: false, pricedMode: "taker", spreadTicks };
  }

  private resolveTakerMinSizeBlock(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    price: number,
    taker: ExecutionPolicy["opportunisticTaker"],
  ): {
    reason: "share_min_size" | "notional_min_size";
    marketMinOrderSize: number | null;
    minNotionalUsdc: number | null;
    notionalUsdc: number;
    safetyBuffer: number;
  } | null {
    const marketMinOrderSize =
      typeof market.minOrderSize === "number" &&
      Number.isFinite(market.minOrderSize) &&
      market.minOrderSize > 0
        ? market.minOrderSize
        : null;

    if (
      marketMinOrderSize !== null &&
      signal.suggestedSize + MIN_SIZE_EPSILON < marketMinOrderSize * taker.safetyBuffer
    ) {
      return {
        reason: "share_min_size",
        marketMinOrderSize,
        minNotionalUsdc: null,
        notionalUsdc: signal.suggestedSizeUsdc,
        safetyBuffer: taker.safetyBuffer,
      };
    }

    const notionalUsdc =
      Number.isFinite(signal.suggestedSizeUsdc) && signal.suggestedSizeUsdc > 0
        ? signal.suggestedSizeUsdc
        : signal.suggestedSize * price;
    const configuredBuyMinNotional =
      signal.side === "buy"
        ? this.deps.liveLiteGuard?.getMinEntryNotionalUsdc?.(taker.marketableBuyMinNotionalUsdc)
        : null;
    const minNotionalUsdc =
      configuredBuyMinNotional ??
      (marketMinOrderSize === null ? taker.fallbackMinNotionalUsdc : null);

    if (
      minNotionalUsdc !== null &&
      Number.isFinite(minNotionalUsdc) &&
      minNotionalUsdc > 0 &&
      notionalUsdc + MIN_NOTIONAL_EPSILON < minNotionalUsdc * taker.safetyBuffer
    ) {
      return {
        reason: "notional_min_size",
        marketMinOrderSize,
        minNotionalUsdc,
        notionalUsdc,
        safetyBuffer: taker.safetyBuffer,
      };
    }

    return null;
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
    tickSize: number,
    policy: ExecutionPolicy,
  ): Order | null {
    if (side !== "sell" || !this.deps.orderRepo) return null;
    const toleranceTicks = policy.sellReplaceMinPriceDeltaTicks ?? 2;
    const acceptablePriceWindow = toleranceTicks * tickSize + 1e-9;
    const orders = this.deps.orderRepo.findByTokenId(tokenId);
    return (
      orders.find(
        (order) =>
          order.side === "sell" &&
          isOpenOrderStatus(order.status) &&
          Math.abs(order.price - executionPrice) < acceptablePriceWindow,
      ) ?? null
    );
  }

  private recordPricingMetrics(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    executionTerms: Extract<ExecutionTermsResolution, { kind: "ok" }>,
  ): void {
    try {
      const capturedAt = new Date(this.now()).toISOString();
      this.deps.runtimeMetrics?.writeCounter(
        "order_priced_mode_total",
        1,
        JSON.stringify({ mode: executionTerms.pricedMode, side: signal.side }),
      );
      if (executionTerms.pricedMode === "taker") {
        this.deps.runtimeMetrics?.writeCounter(
          "taker_decision_total",
          1,
          JSON.stringify({ side: signal.side, spread_ticks: executionTerms.spreadTicks ?? null }),
        );
        this.deps.runtimeMetrics?.writeCounter(
          "taker_attempt_total",
          1,
          JSON.stringify({ side: signal.side, mode: "success" }),
        );
        const day = capturedAt.slice(0, 10);
        if (this.lastTakerInfoLogDay !== day) {
          this.lastTakerInfoLogDay = day;
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: String(signal.tokenId),
              side: signal.side,
              spreadTicks: executionTerms.spreadTicks ?? null,
              executionPrice: executionTerms.price,
            },
            "opportunistic taker pricing selected",
          );
        }
      }
      if (executionTerms.pricedMode === "bid-anchored") {
        this.deps.runtimeMetrics?.writeCounter(
          "bid_anchored_decision_total",
          1,
          JSON.stringify({
            side: signal.side,
            anchor_ticks_used: executionTerms.anchorTicksUsed ?? null,
          }),
        );
      }
      if (signal.side === "sell" && executionTerms.exitAnchorMode) {
        this.deps.runtimeMetrics?.writeCounter(
          "exit_anchor_mode_total",
          1,
          JSON.stringify({ mode: executionTerms.exitAnchorMode }),
        );
      }
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "failed to record pricing metrics",
      );
    }
  }

  private recordTakerMinSizeDisabledMetric(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    block: {
      reason: "share_min_size" | "notional_min_size";
      marketMinOrderSize: number | null;
      minNotionalUsdc: number | null;
      notionalUsdc: number;
      safetyBuffer: number;
    },
  ): void {
    try {
      const labels = {
        side: signal.side,
        token_id: String(signal.tokenId),
        reason: block.reason,
        market_min_order_size: block.marketMinOrderSize,
        min_notional_usdc: block.minNotionalUsdc,
        requested_size_shares: signal.suggestedSize,
        requested_size_usdc: block.notionalUsdc,
        required_size_shares:
          block.marketMinOrderSize === null ? null : block.marketMinOrderSize * block.safetyBuffer,
        required_notional_usdc:
          block.minNotionalUsdc === null ? null : block.minNotionalUsdc * block.safetyBuffer,
        safety_buffer: block.safetyBuffer,
      };
      this.deps.runtimeMetrics?.writeCounter(
        "taker_disabled_min_size_total",
        1,
        JSON.stringify(labels),
      );
      this.deps.runtimeMetrics?.writeCounter(
        "taker_attempt_total",
        1,
        JSON.stringify({ side: signal.side, mode: "rejected", reason: "min_size" }),
      );
      this.deps.runtimeMetrics?.writeCounter(
        "taker_disabled_fraction_over_threshold",
        1,
        JSON.stringify({ side: signal.side, bucket: takerFractionBucket(signal, block) }),
      );
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "failed to record taker min-size metric",
      );
    }
  }
}

function canUseBaseMarketForPricing(market: NormalizedMarket): boolean {
  return market.bookSource === "clob" || market.bookSource === "simulation";
}

function takerFractionBucket(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  block: {
    reason: "share_min_size" | "notional_min_size";
    marketMinOrderSize: number | null;
    minNotionalUsdc: number | null;
    notionalUsdc: number;
    safetyBuffer: number;
  },
): "0-0.5" | "0.5-0.8" | "0.8-0.95" | "0.95-1.0" {
  const requiredShares =
    block.marketMinOrderSize === null ? null : block.marketMinOrderSize * block.safetyBuffer;
  const requiredNotional =
    block.minNotionalUsdc === null ? null : block.minNotionalUsdc * block.safetyBuffer;
  const fraction =
    block.reason === "share_min_size" && requiredShares !== null && requiredShares > 0
      ? signal.suggestedSize / requiredShares
      : block.reason === "notional_min_size" && requiredNotional !== null && requiredNotional > 0
        ? block.notionalUsdc / requiredNotional
        : 0;
  if (fraction < 0.5) return "0-0.5";
  if (fraction < 0.8) return "0.5-0.8";
  if (fraction < 0.95) return "0.8-0.95";
  return "0.95-1.0";
}

function resolveBidAnchoredSellPrice(
  bestBid: number,
  bestAsk: number | null,
  tickSize: number,
  anchorTicks: number,
): number {
  const rawPrice = roundToTick(bestBid + anchorTicks * tickSize, tickSize);
  if (bestAsk == null || !Number.isFinite(bestAsk)) return rawPrice;

  const insideAsk = roundToTick(bestAsk - tickSize, tickSize);
  if (insideAsk > bestBid + SELL_DEDUP_PRICE_EPSILON) {
    return Math.min(rawPrice, insideAsk);
  }
  return Math.min(rawPrice, roundToTick(bestAsk, tickSize));
}

/**
 * Resolves SELL price using an ask-side midpoint anchor.
 *
 * EXIT-FIX-2 keeps the midpoint+N tick floor but undercuts the visible ask when doing so
 * stays passive and above that floor. This matches the 2026-05-22 Plankton evidence:
 * low-entry high-multiple exits are predominantly maker-like and fill near best ask.
 *
 * Returns null if bestBid, tickSize, or anchorTicks are unavailable or non-positive.
 * Missing bestAsk falls back to a one-sided bestBid+N tick anchor.
 */
export function resolveMidpointAnchoredSellPrice(
  bestBid: number | null,
  bestAsk: number | null,
  tickSize: number,
  anchorTicks: number,
): number | null {
  return (
    resolveMidpointAnchoredSellPriceWithMode(bestBid, bestAsk, tickSize, anchorTicks)?.price ?? null
  );
}

type ExitAnchorMode = "midpoint" | "ask_undercut" | "ask_fallback";

function resolveMidpointAnchoredSellPriceWithMode(
  bestBid: number | null,
  bestAsk: number | null,
  tickSize: number,
  anchorTicks: number,
): { price: number; anchorMode: ExitAnchorMode } | null {
  if (
    bestBid == null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(tickSize) ||
    !Number.isFinite(anchorTicks) ||
    bestBid <= 0 ||
    tickSize <= 0
  ) {
    return null;
  }

  const hasValidAsk = bestAsk != null && Number.isFinite(bestAsk) && bestAsk > 0;
  const midpoint = hasValidAsk ? (bestBid + bestAsk) / 2 : bestBid;
  const base = floorToTick(midpoint + anchorTicks * tickSize, tickSize);
  if (!hasValidAsk || bestAsk <= midpoint) {
    return { price: base, anchorMode: "midpoint" };
  }

  const askUnder = floorToTick(bestAsk - tickSize, tickSize);
  if (askUnder <= bestBid) {
    return { price: floorToTick(bestAsk, tickSize), anchorMode: "ask_fallback" };
  }
  if (askUnder >= base) {
    return { price: askUnder, anchorMode: "ask_undercut" };
  }
  return { price: base, anchorMode: "midpoint" };
}

/**
 * Track P F2 — hard ceiling on any SELL exit target.
 * A Polymarket price is a probability in [0, 1]; resting a SELL above ~0.97
 * can never fill. This alone removes the bulk of the 97.8% cancel rate.
 */
export const SELL_PRICE_CEILING = 0.97;

/**
 * Track P F2 — Plankton-aligned SELL markup ceiling by entry tier
 * (research_plankton/plankton_sell_pricing_playbook_2026-06-04.md).
 *
 * Markup is mechanically bounded by entry price: only the cheap (<0.02) tail
 * can fill at large multiples (median 2.5x). Above ~0.10 entry a constant 10x
 * target exceeds 1.0 and never fills. The tiers reproduce the analyst's
 * entry-binned first-markup medians (0.02-0.05 and 0.05-0.15 both 1.36x).
 */
export function planktonAlignedMarkupCap(avgEntry: number): number {
  if (avgEntry < 0.02) return 2.5;
  if (avgEntry < 0.15) return 1.36;
  if (avgEntry < 0.35) return 1.17;
  return 1.1;
}

/**
 * Track P F2 — caps a computed SELL price to the lower of the Plankton tier
 * target (avgEntry * markup) and the 0.97 ceiling, floored to a valid tick.
 *
 * When the computed price is already at/below the cap the original price is
 * returned unchanged (existing anchored pricing preserved). When avgEntry is
 * unknown only the ceiling applies. A cap that would floor below one tick is
 * ignored so the function can never produce a non-executable price.
 */
export function capSellPriceToPlanktonTier(
  price: number,
  avgEntry: number | null,
  tickSize: number,
): number {
  let cap = SELL_PRICE_CEILING;
  if (avgEntry != null && Number.isFinite(avgEntry) && avgEntry > 0) {
    cap = Math.min(cap, avgEntry * planktonAlignedMarkupCap(avgEntry));
  }
  if (!Number.isFinite(price) || price <= cap) return price;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  const cappedTick = floorToTick(cap, tickSize);
  if (cappedTick < tickSize) return price;
  return cappedTick;
}

function resolveOrderSize(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  executionPrice: number,
): number {
  if (signal.side !== "buy") return signal.suggestedSize;
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return signal.suggestedSize;
  return signal.suggestedSizeUsdc / executionPrice;
}

function resolveShadowExecutionPrice(executionTerms: ExecutionTermsResolution): number | null {
  if (executionTerms.kind === "ok" || executionTerms.kind === "invalid") {
    return finitePositiveOrNull(executionTerms.price);
  }
  return null;
}

function resolveShadowExitAnchorMode(executionTerms: ExecutionTermsResolution): string | null {
  if (executionTerms.kind !== "ok") return null;
  return executionTerms.exitAnchorMode ?? executionTerms.pricedMode;
}

function finitePositiveOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function computePositiveRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null) return null;
  return numerator / denominator;
}

function isOpenOrderStatus(status: Order["status"]): boolean {
  return status === "pending" || status === "open" || status === "partially-filled";
}

interface SellPricingShadow {
  avgEntry: number | null;
  avgEntrySource: SellShadowAvgEntrySource;
  signalPrice: number | null;
  executionPrice: number | null;
  executionVsSignalRatio: number | null;
  executionVsAvgEntryRatio: number | null;
  cap5Violation: boolean | null;
  cap10Violation: boolean | null;
  exitPricingMode: ExecutionPolicy["exitPricingMode"];
  exitAnchorMode: string | null;
}

type ExecutionTermsResolution =
  | {
      kind: "ok";
      price: number;
      postOnly?: boolean;
      pricedMode: OrderPricedMode;
      spreadTicks?: number;
      anchorTicksUsed?: number;
      exitAnchorMode?: ExitAnchorMode;
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

type OrderPricedMode =
  | "edge"
  | "bid-anchored"
  | "midpoint-anchored"
  | "bounded-midpoint"
  | "taker"
  | "ladder";

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

function bucketForTimeToEndMs(timeToEndMs: number): DeadSideBucket {
  if (timeToEndMs < 0) return "<0";
  if (timeToEndMs <= 60_000) return "<1m";
  if (timeToEndMs <= 5 * 60_000) return "1-5m";
  if (timeToEndMs <= 15 * 60_000) return "5-15m";
  if (timeToEndMs <= 60 * 60_000) return "15-60m";
  if (timeToEndMs <= 4 * 60 * 60_000) return "1-4h";
  return ">4h";
}
