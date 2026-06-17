import type {
  EventBus,
  LadderRung,
  LadderState,
  NormalizedMarket,
  Order,
  OrderBookSnapshot,
  OrderId,
  Position,
  ProfileLadderBand,
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

type ProfileLadderBookCacheStatus =
  | "fresh-cache"
  | "refreshed"
  | "cache-miss"
  | "cache-stale"
  | "refresh-budget-exhausted"
  | "refresh-failed";

export interface ProfileLadderBookCache {
  getFreshOrRefresh(
    tokenId: string,
    nowMs?: number,
  ): Promise<{
    entry: {
      bookSource: "clob";
      sourceKind: "ws" | "rest";
      book: OrderBookSnapshot;
    } | null;
    status: ProfileLadderBookCacheStatus;
  }>;
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
  bookCache?: ProfileLadderBookCache | undefined;
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
export const PLANNED_RUNG_RETRY_MS = 60_000;

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
  skipped_unknown_min_order_size: number;
  skipped_not_profile_owned: number;
  skipped_band_disabled: number;
  skipped_existing_sell_order: number;
  skipped_dormant: number;
  // planned_rung_count is the full target ladder size across adopted positions;
  // estimated_order_count is retained for existing operator dashboards and now
  // intentionally mirrors placed_live_rung_count under the conservative cap.
  planned_rung_count: number;
  estimated_order_count: number;
  placed_live_rung_count: number;
  planned_only_ladder_count: number;
  retryable_skip_count: number;
}

interface LiveRungAdvanceResult {
  placed: number;
  skippedUnknownMinOrderSize: number;
  attempted: boolean;
}

interface ProfileLadderOrderMarketData {
  bookSource: NonNullable<NormalizedMarket["bookSource"]>;
  minOrderSize: number;
  effectiveMinOrderSize: number;
  tickSize: number;
  cacheStatus?: "base-market" | ProfileLadderBookCacheStatus;
}

export class ProfileLadderModule implements RuntimeModule {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly bboCooldownUntilByToken = new Map<string, number>();
  private readonly marketByToken = new Map<string, NormalizedMarket>();
  private readonly scaleInBuyPendingByToken = new Set<string>();
  private readonly pendingRungByClientOrderId = new Map<
    string,
    { tokenId: TokenId; ladderId: string; rungIndex: number }
  >();
  private readonly plannedRungRetryCooldownUntilByToken = new Map<string, number>();
  private readonly missingLadderRecoveryCooldownUntilByToken = new Map<string, number>();
  private readonly pendingRebuildDeferCooldownUntilByToken = new Map<string, number>();
  // Plankton post-fill REST: one bounded reevaluation timer per token. A SELL
  // fill never places the next rung inline; it schedules a delayed reevaluation.
  private readonly postFillTimerByToken = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;
  private adoptionDone = false;
  private adoptionTimer: ReturnType<typeof setTimeout> | undefined;
  private plannedRungRecoveryTimer: ReturnType<typeof setInterval> | undefined;
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
      this.deps.bus.subscribe("OrderRejected", async (event) => {
        this.handlePendingOrderResolved(event.clientOrderId);
      }),
      this.deps.bus.subscribe("OrderSkipped", async (event) => {
        this.handlePendingOrderResolved(event.clientOrderId);
      }),
    );
    this.started = true;
    this.adoptExistingEnabled = this.policy().adoptExisting.enabled;
    this.ensurePolicyReloadSubscription();
    this.startPlannedRungRecoveryTimer();
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
    if (this.plannedRungRecoveryTimer != null) {
      clearInterval(this.plannedRungRecoveryTimer);
      this.plannedRungRecoveryTimer = undefined;
    }
    for (const timer of this.postFillTimerByToken.values()) clearTimeout(timer);
    this.postFillTimerByToken.clear();
    this.plannedRungRetryCooldownUntilByToken.clear();
    this.missingLadderRecoveryCooldownUntilByToken.clear();
    this.pendingRebuildDeferCooldownUntilByToken.clear();
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
    const result = await this.buildAndPlace(position, market, "ladder_placed");
    if (result == null) return;
    const { state } = result;
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
      skipped_unknown_min_order_size: 0,
      skipped_not_profile_owned: 0,
      skipped_band_disabled: 0,
      skipped_existing_sell_order: 0,
      skipped_dormant: 0,
      planned_rung_count: 0,
      estimated_order_count: 0,
      placed_live_rung_count: 0,
      planned_only_ladder_count: 0,
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
    const result = await this.buildAndPlace(position, market, "ladder_adopted", "flat");
    if (result == null) return;
    const { state, placedLiveRungs } = result;
    summary.adopted_count += 1;
    summary.planned_rung_count += state.activeRungs.length;
    summary.estimated_order_count += placedLiveRungs;
    summary.placed_live_rung_count += placedLiveRungs;
    summary.skipped_unknown_min_order_size += result.skippedUnknownMinOrderSize;
    if (placedLiveRungs === 0 && state.activeRungs.some((rung) => rung.lifecycle === "planned")) {
      summary.planned_only_ladder_count += 1;
    }
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
    const existing = this.deps.repository.getLadder(position.tokenId);
    if (this.hasPendingRungForToken(position.tokenId)) {
      const band = existing?.band ?? resolveLadderBand(position.avgEntryPrice, this.policy().bands);
      if (band != null) {
        this.writePendingRebuildDeferredCounter(position.tokenId, band);
      }
      return;
    }

    const result = await this.buildAndPlace(position, market, "ladder_rebuilt");
    if (result == null) return;
    const { state } = result;
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
      if (state == null) {
        await this.recoverMissingAdoptedLadderIfReady(market);
        continue;
      }
      if (this.isDormant(market.tokenId)) {
        this.writeCounter("ladder_rebuild_skipped_dormant", 1);
        continue;
      }

      const plannedRetry = await this.retryPlannedLiveRungsIfReady(state, market);
      if (plannedRetry) continue;

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
  ): Promise<{
    state: LadderState;
    placedLiveRungs: number;
    skippedUnknownMinOrderSize: number;
  } | null> {
    const policy = this.policy();
    if (!policy.enabled) return null;
    const previous = this.deps.repository.getLadder(position.tokenId);
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
      previousBand: previous?.band ?? null,
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
      activeRungs: mergeLiveRungs(plan.rungs, previous),
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
      createdAtMs: previous?.createdAtMs ?? now,
      updatedAtMs: now,
      metadataJson: JSON.stringify({ eventType }),
    };
    this.deps.repository.upsertLadder(state);

    this.writeCounter("profile_ladder_planned_rungs", plan.rungs.length, { band: plan.band });
    const liveRungs = await this.advanceLiveRungs(state, market, now);
    this.writeCounter("profile_ladder_placed_live_rungs", liveRungs.placed, { band: plan.band });
    if (liveRungs.placed === 0 && state.activeRungs.some((rung) => rung.lifecycle === "planned")) {
      this.writeCounter("profile_ladder_planned_only_ladder_count", 1, { band: plan.band });
    }
    return {
      state,
      placedLiveRungs: liveRungs.placed,
      skippedUnknownMinOrderSize: liveRungs.skippedUnknownMinOrderSize,
    };
  }

  // Plankton conservative cap: the builder produces the full price ladder, but
  // only the first `maxConcurrentRungs` (default 1) sell rungs ever go live at
  // once. Occupancy counts rungs already placed/partially filled plus any
  // profile-ladder rung still in flight for this token, even if a later rebuild
  // would compute a different ladderId.
  private async advanceLiveRungs(
    state: LadderState,
    market: NormalizedMarket,
    now: number,
  ): Promise<LiveRungAdvanceResult> {
    const cap = this.resolveLiveRungCap(state.band);
    const pendingRungsForToken = this.pendingRungsForToken(state.tokenId);
    const pendingRungIndexes = this.pendingRungIndexesFor(state);
    let occupied =
      state.activeRungs.filter(
        (rung) => rung.lifecycle === "placed" || rung.lifecycle === "partially_filled",
      ).length + pendingRungsForToken.length;
    const position = positionFromLadderState(state);
    let placed = 0;
    let skippedUnknownMinOrderSize = 0;
    let attempted = false;
    for (const rung of state.activeRungs) {
      if (occupied >= cap) break;
      const submittable =
        rung.lifecycle === "planned" &&
        rung.orderId == null &&
        !pendingRungIndexes.has(rung.rungIndex);
      if (!submittable) continue;
      attempted = true;
      // Plankton no-taker-sell: a post-only SELL at/below the best bid would
      // cross and execute as a taker. Skip it (it never goes live) and let the
      // loop rest the slot on the next non-crossing planned rung, if any.
      if (wouldCrossPostOnly(rung.price, market.bestBid)) {
        this.writeCounter("profile_ladder_skipped_crossing_post_only", 1, { band: state.band });
        continue;
      }
      const marketData = await this.resolveOrderMarketData(state.band, market, now);
      if (marketData == null) {
        this.writeCounter("profile_ladder_skipped_unknown_min_order_size", 1, {
          band: state.band,
        });
        this.armPlannedRungRetryCooldown(state.tokenId, now);
        skippedUnknownMinOrderSize += 1;
        break;
      }
      await this.publishPlaceOrder(position, market, marketData, state.ladderId, rung, now);
      occupied += 1;
      placed += 1;
    }
    return { placed, skippedUnknownMinOrderSize, attempted };
  }

  private startPlannedRungRecoveryTimer(): void {
    if (this.plannedRungRecoveryTimer != null) return;
    this.plannedRungRecoveryTimer = setInterval(() => {
      void this.retryPlannedLiveRungsForCachedMarkets();
    }, PLANNED_RUNG_RETRY_MS);
    this.plannedRungRecoveryTimer.unref?.();
  }

  private async retryPlannedLiveRungsForCachedMarkets(): Promise<void> {
    for (const state of this.deps.repository.findActive()) {
      if (this.isDormant(state.tokenId)) continue;
      if (this.postFillTimerByToken.has(String(state.tokenId))) continue;
      const market = this.marketByToken.get(String(state.tokenId));
      if (market == null) continue;
      await this.retryPlannedLiveRungsIfReady(state, market);
    }
  }

  private async retryPlannedLiveRungsIfReady(
    state: LadderState,
    market: NormalizedMarket,
  ): Promise<boolean> {
    if (!this.canRetryPlannedLiveRungs(state)) return false;
    const result = await this.advanceLiveRungs(state, market, this.now());
    if (result.attempted) {
      this.armPlannedRungRetryCooldown(state.tokenId, this.now());
      return true;
    }
    return false;
  }

  private canRetryPlannedLiveRungs(state: LadderState): boolean {
    if (state.status !== "active") return false;
    if (this.postFillTimerByToken.has(String(state.tokenId))) return false;
    if (this.isPlannedRungRetryCooldownActive(state.tokenId)) return false;
    if (!state.activeRungs.some((rung) => rung.lifecycle === "planned" && rung.orderId == null)) {
      return false;
    }
    const occupied =
      state.activeRungs.filter(
        (rung) => rung.lifecycle === "placed" || rung.lifecycle === "partially_filled",
      ).length + this.pendingRungsForToken(state.tokenId).length;
    return occupied < this.resolveLiveRungCap(state.band);
  }

  private isPlannedRungRetryCooldownActive(tokenId: TokenId): boolean {
    return (this.plannedRungRetryCooldownUntilByToken.get(String(tokenId)) ?? 0) > this.now();
  }

  private armPlannedRungRetryCooldown(tokenId: TokenId, now: number): void {
    this.plannedRungRetryCooldownUntilByToken.set(String(tokenId), now + PLANNED_RUNG_RETRY_MS);
  }

  private async recoverMissingAdoptedLadderIfReady(market: NormalizedMarket): Promise<void> {
    const sellLadder = this.policy();
    if (!sellLadder.enabled || !sellLadder.adoptExisting.enabled) return;
    if (!this.adoptionDone) return;
    if (this.deps.positionRepo == null || this.deps.isProfileOwned == null) return;
    const tokenKey = String(market.tokenId);
    if ((this.missingLadderRecoveryCooldownUntilByToken.get(tokenKey) ?? 0) > this.now()) return;
    if (this.isDormant(market.tokenId)) return;
    if (!this.deps.isProfileOwned(market.tokenId)) return;
    if (!isValidLadderBbo(market.bestBid, market.bestAsk)) {
      this.armMissingLadderRecoveryCooldown(market.tokenId);
      return;
    }
    if (this.hasOpenSellOrder(market.tokenId)) {
      this.armMissingLadderRecoveryCooldown(market.tokenId);
      return;
    }

    const position = this.findOpenPosition(market.tokenId);
    if (position == null) return;
    const band = resolveLadderBand(position.avgEntryPrice, sellLadder.bands);
    if (band == null || !sellLadder.bands[band].enabled) {
      this.armMissingLadderRecoveryCooldown(market.tokenId);
      return;
    }

    const result = await this.buildAndPlace(position, market, "ladder_adopted", "flat");
    if (result == null) {
      this.armMissingLadderRecoveryCooldown(market.tokenId);
      return;
    }
    const { state } = result;
    this.writeCounter("profile_ladder_adopted", 1, { band: state.band });
    this.insertRiskEvent("ladder_adopted", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      band: state.band,
      rungCount: state.activeRungs.length,
      ladderId: state.ladderId,
      source: "adopted_recovery",
    });
  }

  private findOpenPosition(tokenId: TokenId): Position | null {
    const tokenKey = String(tokenId);
    return (
      this.deps.positionRepo
        ?.findOpen()
        .find((position) => String(position.tokenId) === tokenKey && position.size > 0) ?? null
    );
  }

  private armMissingLadderRecoveryCooldown(tokenId: TokenId): void {
    this.missingLadderRecoveryCooldownUntilByToken.set(
      String(tokenId),
      this.now() + PLANNED_RUNG_RETRY_MS,
    );
  }

  private writePendingRebuildDeferredCounter(tokenId: TokenId, band: ProfileLadderBand): void {
    const tokenKey = String(tokenId);
    if ((this.pendingRebuildDeferCooldownUntilByToken.get(tokenKey) ?? 0) > this.now()) return;
    this.pendingRebuildDeferCooldownUntilByToken.set(tokenKey, this.now() + PLANNED_RUNG_RETRY_MS);
    this.writeCounter("profile_ladder_rebuild_deferred_due_pending_order", 1, { band });
  }

  private resolveLiveRungCap(band: ProfileLadderBand): number {
    return Math.max(1, this.policy().bands[band].maxConcurrentRungs);
  }

  private pendingRungIndexesFor(state: LadderState): Set<number> {
    const indexes = new Set<number>();
    for (const pending of this.pendingRungsForToken(state.tokenId)) {
      if (pending.ladderId === state.ladderId) {
        indexes.add(pending.rungIndex);
      }
    }
    return indexes;
  }

  private pendingRungsForToken(
    tokenId: TokenId,
  ): ReadonlyArray<{ tokenId: TokenId; ladderId: string; rungIndex: number }> {
    const tokenKey = String(tokenId);
    return [...this.pendingRungByClientOrderId.values()].filter(
      (pending) => String(pending.tokenId) === tokenKey,
    );
  }

  private hasPendingRungForToken(tokenId: TokenId): boolean {
    return this.pendingRungsForToken(tokenId).length > 0;
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
    marketData: ProfileLadderOrderMarketData,
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
      ladderId,
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
          ...(marketData.cacheStatus == null ? {} : { cacheStatus: marketData.cacheStatus }),
          marketData,
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

  private async resolveOrderMarketData(
    band: ProfileLadderBand,
    market: NormalizedMarket,
    now: number,
  ): Promise<ProfileLadderOrderMarketData | null> {
    const marketData = this.resolveOrderMarketDataFromMarket(market);
    if (marketData != null) return marketData;

    const resolution = await this.deps.bookCache?.getFreshOrRefresh(String(market.tokenId), now);
    const book = resolution?.entry?.book;
    const minOrderSize = book?.minOrderSize;
    if (typeof minOrderSize !== "number" || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
      if (resolution != null) {
        this.writeCounter("profile_ladder_min_order_size_hydration_miss", 1, { band });
      }
      return null;
    }
    const cacheStatus = resolution?.status ?? "refreshed";
    this.writeCounter("profile_ladder_min_order_size_hydrated_from_book_cache", 1, {
      band,
      source: cacheStatus,
    });
    return {
      bookSource: resolution?.entry?.bookSource ?? "clob",
      minOrderSize,
      effectiveMinOrderSize: minOrderSize,
      tickSize: market.tickSize,
      cacheStatus,
    };
  }

  private resolveOrderMarketDataFromMarket(
    market: NormalizedMarket,
  ): ProfileLadderOrderMarketData | null {
    const minOrderSize = market.minOrderSize;
    if (typeof minOrderSize !== "number" || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
      return null;
    }
    return {
      bookSource: market.bookSource ?? "unknown",
      minOrderSize,
      effectiveMinOrderSize: minOrderSize,
      tickSize: market.tickSize,
      cacheStatus: "base-market",
    };
  }

  private handleOrderPlaced(event: RuntimeEventMap["OrderPlaced"]): void {
    const pending = this.pendingRungByClientOrderId.get(String(event.clientOrderId));
    if (pending == null) return;

    const state = this.deps.repository.getLadder(pending.tokenId);
    this.pendingRungByClientOrderId.delete(String(event.clientOrderId));
    if (state == null) return;
    // A stale backfill for a superseded ladder (e.g. rebuilt under a new
    // ladderId) must not mutate the current ladder's rungs.
    if (state.ladderId !== pending.ladderId) return;

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

  private handlePendingOrderResolved(
    clientOrderId: RuntimeEventMap["OrderRejected"]["clientOrderId"],
  ): void {
    this.pendingRungByClientOrderId.delete(String(clientOrderId));
  }

  private handleFillReceived(event: RuntimeEventMap["FillReceived"]): void {
    if (event.side === "buy") {
      this.scaleInBuyPendingByToken.add(String(event.tokenId));
      return;
    }
    if (event.side !== "sell") return;
    const state = this.deps.repository.getLadder(event.tokenId);
    if (state == null) return;
    let matchedIndex = -1;
    const activeRungs = state.activeRungs.map((rung) => {
      if (rung.orderId !== String(event.orderId)) return rung;
      matchedIndex = rung.rungIndex;
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
    if (matchedIndex < 0) return;

    const updated = {
      ...state,
      activeRungs,
      lastFillAtMs: event.timestamp,
      updatedAtMs: event.timestamp,
    };
    this.deps.repository.upsertLadder(updated);
    const filledRung = activeRungs.find((rung) => rung.rungIndex === matchedIndex);
    if (filledRung == null) return;
    if (filledRung.lifecycle === "partially_filled") {
      this.writeCounter("profile_ladder_partial_fill_held", 1, { band: state.band });
    }
    this.recordPostFill(updated, filledRung);
  }

  // Plankton post-fill REST: a SELL fill never triggers an immediate next-rung
  // placement. Record where the fill landed, then schedule a single bounded
  // reevaluation after the rest cooldown — the modal observed behavior is REST,
  // with the next live rung (if any) appearing only after a delay.
  private recordPostFill(state: LadderState, filledRung: LadderRung): void {
    const fillType = filledRung.lifecycle === "filled" ? "full" : "partial";
    const position = this.classifyFillPosition(state, filledRung.rungIndex);
    this.writeCounter("profile_ladder_fill_position", 1, { position, fillType, band: state.band });
    const delayMs = this.policy().postFill.reevalCooldownMs;
    this.writeCounter("profile_ladder_post_fill_delay_ms", delayMs, { band: state.band });
    this.schedulePostFillReeval(state.tokenId, delayMs);
  }

  private classifyFillPosition(
    state: LadderState,
    rungIndex: number,
  ): "bottom" | "middle" | "top" | "unknown" {
    const lastIndex = state.activeRungs.length - 1;
    if (rungIndex < 0 || rungIndex > lastIndex) return "unknown";
    if (rungIndex === 0) return "bottom";
    if (rungIndex === lastIndex) return "top";
    return "middle";
  }

  private schedulePostFillReeval(tokenId: TokenId, delayMs: number): void {
    const key = String(tokenId);
    // One reevaluation in flight per token — back-to-back fills coalesce into a
    // single delayed pass rather than stacking timers.
    if (this.postFillTimerByToken.has(key)) return;
    const timer = setTimeout(() => {
      this.postFillTimerByToken.delete(key);
      void this.reevaluateAfterFill(tokenId);
    }, delayMs);
    timer.unref?.();
    this.postFillTimerByToken.set(key, timer);
  }

  private async reevaluateAfterFill(tokenId: TokenId): Promise<void> {
    const state = this.deps.repository.getLadder(tokenId);
    if (state == null || state.status !== "active") return;
    if (this.isDormant(tokenId)) {
      this.writeCounter("ladder_rebuild_skipped_dormant", 1);
      return;
    }
    const market = this.marketByToken.get(String(tokenId));
    if (market == null) return;
    const placed = await this.advanceLiveRungs(state, market, this.now());
    this.writeCounter("profile_ladder_post_fill_action", 1, {
      action: placed.placed > 0 ? "place_next" : "rest",
      band: state.band,
    });
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

// A post-only SELL only rests as a maker when it sits strictly above the best
// bid; at or below the bid the exchange would either reject it or cross it into
// a taker fill. An unknown bid cannot be evaluated, so it is treated as safe.
function wouldCrossPostOnly(price: number, bestBid: number | null): boolean {
  return isPositiveFinite(bestBid) && price <= bestBid;
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}

// A rung owns a real resting order once OrderPlaced has backfilled its exchange
// orderId. Such a rung must never be silently replaced by a freshly-planned
// (orderId-null) rung during a rebuild, or the live order is orphaned: untracked
// in module state yet still resting on the exchange, breaking cap, fill matching,
// and cancellation.
function hasLiveOrder(rung: LadderRung): boolean {
  return (
    rung.orderId != null &&
    (rung.lifecycle === "placed" ||
      rung.lifecycle === "partially_filled" ||
      rung.lifecycle === "filled")
  );
}

function pricesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

// Rebuild ownership guard: a rebuild recomputes the planned vector, but any rung
// that already owns a live exchange order must survive that replacement.
// - Same target price still planned -> preserve the live rung wholesale
//   (orderId, lifecycle, filled size), re-seated at the new plan index.
// - No matching price (basis/profile shifted, price materially moved) -> the live
//   order can still rest, so keep it appended (option B: deferred replacement,
//   never orphaned). It still occupies the cap and remains matchable/cancellable.
function mergeLiveRungs(
  planRungs: readonly LadderRung[],
  previous: LadderState | null,
): LadderRung[] {
  const liveOld = (previous?.activeRungs ?? []).filter(hasLiveOrder);
  if (liveOld.length === 0) return planRungs.map((rung) => ({ ...rung }));

  const consumed = new Set<number>();
  const merged = planRungs.map((planRung) => {
    const matchIndex = liveOld.findIndex(
      (old, index) => !consumed.has(index) && pricesEqual(old.price, planRung.price),
    );
    if (matchIndex < 0) return { ...planRung };
    consumed.add(matchIndex);
    return { ...liveOld[matchIndex]!, rungIndex: planRung.rungIndex };
  });

  let tailIndex = planRungs.length;
  for (let index = 0; index < liveOld.length; index += 1) {
    if (consumed.has(index)) continue;
    merged.push({ ...liveOld[index]!, rungIndex: tailIndex });
    tailIndex += 1;
  }
  return merged;
}
