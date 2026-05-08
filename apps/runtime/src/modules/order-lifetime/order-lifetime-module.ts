import type {
  AlgoTokenModeState,
  AlgoTokenModeStateRepository,
  EventBus,
  FillRepository,
  Market,
  MarketRepository,
  Order,
  OrderRepository,
  OrderLifetimePolicy,
  PositionRepository,
  RiskEventRepository,
  RuntimeEventMap,
  RuntimeModule,
  TokenId,
} from "@plankton/domain";
import { EXIT_REASONS, createConditionId, createTokenId } from "@plankton/domain";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { Logger } from "../../logger.js";
import {
  advanceOrderLifetimeTtlStage,
  classifyOrderLifetimeMode,
} from "./order-lifetime-classifier.js";
import { resolveExitOrderLifetime, type ExitOrderLifetimeDecision } from "./order-lifetime-ttl.js";

const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const METRIC_FLUSH_INTERVAL_MS = 60_000;
const MODE_WINDOW_LIMIT = 10;
const BURST_SUBMIT_WINDOW_MS = 60_000;

export interface OrderLifetimeModuleDeps {
  bus: EventBus;
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  positionRepo: PositionRepository;
  modeStateRepo: AlgoTokenModeStateRepository;
  riskEventRepo: RiskEventRepository;
  runtimeMetrics: RuntimeMetricWriter;
  policy: () => OrderLifetimePolicy;
  log: Logger;
  maintenanceIntervalMs?: number;
}

export interface OrderLifetimePlacementDecision {
  allowed: boolean;
  reason: string | null;
  mode: AlgoTokenModeState["mode"] | null;
  budgetPerMinute: number | null;
  remainingBudget: number | null;
}

export class OrderLifetimeModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastMaintenanceAt: number | null = null;
  private lastMetricFlushAt = 0;
  private metricsWindow = createMetricsWindow(Date.now());
  private readonly burstSubmitTimestampsMs: number[] = [];
  private readonly suppressedTransitionEventKeys = new Set<string>();

  constructor(private readonly deps: OrderLifetimeModuleDeps) {
    this.log = deps.log.child({ module: "order-lifetime" });
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("FillReceived", (event) => this.handleFillReceived(event)),
      this.deps.bus.subscribe("OrderPlaced", (event) => this.handleOrderPlaced(event)),
      this.deps.bus.subscribe("OrderCancelled", (event) => this.handleOrderCancelled(event)),
      this.deps.bus.subscribe("PositionUpdated", (event) => this.handlePositionUpdated(event)),
      this.deps.bus.subscribe("MarketResolved", (event) => this.handleMarketResolved(event)),
    );
    this.seedRecentExitSubmits(Date.now());
    await this.refreshActiveTokenStates(Date.now());
    this.timer = setInterval(() => {
      this.refreshActiveTokenStates(Date.now()).catch((err) =>
        this.log.error({ err }, "order lifetime maintenance failed"),
      );
    }, this.deps.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS);
    this.timer.unref();
    this.started = true;
    this.log.info(
      { enforcement: this.deps.policy().enforcement, enabled: this.deps.policy().enabled },
      "order lifetime module started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;
    this.flushMetrics(Date.now(), true);
    this.started = false;
    this.log.info("order lifetime module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) return { ok: false, detail: "not started" };
    const policy = this.deps.policy();
    return {
      ok: true,
      detail: `enabled=${policy.enabled} enforcement=${policy.enforcement} lastMaintenance=${this.lastMaintenanceAt ?? "never"}`,
    };
  }

  resolveExitOrder(
    order: Pick<Order, "createdAt" | "orderId" | "tokenId">,
    market: Pick<Market, "endDate"> | null,
    flatTtlMs: number,
    nowMs: number,
  ): ExitOrderLifetimeDecision {
    const policy = this.deps.policy();
    let decision = resolveExitOrderLifetime({
      order,
      market,
      modeState: this.getModeState(order.tokenId),
      policy,
      flatTtlMs,
      nowMs,
    });
    if (shouldHoldForBurstRateLimit(decision, policy, this.burstSubmitTimestampsMs, nowMs)) {
      decision = {
        ...decision,
        rateLimited: true,
        wouldCancelUnderMode: false,
        cancelReason: null,
      };
    }
    this.recordLifetimeDecision(decision, nowMs);
    return decision;
  }

  canPlaceExitOrder(tokenId: TokenId, nowMs: number): OrderLifetimePlacementDecision {
    const policy = this.deps.policy();
    if (!policy.enabled || policy.enforcement !== "enforce") {
      return {
        allowed: true,
        reason: null,
        mode: null,
        budgetPerMinute: null,
        remainingBudget: null,
      };
    }

    const state = this.getModeState(tokenId);
    if (state?.mode !== "BURST") {
      return {
        allowed: true,
        reason: null,
        mode: state?.mode ?? null,
        budgetPerMinute: null,
        remainingBudget: null,
      };
    }

    pruneBurstSubmitTimestamps(this.burstSubmitTimestampsMs, nowMs);
    const remainingBudget =
      policy.relayerSubmitBudgetPerMinute - this.burstSubmitTimestampsMs.length;
    if (remainingBudget > 0) {
      return {
        allowed: true,
        reason: null,
        mode: "BURST",
        budgetPerMinute: policy.relayerSubmitBudgetPerMinute,
        remainingBudget,
      };
    }

    this.metricsWindow.rateLimited++;
    this.metricsWindow.byReason.order_lifetime_burst_rate_limit =
      (this.metricsWindow.byReason.order_lifetime_burst_rate_limit ?? 0) + 1;
    this.flushMetrics(nowMs, false);
    return {
      allowed: false,
      reason: "order-lifetime-burst-rate-limit",
      mode: "BURST",
      budgetPerMinute: policy.relayerSubmitBudgetPerMinute,
      remainingBudget: 0,
    };
  }

  async refreshActiveTokenStates(nowMs: number): Promise<void> {
    const tokenIds = this.collectActiveTokenIds();
    for (const tokenId of tokenIds) this.refreshTokenState(tokenId, nowMs);
    this.lastMaintenanceAt = nowMs;
    this.writeModeDistribution(nowMs);
    this.flushMetrics(nowMs, false);
  }

  private async handleFillReceived(event: RuntimeEventMap["FillReceived"]): Promise<void> {
    this.refreshTokenState(event.tokenId, event.timestamp);
  }

  private async handleOrderPlaced(event: RuntimeEventMap["OrderPlaced"]): Promise<void> {
    if (!EXIT_REASONS.has(event.signalReason ?? "")) return;
    const state = this.getModeState(event.tokenId);
    if (state?.mode === "BURST") {
      this.recordBurstSubmit(event.timestamp);
    }
    this.recordExitOrderState(event);
  }

  private async handleOrderCancelled(event: RuntimeEventMap["OrderCancelled"]): Promise<void> {
    if (event.reason !== "stale_exit_ttl") return;
    const existing = this.getModeState(event.tokenId);
    if (!existing) return;
    const next = advanceOrderLifetimeTtlStage(existing, this.deps.policy(), event.timestamp);
    this.deps.modeStateRepo.upsert(next);
    this.recordStaleCancel(next.mode);
  }

  private async handlePositionUpdated(event: RuntimeEventMap["PositionUpdated"]): Promise<void> {
    if (event.position.status !== "closed") return;
    this.resetToken(event.position.tokenId, "position_closed", Date.now());
  }

  private async handleMarketResolved(event: RuntimeEventMap["MarketResolved"]): Promise<void> {
    for (const tokenId of event.tokenIds) {
      this.resetToken(tokenId, "market_resolved", event.timestamp);
    }
  }

  private refreshTokenState(tokenId: TokenId, nowMs: number): void {
    const snapshot = this.buildTokenSnapshot(tokenId);
    if (!snapshot) return;
    const previous = this.getModeState(tokenId);
    const result = classifyOrderLifetimeMode({
      ...snapshot,
      previous,
      policy: this.deps.policy(),
      nowMs,
    });
    this.deps.modeStateRepo.upsert(result.state);
    if (result.transitioned)
      this.logModeTransition(previous, result.state, result.transitionReason);
  }

  private resetToken(tokenId: TokenId, reason: string, nowMs: number): void {
    const snapshot = this.buildTokenSnapshot(tokenId);
    const previous = this.readModeState(tokenId);
    const conditionId = snapshot?.conditionId ?? previous?.conditionId;
    if (!conditionId) return;
    const nowIso = new Date(nowMs).toISOString();
    const state: AlgoTokenModeState = {
      tokenId,
      conditionId,
      outcomeIndex: snapshot?.outcomeIndex ?? previous?.outcomeIndex ?? null,
      mode: "PASSIVE",
      modeConfidence: "low",
      modeStatus: "confirmed",
      modeSince: nowIso,
      modeAssessedAt: nowIso,
      ttlStage: 0,
      lastFillAt: snapshot?.fills.at(-1)?.filledAt ?? previous?.lastFillAt ?? null,
      lastOrderAt: snapshot?.orders.at(-1)?.createdAt ?? previous?.lastOrderAt ?? null,
      lastStaleCancelAt: previous?.lastStaleCancelAt ?? null,
      fillCountWindow: snapshot?.fills.length ?? previous?.fillCountWindow ?? 0,
      orderCountWindow: snapshot?.orders.length ?? previous?.orderCountWindow ?? 0,
      firstFillLatencyMs: previous?.firstFillLatencyMs ?? null,
      medianGapMs: previous?.medianGapMs ?? null,
      p75GapMs: previous?.p75GapMs ?? null,
      spanMs: previous?.spanMs ?? null,
      lastFillTimestampsJson: previous?.lastFillTimestampsJson ?? null,
      transitionCountDay: previous?.transitionCountDay ?? 0,
      transitionDay: previous?.transitionDay ?? nowIso.slice(0, 10),
      resetReason: reason,
      updatedAt: nowIso,
    };
    this.deps.modeStateRepo.upsert(state);
    if (previous && previous.mode !== state.mode) this.logModeTransition(previous, state, reason);
  }

  private buildTokenSnapshot(tokenId: TokenId): {
    tokenId: TokenId;
    conditionId: import("@plankton/domain").ConditionId;
    outcomeIndex: number | null;
    fills: ReturnType<FillRepository["findByTokenId"]>;
    orders: ReturnType<OrderRepository["findByTokenId"]>;
    market: Market | null;
  } | null {
    const market = this.deps.marketRepo.findByTokenId(tokenId);
    const fills = this.findRecentFills(tokenId);
    const orders = this.findOrderWindow(tokenId);
    const previous = this.readModeState(tokenId);
    const conditionId = market?.conditionId ?? orders[0]?.conditionId ?? fills[0]?.conditionId;
    if (!conditionId && !previous) return null;
    return {
      tokenId,
      conditionId:
        previous?.conditionId ?? createConditionId(String(conditionId ?? previous?.conditionId)),
      outcomeIndex: market?.outcomeIndex ?? previous?.outcomeIndex ?? null,
      fills: sortByIso(fills, (fill) => fill.filledAt),
      orders: sortByIso(orders, (order) => order.createdAt),
      market,
    };
  }

  private findRecentFills(tokenId: TokenId): ReturnType<FillRepository["findByTokenId"]> {
    return (
      this.deps.fillRepo.findRecentByTokenId?.(tokenId, MODE_WINDOW_LIMIT) ??
      this.deps.fillRepo.findByTokenId(tokenId)
    );
  }

  private findOrderWindow(tokenId: TokenId): ReturnType<OrderRepository["findByTokenId"]> {
    const recent =
      this.deps.orderRepo.findRecentByTokenId?.(tokenId, MODE_WINDOW_LIMIT) ??
      this.deps.orderRepo.findByTokenId(tokenId);
    const first = this.deps.orderRepo.findFirstByTokenId?.(tokenId) ?? null;
    if (!first || recent.some((order) => order.orderId === first.orderId)) return recent;
    return [first, ...recent];
  }

  private recordExitOrderState(event: RuntimeEventMap["OrderPlaced"]): void {
    const nowIso = new Date(event.timestamp).toISOString();
    const existing = this.getModeState(event.tokenId);
    if (existing) {
      this.deps.modeStateRepo.upsert({
        ...existing,
        lastOrderAt: nowIso,
        orderCountWindow: Math.max(0, existing.orderCountWindow) + 1,
        updatedAt: nowIso,
      });
      return;
    }

    const market = this.deps.marketRepo.findByTokenId(event.tokenId);
    this.deps.modeStateRepo.upsert({
      tokenId: event.tokenId,
      conditionId: event.conditionId,
      outcomeIndex: market?.outcomeIndex ?? null,
      mode: "PASSIVE",
      modeConfidence: "low",
      modeStatus: "confirmed",
      modeSince: nowIso,
      modeAssessedAt: nowIso,
      ttlStage: 0,
      lastFillAt: null,
      lastOrderAt: nowIso,
      lastStaleCancelAt: null,
      fillCountWindow: 0,
      orderCountWindow: 1,
      firstFillLatencyMs: null,
      medianGapMs: null,
      p75GapMs: null,
      spanMs: null,
      lastFillTimestampsJson: null,
      transitionCountDay: 0,
      transitionDay: nowIso.slice(0, 10),
      resetReason: "exit_order_placed",
      updatedAt: nowIso,
    });
  }

  private collectActiveTokenIds(): TokenId[] {
    const tokenIds = new Set<string>();
    for (const position of this.deps.positionRepo.findOpen())
      tokenIds.add(String(position.tokenId));
    for (const order of this.deps.orderRepo.findOpen()) tokenIds.add(String(order.tokenId));
    for (const state of this.deps.modeStateRepo.findAll()) {
      if (isValidModeState(state)) tokenIds.add(String(state.tokenId));
      else this.recordCorruptModeState(state.tokenId, "find_all_invalid_mode_state");
    }
    return [...tokenIds].map(createTokenId);
  }

  private logModeTransition(
    previous: AlgoTokenModeState | null,
    state: AlgoTokenModeState,
    reason: string,
  ): void {
    const policy = this.deps.policy();
    if (
      state.mode !== "BURST" &&
      state.transitionCountDay > policy.maxTransitionEventsPerTokenPerDay
    ) {
      this.metricsWindow.transitionEventsSuppressed++;
      this.logSuppressedTransition(previous, state, reason);
      return;
    }
    this.deps.riskEventRepo.insert({
      eventType: "order_lifetime_mode_transition",
      payload: {
        tokenId: String(state.tokenId),
        conditionId: String(state.conditionId),
        fromMode: previous?.mode ?? null,
        toMode: state.mode,
        fromStatus: previous?.modeStatus ?? null,
        toStatus: state.modeStatus,
        confidence: state.modeConfidence,
        reason,
        fillCountWindow: state.fillCountWindow,
        medianGapMs: state.medianGapMs,
        p75GapMs: state.p75GapMs,
        spanMs: state.spanMs,
        transitionCountDay: state.transitionCountDay,
        modeAssessedAt: state.modeAssessedAt,
      },
    });
  }

  private logSuppressedTransition(
    previous: AlgoTokenModeState | null,
    state: AlgoTokenModeState,
    reason: string,
  ): void {
    const day = state.transitionDay ?? state.modeAssessedAt.slice(0, 10);
    const key = `${String(state.tokenId)}:${day}`;
    if (this.suppressedTransitionEventKeys.has(key)) return;
    this.suppressedTransitionEventKeys.add(key);
    this.deps.riskEventRepo.insert({
      eventType: "order_lifetime_transition_storm_suppressed",
      payload: {
        tokenId: String(state.tokenId),
        conditionId: String(state.conditionId),
        fromMode: previous?.mode ?? null,
        toMode: state.mode,
        reason,
        transitionCountDay: state.transitionCountDay,
        modeAssessedAt: state.modeAssessedAt,
      },
    });
  }

  private writeModeDistribution(nowMs: number): void {
    const states = this.deps.modeStateRepo.findAll().filter((state) => isValidModeState(state));
    const byMode = countBy(states, (state) => state.mode);
    const byConfidence = countBy(states, (state) => `${state.mode}:${state.modeConfidence}`);
    const candidateCount = states.filter((state) => state.modeStatus === "candidate").length;
    this.deps.runtimeMetrics.writeLatest(
      "order_lifetime_mode_distribution",
      states.length,
      JSON.stringify({
        total: states.length,
        byMode,
        byConfidence,
        candidateCount,
        capturedAt: new Date(nowMs).toISOString(),
      }),
      new Date(nowMs).toISOString(),
    );
  }

  private recordLifetimeDecision(decision: ExitOrderLifetimeDecision, nowMs: number): void {
    const key = decision.mode;
    this.metricsWindow.decisions++;
    this.metricsWindow.byMode[key] = (this.metricsWindow.byMode[key] ?? 0) + 1;
    if (decision.wouldCancelUnderMode) this.metricsWindow.wouldCancelUnderMode++;
    if (decision.wouldCancelUnderFlat) this.metricsWindow.wouldCancelUnderFlat++;
    if (decision.resolutionCapApplied) this.metricsWindow.resolutionCapApplied++;
    if (decision.rateLimited) this.metricsWindow.rateLimited++;
    if (decision.cancelReason) {
      this.metricsWindow.byReason[decision.cancelReason] =
        (this.metricsWindow.byReason[decision.cancelReason] ?? 0) + 1;
    }
    this.flushMetrics(nowMs, false);
  }

  private recordStaleCancel(mode: AlgoTokenModeState["mode"]): void {
    this.metricsWindow.staleExitCancelByMode[mode] =
      (this.metricsWindow.staleExitCancelByMode[mode] ?? 0) + 1;
  }

  private flushMetrics(nowMs: number, force: boolean): void {
    if (!force && nowMs - this.lastMetricFlushAt < METRIC_FLUSH_INTERVAL_MS) return;
    this.lastMetricFlushAt = nowMs;
    this.deps.runtimeMetrics.writeLatest(
      "order_lifetime_ttl_activity",
      this.metricsWindow.decisions,
      JSON.stringify({
        ...this.metricsWindow,
        windowEndMs: nowMs,
        policy: {
          enabled: this.deps.policy().enabled,
          enforcement: this.deps.policy().enforcement,
        },
      }),
      new Date(nowMs).toISOString(),
    );
    this.metricsWindow = createMetricsWindow(nowMs);
  }

  private getModeState(tokenId: TokenId): AlgoTokenModeState | null {
    const state = this.readModeState(tokenId);
    if (!state) return null;
    if (isValidModeState(state)) return state;
    this.recordCorruptModeState(tokenId, "invalid_mode_state");
    this.resetToken(tokenId, "corrupt_mode_state", Date.now());
    return null;
  }

  private readModeState(tokenId: TokenId): AlgoTokenModeState | null {
    return this.deps.modeStateRepo.get(tokenId);
  }

  private recordCorruptModeState(tokenId: TokenId, reason: string): void {
    this.deps.riskEventRepo.insert({
      eventType: "order_lifetime_corrupt_mode_state",
      payload: { tokenId: String(tokenId), reason, observedAt: new Date().toISOString() },
    });
  }

  private recordBurstSubmit(nowMs: number): void {
    pruneBurstSubmitTimestamps(this.burstSubmitTimestampsMs, nowMs);
    this.burstSubmitTimestampsMs.push(nowMs);
  }

  private seedRecentExitSubmits(nowMs: number): void {
    const sinceIso = new Date(nowMs - BURST_SUBMIT_WINDOW_MS).toISOString();
    const recentOrders = this.deps.orderRepo.findRecentBySignalReasons?.(
      [...EXIT_REASONS],
      sinceIso,
      this.deps.policy().relayerSubmitBudgetPerMinute,
    );
    if (!recentOrders) return;
    this.burstSubmitTimestampsMs.length = 0;
    for (const order of recentOrders) {
      const createdAtMs = Date.parse(order.createdAt);
      if (Number.isFinite(createdAtMs)) this.burstSubmitTimestampsMs.push(createdAtMs);
    }
    this.burstSubmitTimestampsMs.sort((a, b) => a - b);
  }
}

function createMetricsWindow(startMs: number): {
  windowStartMs: number;
  decisions: number;
  wouldCancelUnderMode: number;
  wouldCancelUnderFlat: number;
  resolutionCapApplied: number;
  rateLimited: number;
  transitionEventsSuppressed: number;
  byMode: Record<string, number>;
  byReason: Record<string, number>;
  staleExitCancelByMode: Record<string, number>;
} {
  return {
    windowStartMs: startMs,
    decisions: 0,
    wouldCancelUnderMode: 0,
    wouldCancelUnderFlat: 0,
    resolutionCapApplied: 0,
    rateLimited: 0,
    transitionEventsSuppressed: 0,
    byMode: {},
    byReason: {},
    staleExitCancelByMode: {},
  };
}

export function shouldHoldForBurstRateLimit(
  decision: ExitOrderLifetimeDecision,
  policy: OrderLifetimePolicy,
  timestampsMs: number[],
  nowMs: number,
): boolean {
  if (!policy.enabled || policy.enforcement !== "enforce") return false;
  if (decision.mode !== "BURST" || !decision.wouldCancelUnderMode) return false;
  pruneBurstSubmitTimestamps(timestampsMs, nowMs);
  return timestampsMs.length >= policy.relayerSubmitBudgetPerMinute;
}

function pruneBurstSubmitTimestamps(timestampsMs: number[], nowMs: number): void {
  const cutoff = nowMs - BURST_SUBMIT_WINDOW_MS;
  while (timestampsMs[0] != null && timestampsMs[0] < cutoff) timestampsMs.shift();
}

function isValidModeState(state: AlgoTokenModeState): boolean {
  return (
    ["PASSIVE", "MIDDLE", "BURST"].includes(state.mode) &&
    ["low", "medium", "high"].includes(state.modeConfidence) &&
    ["candidate", "confirmed"].includes(state.modeStatus) &&
    Number.isInteger(state.ttlStage) &&
    state.ttlStage >= 0 &&
    Number.isInteger(state.transitionCountDay) &&
    state.transitionCountDay >= 0 &&
    nonNegativeOrNull(state.firstFillLatencyMs) &&
    nonNegativeOrNull(state.medianGapMs) &&
    nonNegativeOrNull(state.p75GapMs) &&
    nonNegativeOrNull(state.spanMs)
  );
}

function nonNegativeOrNull(value: number | null): boolean {
  return value == null || (Number.isFinite(value) && value >= 0);
}

function sortByIso<T>(items: readonly T[], getIso: (item: T) => string): T[] {
  return [...items].sort((a, b) => Date.parse(getIso(a)) - Date.parse(getIso(b)));
}

function countBy<T>(items: readonly T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
