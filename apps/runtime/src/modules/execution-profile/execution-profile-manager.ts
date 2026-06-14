import {
  OrderStatus,
  S1_LADDER_RULE_ID,
  type EventBus,
  type Order,
  type OrderRepository,
  type Position,
  type PositionRepository,
  type RuntimeModule,
  type TokenId,
} from "@krabs/domain";

import { InMemoryProfileOwnershipReader } from "./profile-ownership-reader.js";
import { resolveProfile } from "./profile-resolver.js";
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

export interface ExecutionProfileManagerDeps {
  bus: EventBus;
  stateRepo: ExecutionProfileStateRepository;
  positionRepo: PositionRepository;
  orderRepo: OrderRepository;
  policy: () => ExecutionProfilePolicy;
  now?: () => number;
}

export class ExecutionProfileManager implements RuntimeModule {
  private readonly ownership = new InMemoryProfileOwnershipReader();
  private readonly unsubscribers: Array<() => void> = [];
  private started = false;

  constructor(private readonly deps: ExecutionProfileManagerDeps) {}

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
      this.deps.bus.subscribe("FillReceived", async ({ tokenId }) => {
        this.reclassifyFromPosition(tokenId);
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
