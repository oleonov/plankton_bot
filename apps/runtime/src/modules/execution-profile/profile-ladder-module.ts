import type {
  EventBus,
  LadderRung,
  LadderState,
  NormalizedMarket,
  Order,
  OrderId,
  Position,
  ProfileLadderMode,
  RuntimeEventMap,
  RuntimeModule,
  TokenId,
} from "@krabs/domain";
import { OrderStatus, PositionStatus, createCommandId, createPositionId } from "@krabs/domain";
import { buildClientOrderId } from "@krabs/domain/node";

import {
  computeProfileLadder,
  isValidLadderBbo,
  resolveLadderBand,
} from "./profile-ladder-builder.js";
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

export interface ProfileLadderPositionReader {
  findOpen(): Position[];
}

export interface ProfileLadderOrderReader {
  findByTokenId(tokenId: TokenId): Order[];
}

export interface ProfileLadderModuleDeps {
  bus: EventBus;
  repository: ProfileLadderRepository;
  policy: () => ExecutionProfilePolicy;
  modeReader?: ProfileLadderModeReader;
  isDormant?: ((tokenId: TokenId) => boolean) | undefined;
  // Adoption (Track #44) dependencies — only consulted when sellLadder.adoptExisting is enabled.
  positionRepo?: ProfileLadderPositionReader;
  orderRepo?: ProfileLadderOrderReader;
  isProfileOwned?: (tokenId: TokenId) => boolean;
  // Lets the module react to a sellLadder.adoptExisting false -> true hot-enable
  // while already started; returns an unsubscribe handle. Mirrors DustAutoCloseModule.
  onPolicyReload?: (handler: () => void) => () => void;
  runtimeMetrics?: ProfileLadderMetricWriter;
  riskEvents?: ProfileLadderRiskEventWriter;
  now?: () => number;
}

// Open SELL orders on the same token block adoption so an adopted ladder never
// stacks on legacy S1/D8/D9/repricing exits.
const OPEN_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.Pending,
  OrderStatus.Open,
  OrderStatus.PartiallyFilled,
]);

// Existing positions never replay PositionUpdated at startup, so adoption is the
// only path that places ladders for them. Defer one pass until the market cache
// warms from the scanner; positions still lacking BBO are reported, not adopted.
const ADOPTION_WARMUP_MS = 60_000;

// Tokens skipped only because their market/BBO had not warmed yet are retried on a
// bounded schedule; every other skip (not owned, band disabled, existing ladder or
// open SELL, dormant) is final. The attempt cap stops a permanently missing market
// from looping forever — after MAX_ADOPTION_ATTEMPTS the pass latches done.
export const ADOPTION_RETRY_MS = 60_000;
export const MAX_ADOPTION_ATTEMPTS = 5;

interface LadderAdoptionSummary {
  attempt: number;
  eligible_count: number;
  adopted_count: number;
  skipped_existing_ladder: number;
  skipped_missing_market: number;
  skipped_not_profile_owned: number;
  skipped_band_disabled: number;
  skipped_existing_sell_order: number;
  skipped_dormant: number;
  estimated_order_count: number;
  retryable_skip_count: number;
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
  private adoptionDone = false;
  private adoptionTimer: ReturnType<typeof setTimeout> | undefined;
  private adoptionAttemptCount = 0;
  private adoptExistingEnabled = false;
  private policyReloadUnsubscribe: (() => void) | undefined;

  constructor(private readonly deps: ProfileLadderModuleDeps) {}

  async start(): Promise<void> {
    if (this.started) return;
    // Stay inert (without latching started) while disabled so a later hot-enable
    // can subscribe on a subsequent start() instead of being permanently poisoned.
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
    this.started = true;
    this.adoptExistingEnabled = this.policy().adoptExisting.enabled;
    this.ensurePolicyReloadSubscription();
    this.scheduleAdoption();
  }

  async stop(): Promise<void> {
    while (this.unsubscribers.length > 0) this.unsubscribers.pop()?.();
    this.policyReloadUnsubscribe?.();
    this.policyReloadUnsubscribe = undefined;
    if (this.adoptionTimer != null) {
      clearTimeout(this.adoptionTimer);
      this.adoptionTimer = undefined;
    }
    this.adoptionDone = false;
    this.adoptionAttemptCount = 0;
    this.adoptExistingEnabled = false;
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

  /**
   * Track #44 startup adoption: place ladders for already-open, profile-owned
   * positions that predate the sell ladder feature. Gated by both
   * sellLadder.enabled and sellLadder.adoptExisting.enabled. Conservative by
   * design — any pre-existing ladder or open SELL order skips the position.
   *
   * Idempotent: it latches `adoptionDone` once a pass finishes with no retryable
   * skips, so repeated calls (or a stale reload) never re-place ladders. Tokens
   * skipped only because their market/BBO had not warmed yet are retried on a
   * bounded schedule (ADOPTION_RETRY_MS, capped at MAX_ADOPTION_ATTEMPTS).
   */
  async adoptExistingLadders(): Promise<void> {
    const sellLadder = this.policy();
    if (!sellLadder.enabled || !sellLadder.adoptExisting.enabled) return;
    if (this.adoptionDone) return;
    // A pass is starting now: drop any pending warmup/retry timer so the
    // post-pass scheduler can install the next one without tripping its guard.
    if (this.adoptionTimer != null) {
      clearTimeout(this.adoptionTimer);
      this.adoptionTimer = undefined;
    }
    this.adoptionAttemptCount += 1;

    const summary: LadderAdoptionSummary = {
      attempt: this.adoptionAttemptCount,
      eligible_count: 0,
      adopted_count: 0,
      skipped_existing_ladder: 0,
      skipped_missing_market: 0,
      skipped_not_profile_owned: 0,
      skipped_band_disabled: 0,
      skipped_existing_sell_order: 0,
      skipped_dormant: 0,
      estimated_order_count: 0,
      retryable_skip_count: 0,
    };

    const maxPositions = this.deps.policy().maxTokensPerCycle;
    for (const position of (this.deps.positionRepo?.findOpen() ?? []).slice(0, maxPositions)) {
      await this.adoptPosition(position, sellLadder, summary);
    }

    summary.retryable_skip_count = summary.skipped_missing_market;
    const shouldRetry =
      summary.skipped_missing_market > 0 && this.adoptionAttemptCount < MAX_ADOPTION_ATTEMPTS;
    if (shouldRetry) {
      this.scheduleAdoption(ADOPTION_RETRY_MS);
    } else {
      this.adoptionDone = true;
    }
    this.insertRiskEvent("ladder_adoption_summary", { ...summary });
  }

  private async adoptPosition(
    position: Position,
    sellLadder: ExecutionProfilePolicy["sellLadder"],
    summary: LadderAdoptionSummary,
  ): Promise<void> {
    const tokenId = position.tokenId;
    if (!(this.deps.isProfileOwned?.(tokenId) ?? false)) {
      summary.skipped_not_profile_owned += 1;
      return;
    }
    if (this.deps.repository.getLadder(tokenId) != null) {
      summary.skipped_existing_ladder += 1;
      return;
    }
    if (this.isDormant(tokenId)) {
      summary.skipped_dormant += 1;
      return;
    }
    const market = this.marketByToken.get(String(tokenId));
    if (market == null || !isValidLadderBbo(market.bestBid, market.bestAsk)) {
      summary.skipped_missing_market += 1;
      return;
    }
    const band = resolveLadderBand(position.avgEntryPrice, sellLadder.bands);
    if (band == null || !sellLadder.bands[band].enabled) {
      summary.skipped_band_disabled += 1;
      return;
    }
    if (this.hasOpenSellOrder(tokenId)) {
      summary.skipped_existing_sell_order += 1;
      return;
    }

    summary.eligible_count += 1;
    const state = await this.buildAndPlace(position, market, "ladder_adopted", "flat");
    if (state == null) return;
    summary.adopted_count += 1;
    summary.estimated_order_count += state.activeRungs.length;
    this.writeCounter("profile_ladder_adopted", 1, { band: state.band });
    this.insertRiskEvent("ladder_adopted", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      band: state.band,
      rungCount: state.activeRungs.length,
      ladderId: state.ladderId,
      source: "adopted",
    });
  }

  private hasOpenSellOrder(tokenId: TokenId): boolean {
    const orders = this.deps.orderRepo?.findByTokenId(tokenId) ?? [];
    return orders.some((order) => order.side === "sell" && OPEN_ORDER_STATUSES.has(order.status));
  }

  private scheduleAdoption(delayMs: number = ADOPTION_WARMUP_MS): void {
    if (!this.started) return;
    const sellLadder = this.policy();
    if (!sellLadder.enabled || !sellLadder.adoptExisting.enabled) return;
    if (this.adoptionDone) return;
    // One timer at a time — no warmup/retry/reload spam stacking passes.
    if (this.adoptionTimer != null) return;
    this.adoptionTimer = setTimeout(() => {
      this.adoptionTimer = undefined;
      void this.adoptExistingLadders();
    }, delayMs);
    this.adoptionTimer.unref?.();
  }

  private ensurePolicyReloadSubscription(): void {
    if (this.policyReloadUnsubscribe != null) return;
    if (this.deps.onPolicyReload == null) return;
    this.policyReloadUnsubscribe = this.deps.onPolicyReload(() => {
      this.handlePolicyReload();
    });
  }

  // Hot-enable: when a live policy reload flips sellLadder.adoptExisting from
  // false to true while the module is already started, schedule a deferred
  // adoption pass. Other reloads (no transition, or a true->false flip) are
  // inert. Already-completed adoption (adoptionDone) is never rerun.
  private handlePolicyReload(): void {
    const enabledNow = this.policy().adoptExisting.enabled;
    const wasEnabled = this.adoptExistingEnabled;
    this.adoptExistingEnabled = enabledNow;
    if (wasEnabled || !enabledNow) return;
    if (!this.started || !this.policy().enabled || this.adoptionDone) return;
    this.scheduleAdoption();
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
      if (this.isDormant(market.tokenId)) {
        this.writeCounter("ladder_rebuild_skipped_dormant", 1);
        continue;
      }

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
    if (this.isDormant(position.tokenId)) {
      this.writeCounter("ladder_rebuild_skipped_dormant", 1);
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
    eventType: "ladder_placed" | "ladder_rebuilt" | "ladder_adopted",
    modeOverride?: ProfileLadderMode,
  ): Promise<LadderState | null> {
    const policy = this.policy();
    if (!policy.enabled) return null;
    const mode = this.resolveMode(position, market, modeOverride);
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
      closedAtMs: null,
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

  private resolveMode(
    position: Position,
    market: NormalizedMarket,
    modeOverride?: ProfileLadderMode,
  ): ProfileLadderMode {
    if (modeOverride != null) return modeOverride;
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

  private isDormant(tokenId: TokenId): boolean {
    return this.deps.isDormant?.(tokenId) === true;
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
