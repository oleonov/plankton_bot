import type {
  EventBus,
  LadderRung,
  LadderState,
  NormalizedMarket,
  OrderId,
  Position,
  RuntimeEventMap,
  RuntimeModule,
  TokenId,
} from "@krabs/domain";
import { PositionStatus, createCommandId } from "@krabs/domain";
import { buildClientOrderId } from "@krabs/domain/node";

import { computeProfileLadder } from "./profile-ladder-builder.js";
import type { ProfileLadderRepository } from "./profile-ladder-repository.js";
import type { ExecutionProfilePolicy } from "./types.js";

export interface ProfileLadderMetricWriter {
  writeCounter(name: string, value?: number, labels?: string): void;
}

export interface ProfileLadderRiskEventWriter {
  insert(event: { eventType: string; payload: Readonly<Record<string, unknown>> }): void;
}

export interface ProfileLadderModuleDeps {
  bus: EventBus;
  repository: ProfileLadderRepository;
  policy: () => ExecutionProfilePolicy;
  runtimeMetrics?: ProfileLadderMetricWriter;
  riskEvents?: ProfileLadderRiskEventWriter;
  now?: () => number;
}

export class ProfileLadderModule implements RuntimeModule {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly bboCooldownUntilByToken = new Map<string, number>();
  private started = false;

  constructor(private readonly deps: ProfileLadderModuleDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.policy().enabled) return;
    this.unsubscribers.push(
      this.deps.bus.subscribe("PositionUpdated", async ({ position }) => {
        if (position.status === PositionStatus.Closed || position.size <= 0) {
          await this.cancelLadder(position.tokenId, "position_closed");
        }
      }),
      this.deps.bus.subscribe("FillReceived", async (event) => {
        this.handleFillReceived(event);
      }),
    );
  }

  async stop(): Promise<void> {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.started = false;
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: true,
      detail: this.policy().enabled
        ? `active=${this.deps.repository.findActive().length}`
        : "disabled",
    };
  }

  async placeLadder(position: Position, market: NormalizedMarket): Promise<void> {
    const state = await this.buildAndPlace(position, market, "ladder_placed");
    if (state == null) return;
    this.writeCounter("profile_ladder_placed", 1, { band: state.band });
    this.insertRiskEvent("ladder_placed", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      band: state.band,
      rungCount: state.activeRungs.length,
      ladderId: state.ladderId,
    });
  }

  async rebuildLadder(
    position: Position,
    market: NormalizedMarket,
    reason: "scale_in" | "profile_reclass" | "bbo_major" | "bbo_strong",
  ): Promise<void> {
    if (isBboReason(reason) && this.isBboCooldownActive(position.tokenId)) return;

    const state = await this.buildAndPlace(position, market, "ladder_rebuilt");
    if (state == null) return;
    if (isBboReason(reason)) {
      this.bboCooldownUntilByToken.set(
        String(position.tokenId),
        this.now() + this.policy().reprice.cooldownMs,
      );
    }
    this.writeCounter("profile_ladder_rebuilt", 1, { band: state.band, reason });
    this.insertRiskEvent("ladder_rebuilt", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      band: state.band,
      reason,
      rungCount: state.activeRungs.length,
      ladderId: state.ladderId,
    });
  }

  async cancelLadder(tokenId: TokenId, reason: "position_closed" | "operator"): Promise<void> {
    const state = this.deps.repository.getLadder(tokenId);
    if (state == null) return;

    for (const rung of state.activeRungs) {
      if (rung.orderId == null) continue;
      await this.deps.bus.publish("CancelOrderRequested", {
        command: {
          type: "CancelOrderCommand",
          commandId: createCommandId(`profile_ladder_cancel_${rung.orderId}_${this.now()}`),
          orderId: rung.orderId as OrderId,
          reason: "operator",
        },
        timestamp: this.now(),
      });
    }
    this.deps.repository.deleteLadder(tokenId);
    this.writeCounter("profile_ladder_cancelled", 1, { band: state.band, reason });
    this.insertRiskEvent("ladder_cancelled", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      band: state.band,
      reason,
      ladderId: state.ladderId,
    });
  }

  private async buildAndPlace(
    position: Position,
    market: NormalizedMarket,
    eventType: "ladder_placed" | "ladder_rebuilt",
  ): Promise<LadderState | null> {
    const policy = this.policy();
    if (!policy.enabled) return null;
    const plan = computeProfileLadder({
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      openedAt: position.openedAt,
      avgEntryPrice: position.avgEntryPrice,
      costBasisUsd: position.costBasisUsdc,
      positionSizeShares: position.size,
      mode: "flat",
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      tickSize: market.tickSize,
      minOrderSize: market.minOrderSize ?? 1,
      config: policy,
      previousBand: this.deps.repository.getLadder(position.tokenId)?.band ?? null,
    });
    if (!plan.ok) return null;

    const now = this.now();
    const state: LadderState = {
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      ladderId: plan.ladderId,
      band: plan.band,
      phase: policy.phase,
      status: "active",
      activeRungs: plan.rungs,
      filledRungs: [],
      lastAvgEntry: position.avgEntryPrice,
      lastCostBasisUsdc: position.costBasisUsdc,
      lastMode: "flat",
      lastBboReferenceJson: JSON.stringify({ bestBid: market.bestBid, bestAsk: market.bestAsk }),
      lastRebuildAtMs: now,
      lastFillAtMs: null,
      staleCheckedAtMs: null,
      qdHandoffAtMs: null,
      createdAtMs: this.deps.repository.getLadder(position.tokenId)?.createdAtMs ?? now,
      updatedAtMs: now,
      metadataJson: JSON.stringify({ eventType }),
    };
    this.deps.repository.upsertLadder(state);

    for (const rung of plan.rungs) {
      await this.publishPlaceOrder(position, market, plan.ladderId, rung, now);
    }
    return state;
  }

  private async publishPlaceOrder(
    position: Position,
    market: NormalizedMarket,
    ladderId: string,
    rung: LadderRung,
    timestamp: number,
  ): Promise<void> {
    const signalId = `profile_ladder_${String(position.tokenId)}_${ladderId}_${rung.rungIndex}`;
    await this.deps.bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId(signalId),
        clientOrderId: buildClientOrderId({
          signalId,
          tokenId: position.tokenId,
          side: "sell",
        }),
        source: "strategy",
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        side: "sell",
        size: rung.sizeShares,
        price: rung.price,
        postOnly: true,
        orderType: "GTC",
        tickSize: market.tickSize,
        negRisk: market.negRisk,
        sequenceInTick: rung.rungIndex,
        signalReason: "profile-ladder-exit",
        signalId,
        decisionRuleId: this.policy().decisionRuleId,
        signalTimestamp: new Date(timestamp).toISOString(),
        metadata: {
          source: this.policy().orderTag,
          profileLadder: {
            ladderId,
            rungIndex: rung.rungIndex,
            multiplier: rung.multiplier,
            sizingFraction: rung.sizingFraction,
          },
        },
      },
      timestamp,
    });
  }

  private handleFillReceived(event: RuntimeEventMap["FillReceived"]): void {
    if (event.side !== "sell") return;
    const state = this.deps.repository.getLadder(event.tokenId);
    if (state == null) return;
    const activeRungs = state.activeRungs.map((rung) => {
      if (rung.orderId !== String(event.orderId)) return rung;
      const filledSizeShares = roundQuantity(rung.filledSizeShares + event.size);
      return {
        ...rung,
        filledSizeShares,
        lifecycle:
          filledSizeShares + 1e-9 >= rung.sizeShares
            ? ("filled" as const)
            : ("partially_filled" as const),
      };
    });
    if (activeRungs === state.activeRungs) return;

    const updated = {
      ...state,
      activeRungs,
      lastFillAtMs: event.timestamp,
      updatedAtMs: event.timestamp,
    };
    this.deps.repository.upsertLadder(updated);
    if (activeRungs.some((rung) => rung.lifecycle === "partially_filled")) {
      this.writeCounter("profile_ladder_partial_fill_held", 1, { band: state.band });
    }
  }

  private policy(): ExecutionProfilePolicy["sellLadder"] {
    return this.deps.policy().sellLadder;
  }

  private isBboCooldownActive(tokenId: TokenId): boolean {
    return (this.bboCooldownUntilByToken.get(String(tokenId)) ?? 0) > this.now();
  }

  private writeCounter(
    name: string,
    value: number,
    labels?: Readonly<Record<string, string>>,
  ): void {
    this.deps.runtimeMetrics?.writeCounter(
      name,
      value,
      labels == null ? undefined : JSON.stringify(labels),
    );
  }

  private insertRiskEvent(eventType: string, payload: Readonly<Record<string, unknown>>): void {
    this.deps.riskEvents?.insert({ eventType, payload });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function isBboReason(reason: string): boolean {
  return reason === "bbo_major" || reason === "bbo_strong";
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}
