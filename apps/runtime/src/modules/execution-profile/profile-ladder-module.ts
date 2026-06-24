import type {
  EventBus,
  LadderBuilderOutput,
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
  TokenOrderLifetimeMode,
  RuntimeModule,
  TokenId,
} from "@krabs/domain";
import { OrderStatus, PositionStatus, createCommandId } from "@krabs/domain";
import { buildClientOrderId } from "@krabs/domain/node";

import {
  computeProfileLadder,
  isValidLadderBbo,
  resolveLadderBand,
} from "./profile-ladder-builder.js";
import {
  isProfileLadderOrder,
  orderMatchesOrderId,
  validateProfileLadderReplacementSellTarget,
} from "../profile-ladder-order-helpers.js";
import { resolvePositiveSellFloor } from "../../executable-price.js";
import type { ProfileLadderRepository } from "./profile-ladder-repository.js";
import type { ExecutionProfilePolicy, ProfileState } from "./types.js";

export interface ProfileLadderMetricWriter {
  writeCounter(name: string, value?: number, labels?: string): void;
}

export interface ProfileLadderRiskEventWriter {
  insert(event: { eventType: string; payload: Readonly<Record<string, unknown>> }): void;
}

export interface ProfileLadderModeReader {
  getMode(tokenId: TokenId): ProfileLadderMode | null;
}

export type ProfileLadderModeReaderMappedMode = "up" | "flat";

export interface ProfileLadderModeReaderConfig {
  enabled: boolean;
  darkCompareOnly: boolean;
  source: "algo_token_mode_state";
  mapping: Record<TokenOrderLifetimeMode, ProfileLadderModeReaderMappedMode>;
  missingBehavior: "local";
}

export interface ProfileLadderModeCandidate {
  source: "algo_token_mode_state";
  sourceMode: TokenOrderLifetimeMode;
  mappedMode: ProfileLadderModeReaderConfig["mapping"][TokenOrderLifetimeMode];
  modeStatus: "candidate" | "confirmed";
  modeConfidence: "low" | "medium" | "high";
}

export interface ProfileLadderModeCandidateReader {
  getCandidate(
    tokenId: TokenId,
    config: ProfileLadderModeReaderConfig,
  ): ProfileLadderModeCandidate | null;
}

export interface ProfileLadderProfileStateReader {
  getProfileState(tokenId: TokenId): ProfileState | null;
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

type StaleNoPositionSource =
  | "bbo_rebuild"
  | "planned_no_live_recovery"
  | "planned_rung_retry"
  | "post_fill_reeval";

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
  modeCandidateReader?: ProfileLadderModeCandidateReader;
  profileStateReader?: ProfileLadderProfileStateReader;
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

const DEFAULT_POST_REFILL_FOLLOW_THROUGH = {
  enabled: true,
  dryRun: true,
  replacementEnabled: false,
  minCoverageRatio: 0.5,
  priceDistanceImprovementPct: 0.1,
  minReplacementPriceImprovementRatio: 0.05,
  minMaterialPositionSizeShares: 1,
  replacementCooldownMs: 120_000,
  cancelAckTimeoutMs: 60_000,
} satisfies ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"];

const STALE_LIVE_RUNG_RISK_EVENT_DEDUPE_MS = 5 * 60_000;

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

interface BuildAndPlaceOptions {
  preservePreviousLiveRungs?: boolean;
  ladderIdSuffix?: string;
}

type PendingProfileLadderRung = {
  tokenId: TokenId;
  ladderId: string;
  rungIndex: number;
  kind: "standard" | "post_refill_replacement";
  oldOrderId?: string;
  createdAtMs?: number;
  deadlineAtMs?: number;
  band?: ProfileLadderBand;
  mode?: ProfileLadderMode;
  profileState?: ProfileLadderTelemetryState;
};

export interface PostRefillStaleLiveRungDecision {
  liveCoverageRatio: number;
  liveProfileLadderSellShares: number;
  liveRung: LadderRung;
  intendedRung: LadderRung;
  positiveFloorPrice: number;
  priceDistanceImprovementPct: number;
  coverageBucket: string;
  priceDistanceBucket: string;
}

export interface PostRefillLiveRungEvaluation {
  liveCoverageRatio: number;
  liveProfileLadderSellShares: number;
  coverageBucket: string;
  decision: PostRefillStaleLiveRungDecision | null;
}

type ProfileLadderTelemetryState = ProfileState | "unknown";

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
  private readonly pendingRungByClientOrderId = new Map<string, PendingProfileLadderRung>();
  private readonly plannedRungRetryCooldownUntilByToken = new Map<string, number>();
  private readonly missingLadderRecoveryCooldownUntilByToken = new Map<string, number>();
  private readonly pendingRebuildDeferCooldownUntilByToken = new Map<string, number>();
  private readonly staleLiveRungRiskEventDedupeUntilByKey = new Map<string, number>();
  private readonly replacementCooldownUntilByToken = new Map<string, number>();
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
        this.handlePendingOrderResolved(event);
      }),
      this.deps.bus.subscribe("OrderSkipped", async (event) => {
        this.handlePendingOrderResolved(event);
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
    this.pendingRungByClientOrderId.clear();
    this.replacementCooldownUntilByToken.clear();
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
    return this.findOpenSellOrders(tokenId).length > 0;
  }

  private findOpenSellOrders(tokenId: TokenId): Order[] {
    return (this.deps.orderRepo?.findByTokenId(tokenId) ?? []).filter(
      (order) => order.side === "sell" && OPEN_ORDER_STATUSES.has(order.status),
    );
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
    await this.recordPostRefillFollowThrough(position, market, state);
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
      if (state.status !== "active") continue;
      if (this.isDormant(market.tokenId)) {
        this.writeCounter("ladder_rebuild_skipped_dormant", 1);
        continue;
      }

      const stalePlannedRecovery = await this.recoverPlannedNoLiveLadderIfReady(state, market);
      if (stalePlannedRecovery) continue;

      const plannedRetry = await this.retryPlannedLiveRungsIfReady(state, market);
      if (plannedRetry) continue;

      const reason = resolveBboRebuildReason(state, market, this.policy());
      if (reason == null) continue;
      const position = this.resolveOpenPositionForActiveLadder(state, "bbo_rebuild");
      if (position == null) continue;
      await this.rebuildLadder(position, market, reason);
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
    if (state.status === "closed") {
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
    options: BuildAndPlaceOptions = {},
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
    const ladderId =
      options.ladderIdSuffix == null ? plan.ladderId : `${plan.ladderId}_${options.ladderIdSuffix}`;
    // GAP-2: surface every rung whose raw price was clamped up to the positive
    // sell floor. Bounded labels only (no token labels) — band/mode/rungIndex.
    for (const rung of plan.rungs) {
      if (rung.floored) {
        this.writeCounter("profile_ladder_rung_price_floored", 1, {
          band: plan.band,
          mode,
          rungIndex: String(rung.rungIndex),
        });
      }
    }
    this.emitModeReaderDarkCompare(position, market, policy, previous, mode, plan);

    const now = this.now();
    const state: LadderState = {
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      ladderId,
      band: plan.band,
      phase: policy.phase,
      status: "active",
      activeRungs:
        options.preservePreviousLiveRungs === false
          ? plan.rungs.map((rung) => ({ ...rung }))
          : mergeLiveRungs(plan.rungs, previous),
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
    const liveRungs = await this.advanceLiveRungs(state, market, now, position);
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
    position: Position,
  ): Promise<LiveRungAdvanceResult> {
    const cap = this.resolveLiveRungCap(state.band);
    const pendingRungsForToken = this.pendingRungsForToken(state.tokenId);
    const pendingRungIndexes = this.pendingRungIndexesFor(state);
    let occupied =
      state.activeRungs.filter(
        (rung) => rung.lifecycle === "placed" || rung.lifecycle === "partially_filled",
      ).length + pendingRungsForToken.length;
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
    this.sweepExpiredPendingReplacements(this.now());
    for (const state of this.deps.repository.findActive()) {
      if (this.isDormant(state.tokenId)) continue;
      if (this.postFillTimerByToken.has(String(state.tokenId))) continue;
      const market = this.marketByToken.get(String(state.tokenId));
      if (market == null) continue;
      if (await this.recoverPlannedNoLiveLadderIfReady(state, market)) continue;
      await this.retryPlannedLiveRungsIfReady(state, market);
    }
  }

  private async retryPlannedLiveRungsIfReady(
    state: LadderState,
    market: NormalizedMarket,
  ): Promise<boolean> {
    if (!this.canRetryPlannedLiveRungs(state)) return false;
    const position = this.resolveOpenPositionForActiveLadder(state, "planned_rung_retry");
    if (position == null) return true;
    const result = await this.advanceLiveRungs(state, market, this.now(), position);
    if (result.attempted) {
      this.armPlannedRungRetryCooldown(state.tokenId, this.now());
      return true;
    }
    return false;
  }

  private async recoverPlannedNoLiveLadderIfReady(
    state: LadderState,
    market: NormalizedMarket,
  ): Promise<boolean> {
    if (state.status !== "active") return false;
    if (this.deps.positionRepo == null || this.deps.orderRepo == null) return false;
    if (this.postFillTimerByToken.has(String(state.tokenId))) return false;
    if (!state.activeRungs.some((rung) => rung.lifecycle === "planned" && rung.orderId == null)) {
      return false;
    }
    if (this.isPlannedRungRetryCooldownActive(state.tokenId)) return true;
    if (this.hasPendingRungForToken(state.tokenId)) return false;

    const openSellOrders = this.findOpenSellOrders(state.tokenId);
    const position = this.resolveOpenPositionForActiveLadder(
      state,
      "planned_no_live_recovery",
      openSellOrders,
    );
    if (position == null) {
      return true;
    }
    const openProfileLadderOrders = openSellOrders.filter(isProfileLadderOrder);
    if (openProfileLadderOrders.length > 0) {
      if (!stateTracksAnyOrder(state, openProfileLadderOrders)) {
        this.armPlannedRungRetryCooldown(state.tokenId, this.now());
        return true;
      }
      return false;
    }
    if (openSellOrders.length > 0) {
      this.armPlannedRungRetryCooldown(state.tokenId, this.now());
      return true;
    }
    if (!isValidLadderBbo(market.bestBid, market.bestAsk)) {
      this.armPlannedRungRetryCooldown(state.tokenId, this.now());
      return true;
    }

    const result = await this.buildAndPlace(position, market, "ladder_rebuilt", undefined, {
      preservePreviousLiveRungs: false,
      ladderIdSuffix: "planned_no_live_recovery",
    });
    this.armPlannedRungRetryCooldown(state.tokenId, this.now());
    if (result == null) return true;

    this.writeCounter("profile_ladder_planned_no_live_recovered", 1, { band: result.state.band });
    this.insertRiskEvent("ladder_rebuilt", {
      tokenId: String(result.state.tokenId),
      conditionId: String(result.state.conditionId),
      band: result.state.band,
      reason: "planned_no_live_recovery",
      rungCount: result.state.activeRungs.length,
      placedLiveRungs: result.placedLiveRungs,
      ladderId: result.state.ladderId,
    });
    return true;
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

  private resolveOpenPositionForActiveLadder(
    state: LadderState,
    source: StaleNoPositionSource,
    openSellOrders: readonly Order[] | null = null,
  ): Position | null {
    if (this.deps.positionRepo == null) {
      this.skipActiveLadderWithoutOpenPosition(state, source, "position_reader_unavailable");
      return null;
    }
    const position = this.findOpenPosition(state.tokenId);
    if (position != null) return position;
    if (this.isPlannedRungRetryCooldownActive(state.tokenId)) return null;
    this.handleActiveLadderWithoutOpenPosition(state, source, openSellOrders);
    return null;
  }

  private handleActiveLadderWithoutOpenPosition(
    state: LadderState,
    source: StaleNoPositionSource,
    openSellOrders: readonly Order[] | null,
  ): void {
    if (this.deps.orderRepo == null) {
      this.skipActiveLadderWithoutOpenPosition(state, source, "order_reader_unavailable");
      return;
    }
    const currentOpenSellOrders = openSellOrders ?? this.findOpenSellOrders(state.tokenId);
    if (currentOpenSellOrders.length > 0) {
      this.skipActiveLadderWithoutOpenPosition(state, source, "open_sell_exists");
      return;
    }

    const closedAtMs = this.now();
    this.deps.repository.markClosed(state.tokenId, "stale_no_open_position", closedAtMs);
    this.writeCounter("profile_ladder_stale_no_position_closed", 1, {
      band: state.band,
      source,
      reason: "no_open_sell",
    });
    this.insertRiskEvent("profile_ladder_stale_no_position_closed", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      ladderId: state.ladderId,
      band: state.band,
      source,
      reason: "no_open_sell",
      closedAtMs,
    });
  }

  private skipActiveLadderWithoutOpenPosition(
    state: LadderState,
    source: StaleNoPositionSource,
    reason: "open_sell_exists" | "position_reader_unavailable" | "order_reader_unavailable",
  ): void {
    this.armPlannedRungRetryCooldown(state.tokenId, this.now());
    this.writeCounter("profile_ladder_stale_no_position_skipped", 1, {
      band: state.band,
      source,
      reason,
    });
    this.insertRiskEvent("profile_ladder_stale_no_position_skipped", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      ladderId: state.ladderId,
      band: state.band,
      source,
      reason,
    });
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

  private emitModeReaderDarkCompare(
    position: Position,
    market: NormalizedMarket,
    policy: ExecutionProfilePolicy["sellLadder"],
    previous: LadderState | null,
    localMode: ProfileLadderMode,
    localPlan: Extract<LadderBuilderOutput, { ok: true }>,
  ): void {
    try {
      const config = (
        policy as ExecutionProfilePolicy["sellLadder"] & {
          modeReader?: ProfileLadderModeReaderConfig;
        }
      ).modeReader;
      if (config == null) return;
      if (!config.enabled || !config.darkCompareOnly) return;

      const candidate =
        this.deps.modeCandidateReader?.getCandidate(position.tokenId, config) ?? null;
      if (candidate == null) {
        this.writeCounter("profile_ladder_mode_reader_coverage", 1, {
          source: config.source,
          result: "missing",
          sourceMode: "null",
          modeStatus: "missing",
          modeConfidence: "missing",
        });
        this.writeCounter("profile_ladder_mode_reader_missing", 1, {
          source: config.source,
          reason: this.deps.modeCandidateReader == null ? "reader_unavailable" : "not_found",
          modeStatus: "missing",
          modeConfidence: "missing",
        });
        return;
      }

      const labels = {
        source: candidate.source,
        sourceMode: candidate.sourceMode,
        mappedCandidate: candidate.mappedMode,
        localMode,
        modeStatus: candidate.modeStatus,
        modeConfidence: candidate.modeConfidence,
      };

      this.writeCounter("profile_ladder_mode_reader_coverage", 1, {
        source: labels.source,
        result: "mapped",
        sourceMode: labels.sourceMode,
        modeStatus: labels.modeStatus,
        modeConfidence: labels.modeConfidence,
      });
      this.writeCounter("profile_ladder_mode_reader_status", 1, {
        modeStatus: labels.modeStatus,
      });
      this.writeCounter("profile_ladder_mode_reader_confidence", 1, {
        modeConfidence: labels.modeConfidence,
      });
      this.writeCounter("profile_ladder_mode_reader_delta", 1, labels);

      const candidatePlan = computeProfileLadder({
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        openedAt: position.openedAt,
        avgEntryPrice: position.avgEntryPrice,
        costBasisUsd: position.costBasisUsdc,
        positionSizeShares: position.size,
        mode: candidate.mappedMode,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        tickSize: market.tickSize,
        minOrderSize: market.minOrderSize ?? 1,
        config: policy,
        previousBand: previous?.band ?? null,
      });

      this.writeCounter("profile_ladder_mode_reader_price_delta_bucket", 1, {
        band: localPlan.band,
        deltaBucket: candidatePlan.ok
          ? priceDeltaBucket(localPlan.rungs, candidatePlan.rungs)
          : "not_comparable",
        localMode,
        mappedCandidate: candidate.mappedMode,
        modeStatus: candidate.modeStatus,
        modeConfidence: candidate.modeConfidence,
      });
    } catch {
      this.writeModeReaderErrorCounter();
    }
  }

  private writeModeReaderErrorCounter(): void {
    try {
      this.writeCounter("profile_ladder_mode_reader_error", 1, { reason: "exception" });
    } catch {
      // Dark-compare telemetry must never affect ladder behavior.
    }
  }

  private async publishPlaceOrder(
    position: Position,
    market: NormalizedMarket,
    marketData: ProfileLadderOrderMarketData,
    ladderId: string,
    rung: LadderRung,
    timestamp: number,
    options: {
      replacement?: {
        oldOrderId: string;
        oldLiveSellPrice: number;
        selectedPlannedPrice: number;
        selectedPlannedRungIndex: number;
        positiveFloorPrice: number;
        liveCoverageRatio: number;
        minReplacementPriceImprovementRatio: number;
        oldLiveRemainingShares: number;
        profileState: ProfileLadderTelemetryState;
        band: ProfileLadderBand;
        mode: ProfileLadderMode;
      };
    } = {},
  ): Promise<void> {
    const signalId = `profile_ladder_${String(position.tokenId)}_${ladderId}_${rung.rungIndex}`;
    const clientOrderId = buildClientOrderId({
      signalId,
      tokenId: position.tokenId,
      side: "sell",
    });
    const commandId =
      options.replacement == null
        ? createCommandId(signalId)
        : createCommandId(
            `${signalId}_post_refill_replace_${options.replacement.oldOrderId}_${timestamp}`,
          );
    this.pendingRungByClientOrderId.set(String(clientOrderId), {
      tokenId: position.tokenId,
      ladderId,
      rungIndex: rung.rungIndex,
      kind: options.replacement == null ? "standard" : "post_refill_replacement",
      ...(options.replacement == null
        ? {}
        : {
            oldOrderId: options.replacement.oldOrderId,
            createdAtMs: timestamp,
            deadlineAtMs:
              timestamp + resolvePostRefillFollowThroughConfig(this.policy()).cancelAckTimeoutMs,
            band: options.replacement.band,
            mode: options.replacement.mode,
            profileState: options.replacement.profileState,
          }),
    });
    await this.deps.bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId,
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
          ...(options.replacement == null
            ? {}
            : {
                profileLadderReplacement: {
                  kind: "post_refill_follow_through",
                  oldOrderId: options.replacement.oldOrderId,
                  oldLiveSellPrice: options.replacement.oldLiveSellPrice,
                  selectedPlannedPrice: options.replacement.selectedPlannedPrice,
                  selectedPlannedRungIndex: options.replacement.selectedPlannedRungIndex,
                  positiveFloorPrice: options.replacement.positiveFloorPrice,
                  liveCoverageRatio: options.replacement.liveCoverageRatio,
                  minReplacementPriceImprovementRatio:
                    options.replacement.minReplacementPriceImprovementRatio,
                  oldLiveRemainingShares: options.replacement.oldLiveRemainingShares,
                },
              }),
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
    if (pending.kind === "post_refill_replacement") {
      this.armReplacementCooldown(pending.tokenId, event.timestamp);
      this.writeReplacementCounter("profile_ladder_replacement_completed_total", pending, {
        action: "complete",
        reason: "order_placed",
      });
      this.insertRiskEvent("profile_ladder_replacement_completed", {
        tokenId: String(pending.tokenId),
        ladderId: pending.ladderId,
        rungIndex: pending.rungIndex,
        oldOrderId: pending.oldOrderId ?? null,
        clientOrderId: String(event.clientOrderId),
        orderId: String(event.orderId),
        completedAtMs: event.timestamp,
      });
    }
    if (state == null) return;
    // A stale backfill for a superseded ladder (e.g. rebuilt under a new
    // ladderId) must not mutate the current ladder's rungs.
    if (state.ladderId !== pending.ladderId) return;

    let matched = false;
    const activeRungs = state.activeRungs.map((rung) => {
      if (
        pending.kind === "post_refill_replacement" &&
        pending.oldOrderId != null &&
        rung.orderId === pending.oldOrderId &&
        rung.rungIndex !== pending.rungIndex
      ) {
        return { ...rung, lifecycle: "cancelled" as const, orderId: null };
      }
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
    event: RuntimeEventMap["OrderRejected"] | RuntimeEventMap["OrderSkipped"],
  ): void {
    const pending = this.pendingRungByClientOrderId.get(String(event.clientOrderId));
    if (pending == null) return;
    const reason = "reason" in event ? event.reason : event.reasonCode;
    if (
      pending.kind === "post_refill_replacement" &&
      (reason === "sell-replace-pending" || reason === "sell-replace-lock-retry")
    ) {
      return;
    }

    this.pendingRungByClientOrderId.delete(String(event.clientOrderId));
    if (pending.kind === "post_refill_replacement") {
      this.armReplacementCooldown(pending.tokenId, event.timestamp);
      this.writeReplacementCounter("profile_ladder_replacement_failed_total", pending, {
        action: "fail",
        reason: boundedReplacementReason(reason),
      });
      this.insertRiskEvent("profile_ladder_replacement_failed", {
        tokenId: String(pending.tokenId),
        ladderId: pending.ladderId,
        rungIndex: pending.rungIndex,
        oldOrderId: pending.oldOrderId ?? null,
        clientOrderId: String(event.clientOrderId),
        reason,
        failedAtMs: event.timestamp,
      });
    }
  }

  private handleFillReceived(event: RuntimeEventMap["FillReceived"]): void {
    if (event.side === "buy") {
      this.scaleInBuyPendingByToken.add(String(event.tokenId));
      return;
    }
    if (event.side !== "sell") return;
    const state = this.deps.repository.getLadder(event.tokenId);
    if (state == null) return;
    this.abortPendingReplacementForOldOrder(event);
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
    const position = this.resolveOpenPositionForActiveLadder(state, "post_fill_reeval");
    if (position == null) return;
    const placed = await this.advanceLiveRungs(state, market, this.now(), position);
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

  private async recordPostRefillFollowThrough(
    position: Position,
    market: NormalizedMarket,
    state: LadderState,
  ): Promise<void> {
    const config = resolvePostRefillFollowThroughConfig(this.policy());
    if (!config.enabled) return;
    if (this.deps.isProfileOwned != null && !this.deps.isProfileOwned(position.tokenId)) return;

    const evaluation = evaluatePostRefillLiveRung({
      state,
      position,
      market,
      config,
    });
    if (evaluation == null) return;

    const profileState = this.resolveProfileState(position.tokenId);
    const decision = evaluation.decision;

    const labels = {
      action: decision == null ? "observe" : resolvePostRefillAction(config),
      band: state.band,
      coverageBucket: evaluation.coverageBucket,
      mode: state.lastMode,
      priceDistanceBucket: decision?.priceDistanceBucket ?? "none",
      reason: decision == null ? "evaluated" : "intended_active_blocked",
      state: profileState,
    };
    this.writeCounter("profile_ladder_post_refill_live_coverage_bucket", 1, labels);
    if (decision == null) return;

    this.writeCounter("profile_ladder_stale_live_rung_detected_total", 1, labels);
    this.writeCounter("profile_ladder_replacement_candidate_total", 1, {
      action: labels.action,
      band: labels.band,
      mode: labels.mode,
      reason: labels.reason,
      state: labels.state,
    });
    if (
      this.shouldWriteStaleLiveRungRiskEvent({
        tokenId: state.tokenId,
        oldOrderId: decision.liveRung.orderId,
        selectedPlannedPrice: decision.intendedRung.price,
        reason: "intended_active_blocked",
      })
    ) {
      this.insertRiskEvent("profile_ladder_stale_live_rung_detected", {
        action: labels.action,
        tokenId: String(state.tokenId),
        conditionId: String(state.conditionId),
        band: state.band,
        mode: state.lastMode,
        profileState,
        reason: "intended_active_blocked",
        liveCoverageRatio: decision.liveCoverageRatio,
        liveProfileLadderSellShares: decision.liveProfileLadderSellShares,
        positionSizeShares: position.size,
        liveRungIndex: decision.liveRung.rungIndex,
        intendedRungIndex: decision.intendedRung.rungIndex,
        oldOrderId: decision.liveRung.orderId,
        oldLivePrice: decision.liveRung.price,
        oldLiveRemainingShares: remainingRungShares(decision.liveRung),
        selectedPlannedPrice: decision.intendedRung.price,
        selectedPlannedShares: decision.intendedRung.sizeShares,
        positiveFloorPrice: decision.positiveFloorPrice,
        avgEntryPrice: position.avgEntryPrice,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        minCoverageRatio: config.minCoverageRatio,
        priceDistanceImprovementPct: decision.priceDistanceImprovementPct,
        dryRun: config.dryRun,
        replacementEnabled: config.replacementEnabled,
      });
    }
    if (config.dryRun || !config.replacementEnabled) return;
    await this.requestPostRefillReplacement({
      position,
      market,
      state,
      decision,
      config,
      profileState,
    });
  }

  private async requestPostRefillReplacement(input: {
    position: Position;
    market: NormalizedMarket;
    state: LadderState;
    decision: PostRefillStaleLiveRungDecision;
    config: ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"];
    profileState: ProfileLadderTelemetryState;
  }): Promise<void> {
    const { config, decision, market, position, profileState, state } = input;
    const skipReason = this.getPostRefillReplacementSkipReason(state, decision, config);
    if (skipReason != null) {
      this.writeCounter("profile_ladder_replacement_place_skipped_total", 1, {
        action: "skip",
        band: state.band,
        mode: state.lastMode,
        reason: skipReason,
        state: profileState,
      });
      return;
    }

    const marketData = await this.resolveOrderMarketData(state.band, market, this.now());
    if (marketData == null) {
      this.writeCounter("profile_ladder_replacement_place_skipped_total", 1, {
        action: "skip",
        band: state.band,
        mode: state.lastMode,
        reason: "unknown_min_order",
        state: profileState,
      });
      return;
    }

    const oldOrderId = decision.liveRung.orderId;
    if (oldOrderId == null) return;
    await this.publishPlaceOrder(
      position,
      market,
      marketData,
      state.ladderId,
      decision.intendedRung,
      this.now(),
      {
        replacement: {
          oldOrderId,
          oldLiveSellPrice: decision.liveRung.price,
          selectedPlannedPrice: decision.intendedRung.price,
          selectedPlannedRungIndex: decision.intendedRung.rungIndex,
          positiveFloorPrice: decision.positiveFloorPrice,
          liveCoverageRatio: decision.liveCoverageRatio,
          minReplacementPriceImprovementRatio: config.minReplacementPriceImprovementRatio,
          oldLiveRemainingShares: remainingRungShares(decision.liveRung),
          profileState,
          band: state.band,
          mode: state.lastMode,
        },
      },
    );
    this.writeCounter("profile_ladder_replacement_place_requested_total", 1, {
      action: "request",
      band: state.band,
      mode: state.lastMode,
      reason: "intended_active_blocked",
      state: profileState,
    });
    this.insertRiskEvent("profile_ladder_replacement_requested", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      ladderId: state.ladderId,
      oldOrderId,
      oldLivePrice: decision.liveRung.price,
      selectedPlannedPrice: decision.intendedRung.price,
      selectedPlannedShares: decision.intendedRung.sizeShares,
      positiveFloorPrice: decision.positiveFloorPrice,
      liveCoverageRatio: decision.liveCoverageRatio,
      band: state.band,
      mode: state.lastMode,
      profileState,
    });
  }

  private getPostRefillReplacementSkipReason(
    state: LadderState,
    decision: PostRefillStaleLiveRungDecision,
    config: ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"],
  ): string | null {
    if (this.resolveLiveRungCap(state.band) !== 1) return "unsupported_concurrent_rungs";
    if (this.isReplacementCooldownActive(state.tokenId)) return "replacement_cooldown";
    if (this.hasPendingRungForToken(state.tokenId)) return "pending_rung";
    if (decision.liveRung.orderId == null) return "missing_old_order_id";
    if (config.cancelAckTimeoutMs <= 0) return "invalid_cancel_timeout";
    const validation = this.validateReplacementTarget(state, decision.liveRung.orderId);
    if (!validation.ok) {
      return validation.reason;
    }
    return null;
  }

  private validateReplacementTarget(
    state: LadderState,
    oldOrderId: string,
  ): ReturnType<typeof validateProfileLadderReplacementSellTarget> {
    return validateProfileLadderReplacementSellTarget(
      oldOrderId,
      this.findOpenSellOrders(state.tokenId),
    );
  }

  private sweepExpiredPendingReplacements(now: number): void {
    for (const [clientOrderId, pending] of this.pendingRungByClientOrderId) {
      if (pending.kind !== "post_refill_replacement") continue;
      if (pending.deadlineAtMs == null || pending.deadlineAtMs > now) continue;
      this.pendingRungByClientOrderId.delete(clientOrderId);
      this.armReplacementCooldown(pending.tokenId, now);
      this.writeReplacementCounter("profile_ladder_replacement_failed_total", pending, {
        action: "fail",
        reason: "cancel_ack_timeout",
      });
      this.insertRiskEvent("profile_ladder_replacement_failed", {
        tokenId: String(pending.tokenId),
        ladderId: pending.ladderId,
        rungIndex: pending.rungIndex,
        oldOrderId: pending.oldOrderId ?? null,
        clientOrderId,
        reason: "cancel_ack_timeout",
        failedAtMs: now,
      });
    }
  }

  private abortPendingReplacementForOldOrder(event: RuntimeEventMap["FillReceived"]): void {
    for (const [clientOrderId, pending] of this.pendingRungByClientOrderId) {
      if (pending.kind !== "post_refill_replacement") continue;
      if (String(event.tokenId) !== String(pending.tokenId)) continue;
      if (String(event.orderId) !== pending.oldOrderId) continue;
      this.pendingRungByClientOrderId.delete(clientOrderId);
      this.armReplacementCooldown(pending.tokenId, event.timestamp);
      this.writeReplacementCounter("profile_ladder_replacement_failed_total", pending, {
        action: "fail",
        reason: "old_order_filled",
      });
      return;
    }
  }

  private isReplacementCooldownActive(tokenId: TokenId): boolean {
    return (this.replacementCooldownUntilByToken.get(String(tokenId)) ?? 0) > this.now();
  }

  private armReplacementCooldown(tokenId: TokenId, now: number): void {
    this.replacementCooldownUntilByToken.set(
      String(tokenId),
      now + resolvePostRefillFollowThroughConfig(this.policy()).replacementCooldownMs,
    );
  }

  private writeReplacementCounter(
    name: string,
    pending: PendingProfileLadderRung,
    labels: { action: string; reason: string },
  ): void {
    this.writeCounter(name, 1, {
      action: labels.action,
      band: pending.band ?? "unknown",
      mode: pending.mode ?? "unknown",
      reason: labels.reason,
      state: pending.profileState ?? "unknown",
    });
  }

  private resolveProfileState(tokenId: TokenId): ProfileLadderTelemetryState {
    try {
      return this.deps.profileStateReader?.getProfileState(tokenId) ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  private shouldWriteStaleLiveRungRiskEvent(input: {
    tokenId: TokenId;
    oldOrderId: string | null;
    selectedPlannedPrice: number;
    reason: string;
  }): boolean {
    const now = this.now();
    if (this.staleLiveRungRiskEventDedupeUntilByKey.size > 1_000) {
      for (const [key, untilMs] of this.staleLiveRungRiskEventDedupeUntilByKey) {
        if (untilMs <= now) this.staleLiveRungRiskEventDedupeUntilByKey.delete(key);
      }
    }
    const key = [
      String(input.tokenId),
      input.oldOrderId ?? "unknown",
      input.selectedPlannedPrice.toFixed(6),
      input.reason,
    ].join("|");
    const dedupeUntilMs = this.staleLiveRungRiskEventDedupeUntilByKey.get(key) ?? 0;
    if (dedupeUntilMs > now) return false;
    this.staleLiveRungRiskEventDedupeUntilByKey.set(
      key,
      now + STALE_LIVE_RUNG_RISK_EVENT_DEDUPE_MS,
    );
    return true;
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

function resolvePostRefillFollowThroughConfig(
  policy: ExecutionProfilePolicy["sellLadder"],
): ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"] {
  return {
    ...DEFAULT_POST_REFILL_FOLLOW_THROUGH,
    ...(policy.postRefillFollowThrough ?? {}),
  };
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

export function evaluatePostRefillLiveRung(input: {
  state: LadderState;
  position: Position;
  market: NormalizedMarket;
  config: ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"];
}): PostRefillLiveRungEvaluation | null {
  const { config, market, position, state } = input;
  if (position.status !== PositionStatus.Open) return null;
  if (position.size < config.minMaterialPositionSizeShares) return null;

  const liveRungs = state.activeRungs.filter(isPlacedOrPartiallyFilledRung);
  if (liveRungs.length === 0) return null;

  const liveProfileLadderSellShares = liveRungs.reduce(
    (sum, liveRung) => sum + remainingRungShares(liveRung),
    0,
  );
  const liveCoverageRatio = liveProfileLadderSellShares / Math.max(position.size, 1e-9);
  const evaluation: PostRefillLiveRungEvaluation = {
    liveCoverageRatio,
    liveProfileLadderSellShares,
    coverageBucket: coverageBucket(liveCoverageRatio),
    decision: null,
  };
  if (liveCoverageRatio >= config.minCoverageRatio) return evaluation;

  const intendedRung = state.activeRungs.find((rung) =>
    isSubmittablePostRefillPlannedRung(rung, market),
  );
  if (intendedRung == null) return evaluation;

  const staleLiveRung = [...liveRungs]
    .filter((liveRung) => liveRung.rungIndex > intendedRung.rungIndex)
    .sort((a, b) => b.rungIndex - a.rungIndex)[0];
  if (staleLiveRung == null) return evaluation;
  if (!isMaterialReplacementPriceImprovement(staleLiveRung.price, intendedRung.price, config)) {
    return evaluation;
  }
  const positiveFloorPrice = resolveReplacementPositiveFloorPrice(position, market);
  if (positiveFloorPrice == null || intendedRung.price + 1e-12 < positiveFloorPrice) {
    return evaluation;
  }

  const priceDistanceImprovementPct = priceDistanceImprovement(
    staleLiveRung.price,
    intendedRung.price,
    intendedRung.price,
  );
  if (priceDistanceImprovementPct < config.priceDistanceImprovementPct) return evaluation;

  evaluation.decision = {
    liveCoverageRatio,
    liveProfileLadderSellShares,
    liveRung: staleLiveRung,
    intendedRung,
    positiveFloorPrice,
    priceDistanceImprovementPct,
    coverageBucket: coverageBucket(liveCoverageRatio),
    priceDistanceBucket: priceDistanceBucket(priceDistanceImprovementPct),
  };
  return evaluation;
}

function isPlacedOrPartiallyFilledRung(rung: LadderRung): boolean {
  return rung.lifecycle === "placed" || rung.lifecycle === "partially_filled";
}

function remainingRungShares(rung: LadderRung): number {
  return Math.max(0, rung.sizeShares - rung.filledSizeShares);
}

function isSubmittablePostRefillPlannedRung(rung: LadderRung, market: NormalizedMarket): boolean {
  const minOrderSize = market.minOrderSize ?? 1;
  return (
    rung.lifecycle === "planned" &&
    rung.orderId == null &&
    rung.sizeShares >= minOrderSize &&
    !wouldCrossPostOnly(rung.price, market.bestBid)
  );
}

function isMaterialReplacementPriceImprovement(
  oldLiveSellPrice: number,
  selectedPlannedPrice: number,
  config: ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"],
): boolean {
  if (!isPositiveFinite(oldLiveSellPrice) || !isPositiveFinite(selectedPlannedPrice)) return false;
  const maxReplacementPrice = oldLiveSellPrice * (1 - config.minReplacementPriceImprovementRatio);
  return selectedPlannedPrice <= maxReplacementPrice + 1e-12;
}

function resolveReplacementPositiveFloorPrice(
  position: Position,
  market: NormalizedMarket,
): number | null {
  if (!isPositiveFinite(position.avgEntryPrice)) return null;
  if (!isPositiveFinite(market.tickSize) || market.tickSize >= 1) return null;
  const { positiveFloorPrice } = resolvePositiveSellFloor(position.avgEntryPrice, market.tickSize);
  return isPositiveFinite(positiveFloorPrice) ? positiveFloorPrice : null;
}

function priceDistanceImprovement(
  livePrice: number,
  plannedPrice: number,
  intendedAnchorPrice: number,
): number {
  const liveDistance = Math.abs(livePrice - intendedAnchorPrice);
  if (liveDistance <= 0) return 0;
  const plannedDistance = Math.abs(plannedPrice - intendedAnchorPrice);
  return (liveDistance - plannedDistance) / liveDistance;
}

function coverageBucket(ratio: number): string {
  if (ratio <= 0) return "0";
  if (ratio < 0.25) return "lt25";
  if (ratio < 0.5) return "25_50";
  if (ratio < 0.75) return "50_75";
  return "ge75";
}

function priceDistanceBucket(improvementPct: number): string {
  if (improvementPct <= 0) return "same";
  if (improvementPct < 0.1) return "lt10pct";
  if (improvementPct < 0.25) return "10_25pct";
  return "ge25pct";
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

function priceDeltaBucket(
  localRungs: readonly LadderRung[],
  candidateRungs: readonly LadderRung[],
): string {
  const count = Math.min(localRungs.length, candidateRungs.length);
  if (count <= 0) return "not_comparable";
  let selectedDelta: number | null = null;
  for (let i = 0; i < count; i += 1) {
    const localPrice = localRungs[i]?.price;
    const candidatePrice = candidateRungs[i]?.price;
    if (!isPositiveFinite(localPrice) || !isPositiveFinite(candidatePrice)) continue;
    const delta = (candidatePrice - localPrice) / localPrice;
    if (selectedDelta == null || Math.abs(delta) > Math.abs(selectedDelta)) {
      selectedDelta = delta;
    }
  }
  if (selectedDelta == null) return "not_comparable";
  if (selectedDelta < -0.25) return "lt_minus_25pct";
  if (selectedDelta < -0.1) return "minus_25_to_minus_10pct";
  if (selectedDelta < -0.02) return "minus_10_to_minus_2pct";
  if (selectedDelta <= 0.02) return "minus_2_to_plus_2pct";
  if (selectedDelta <= 0.1) return "plus_2_to_plus_10pct";
  if (selectedDelta <= 0.25) return "plus_10_to_plus_25pct";
  return "gt_plus_25pct";
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

function stateTracksAnyOrder(state: LadderState, orders: readonly Order[]): boolean {
  const trackedOrderIds = new Set(
    state.activeRungs
      .map((rung) => rung.orderId)
      .filter((orderId): orderId is string => typeof orderId === "string" && orderId.length > 0),
  );
  return orders.some((order) => {
    for (const orderId of trackedOrderIds) {
      if (orderMatchesOrderId(order, orderId)) return true;
    }
    return false;
  });
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(6));
}

function resolvePostRefillAction(
  config: ExecutionProfilePolicy["sellLadder"]["postRefillFollowThrough"],
): string {
  if (config.dryRun) return "dry_run";
  return config.replacementEnabled ? "request" : "telemetry";
}

function boundedReplacementReason(reason: string): string {
  switch (reason) {
    case "sell-replace-chain-cap":
    case "sell-replace-lock-active":
    case "sell-replace-invalid-threshold":
    case "sell-order-acceptable-price-already-open":
    case "sell-replace-required-order-missing":
    case "sell-replace-duplicate-live-sell":
    case "post-only-cross-pre-submit":
    case "cancel_ack_timeout":
    case "old_order_filled":
      return reason;
    default:
      return "other";
  }
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
