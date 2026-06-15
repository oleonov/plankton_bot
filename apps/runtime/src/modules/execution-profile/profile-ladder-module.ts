import type {
  EventBus,
  LadderRung,
  LadderState,
  NormalizedMarket,
  OrderId,
  Position,
  ProfileLadderMode,
  RuntimeEventMap,
  RuntimeModule,
  TokenId,
} from "@krabs/domain";
import { PositionStatus, createCommandId, createPositionId } from "@krabs/domain";
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

export interface ProfileLadderModeReader {
  getMode(tokenId: TokenId): ProfileLadderMode | null;
}

export interface ProfileLadderModuleDeps {
  bus: EventBus;
  repository: ProfileLadderRepository;
  policy: () => ExecutionProfilePolicy;
  modeReader?: ProfileLadderModeReader;
  runtimeMetrics?: ProfileLadderMetricWriter;
  riskEvents?: ProfileLadderRiskEventWriter;
  now?: () => number;
}

export class ProfileLadderModule implements RuntimeModule {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly bboCooldownUntilByToken = new Map<string, number>();
  private readonly marketByToken = new Map<string, NormalizedMarket>();
  private readonly scaleInBuyPendingByToken = new Set<string>();
  private readonly pendingRungByClientOrderId = new Map<
    string,
    { tokenId: TokenId; rungIndex: number }
  >();
  private started = false;

  constructor(private readonly deps: ProfileLadderModuleDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.policy().enabled) return;
    this.unsubscribers.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", async (event) => {
        await this.handleMarketUpdate(event);
      }),
      this.deps.bus.subscribe("PositionUpdated", async ({ position }) => {
        await this.handlePositionUpdated(position);
      }),
      this.deps.bus.subscribe("FillReceived", async (event) => {
        this.handleFillReceived(event);
      }),
      this.deps.bus.subscribe("OrderPlaced", async (event) => {
        this.handleOrderPlaced(event);
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

  private async handleMarketUpdate(
    event: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of event.markets) {
      this.marketByToken.set(String(market.tokenId), market);
      const state = this.deps.repository.getLadder(market.tokenId);
      if (state == null) continue;

      const reason = resolveBboRebuildReason(state, market, this.policy());
      if (reason == null) continue;
      await this.rebuildLadder(positionFromLadderState(state), market, reason);
    }
  }

  private async handlePositionUpdated(position: Position): Promise<void> {
    if (position.status === PositionStatus.Closed || position.size <= 0) {
      this.scaleInBuyPendingByToken.delete(String(position.tokenId));
      await this.cancelLadder(position.tokenId, "position_closed");
      return;
    }

    const market = this.marketByToken.get(String(position.tokenId));
    if (market == null) return;

    const state = this.deps.repository.getLadder(position.tokenId);
    if (state == null) {
      await this.placeLadder(position, market);
      return;
    }

    if (
      this.scaleInBuyPendingByToken.has(String(position.tokenId)) ||
      hasPositionBasisChanged(state, position)
    ) {
      this.scaleInBuyPendingByToken.delete(String(position.tokenId));
      await this.rebuildLadder(position, market, "scale_in");
    }
  }

  private async buildAndPlace(
    position: Position,
    market: NormalizedMarket,
    eventType: "ladder_placed" | "ladder_rebuilt",
  ): Promise<LadderState | null> {
    const policy = this.policy();
    if (!policy.enabled) return null;
    const mode = this.resolveMode(position, market);
    const plan = computeProfileLadder({
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      openedAt: position.openedAt,
      avgEntryPrice: position.avgEntryPrice,
      costBasisUsd: position.costBasisUsdc,
      positionSizeShares: position.size,
      mode,
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
      lastMode: mode,
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

  private resolveMode(position: Position, market: NormalizedMarket): ProfileLadderMode {
    if (this.deps.modeReader != null) {
      const mode = this.deps.modeReader.getMode(position.tokenId);
      if (mode != null) return mode;
      this.writeCounter("profile_ladder_mode_missing", 1);
      return "flat";
    }
    return resolveSignalBasedMode(position, market, this.deps.policy());
  }

  private async publishPlaceOrder(
    position: Position,
    market: NormalizedMarket,
    ladderId: string,
    rung: LadderRung,
    timestamp: number,
  ): Promise<void> {
    const signalId = `profile_ladder_${String(position.tokenId)}_${ladderId}_${rung.rungIndex}`;
    const clientOrderId = buildClientOrderId({
      signalId,
      tokenId: position.tokenId,
      side: "sell",
    });
    this.pendingRungByClientOrderId.set(String(clientOrderId), {
      tokenId: position.tokenId,
      rungIndex: rung.rungIndex,
    });
    await this.deps.bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId(signalId),
        clientOrderId,
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

  private handleOrderPlaced(event: RuntimeEventMap["OrderPlaced"]): void {
    const pending = this.pendingRungByClientOrderId.get(String(event.clientOrderId));
    if (pending == null) return;

    const state = this.deps.repository.getLadder(pending.tokenId);
    this.pendingRungByClientOrderId.delete(String(event.clientOrderId));
    if (state == null) return;

    let matched = false;
    const activeRungs = state.activeRungs.map((rung) => {
      if (rung.rungIndex !== pending.rungIndex) return rung;
      matched = true;
      return {
        ...rung,
        orderId: String(event.orderId),
        lifecycle: rung.lifecycle === "planned" ? ("placed" as const) : rung.lifecycle,
      };
    });
    if (!matched) return;
    this.deps.repository.upsertLadder({
      ...state,
      activeRungs,
      updatedAtMs: event.timestamp,
    });
  }

  private handleFillReceived(event: RuntimeEventMap["FillReceived"]): void {
    if (event.side === "buy") {
      this.scaleInBuyPendingByToken.add(String(event.tokenId));
      return;
    }
    if (event.side !== "sell") return;
    const state = this.deps.repository.getLadder(event.tokenId);
    if (state == null) return;
    let matched = false;
    const activeRungs = state.activeRungs.map((rung) => {
      if (rung.orderId !== String(event.orderId)) return rung;
      matched = true;
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
    if (!matched) return;

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

function resolveBboRebuildReason(
  state: LadderState,
  market: NormalizedMarket,
  policy: ExecutionProfilePolicy["sellLadder"],
): "bbo_major" | "bbo_strong" | null {
  const reference = parseBboReference(state.lastBboReferenceJson);
  if (
    reference == null ||
    !isPositiveFinite(reference.bestBid) ||
    !isPositiveFinite(reference.bestAsk) ||
    !isPositiveFinite(market.bestBid) ||
    !isPositiveFinite(market.bestAsk)
  ) {
    return null;
  }

  const bidMove = Math.abs(market.bestBid - reference.bestBid) / reference.bestBid;
  const askMove = Math.abs(market.bestAsk - reference.bestAsk) / reference.bestAsk;
  const move = Math.max(bidMove, askMove);
  if (move >= policy.reprice.strongBboMovePct) return "bbo_strong";
  if (move >= policy.reprice.majorBboMovePct) return "bbo_major";
  return null;
}

function parseBboReference(
  raw: string | null,
): { bestBid: number | null; bestAsk: number | null } | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<{ bestBid: unknown; bestAsk: unknown }>;
    return {
      bestBid: typeof parsed.bestBid === "number" ? parsed.bestBid : null,
      bestAsk: typeof parsed.bestAsk === "number" ? parsed.bestAsk : null,
    };
  } catch {
    return null;
  }
}

function positionFromLadderState(state: LadderState): Position {
  const size =
    isPositiveFinite(state.lastAvgEntry) && isPositiveFinite(state.lastCostBasisUsdc)
      ? state.lastCostBasisUsdc / state.lastAvgEntry
      : 0;
  const openedAt = new Date(state.createdAtMs).toISOString();
  return {
    positionId: createPositionId(`profile-ladder-rebuild-${String(state.tokenId)}`),
    tokenId: state.tokenId,
    conditionId: state.conditionId,
    side: "buy",
    size,
    avgEntryPrice: state.lastAvgEntry,
    costBasisUsdc: state.lastCostBasisUsdc,
    currentValueUsdc: state.lastCostBasisUsdc,
    realizedPnl: 0,
    status: PositionStatus.Open,
    entryStyle: "probe",
    openedAt,
    closedAt: null,
    updatedAt: new Date(state.updatedAtMs).toISOString(),
  };
}

function hasPositionBasisChanged(state: LadderState, position: Position): boolean {
  return (
    Math.abs(state.lastAvgEntry - position.avgEntryPrice) > 1e-9 ||
    Math.abs(state.lastCostBasisUsdc - position.costBasisUsdc) > 1e-6
  );
}

function resolveSignalBasedMode(
  position: Position,
  market: NormalizedMarket,
  policy: ExecutionProfilePolicy,
): ProfileLadderMode {
  const mark = firstPositiveFinite(market.bestAsk, market.midPrice, market.lastTradePrice);
  if (mark == null) return "flat";

  const profile =
    position.avgEntryPrice < 0.05
      ? "cheap"
      : position.avgEntryPrice < 0.35
        ? "medium"
        : "expensive";
  const config = policy.profiles[profile].scaleIn;
  if (mark > position.avgEntryPrice * (1 + config.modes.up.thresholdPct)) return "up";
  if (mark < position.avgEntryPrice * (1 - config.modes.avgDown.thresholdPct)) return "avg_down";
  return "flat";
}

function firstPositiveFinite(...values: ReadonlyArray<number | null | undefined>): number | null {
  return values.find((value): value is number => isPositiveFinite(value)) ?? null;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}
