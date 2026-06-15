import type {
  AbandonmentReason,
  AbandonmentEvaluatorInput,
  ExecutionProfilePolicy,
  Order,
  OrderRepository,
  PositionRepository,
  ProfileLadderBand,
  RiskEventRepository,
  TokenId,
} from "@krabs/domain";

import { decideAbandonment } from "./abandonment-evaluator.js";
import {
  EXECUTION_PROFILE_METRICS,
  EXECUTION_PROFILE_RISK_EVENTS,
  writeExecutionProfileCounter,
  type ExecutionProfileCounterWriter,
} from "./execution-profile-metrics.js";
import { reduceProfileState } from "./profile-state-reducer.js";
import type {
  ExecutionProfileStateRecord,
  ExecutionProfileStateRepository,
  ProfileState,
} from "./types.js";

export interface AbandonmentManagerDeps {
  stateRepo: ExecutionProfileStateRepository;
  positionRepo: Pick<PositionRepository, "findByTokenId">;
  orderRepo: Pick<OrderRepository, "findByTokenId">;
  policy: () => ExecutionProfilePolicy;
  metrics?: ExecutionProfileCounterWriter | undefined;
  riskEvents?: Pick<RiskEventRepository, "insert"> | undefined;
  hasPendingScaleIn?: ((tokenId: TokenId) => boolean) | undefined;
  onStateChanged?: ((state: ExecutionProfileStateRecord) => void) | undefined;
  now?: (() => number) | undefined;
}

export class AbandonmentManager {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AbandonmentManagerDeps) {}

  start(): void {
    const policy = this.deps.policy();
    const config = policy.abandonment;
    if (!policy.enabled || !config.enabled || this.timer != null) return;
    this.timer = setInterval(() => {
      this.runOnce();
    }, config.evaluationIntervalMs);
  }

  stop(): void {
    if (this.timer == null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  runOnce(nowMs = this.deps.now?.() ?? Date.now()): number {
    const policy = this.deps.policy();
    const config = policy.abandonment;
    if (!policy.enabled || !config.enabled) return 0;

    let transitioned = 0;
    for (const state of this.candidates(config.maxTokensPerCycle)) {
      const input = this.inputForState(state, nowMs);
      if (input == null) continue;
      const decision = decideAbandonment(input, config);
      this.recordEvaluation(input.band, decision.result, decision.reason);
      if (!decision.shouldAbandon) continue;

      const reduction = reduceProfileState(state, {
        type: "abandonment_triggered",
        tokenId: state.tokenId,
        occurredAtMs: nowMs,
        payload: {
          band: decision.band,
          reason: decision.reason,
          timeSinceFirstBuyMs: decision.timeSinceFirstBuyMs,
        },
      });
      if (reduction.rejected || reduction.next == null) continue;

      const next = withAbandonmentMetadata(reduction.next, input, decision.timeSinceFirstBuyMs);
      this.deps.stateRepo.runInTransaction(() => {
        this.deps.stateRepo.upsertState(next);
      });
      writeExecutionProfileCounter(
        this.deps.metrics,
        EXECUTION_PROFILE_METRICS.positionAbandonedDormantPerBand,
        { band: input.band },
      );
      this.deps.riskEvents?.insert({
        eventType: EXECUTION_PROFILE_RISK_EVENTS.positionAbandonedDormant,
        payload: {
          tokenId: String(state.tokenId),
          conditionId: String(state.conditionId),
          band: input.band,
          costBasisUsdc: input.costBasisUsdc,
          buyCount: input.buyCount,
          sellCount: input.sellCount,
          ageMs: decision.timeSinceFirstBuyMs,
          reason: decision.reason,
        },
      });
      this.deps.onStateChanged?.(next);
      transitioned += 1;
    }
    return transitioned;
  }

  private recordEvaluation(
    band: AbandonmentEvaluatorInput["band"],
    result: "abandoned" | "kept",
    reason: AbandonmentReason,
  ): void {
    writeExecutionProfileCounter(
      this.deps.metrics,
      EXECUTION_PROFILE_METRICS.positionAbandonedEvaluation,
      { band, result, reason },
    );
  }

  private candidates(maxTokensPerCycle: number): ExecutionProfileStateRecord[] {
    return [
      ...this.deps.stateRepo.findByState("PROBING"),
      ...this.deps.stateRepo.findByState("ACCUMULATING"),
    ]
      .sort((left, right) => Date.parse(left.lastTransitionAt) - Date.parse(right.lastTransitionAt))
      .slice(0, maxTokensPerCycle);
  }

  private inputForState(
    state: ExecutionProfileStateRecord,
    nowMs: number,
  ): AbandonmentEvaluatorInput | null {
    if (!isAbandonmentState(state.state)) return null;
    const position = this.deps.positionRepo.findByTokenId(state.tokenId);
    if (position == null) return null;
    const band = bandForAvgEntry(position.avgEntryPrice);
    if (band == null) return null;

    const orders = this.deps.orderRepo.findByTokenId(state.tokenId);
    return {
      band,
      state: state.state,
      costBasisUsdc: position.costBasisUsdc,
      buyCount: state.addCount,
      sellCount: orders.filter((order) => order.side === "sell").length,
      firstBuyAtMs: metadataNumber(state.metadata, "firstBuyAtMs"),
      nowMs,
      pendingScaleIn:
        this.deps.hasPendingScaleIn?.(state.tokenId) === true ||
        orders.some((order) => order.side === "buy" && isActiveOrder(order)),
      activeProfileLadder:
        state.activeLadderId != null ||
        orders.some(
          (order) =>
            order.side === "sell" &&
            isActiveOrder(order) &&
            order.metadata?.source === "profile_ladder",
        ),
      activeSellOrder: orders.some((order) => order.side === "sell" && isActiveOrder(order)),
    };
  }
}

function isAbandonmentState(state: ProfileState): state is "PROBING" | "ACCUMULATING" {
  return state === "PROBING" || state === "ACCUMULATING";
}

function bandForAvgEntry(avgEntryPrice: number): ProfileLadderBand | null {
  if (!Number.isFinite(avgEntryPrice) || avgEntryPrice < 0) return null;
  if (avgEntryPrice < 0.05) return "cheap";
  if (avgEntryPrice < 0.15) return "medium_low";
  if (avgEntryPrice < 0.35) return "medium_high";
  return "expensive";
}

function isActiveOrder(order: Order): boolean {
  return (
    order.status === "pending" || order.status === "open" || order.status === "partially-filled"
  );
}

function metadataNumber(
  metadata: Readonly<Record<string, unknown>> | null,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function withAbandonmentMetadata(
  state: ExecutionProfileStateRecord,
  input: AbandonmentEvaluatorInput,
  timeSinceFirstBuyMs: number | null,
): ExecutionProfileStateRecord {
  return {
    ...state,
    metadata: {
      ...(state.metadata ?? {}),
      abandonedDormantAtMs: input.nowMs,
      abandonmentBand: input.band,
      abandonmentReason: "qualified",
      timeSinceFirstBuyMs,
    },
  };
}
