import { randomUUID } from "node:crypto";
import type {
  AlgoRulesRepository,
  EventBus,
  Fill,
  FillRepository,
  LegStateRepository,
  MultiBuyLadderPolicy,
  NormalizedMarket,
  Order,
  OrderRepository,
  RuntimeEventMap,
  RuntimeModule,
  Signal,
  SignalReason as SignalReasonType,
  TokenId,
  ExecutionPolicy,
} from "@krabs/domain";
import {
  ENTRY_REASONS,
  canPlaceBuyOrderForMarket,
  createConditionId,
  deriveState,
  evaluateSize,
  resolveSignalReason,
} from "@krabs/domain";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { Logger } from "../../logger.js";

// Lifecycle-generated BUYs intentionally bypass AlgoDecision's drop-trigger gate:
// they are continuations of an already-approved entry path and still traverse
// RiskInventory, same-price cooldown, wallet/order capacity, and signal-to-order.
const OUTBID_REPRICED_REASON = "outbid_repriced";
const OUTBID_REPRICE_SIGNAL_PREFIX = "outbid-reprice";
const EPSILON = 1e-9;

type TimerHandle = ReturnType<typeof setTimeout>;

interface LadderState {
  attemptedSteps: number;
  filledSteps: number;
  firstFillPrice: number;
  anchorMs: number;
}

interface EntryLifecycleMetrics {
  outbidRepriceCancels: number;
  outbidRepriceSignals: number;
  outbidRepriceFills: number;
  ladderSignals: number;
  ladderFills: number;
  ladderCooldownPaused: number;
  ladderStopped: Record<string, number>;
  ladderSignalsByStep: Record<string, number>;
  ladderFillsByStep: Record<string, number>;
}

export interface EntryLifecycleModuleDeps {
  bus: EventBus;
  orderRepo: OrderRepository;
  fillRepo: Pick<FillRepository, "findByOrderId" | "findByTokenId">;
  legStateRepo: LegStateRepository;
  algoRulesRepo: AlgoRulesRepository;
  policy: () => ExecutionPolicy;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  log: Logger;
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export class EntryLifecycleModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly repriceCountBySignalId = new Map<string, number>();
  private readonly repricedSignalIds = new Set<string>();
  private readonly ladderSignalSteps = new Map<string, number>();
  private readonly ladderStateByToken = new Map<string, LadderState>();
  private readonly ladderResetAnchorByToken = new Map<string, number>();
  private readonly ladderTimers = new Map<string, TimerHandle>();
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private readonly unsubs: Array<() => void> = [];
  private started = false;
  private metrics: EntryLifecycleMetrics = createMetrics();

  constructor(private readonly deps: EntryLifecycleModuleDeps) {
    this.log = deps.log.child({ module: "entry-lifecycle" });
  }

  getRepriceCount(signalId: string | null): number {
    if (!signalId) return 0;
    return this.repriceCountBySignalId.get(signalId) ?? parseRepriceCount(signalId);
  }

  getMarket(tokenId: TokenId): NormalizedMarket | null {
    return this.marketCache.get(String(tokenId)) ?? null;
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (event) =>
        this.handleMarketUpdated(event),
      ),
      this.deps.bus.subscribe("TrackedMarketsChanged", (event) =>
        this.handleTrackedMarketsChanged(event),
      ),
      this.deps.bus.subscribe("OrderCancelled", (event) => this.handleOrderCancelled(event)),
      this.deps.bus.subscribe("FillReceived", (event) => this.handleFillReceived(event)),
      this.deps.bus.subscribe("SignalConversionSkipped", (event) =>
        this.handleSignalConversionSkipped(event),
      ),
      this.deps.bus.subscribe("PositionUpdated", (event) => this.handlePositionUpdated(event)),
      this.deps.bus.subscribe("MarketResolvedHint", (event) => this.handleMarketResolved(event)),
    );
    this.started = true;
    this.log.info("entry lifecycle module started");
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    for (const timer of this.ladderTimers.values()) this.clearTimer(timer);
    this.ladderTimers.clear();
    this.started = false;
    this.log.info("entry lifecycle module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: this.started,
      detail: `repriced=${this.metrics.outbidRepriceSignals} ladder=${this.metrics.ladderSignals} scheduled=${this.ladderTimers.size}`,
    };
  }

  private async handleOrderCancelled(event: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    if (event.reason !== OUTBID_REPRICED_REASON) return;
    this.metrics.outbidRepriceCancels++;
    const order = this.deps.orderRepo.findById(event.orderId);
    if (!order || order.side !== "buy" || !isEntryReason(order.signalReason)) return;
    const market = this.getMarket(order.tokenId);
    if (!market) return;
    const priorCount = this.getRepriceCount(order.signalId ?? null);
    const policy = this.deps.policy().repriceOnOutbid;
    if (!policy.enabled || priorCount >= policy.maxRepriceCount) return;

    const signal = this.buildRepriceSignal(order, market, priorCount + 1, event.timestamp);
    if (!signal) return;
    this.repriceCountBySignalId.set(signal.signalId, priorCount + 1);
    this.repricedSignalIds.add(signal.signalId);
    this.metrics.outbidRepriceSignals++;
    this.writeMetrics(event.timestamp);
    await this.publishSignal(signal, market);
  }

  private async handleFillReceived(event: RuntimeEventMap["FillReceived"]): Promise<void> {
    if (event.side !== "buy") return;
    if (event.signalId && this.repricedSignalIds.has(event.signalId)) {
      this.metrics.outbidRepriceFills++;
    }
    const ladderStep = event.signalId ? this.ladderSignalSteps.get(event.signalId) : undefined;
    if (ladderStep != null) {
      this.metrics.ladderFills++;
      increment(this.metrics.ladderFillsByStep, String(ladderStep));
      const state = this.ensureLadderState(
        event.tokenId,
        event.price,
        this.resolveAnchorForFill(event),
      );
      state.filledSteps++;
    }
    if (!isLadderEligibleFill(event)) {
      this.writeMetrics(event.timestamp);
      return;
    }
    this.scheduleNextLadderBuy(event);
    this.writeMetrics(event.timestamp);
  }

  private async handleSignalConversionSkipped(
    event: RuntimeEventMap["SignalConversionSkipped"],
  ): Promise<void> {
    if (!this.ladderSignalSteps.has(event.signal.signalId)) return;
    if (!event.reasons.includes("same-price-cooldown")) return;
    this.metrics.ladderCooldownPaused++;
    this.scheduleLadderRetryAfterCooldown(event);
    this.writeMetrics(event.skippedAt);
  }

  private async handleMarketUpdated(
    event: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of event.markets) {
      const key = String(market.tokenId);
      if (market.active) {
        this.marketCache.set(key, market);
      } else {
        this.marketCache.delete(key);
      }
    }
  }

  private async handleTrackedMarketsChanged(
    event: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    for (const tokenId of event.removedTokenIds) this.marketCache.delete(String(tokenId));
  }

  private async handlePositionUpdated(event: RuntimeEventMap["PositionUpdated"]): Promise<void> {
    if (event.position.status !== "closed" && event.position.size > 0) return;
    this.resetToken(event.position.tokenId, "position_closed");
  }

  private async handleMarketResolved(event: RuntimeEventMap["MarketResolvedHint"]): Promise<void> {
    for (const tokenId of event.tokenIds) this.resetToken(tokenId, "market_resolved");
  }

  private scheduleNextLadderBuy(event: RuntimeEventMap["FillReceived"]): void {
    const policy = this.deps.policy().multiBuyLadder;
    if (!policy.enabled) return;
    const tokenKey = String(event.tokenId);
    if (this.ladderTimers.has(tokenKey)) return;
    this.ensureLadderState(event.tokenId, event.price, this.resolveAnchorForFill(event));
    const decision = this.evaluateLadderReadiness(event.tokenId, event.price, policy);
    if (!decision.allowed) {
      this.recordLadderStop(decision.reason);
      return;
    }
    const timer = this.setTimer(() => {
      this.ladderTimers.delete(tokenKey);
      this.fireLadderBuy(event.tokenId).catch((err) =>
        this.log.error({ err, tokenId: tokenKey }, "multi-buy ladder fire failed"),
      );
    }, policy.ladderGapMs);
    this.ladderTimers.set(tokenKey, timer);
  }

  private scheduleLadderRetryAfterCooldown(
    event: RuntimeEventMap["SignalConversionSkipped"],
  ): void {
    const policy = this.deps.policy().multiBuyLadder;
    if (!policy.enabled) return;
    const tokenKey = String(event.signal.tokenId);
    if (this.ladderTimers.has(tokenKey)) return;
    const cooldownUntil = numericDiagnostic(event.diagnostics.cooldownUntilTsUtc);
    const now = this.now();
    const cooldownDelay = cooldownUntil != null ? Math.max(cooldownUntil - now, 0) : 0;
    const delayMs = Math.max(policy.ladderGapMs, cooldownDelay);
    const timer = this.setTimer(() => {
      this.ladderTimers.delete(tokenKey);
      this.fireLadderBuy(event.signal.tokenId).catch((err) =>
        this.log.error({ err, tokenId: tokenKey }, "multi-buy ladder cooldown retry failed"),
      );
    }, delayMs);
    this.ladderTimers.set(tokenKey, timer);
  }

  private async fireLadderBuy(tokenId: TokenId): Promise<void> {
    if (!this.started) return;
    const now = this.now();
    const policy = this.deps.policy().multiBuyLadder;
    if (!policy.enabled) return;
    const readiness = this.evaluateLadderReadiness(tokenId, null, policy);
    if (!readiness.allowed) {
      this.recordLadderStop(readiness.reason);
      this.writeMetrics(now);
      return;
    }
    const market = readiness.market;
    const price = readiness.ladderTargetPrice;
    if (price == null || price <= 0 || !Number.isFinite(price)) {
      this.recordLadderStop("price_unavailable");
      this.writeMetrics(now);
      return;
    }
    const legState = this.deps.legStateRepo.get(tokenId);
    const buyFills = this.buyFills(tokenId);
    const buyCount = legState?.buyCount ?? buyFills.length;
    const state = deriveState(legState);
    const sizeResult = evaluateSize(
      "BUY",
      { state, price, nthBuy: buyCount + 1, buyCount },
      this.deps.algoRulesRepo.getSizeRules("BUY"),
    );
    // Ladder steps are new strategy attempts, not replacements of one existing order;
    // use a fresh signal id so the bridge/client-order-id dedupe treats each step independently.
    const signalId = randomUUID();
    const reason = resolveSignalReason("buy", buyCount);
    const suggestedSizeUsdc = sizeResult.sizeUsdc;
    const signal: Signal = {
      signalId,
      tokenId,
      conditionId: createConditionId(market.conditionId),
      side: "buy",
      suggestedPrice: price,
      ladderTargetPrice: price,
      suggestedSize: suggestedSizeUsdc / price,
      suggestedSizeUsdc,
      reason,
      strategyTick: now,
      sequenceInTick: 0,
      decisionRuleId: "LADDER",
      sizingRuleId: sizeResult.ruleId,
      generatedAt: new Date(now).toISOString(),
    };
    const stateForToken = this.ensureLadderState(
      tokenId,
      buyFills[0]?.price ?? price,
      this.resolveCurrentAnchorMs(tokenId) ?? now - 1,
    );
    stateForToken.attemptedSteps++;
    const step = stateForToken.attemptedSteps;
    this.ladderSignalSteps.set(signalId, step);
    this.metrics.ladderSignals++;
    increment(this.metrics.ladderSignalsByStep, String(step));
    this.writeMetrics(now);
    await this.publishSignal(signal, market);
  }

  private evaluateLadderReadiness(
    tokenId: TokenId,
    fallbackFirstPrice: number | null,
    policy: MultiBuyLadderPolicy,
  ):
    | { allowed: true; market: NormalizedMarket; ladderTargetPrice: number }
    | { allowed: false; reason: string } {
    const market = this.getMarket(tokenId);
    if (!market) return { allowed: false, reason: "market_missing" };
    if (!canPlaceBuyOrderForMarket(market, this.now()).allowed) {
      return { allowed: false, reason: "market_not_buyable" };
    }
    const buyFills = this.buyFills(tokenId);
    const existingState = this.ladderStateByToken.get(String(tokenId));
    const firstFillPrice =
      buyFills[0]?.price ?? fallbackFirstPrice ?? existingState?.firstFillPrice;
    if (firstFillPrice == null || !Number.isFinite(firstFillPrice) || firstFillPrice <= 0) {
      return { allowed: false, reason: "price_unavailable" };
    }
    const totalUsdc = buyFills.reduce((sum, fill) => sum + fill.sizeUsdc, 0);
    if (buyFills.length >= policy.maxLadderFillsPerToken) {
      return { allowed: false, reason: "max_ladder_fills" };
    }
    if (totalUsdc >= policy.perTokenUsdcCap) return { allowed: false, reason: "per_token_cap" };
    const currentPrice = market.bestBid ?? market.midPrice;
    // R55 treats >=5 ticks away from the first fill as a new regime in either direction.
    if (
      currentPrice != null &&
      Number.isFinite(currentPrice) &&
      Number.isFinite(market.tickSize) &&
      market.tickSize > 0 &&
      Math.abs(currentPrice - firstFillPrice) >=
        policy.maxPriceDriftTicks * market.tickSize - EPSILON
    ) {
      return { allowed: false, reason: "price_drift" };
    }
    const state = this.ensureLadderState(
      tokenId,
      firstFillPrice ?? currentPrice ?? 0,
      this.resolveCurrentAnchorMs(tokenId) ?? this.now() - 1,
    );
    if (state.attemptedSteps >= 3) {
      const fillRate = state.filledSteps / state.attemptedSteps;
      if (fillRate < policy.minStepFillRate) return { allowed: false, reason: "low_fill_rate" };
    }
    return { allowed: true, market, ladderTargetPrice: firstFillPrice };
  }

  private buildRepriceSignal(
    order: Order,
    market: NormalizedMarket,
    repriceCount: number,
    nowMs: number,
  ): Signal | null {
    const price = market.bestBid ?? order.price;
    const remainingSize = this.remainingOrderSize(order);
    if (!isExecutableRemainingSize(remainingSize, market.minOrderSize)) {
      this.log.info(
        {
          orderId: String(order.orderId),
          tokenId: String(order.tokenId),
          remainingSize,
          minOrderSize: market.minOrderSize ?? null,
        },
        "outbid reprice skipped — remaining order size below exchange minimum",
      );
      return null;
    }
    const suggestedSizeUsdc = remainingSize * price;
    return {
      signalId: buildRepriceSignalId(repriceCount),
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      side: "buy",
      suggestedPrice: price,
      suggestedSize: remainingSize,
      suggestedSizeUsdc,
      reason: order.signalReason as SignalReasonType,
      strategyTick: nowMs,
      sequenceInTick: repriceCount,
      decisionRuleId: "OUTBID_REPRICE",
      sizingRuleId: null,
      generatedAt: new Date(nowMs).toISOString(),
    };
  }

  private async publishSignal(signal: Signal, market: NormalizedMarket): Promise<void> {
    await this.deps.bus.publish("SignalProduced", { signal, market });
  }

  private remainingOrderSize(order: Order): number {
    const filledSize = this.deps.fillRepo
      .findByOrderId(order.orderId)
      .filter((fill) => fill.side === order.side)
      .reduce((sum, fill) => sum + fill.size, 0);
    return Math.max(order.size - filledSize, 0);
  }

  private buyFills(tokenId: TokenId): Fill[] {
    const anchorMs = this.resolveCurrentAnchorMs(tokenId);
    return this.deps.fillRepo
      .findByTokenId(tokenId)
      .filter((fill) => fill.side === "buy")
      .filter((fill) => anchorMs == null || Date.parse(fill.filledAt) >= anchorMs)
      .sort((a, b) => Date.parse(a.filledAt) - Date.parse(b.filledAt));
  }

  private ensureLadderState(
    tokenId: TokenId,
    firstFillPrice: number,
    anchorMs: number,
  ): LadderState {
    const key = String(tokenId);
    let state = this.ladderStateByToken.get(key);
    if (!state) {
      state = { attemptedSteps: 0, filledSteps: 0, firstFillPrice, anchorMs };
      this.ladderStateByToken.set(key, state);
    }
    return state;
  }

  private resolveAnchorForFill(event: RuntimeEventMap["FillReceived"]): number {
    return this.resolveCurrentAnchorMs(event.tokenId, event.timestamp) ?? event.timestamp - 1;
  }

  private resolveCurrentAnchorMs(
    tokenId: TokenId,
    beforeOrAtMs = Number.POSITIVE_INFINITY,
  ): number | null {
    const key = String(tokenId);
    const anchors = [
      this.ladderStateByToken.get(key)?.anchorMs,
      this.ladderResetAnchorByToken.get(key),
      parseOptionalIsoMs(this.deps.legStateRepo.get(tokenId)?.firstTradeAt),
    ].filter((value): value is number => value != null && value <= beforeOrAtMs);
    return anchors.length > 0 ? Math.max(...anchors) : null;
  }

  private resetToken(tokenId: TokenId, reason: string): void {
    const key = String(tokenId);
    const timer = this.ladderTimers.get(key);
    if (timer) this.clearTimer(timer);
    this.ladderTimers.delete(key);
    this.ladderStateByToken.delete(key);
    this.ladderResetAnchorByToken.set(key, this.now());
    this.recordLadderStop(reason);
    this.writeMetrics(this.now());
  }

  private recordLadderStop(reason: string): void {
    increment(this.metrics.ladderStopped, reason);
  }

  private writeMetrics(nowMs: number): void {
    this.deps.runtimeMetrics?.writeLatest(
      "entry_lifecycle_activity",
      this.metrics.outbidRepriceSignals + this.metrics.ladderSignals,
      JSON.stringify({ ...this.metrics, capturedAt: new Date(nowMs).toISOString() }),
      new Date(nowMs).toISOString(),
    );
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private setTimer(fn: () => void, delayMs: number): TimerHandle {
    return this.deps.setTimer ? this.deps.setTimer(fn, delayMs) : setTimeout(fn, delayMs);
  }

  private clearTimer(handle: TimerHandle): void {
    if (this.deps.clearTimer) {
      this.deps.clearTimer(handle);
      return;
    }
    clearTimeout(handle);
  }
}

function createMetrics(): EntryLifecycleMetrics {
  return {
    outbidRepriceCancels: 0,
    outbidRepriceSignals: 0,
    outbidRepriceFills: 0,
    ladderSignals: 0,
    ladderFills: 0,
    ladderCooldownPaused: 0,
    ladderStopped: {},
    ladderSignalsByStep: {},
    ladderFillsByStep: {},
  };
}

function isEntryReason(reason: string | null): reason is SignalReasonType {
  return reason != null && ENTRY_REASONS.has(reason);
}

function isLadderEligibleFill(event: RuntimeEventMap["FillReceived"]): boolean {
  return event.signalId != null && isEntryReason(event.signalReason);
}

function buildRepriceSignalId(repriceCount: number): string {
  return `${OUTBID_REPRICE_SIGNAL_PREFIX}:${repriceCount}:${randomUUID()}`;
}

function parseRepriceCount(signalId: string): number {
  const match = new RegExp(`^${OUTBID_REPRICE_SIGNAL_PREFIX}:(\\d+):`).exec(signalId);
  if (!match) return 0;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function parseOptionalIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isExecutableRemainingSize(size: number, minOrderSize: number | null | undefined): boolean {
  if (!Number.isFinite(size) || size <= EPSILON) return false;
  if (minOrderSize == null || !Number.isFinite(minOrderSize) || minOrderSize <= 0) return true;
  return size + EPSILON >= minOrderSize;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function numericDiagnostic(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
