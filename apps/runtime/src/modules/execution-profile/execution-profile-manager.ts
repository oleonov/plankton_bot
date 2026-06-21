import {
  OrderStatus,
  applyStockCloseTailSizeDamp,
  DEFAULT_BUY_GUARDS_POLICY,
  evaluateD3NearDeathGuard,
  evaluatePostSellBuybackGuard,
  type CapDecision,
  type BuyGuardsPolicy,
  type PostSellBuybackGuardSignals,
  S1_LADDER_RULE_ID,
  SignalReason,
  type EventBus,
  type NormalizedMarket,
  type Order,
  type OrderRepository,
  type Position,
  type PositionRepository,
  type RiskEventRepository,
  type RuntimeEventMap,
  type RuntimeModule,
  type ScaleInDecision,
  type ScaleInConfig,
  type ScaleInMarketSignals,
  type ScaleInMode,
  type ScaleInReason,
  type SignalSnapshot,
  type TokenId,
} from "@krabs/domain";

import { AbandonmentManager } from "./abandonment-manager.js";
import { decideCostCap } from "./cost-cap-enforcer.js";
import type { EffectiveResolutionGate } from "../../effective-resolution-service.js";
import type { ExecutionProfileAnomalyDetector } from "./execution-profile-anomaly-detector.js";
import type { ExecutionProfileHealthChecker } from "./execution-profile-health-checker.js";
import {
  EXECUTION_PROFILE_METRICS,
  EXECUTION_PROFILE_RISK_EVENTS,
  writeExecutionProfileCounter,
  type ExecutionProfileLabels,
} from "./execution-profile-metrics.js";
import type { ExecutionProfileRollup } from "./execution-profile-rollup.js";
import { InMemoryProfileOwnershipReader } from "./profile-ownership-reader.js";
import { resolveProfile } from "./profile-resolver.js";
import { reduceProfileState } from "./profile-state-reducer.js";
import { createStubScaleInSignalSource, type ScaleInSignalSource } from "./signal-feed-stub.js";
import { decideScaleIn, EXECUTION_PROFILE_SCALE_IN_RULE_ID } from "./scale-in-decider.js";
import { isExecutableOrderSize } from "../../min-order-size.js";
import type {
  ExecutionProfilePolicy,
  ExecutionProfileStateRecord,
  ExecutionProfileStateRepository,
  Profile,
  ProfileSnapshot,
} from "./types.js";

const OPEN_ORDER_STATUSES: readonly OrderStatus[] = [
  OrderStatus.Pending,
  OrderStatus.Open,
  OrderStatus.PartiallyFilled,
];

const SCALE_IN_STATES = new Set(["PROBING", "ACCUMULATING", "HARVESTING"]);

export interface ExecutionProfileMetricWriter {
  writeCounter(name: string, value?: number, labels?: string): void;
  writeEvent?(metricName: string, value: number, labels: string, capturedAt: string): void;
}

export interface ExecutionProfileSignalFeedReader {
  getSnapshot(tokenId: TokenId, nowMs?: number): SignalSnapshot | null;
}

export interface ExecutionProfileManagerDeps {
  bus: EventBus;
  stateRepo: ExecutionProfileStateRepository;
  positionRepo: PositionRepository;
  orderRepo: OrderRepository;
  policy: () => ExecutionProfilePolicy;
  buyGuardsPolicy?: () => BuyGuardsPolicy;
  effectiveResolution?: Pick<EffectiveResolutionGate, "toBuyRunwayFields">;
  scaleInSignalSource?: ScaleInSignalSource;
  signalFeedReader?: ExecutionProfileSignalFeedReader;
  runtimeMetrics?: ExecutionProfileMetricWriter;
  riskEvents?: Pick<RiskEventRepository, "insert">;
  rollup?: ExecutionProfileRollup;
  healthChecker?: ExecutionProfileHealthChecker;
  anomalyDetector?: ExecutionProfileAnomalyDetector;
  now?: () => number;
}

export class ExecutionProfileManager implements RuntimeModule {
  private readonly ownership = new InMemoryProfileOwnershipReader();
  private readonly scaleInSignalSource: ScaleInSignalSource;
  private readonly abandonmentManager: AbandonmentManager;
  private readonly pendingScaleIn = new Map<string, { profile: Profile; createdAtMs: number }>();
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(private readonly deps: ExecutionProfileManagerDeps) {
    this.scaleInSignalSource = deps.scaleInSignalSource ?? createStubScaleInSignalSource();
    this.abandonmentManager = new AbandonmentManager({
      stateRepo: deps.stateRepo,
      positionRepo: deps.positionRepo,
      orderRepo: deps.orderRepo,
      policy: deps.policy,
      metrics: deps.runtimeMetrics,
      riskEvents: deps.riskEvents,
      hasPendingScaleIn: (tokenId) => this.pendingScaleIn.has(String(tokenId)),
      onStateChanged: (state) => {
        this.ownership.setSnapshot(toSnapshot(state));
      },
      now: deps.now,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.recoverState();
    this.adoptExistingS1Ladders();
    this.adoptExistingPositions();
    this.subscribe();
    this.deps.rollup?.start();
    this.deps.healthChecker?.start();
    this.abandonmentManager.start();
  }

  async stop(): Promise<void> {
    this.abandonmentManager.stop();
    while (this.unsubscribers.length > 0) {
      const unsub = this.unsubscribers.pop();
      unsub?.();
    }
    await this.deps.healthChecker?.stop();
    await this.deps.rollup?.stop();
    this.started = false;
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true, detail: `active=${this.ownership.size()}` };
  }

  getSnapshot(tokenId: TokenId): ProfileSnapshot | undefined {
    return this.ownership.getSnapshot(tokenId);
  }

  isProfileOwned(tokenId: TokenId): boolean {
    return this.ownership.isProfileOwned(tokenId);
  }

  getProfileAssignment(tokenId: TokenId): Profile | undefined {
    return this.getSnapshot(tokenId)?.profile;
  }

  shouldSuppressLegacySell(tokenId: TokenId): boolean {
    return this.policy().sellLadder.enabled && this.isProfileOwned(tokenId);
  }

  private subscribe(): void {
    this.unsubscribers.push(
      this.deps.bus.subscribe("PositionUpdated", async ({ position }) => {
        if (position.status === "closed" || position.size <= 0) this.closeToken(position.tokenId);
      }),
      this.deps.bus.subscribe("PositionSettled", async ({ tokenId }) => {
        this.closeToken(tokenId);
      }),
      this.deps.bus.subscribe("FillReceived", async (fill) => {
        this.handleFillReceived(fill);
      }),
      this.deps.bus.subscribe("MarketSnapshotHeartbeat", async ({ markets, timestamp }) => {
        await this.evaluateScaleIn(markets, timestamp);
      }),
    );
  }

  private recoverState(): void {
    const active = this.deps.stateRepo.findAllActive();
    this.ownership.hydrate(active.map(toSnapshot));
    const openTokenIds = this.deps.positionRepo.findOpen().map((position) => position.tokenId);
    for (const orphan of this.deps.stateRepo.findOrphans(openTokenIds)) {
      this.recordCounter(EXECUTION_PROFILE_METRICS.recoveryOrphan, {
        profile: orphan.profile,
        state: orphan.state,
      });
    }
  }

  private adoptExistingS1Ladders(): void {
    const policy = this.policy();
    if (!policy.enabled || !policy.adoptExistingS1Ladders.enabled) return;
    const openPositions = this.openPositionsByToken();
    for (const order of this.deps.orderRepo.findOpen()) {
      if (!isOpenS1SellOrder(order)) continue;
      const position = openPositions.get(String(order.tokenId));
      if (position == null || this.deps.stateRepo.getState(order.tokenId) != null) continue;
      this.persistAdoptedPosition(position, order);
    }
  }

  private adoptExistingPositions(): void {
    const policy = this.policy();
    if (!policy.enabled || !policy.sellLadder.enabled || !policy.adoptExistingPositions.enabled)
      return;
    for (const position of this.deps.positionRepo.findOpen().slice(0, policy.maxTokensPerCycle)) {
      if (this.deps.stateRepo.getState(position.tokenId) != null) continue;
      this.persistAdoptedPosition(position, null);
    }
  }

  private persistAdoptedPosition(position: Position, order: Order | null): void {
    const policy = this.policy();
    const resolved = resolveProfile({
      currentProfile: null,
      avgEntry: position.avgEntryPrice,
      config: policy.profileHysteresis,
    });
    if (resolved.profile == null) return;
    const nowIso = new Date(this.now()).toISOString();
    const state: ExecutionProfileStateRecord = {
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      profile: resolved.profile,
      state: "EXITING",
      assumedAt: nowIso,
      lastAvgEntry: position.avgEntryPrice,
      lastTransitionAt: nowIso,
      activeLadderId: order == null ? null : readS1LadderId(order),
      handoffStartedAt: null,
      addCount: 0,
      lastBuyAtMs: null,
      initialProbeSizeUsd: null,
      metadata: order == null ? { adopted: "position" } : { adopted: "s1_ladder" },
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.deps.stateRepo.runInTransaction(() => {
      this.deps.stateRepo.upsertState(state);
      this.ownership.setSnapshot(toSnapshot(state));
    });
    this.recordAssignment(state, order == null ? "position" : "s1_ladder");
  }

  private recordAssignment(
    state: ExecutionProfileStateRecord,
    adoptedFrom: "position" | "s1_ladder" | "buy_fill",
  ): void {
    this.recordCounter(EXECUTION_PROFILE_METRICS.assigned, { profile: state.profile });
    this.recordRiskEvent(EXECUTION_PROFILE_RISK_EVENTS.assigned, {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      profile: state.profile,
      state: state.state,
      activeLadderId: state.activeLadderId,
      adoptedFrom,
      assignedAt: state.assumedAt,
    });
  }

  private reclassifyFromPosition(tokenId: TokenId): void {
    const current = this.deps.stateRepo.getState(tokenId);
    const position = this.deps.positionRepo.findByTokenId(tokenId);
    if (current == null || position == null) return;
    const resolved = resolveProfile({
      currentProfile: current.profile,
      avgEntry: position.avgEntryPrice,
      config: this.policy().profileHysteresis,
    });
    if (resolved.profile == null || resolved.profile === current.profile) return;
    const nowIso = new Date(this.now()).toISOString();
    const next: ExecutionProfileStateRecord = {
      ...current,
      profile: resolved.profile,
      lastAvgEntry: position.avgEntryPrice,
      lastTransitionAt: nowIso,
      updatedAt: nowIso,
    };
    this.deps.stateRepo.runInTransaction(() => {
      this.deps.stateRepo.upsertState(next);
      this.ownership.setSnapshot(toSnapshot(next));
    });
    this.recordCounter(EXECUTION_PROFILE_METRICS.reclassified, {
      fromProfile: current.profile,
      toProfile: next.profile,
    });
    this.recordRiskEvent(EXECUTION_PROFILE_RISK_EVENTS.reclassified, {
      tokenId: String(next.tokenId),
      fromProfile: current.profile,
      toProfile: next.profile,
      avgEntry: position.avgEntryPrice,
      reclassifiedAt: nowIso,
    });
  }

  private closeToken(tokenId: TokenId): void {
    const current = this.deps.stateRepo.getState(tokenId);
    if (current == null || current.state === "CLOSED") return;
    const nowIso = new Date(this.now()).toISOString();
    const next: ExecutionProfileStateRecord = {
      ...current,
      state: "CLOSED",
      lastTransitionAt: nowIso,
      updatedAt: nowIso,
    };
    this.deps.stateRepo.runInTransaction(() => {
      this.deps.stateRepo.upsertState(next);
      this.ownership.deleteSnapshot(tokenId);
    });
  }

  private openPositionsByToken(): Map<string, Position> {
    const result = new Map<string, Position>();
    for (const position of this.deps.positionRepo.findOpen()) {
      result.set(String(position.tokenId), position);
    }
    return result;
  }

  private policy(): ExecutionProfilePolicy {
    return this.deps.policy();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async evaluateScaleIn(
    markets: readonly NormalizedMarket[],
    timestamp: number,
  ): Promise<void> {
    const policy = this.policy();
    if (!policy.enabled || !policy.scaleIn.enabled) return;
    for (const market of markets.slice(0, policy.maxTokensPerCycle)) {
      const tokenId = market.tokenId;
      const state = this.deps.stateRepo.getState(tokenId);
      if (state == null) continue;
      if (state.state === "ABANDONED_DORMANT") {
        this.recordCounter("scale_in_skipped_dormant", {});
        continue;
      }
      if (!SCALE_IN_STATES.has(state.state)) {
        this.recordManagerScaleInSkip(tokenId, state.profile, "not_active_state");
        continue;
      }
      const position = this.deps.positionRepo.findByTokenId(tokenId);
      if (position == null || position.status !== "open" || position.size <= 0) {
        this.recordManagerScaleInSkip(tokenId, state.profile, "missing_position");
        continue;
      }
      const currentMarkPrice = resolveBuyMarkPrice(market);
      if (currentMarkPrice == null) {
        this.recordManagerScaleInSkip(tokenId, state.profile, "missing_mark_price");
        continue;
      }

      const signals = this.buildMarketSignals(tokenId, timestamp);
      const decision = decideScaleIn(
        {
          profile: state.profile,
          currentCostUsd: position.costBasisUsdc,
          avgEntryPrice: position.avgEntryPrice,
          currentMarkPrice,
          timeSinceLastBuyMs:
            state.lastBuyAtMs == null ? 0 : Math.max(0, timestamp - state.lastBuyAtMs),
          marketSignals: signals,
          previousAddCount: state.addCount,
          initialProbeSizeUsd:
            state.initialProbeSizeUsd ?? policy.profiles[state.profile].scaleIn.initialProbeSizeUsd,
        },
        toScaleInConfig(policy),
      );

      this.recordCounter(EXECUTION_PROFILE_METRICS.scaleInDecided, {
        profile: state.profile,
        outcome: decision.action === "add" ? "allow" : "skip",
        mode: decision.mode ?? "none",
      });
      if (decision.action === "skip") {
        this.recordScaleInSkip(state.profile, decision);
        continue;
      }

      const buyGuardsPolicy = this.deps.buyGuardsPolicy?.() ?? DEFAULT_BUY_GUARDS_POLICY;
      const runway = this.deps.effectiveResolution?.toBuyRunwayFields(market, timestamp) ?? null;
      const nearDeathGuard = evaluateD3NearDeathGuard({
        policy: buyGuardsPolicy.d3NearDeathGuard,
        addPrice: currentMarkPrice,
        avgEntryPrice: position.avgEntryPrice,
        runway,
      });
      if (nearDeathGuard.action === "block") {
        this.recordBuyGuardCounter("d3_near_death_scale_in_suppressed_total", {
          reason: nearDeathGuard.reason,
          marketClass: nearDeathGuard.marketClass,
          confidence: nearDeathGuard.confidence,
          thresholdBucket: nearDeathGuard.thresholdBucket,
          action: "block",
        });
        this.recordRiskEvent("d3_near_death_scale_in_suppressed", {
          tokenId: String(tokenId),
          conditionId: String(position.conditionId),
          reason: nearDeathGuard.reason,
          addPrice: currentMarkPrice,
          avgEntryPrice: position.avgEntryPrice,
          dropVsRunningAvg: nearDeathGuard.dropVsRunningAvg,
          effectiveRunwayHours: runway?.effectiveRunwayHours ?? null,
          marketClass: nearDeathGuard.marketClass,
          confidence: nearDeathGuard.confidence,
          signalTimestamp: new Date(timestamp).toISOString(),
        });
        this.recordRollup({
          kind: "scale_in",
          profile: state.profile,
          outcome: "skip",
          mode: decision.mode ?? "none",
          reason: nearDeathGuard.reason as ScaleInReason,
          sample: { tokenId: String(tokenId), markPrice: currentMarkPrice },
        });
        continue;
      }

      const damp = applyStockCloseTailSizeDamp({
        policy: buyGuardsPolicy.stockCloseTailSizeDamp,
        market,
        baseSizeUsdc: decision.proposedAddSizeUsd,
        target: "scale_in",
      });
      if (damp.action === "telemetry") {
        this.recordBuyGuardCounter("stock_close_yes_tail_size_damp_telemetry_total", {
          reason: damp.reason,
          marketClass: damp.marketClass,
          confidence: damp.confidence,
          thresholdBucket: damp.thresholdBucket,
          action: "telemetry",
        });
      }
      let proposedAddSizeUsd = decision.proposedAddSizeUsd;
      const profileScaleInConfig = policy.profiles[state.profile].scaleIn;
      if (damp.action === "apply") {
        const postDampShares = currentMarkPrice > 0 ? damp.dampedSizeUsdc / currentMarkPrice : 0;
        const belowMinOrder =
          damp.dampedSizeUsdc < profileScaleInConfig.minAddNotionalUsd ||
          !isExecutableOrderSize(postDampShares, market.minOrderSize);
        if (belowMinOrder && buyGuardsPolicy.stockCloseTailSizeDamp.skipBelowMinOrder) {
          this.recordBuyGuardCounter("stock_close_yes_tail_size_damp_skipped_total", {
            reason: "stock_close_tail_damp_below_min_order",
            marketClass: damp.marketClass,
            confidence: damp.confidence,
            thresholdBucket: damp.thresholdBucket,
            action: "skip",
          });
          this.recordRiskEvent("stock_close_yes_tail_size_damp_skip", {
            tokenId: String(tokenId),
            conditionId: String(position.conditionId),
            reason: "stock_close_tail_damp_below_min_order",
            baseSizeUsdc: damp.baseSizeUsdc,
            dampedSizeUsdc: damp.dampedSizeUsdc,
            minAddNotionalUsd: profileScaleInConfig.minAddNotionalUsd,
            minOrderSize: market.minOrderSize ?? null,
            postDampShares,
            rangePct: damp.rangePct,
            marketClass: damp.marketClass,
            confidence: damp.confidence,
            signalTimestamp: new Date(timestamp).toISOString(),
          });
          this.recordRollup({
            kind: "scale_in",
            profile: state.profile,
            outcome: "skip",
            mode: decision.mode ?? "none",
            reason: "stock_close_tail_damp_below_min_order",
            sample: { tokenId: String(tokenId), proposedAddSizeUsd: damp.dampedSizeUsdc },
          });
          continue;
        }
        if (belowMinOrder) {
          this.recordBuyGuardCounter("stock_close_yes_tail_size_damp_telemetry_total", {
            reason: "stock_close_tail_damp_below_min_order",
            marketClass: damp.marketClass,
            confidence: damp.confidence,
            thresholdBucket: damp.thresholdBucket,
            action: "telemetry",
          });
        } else {
          proposedAddSizeUsd = damp.dampedSizeUsdc;
          this.recordBuyGuardCounter("stock_close_yes_tail_size_damp_applied_total", {
            reason: damp.reason,
            marketClass: damp.marketClass,
            confidence: damp.confidence,
            thresholdBucket: damp.thresholdBucket,
            action: "apply",
          });
          this.recordRiskEvent("stock_close_yes_tail_size_damp_apply", {
            tokenId: String(tokenId),
            conditionId: String(position.conditionId),
            reason: damp.reason,
            baseSizeUsdc: damp.baseSizeUsdc,
            dampedSizeUsdc: damp.dampedSizeUsdc,
            rangePct: damp.rangePct,
            marketClass: damp.marketClass,
            confidence: damp.confidence,
            signalTimestamp: new Date(timestamp).toISOString(),
          });
        }
      }

      const harvestingDecision = this.evaluateHarvestingBuyGuard({
        state,
        position,
        tokenId,
        buyPrice: currentMarkPrice,
        mode: decision.mode ?? "none",
        timestamp,
      });
      if (harvestingDecision === "block") {
        continue;
      }

      const cap = decideCostCap(
        {
          profile: state.profile,
          currentCostUsd: position.costBasisUsdc,
          action: {
            side: "buy",
            kind: "scale_in",
            proposedNotionalUsd: proposedAddSizeUsd,
          },
          signals: decision.costCapContext,
        },
        { enabled: policy.costCaps.enabled, profiles: policy.profiles },
      );
      this.recordCostCapTelemetry(tokenId, state.profile, cap);
      if (!cap.allow) {
        this.recordCounter(EXECUTION_PROFILE_METRICS.scaleInCostCapBlocked, {
          profile: state.profile,
          severity: cap.severity,
        });
        this.recordRollup({
          kind: "cost_cap",
          profile: state.profile,
          outcome: "block",
          mode: decision.mode ?? "none",
          reason: "cost_cap_blocked",
          sample: { tokenId: String(tokenId), severity: cap.severity, decisionReason: cap.reason },
        });
        continue;
      }

      if (this.hasOpenBuyOrder(tokenId) || this.pendingScaleIn.has(String(tokenId))) {
        this.recordManagerScaleInSkip(tokenId, state.profile, "add_in_flight", decision.mode);
        continue;
      }
      this.pendingScaleIn.set(String(tokenId), { profile: state.profile, createdAtMs: timestamp });
      await this.deps.bus.publish("SignalProduced", {
        market,
        signal: {
          signalId: `execution-profile:${String(tokenId)}:${timestamp}:${state.addCount + 1}`,
          tokenId,
          conditionId: position.conditionId,
          side: "buy",
          suggestedPrice: currentMarkPrice,
          suggestedSize: proposedAddSizeUsd / currentMarkPrice,
          suggestedSizeUsdc: proposedAddSizeUsd,
          reason: SignalReason.ScaleIn,
          strategyTick: timestamp,
          sequenceInTick: state.addCount,
          decisionRuleId: EXECUTION_PROFILE_SCALE_IN_RULE_ID,
          sizingRuleId: `profile:${state.profile}:add:${state.addCount + 1}`,
          generatedAt: new Date(timestamp).toISOString(),
        },
      });
      this.recordCounter(EXECUTION_PROFILE_METRICS.scaleInEmitted, { profile: state.profile });
      this.recordRollup({
        kind: "scale_in",
        profile: state.profile,
        outcome: "allow",
        mode: decision.mode ?? "none",
        reason: "allowed",
        sample: {
          tokenId: String(tokenId),
          proposedAddSizeUsd,
          markPrice: currentMarkPrice,
        },
      });
    }
  }

  private evaluateHarvestingBuyGuard(args: {
    state: ExecutionProfileStateRecord;
    position: Position;
    tokenId: TokenId;
    buyPrice: number;
    mode: ScaleInMode | "none";
    timestamp: number;
  }): "allow" | "block" {
    if (args.state.state !== "HARVESTING") return "allow";
    const policy = this.policy().scaleIn.harvestingGuard;
    if (!policy.enabled) return "allow";
    const decision = evaluatePostSellBuybackGuard(
      {
        buyPrice: args.buyPrice,
        lastSellPrice: numericMetadata(args.state.metadata, "lastSellPrice"),
        lastSellAtMs: numericMetadata(args.state.metadata, "lastSellAtMs"),
        nowMs: args.timestamp,
        signals: this.harvestingGuardSignals(args.tokenId, args.timestamp),
      },
      policy,
    );
    if (decision.action !== "block") {
      this.recordHarvestingGuardAllowed(
        args.state,
        args.position,
        args.buyPrice,
        args.mode ?? "none",
        decision.reason,
      );
      if (decision.reason === "strong_override") {
        this.recordBuyGuardCounter("harvesting_buy_above_last_sell_override_total", {
          band: args.state.profile,
          mode: args.mode ?? "none",
          overrideReason: decision.overrideReason ?? "unknown",
        });
      }
      return "allow";
    }

    this.recordBuyGuardCounter("harvesting_buy_above_last_sell_suppressed_total", {
      band: args.state.profile,
      mode: args.mode ?? "none",
      thresholdBucket: bucketHarvestingRatio(decision.ratio),
      overrideStatus: decision.overrideStatus,
    });
    this.recordRiskEvent("harvesting_buy_above_last_sell_suppressed", {
      tokenId: String(args.tokenId),
      conditionId: String(args.position.conditionId),
      buyPrice: args.buyPrice,
      lastSellPrice: numericMetadata(args.state.metadata, "lastSellPrice"),
      lastSellAtMs: numericMetadata(args.state.metadata, "lastSellAtMs"),
      ratio: decision.ratio,
      overrideStatus: decision.overrideStatus,
      state: args.state.state,
      decisionRuleId: EXECUTION_PROFILE_SCALE_IN_RULE_ID,
      signalReason: SignalReason.ScaleIn,
      signalTimestamp: new Date(args.timestamp).toISOString(),
    });
    this.recordRollup({
      kind: "scale_in",
      profile: args.state.profile,
      outcome: "skip",
      mode: args.mode ?? "none",
      reason: "harvesting_buy_above_last_sell_suppressed",
      sample: { tokenId: String(args.tokenId), markPrice: args.buyPrice },
    });
    return "block";
  }

  private recordHarvestingGuardAllowed(
    state: ExecutionProfileStateRecord,
    position: Position,
    buyPrice: number,
    mode: ScaleInMode | "none",
    reason: string,
  ): void {
    if (state.state !== "HARVESTING") return;
    this.recordBuyGuardCounter("harvesting_buy_allowed_total", {
      band: state.profile,
      mode,
      reason,
    });
    if (reason === "missing_last_sell_context") {
      this.recordRiskEvent("harvesting_buy_missing_last_sell_context", {
        tokenId: String(state.tokenId),
        conditionId: String(position.conditionId),
        buyPrice,
        state: state.state,
      });
    }
  }

  private handleFillReceived(fill: RuntimeEventMap["FillReceived"]): void {
    this.pendingScaleIn.delete(String(fill.tokenId));
    this.reclassifyFromPosition(fill.tokenId);
    if (fill.side === "sell") {
      this.handleSellFillReceived(fill);
      return;
    }
    if (fill.side !== "buy") return;
    const position = this.deps.positionRepo.findByTokenId(fill.tokenId);
    if (position == null) return;
    const current = this.deps.stateRepo.getState(fill.tokenId);
    // First BUY initialization only happens when the feature is enabled; existing
    // states keep updating regardless so in-flight positions never silently stall.
    if (current == null && !this.policy().enabled) return;
    const profile = current?.profile ?? this.resolveInitialProfile(position);
    if (profile == null) return;
    const reduction = reduceProfileState(current, {
      type: "buy_fill_received",
      tokenId: fill.tokenId,
      occurredAtMs: fill.timestamp,
      payload: {
        conditionId: fill.conditionId,
        profile,
        avgEntry: position.avgEntryPrice,
      },
    });
    const base = reduction.next ?? current;
    if (base == null) return;
    const next = this.withBuyAccounting(base, fill);
    this.deps.stateRepo.runInTransaction(() => {
      this.deps.stateRepo.upsertState(next);
      if (next.state === "CLOSED") this.ownership.deleteSnapshot(fill.tokenId);
      else this.ownership.setSnapshot(toSnapshot(next));
    });
    this.consumeReducerEffects(reduction.effects, fill.timestamp);
    if (current == null && reduction.transition != null) {
      this.recordAssignment(next, "buy_fill");
    }
  }

  private handleSellFillReceived(fill: RuntimeEventMap["FillReceived"]): void {
    const current = this.deps.stateRepo.getState(fill.tokenId);
    if (current == null || !isHarvestTriggerState(current.state)) return;
    if (isDustAutoCloseFill(fill) || fill.price <= current.lastAvgEntry) return;
    const guard = this.policy().scaleIn.harvestingGuard;
    if (!guard.transitionEnabled) return;

    const reduction = reduceProfileState(current, {
      type: "harvest_lifecycle_activated",
      tokenId: fill.tokenId,
      occurredAtMs: fill.timestamp,
      payload: {},
    });
    const base = reduction.next ?? current;
    const next = this.withSellHarvestingMetadata(base, fill);
    this.deps.stateRepo.runInTransaction(() => {
      this.deps.stateRepo.upsertState(next);
      this.ownership.setSnapshot(toSnapshot(next));
    });
    this.consumeReducerEffects(reduction.effects, fill.timestamp);
    if (reduction.transition?.to === "HARVESTING") {
      this.recordBuyGuardCounter("harvesting_state_entered_total", {
        band: next.profile,
        reason: "first_profitable_sell",
      });
      this.recordRiskEvent("harvest_lifecycle_activated", {
        tokenId: String(next.tokenId),
        conditionId: String(next.conditionId),
        from: reduction.transition.from,
        to: reduction.transition.to,
        fillPrice: fill.price,
        lastAvgEntry: current.lastAvgEntry,
        occurredAt: new Date(fill.timestamp).toISOString(),
      });
    }
  }

  private withSellHarvestingMetadata(
    state: ExecutionProfileStateRecord,
    fill: RuntimeEventMap["FillReceived"],
  ): ExecutionProfileStateRecord {
    const metadata = state.metadata ?? {};
    const firstProfitableSellAtMs =
      typeof metadata.firstProfitableSellAtMs === "number" &&
      Number.isFinite(metadata.firstProfitableSellAtMs)
        ? metadata.firstProfitableSellAtMs
        : fill.timestamp;
    const harvestSellCount =
      typeof metadata.harvestSellCount === "number" && Number.isFinite(metadata.harvestSellCount)
        ? metadata.harvestSellCount + 1
        : 1;
    return {
      ...state,
      metadata: {
        ...metadata,
        lastSellPrice: fill.price,
        lastSellAtMs: fill.timestamp,
        firstProfitableSellAtMs,
        lastProfitableSellPrice: fill.price,
        harvestSellCount,
      },
      updatedAt: new Date(fill.timestamp).toISOString(),
    };
  }

  private resolveInitialProfile(position: Position): Profile | null {
    return resolveProfile({
      currentProfile: null,
      avgEntry: position.avgEntryPrice,
      config: this.policy().profileHysteresis,
    }).profile;
  }

  private withBuyAccounting(
    state: ExecutionProfileStateRecord,
    fill: RuntimeEventMap["FillReceived"],
  ): ExecutionProfileStateRecord {
    const updatedAt = new Date(fill.timestamp).toISOString();
    const metadata = state.metadata ?? {};
    const firstBuyAtMs =
      typeof metadata.firstBuyAtMs === "number" && Number.isFinite(metadata.firstBuyAtMs)
        ? metadata.firstBuyAtMs
        : fill.timestamp;
    return {
      ...state,
      addCount: state.addCount + 1,
      lastBuyAtMs: fill.timestamp,
      initialProbeSizeUsd: state.initialProbeSizeUsd ?? fill.sizeUsdc,
      metadata: { ...metadata, firstBuyAtMs },
      updatedAt,
    };
  }

  private hasOpenBuyOrder(tokenId: TokenId): boolean {
    return this.deps.orderRepo
      .findOpen()
      .some((order) => order.tokenId === tokenId && order.side === "buy");
  }

  private buildMarketSignals(tokenId: TokenId, timestamp: number): ScaleInMarketSignals {
    const policy = this.policy();
    if (policy.signalFeed.enabled && policy.scaleIn.useRealFeed && this.deps.signalFeedReader) {
      const snapshot = this.deps.signalFeedReader.getSnapshot(tokenId, timestamp);
      if (snapshot != null) return signalsFromSnapshot(snapshot);
    }
    return this.scaleInSignalSource.getSignalSnapshot(tokenId);
  }

  private harvestingGuardSignals(tokenId: TokenId, timestamp: number): PostSellBuybackGuardSignals {
    const policy = this.policy();
    if (!policy.signalFeed.enabled || !policy.scaleIn.useRealFeed || !this.deps.signalFeedReader) {
      return unavailableGuardSignals();
    }
    const snapshot = this.deps.signalFeedReader.getSnapshot(tokenId, timestamp);
    if (snapshot == null) return unavailableGuardSignals();
    const usable =
      !snapshot.insufficientForRecovery &&
      !snapshot.insufficientForRange &&
      !snapshot.insufficientForStd;
    return {
      recovery60: snapshot.recovery60,
      range60: snapshot.range60,
      std60: snapshot.std60,
      usable,
    };
  }

  private recordCounter(name: string, labels: Record<string, unknown>): void {
    writeExecutionProfileCounter(this.deps.runtimeMetrics, name, labels as ExecutionProfileLabels);
  }

  private recordBuyGuardCounter(name: string, labels: Record<string, string>): void {
    this.deps.runtimeMetrics?.writeCounter(name, 1, JSON.stringify(labels));
  }

  private recordRiskEvent(eventType: string, payload: Record<string, unknown>): void {
    this.deps.riskEvents?.insert({
      eventType,
      payload,
    });
  }

  private recordManagerScaleInSkip(
    tokenId: TokenId,
    profile: Profile,
    reason: ScaleInReason,
    mode: ScaleInDecision["mode"] | "none" = "none",
  ): void {
    this.recordCounter(EXECUTION_PROFILE_METRICS.scaleInSkipped, { reason });
    this.recordRollup({
      kind: "scale_in",
      profile,
      outcome: "skip",
      mode: mode ?? "none",
      reason,
      sample: { tokenId: String(tokenId) },
    });
  }

  private recordScaleInSkip(profile: Profile, decision: ScaleInDecision): void {
    this.recordCounter(EXECUTION_PROFILE_METRICS.scaleInSkipped, { reason: decision.reason });
    this.recordRollup({
      kind: "scale_in",
      profile,
      outcome: decision.reason === "scale_in_disabled" ? "disabled" : "skip",
      mode: decision.mode ?? "none",
      reason: decision.reason,
      sample: {
        proposedAddSizeUsd: decision.proposedAddSizeUsd,
        triggerSignals: decision.triggerSignals,
      },
    });
  }

  private recordCostCapTelemetry(tokenId: TokenId, profile: Profile, cap: CapDecision): void {
    const decision = cap.allow
      ? "allow"
      : cap.reason === "cost_caps_disabled"
        ? "disabled"
        : "block";
    this.recordCounter(EXECUTION_PROFILE_METRICS.costCapEnforced, {
      profile,
      severity: cap.severity,
      decision,
    });
    this.recordCounter(costCapSeverityMetric(cap.severity), { profile });
    if (cap.crossedBand !== "none") {
      this.recordCounter(EXECUTION_PROFILE_METRICS.costCapCrossed, { band: cap.crossedBand });
    }
    this.recordRiskEvent(EXECUTION_PROFILE_RISK_EVENTS.costCapDecided, {
      tokenId: String(tokenId),
      profile,
      allow: cap.allow,
      severity: cap.severity,
      crossedBand: cap.crossedBand,
      reason: cap.reason,
      requiredSignal: cap.requiredSignal,
      currentCostUsd: cap.currentCostUsd,
      roundedCurrentCostUsd: cap.roundedCurrentCostUsd,
      projectedCostUsd: cap.projectedCostUsd,
      roundedProjectedCostUsd: cap.roundedProjectedCostUsd,
      normalCapUsd: cap.normalCapUsd,
      aggressiveCapUsd: cap.aggressiveCapUsd,
      hardCapAtAggressive: cap.hardCapAtAggressive,
      signalReasons: cap.signalReasons,
    });
  }

  private consumeReducerEffects(
    effects: readonly { type: string; name: string; payload?: Readonly<Record<string, unknown>> }[],
    occurredAtMs: number,
  ): void {
    for (const effect of effects) {
      if (effect.type === "increment_counter") {
        this.recordCounter(effect.name, (effect.payload ?? {}) as Record<string, unknown>);
      }
      if (effect.type === "publish_event") {
        this.recordRiskEvent(effect.name, {
          ...(effect.payload ?? {}),
          occurredAt: new Date(occurredAtMs).toISOString(),
        });
      }
    }
  }

  private recordRollup(input: Parameters<ExecutionProfileRollup["record"]>[0]): void {
    this.deps.rollup?.record(input);
  }

  getPendingScaleIns(): Array<{ tokenId: string; profile: Profile; createdAtMs: number }> {
    return [...this.pendingScaleIn.entries()].map(([tokenId, pending]) => ({
      tokenId,
      profile: pending.profile,
      createdAtMs: pending.createdAtMs,
    }));
  }
}

function toScaleInConfig(policy: ExecutionProfilePolicy): ScaleInConfig {
  return {
    enabled: policy.scaleIn.enabled,
    profiles: policy.profiles,
  };
}

function resolveBuyMarkPrice(market: NormalizedMarket): number | null {
  return (
    finitePositiveOrNull(market.bestAsk) ??
    finitePositiveOrNull(market.midPrice) ??
    finitePositiveOrNull(market.lastTradePrice ?? null)
  );
}

function finitePositiveOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function toSnapshot(state: ExecutionProfileStateRecord): ProfileSnapshot {
  return {
    tokenId: state.tokenId,
    profile: state.profile,
    state: state.state,
    assumedAt: state.assumedAt,
    lastTransitionAt: state.lastTransitionAt,
    activeLadderId: state.activeLadderId,
  };
}

function isOpenS1SellOrder(order: Order): boolean {
  return (
    order.side === "sell" &&
    order.decisionRuleId === S1_LADDER_RULE_ID &&
    OPEN_ORDER_STATUSES.includes(order.status)
  );
}

function readS1LadderId(order: Order): string | null {
  const s1 = order.metadata?.s1;
  return s1 != null && typeof s1 === "object" && "ladderId" in s1 && typeof s1.ladderId === "string"
    ? s1.ladderId
    : null;
}

function costCapSeverityMetric(severity: CapDecision["severity"]): string {
  if (severity === "under_p75") return EXECUTION_PROFILE_METRICS.costCapUnder;
  if (severity === "between") return EXECUTION_PROFILE_METRICS.costCapBetween;
  return EXECUTION_PROFILE_METRICS.costCapOver;
}

function signalsFromSnapshot(snapshot: SignalSnapshot): ScaleInMarketSignals {
  return {
    recovery60: snapshot.recovery60,
    range60: snapshot.range60,
    std60: snapshot.std60,
    tradeCount3h: snapshot.tradeCount3h,
    notional3h: snapshot.notional3h ?? 0,
  };
}

function unavailableGuardSignals(): PostSellBuybackGuardSignals {
  return { recovery60: null, range60: null, std60: null, usable: false };
}

function numericMetadata(
  metadata: Readonly<Record<string, unknown>> | null,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bucketHarvestingRatio(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return "unknown";
  if (ratio > 1.05) return "gt_1_05";
  if (ratio > 1.03) return "gt_1_03";
  return "lte_1_03";
}

function isHarvestTriggerState(state: ExecutionProfileStateRecord["state"]): boolean {
  return state === "PROBING" || state === "ACCUMULATING" || state === "HARVESTING";
}

function isDustAutoCloseFill(fill: RuntimeEventMap["FillReceived"]): boolean {
  return fill.signalReason === "dust-auto-close" || fill.decisionRuleId === "S4_DUST_AUTO_CLOSE";
}
