import type {
  ConditionId,
  ExecutionProfileHysteresisBounds,
  ExecutionProfileName,
  ExecutionProfilePolicy as DomainExecutionProfilePolicy,
  TokenId,
} from "@krabs/domain";

export type Profile = ExecutionProfileName;
export type ExecutionProfilePolicy = DomainExecutionProfilePolicy;
export type { ExecutionProfileHysteresisBounds };

export const PROFILE_STATES = [
  "SCANNING",
  "PROBING",
  "ACCUMULATING",
  "HARVESTING",
  "EXITING",
  "QD_HANDOFF",
  "ABANDONED",
  "ABANDONED_DORMANT",
  "CLOSED",
] as const;

export type ProfileState = (typeof PROFILE_STATES)[number];

export interface ProfileSnapshot {
  tokenId: TokenId;
  profile: Profile;
  state: ProfileState;
  assumedAt: string;
  lastTransitionAt: string;
  activeLadderId: string | null;
}

export interface ExecutionProfileStateRecord extends ProfileSnapshot {
  conditionId: ConditionId;
  lastAvgEntry: number;
  handoffStartedAt: string | null;
  addCount: number;
  lastBuyAtMs: number | null;
  initialProbeSizeUsd: number | null;
  metadata: Readonly<Record<string, unknown>> | null;
  createdAt: string;
  updatedAt: string;
}

export type ReducerEventType =
  | "position_adopted"
  | "buy_fill_received"
  | "harvest_lifecycle_activated"
  | "sell_lifecycle_activated"
  | "qd_handoff_started"
  | "abandonment_triggered"
  | "position_closed"
  | "position_settled";

export interface ReducerEvent {
  type: ReducerEventType;
  tokenId: TokenId;
  occurredAtMs: number;
  payload?: Readonly<Record<string, unknown>>;
}

export type ReducerEffectType = "persist_state" | "publish_event" | "increment_counter";

export interface ReducerEffect {
  type: ReducerEffectType;
  name: string;
  payload?: Readonly<Record<string, unknown>>;
}

export interface ProfileStateTransition {
  from: ProfileState | null;
  to: ProfileState;
  occurredAt: string;
}

export interface ProfileReduction {
  next: ExecutionProfileStateRecord | null;
  transition: ProfileStateTransition | null;
  effects: readonly ReducerEffect[];
  rejected: boolean;
  rejectionReason?: string;
}

export interface ExecutionProfileStateRepository {
  upsertState(state: ExecutionProfileStateRecord): void;
  getState(tokenId: TokenId): ExecutionProfileStateRecord | null;
  findAllActive(): ExecutionProfileStateRecord[];
  findByState(state: ProfileState): ExecutionProfileStateRecord[];
  findOrphans(openTokenIds: readonly TokenId[]): ExecutionProfileStateRecord[];
  delete(tokenId: TokenId): void;
  runInTransaction<T>(fn: () => T): T;
}
