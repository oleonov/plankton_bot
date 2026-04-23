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
 *  - Enforce a short per-token cooldown after repeated unfilled entry cancels
 *  - Publish PlaceOrderRequested with a deterministic clientOrderId
 *
 * Does NOT evaluate risk — that already happened upstream.
 */

import type {
  EventBus,
  NormalizedMarket,
  OrderRepository,
  RuntimeEventMap,
  PlaceOrderCommand,
  TokenId,
} from "@plankton/domain";
import { createCommandId, ENTRY_REASONS, isAlive } from "@plankton/domain";
import { buildClientOrderId } from "@plankton/domain/node";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import {
  validateExecutablePrice,
  type ExecutablePriceValidationFailureReason,
} from "../../executable-price.js";
import {
  applyOrderBookToMarket,
  type CandidateBookCache,
  type CandidateBookResolution,
} from "./candidate-book-cache.js";

const BRIDGE_WS_BOOK_WAIT_MS = 100;
const MAX_UNFILLED_CANCELS_BEFORE_COOLDOWN = 3;
const UNFILLED_CANCEL_COOLDOWN_MS = 10 * 60_000;

export interface SignalToOrderBridgeDeps {
  bus: EventBus;
  log: Logger;
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
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
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

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    // Drop per-token state the moment market-data stops tracking a token.
    // Historically these maps only shrank on a successful fill or a cooldown
    // bypass — long-tail tokens leaked forever. See plans/2026-04-21-memory-leak-cleanup.md Task 4.
    for (const tokenId of payload.removedTokenIds) {
      const key = this.cooldownKey(tokenId);
      this.marketCache.delete(key);
      this.unfilledCancelCountByToken.delete(key);
      this.cooldownUntilByToken.delete(key);
      this.cooldownBaselineByToken.delete(key);
    }
  }

  private async handleApproved(payload: RuntimeEventMap["SignalApproved"]): Promise<void> {
    const { signal, market: embeddedMarket } = payload;

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
    const cooldown = this.resolveCooldownState(signal, market);
    if (cooldown.bypassReason && cooldown.previousCooldownUntil != null) {
      this.cooldownUntilByToken.delete(this.cooldownKey(signal.tokenId));
      this.cooldownBaselineByToken.delete(this.cooldownKey(signal.tokenId));
      void this.deps.bus.publish("CooldownBypassApplied", {
        tokenId: signal.tokenId,
        reason: cooldown.bypassReason,
        previousCooldownUntil: cooldown.previousCooldownUntil,
        appliedAt: Date.now(),
      });
    }
    if (cooldown.cooldownUntilMs != null && cooldown.cooldownUntilMs > Date.now()) {
      await this.publishConversionSkipped(signal, "marketability", ["token-cooling-down"], {
        cacheStatus: pricing.cacheStatus,
        cooldownUntil: cooldown.cooldownUntilMs,
      });
      return;
    }

    const executionTerms = this.resolveExecutionTerms(signal, market);
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
      return;
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
      size: resolveOrderSize(signal, executionTerms.price),
      price: executionTerms.price,
      ...(executionTerms.postOnly ? { postOnly: true } : {}),
      orderType: "GTC",
      tickSize: market.tickSize,
      negRisk: market.negRisk,
      sequenceInTick: signal.sequenceInTick,
      signalReason: signal.reason,
      metadata: {
        cacheStatus: pricing.cacheStatus,
        marketData: {
          bookSource: market.bookSource ?? "unknown",
          minOrderSize: market.minOrderSize ?? null,
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
      },
      "signal converted to order command",
    );

    await this.deps.bus.publish("PlaceOrderRequested", {
      command: cmd,
      timestamp: Date.now(),
    });
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

    if (baseMarket.bookSource === "clob") {
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
   * Execution price = bestBid (buy) / bestAsk (sell). Spec §7 executes at canonical book
   * top. In relayer mode the order is marked postOnly to avoid accidental taker fills.
   */
  private resolveExecutionTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
  ): ExecutionTermsResolution {
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
    const isRelayer = this.deps.liveLiteGuard?.getWalletMode() === "relayer";
    return isRelayer ? { kind: "ok", price, postOnly: true } : { kind: "ok", price };
  }

  private async handleFillReceived(payload: RuntimeEventMap["FillReceived"]): Promise<void> {
    this.filledOrderIds.add(String(payload.orderId));
    const key = this.cooldownKey(payload.tokenId);
    this.unfilledCancelCountByToken.delete(key);
    this.cooldownUntilByToken.delete(key);
    this.cooldownBaselineByToken.delete(key);
    this.pruneFilledOrderIds();
  }

  private async handleOrderCancelled(payload: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    if (!this.deps.orderRepo || this.filledOrderIds.has(String(payload.orderId))) return;

    // Reprice cancels are intentional cancel-and-replace — not failed fills
    if (payload.reason === "entry-reprice-cancel") return;

    const order = this.deps.orderRepo.findById(payload.orderId);
    if (
      !order ||
      order.side !== "buy" ||
      order.signalReason == null ||
      !isEntryReason(order.signalReason)
    ) {
      return;
    }

    const key = this.cooldownKey(order.tokenId);
    const nextCount = (this.unfilledCancelCountByToken.get(key) ?? 0) + 1;
    this.unfilledCancelCountByToken.set(key, nextCount);

    if (nextCount < MAX_UNFILLED_CANCELS_BEFORE_COOLDOWN) return;

    const cooldownUntil = Date.now() + UNFILLED_CANCEL_COOLDOWN_MS;
    this.cooldownUntilByToken.set(key, cooldownUntil);
    this.cooldownBaselineByToken.set(
      key,
      buildCooldownBaseline(this.resolveBaselineMarket(order.tokenId)),
    );
    this.log.warn(
      {
        orderId: payload.orderId,
        tokenId: order.tokenId,
        unfilledCancels: nextCount,
        cooldownUntil,
      },
      "entry token cooled down after repeated cancel-without-fill",
    );
  }

  private cooldownKey(tokenId: TokenId): string {
    return String(tokenId);
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
    const key = this.cooldownKey(signal.tokenId);
    const cooldownUntilMs = this.cooldownUntilByToken.get(key) ?? null;
    if (cooldownUntilMs == null || cooldownUntilMs <= Date.now()) {
      // Natural expiry path: evict the cooldown trio so stale per-token state
      // doesn't pile up for tokens we stop trading. Fill / bypass handlers
      // already delete explicitly; this closes the common path.
      if (cooldownUntilMs != null) {
        this.cooldownUntilByToken.delete(key);
        this.cooldownBaselineByToken.delete(key);
        this.unfilledCancelCountByToken.delete(key);
      }
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

type CooldownBypassReason = "price-moved" | "spread-narrowed" | "trade-recency-improved";

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

type ExecutionTermsResolution =
  | { kind: "ok"; price: number; postOnly?: boolean }
  | { kind: "unavailable" }
  | {
      kind: "invalid";
      price: number;
      tickSize: number;
      minPrice: number;
      maxPrice: number;
      validationReason: ExecutablePriceValidationFailureReason;
    };
