import {
  OrderStatus,
  S1_LADDER_RULE_ID,
  SignalReason,
  type EventBus,
  type NormalizedMarket,
  type Order,
  type OrderRepository,
  type Position,
  type PositionRepository,
  type RuntimeEventMap,
  type RuntimeModule,
  type ScaleInConfig,
  type TokenId,
} from "@krabs/domain";

import { decideCostCap } from "./cost-cap-enforcer.js";
import { InMemoryProfileOwnershipReader } from "./profile-ownership-reader.js";
import { resolveProfile } from "./profile-resolver.js";
import { reduceProfileState } from "./profile-state-reducer.js";
import { createStubScaleInSignalSource, type ScaleInSignalSource } from "./signal-feed-stub.js";
import { decideScaleIn, EXECUTION_PROFILE_SCALE_IN_RULE_ID } from "./scale-in-decider.js";
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

const SCALE_IN_STATES = new Set(["PROBING", "ACCUMULATING"]);

export interface ExecutionProfileMetricWriter {
  writeCounter(name: string, value?: number, labels?: string): void;
}

export interface ExecutionProfileManagerDeps {
  bus: EventBus;
  stateRepo: ExecutionProfileStateRepository;
  positionRepo: PositionRepository;
  orderRepo: OrderRepository;
  policy: () => ExecutionProfilePolicy;
  scaleInSignalSource?: ScaleInSignalSource;
  runtimeMetrics?: ExecutionProfileMetricWriter;
  now?: () => number;
}

export class ExecutionProfileManager implements RuntimeModule {
  private readonly ownership = new InMemoryProfileOwnershipReader();
  private readonly scaleInSignalSource: ScaleInSignalSource;
  private readonly pendingScaleIn = new Set<string>();
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(private readonly deps: ExecutionProfileManagerDeps) {
    this.scaleInSignalSource = deps.scaleInSignalSource ?? createStubScaleInSignalSource();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.recoverState();
    this.adoptExistingS1Ladders();
    this.adoptExistingPositions();
    this.subscribe();
  }

  async stop(): Promise<void> {
    while (this.unsubscribers.length > 0) {
      const unsub = this.unsubscribers.pop();
      unsub?.();
    }
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
      if (state == null || !SCALE_IN_STATES.has(state.state)) continue;
      const position = this.deps.positionRepo.findByTokenId(tokenId);
      if (position == null || position.status !== "open" || position.size <= 0) continue;
      const currentMarkPrice = resolveBuyMarkPrice(market);
      if (currentMarkPrice == null) {
        this.recordCounter("track_execution_profile_scale_in_skipped", {
          reason: "invalid_inputs",
        });
        continue;
      }

      const signals = this.scaleInSignalSource.getSignalSnapshot(tokenId);
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

      this.recordCounter("track_execution_profile_scale_in_decided", {
        profile: state.profile,
        action: decision.action,
        mode: decision.mode ?? "none",
      });
      if (decision.action === "skip") {
        this.recordCounter("track_execution_profile_scale_in_skipped", { reason: decision.reason });
        continue;
      }

      const cap = decideCostCap(
        {
          profile: state.profile,
          currentCostUsd: position.costBasisUsdc,
          action: {
            side: "buy",
            kind: "scale_in",
            proposedNotionalUsd: decision.proposedAddSizeUsd,
          },
          signals: decision.costCapContext,
        },
        { enabled: policy.costCaps.enabled, profiles: policy.profiles },
      );
      if (!cap.allow) {
        this.recordCounter("track_execution_profile_scale_in_cost_cap_blocked", {
          profile: state.profile,
          severity: cap.severity,
        });
        continue;
      }

      if (this.hasOpenBuyOrder(tokenId) || this.pendingScaleIn.has(String(tokenId))) {
        this.recordCounter("track_execution_profile_scale_in_skipped", { reason: "add_in_flight" });
        continue;
      }
      this.pendingScaleIn.add(String(tokenId));
      await this.deps.bus.publish("SignalProduced", {
        market,
        signal: {
          signalId: `execution-profile:${String(tokenId)}:${timestamp}:${state.addCount + 1}`,
          tokenId,
          conditionId: position.conditionId,
          side: "buy",
          suggestedPrice: currentMarkPrice,
          suggestedSize: decision.proposedAddSizeUsd / currentMarkPrice,
          suggestedSizeUsdc: decision.proposedAddSizeUsd,
          reason: SignalReason.ScaleIn,
          strategyTick: timestamp,
          sequenceInTick: state.addCount,
          decisionRuleId: EXECUTION_PROFILE_SCALE_IN_RULE_ID,
          sizingRuleId: `profile:${state.profile}:add:${state.addCount + 1}`,
          generatedAt: new Date(timestamp).toISOString(),
        },
      });
      this.recordCounter("track_execution_profile_scale_in_emitted", { profile: state.profile });
    }
  }

  private handleFillReceived(fill: RuntimeEventMap["FillReceived"]): void {
    this.pendingScaleIn.delete(String(fill.tokenId));
    this.reclassifyFromPosition(fill.tokenId);
    if (fill.side !== "buy") return;
    const current = this.deps.stateRepo.getState(fill.tokenId);
    const position = this.deps.positionRepo.findByTokenId(fill.tokenId);
    if (current == null || position == null) return;
    const updated = this.withBuyAccounting(current, fill);
    const reduction = reduceProfileState(updated, {
      type: "buy_fill_received",
      tokenId: fill.tokenId,
      occurredAtMs: fill.timestamp,
      payload: {
        conditionId: fill.conditionId,
        profile: updated.profile,
        avgEntry: position.avgEntryPrice,
      },
    });
    const next = reduction.next ?? updated;
    this.deps.stateRepo.runInTransaction(() => {
      this.deps.stateRepo.upsertState(next);
      if (next.state === "CLOSED") this.ownership.deleteSnapshot(fill.tokenId);
      else this.ownership.setSnapshot(toSnapshot(next));
    });
  }

  private withBuyAccounting(
    state: ExecutionProfileStateRecord,
    fill: RuntimeEventMap["FillReceived"],
  ): ExecutionProfileStateRecord {
    const updatedAt = new Date(fill.timestamp).toISOString();
    return {
      ...state,
      addCount: state.addCount + 1,
      lastBuyAtMs: fill.timestamp,
      initialProbeSizeUsd: state.initialProbeSizeUsd ?? fill.sizeUsdc,
      updatedAt,
    };
  }

  private hasOpenBuyOrder(tokenId: TokenId): boolean {
    return this.deps.orderRepo
      .findOpen()
      .some((order) => order.tokenId === tokenId && order.side === "buy");
  }

  private recordCounter(name: string, labels: Record<string, unknown>): void {
    this.deps.runtimeMetrics?.writeCounter(name, 1, JSON.stringify(labels));
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
