import type {
  EventBus,
  LadderBuilderOutput,
  LadderRung,
  LadderState,
  MakerEntryPolicy,
  NormalizedMarket,
  Order,
  OrderBookSnapshot,
  OrderId,
  Position,
  ProfileLadderBand,
  ProfileLadderMode,
  RungLifecycle,
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
  wouldCrossProfileLadderPostOnly,
} from "./profile-ladder-builder.js";
import {
  computeProfileLadderShadowEvaluation,
  type ProfileLadderShadowCandidateResult,
  type ProfileLadderShadowEvaluation,
} from "./profile-ladder-shadow-policy.js";
import {
  isProfileLadderOrder,
  isProfileLadderSellOrder,
  orderMatchesOrderId,
  validateProfileLadderReplacementSellTarget,
} from "../profile-ladder-order-helpers.js";
import { resolvePositiveSellFloor } from "../../executable-price.js";
import { isBounceOwned } from "../exit-ownership/is-bounce-owned.js";
import { isExecutableOrderSize, resolveEffectiveMinOrderSize } from "../../min-order-size.js";
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
  findDust(): Position[];
  findActiveByTokenId(tokenId: TokenId): Position[];
}

export interface ProfileLadderOrderReader {
  findByTokenId(tokenId: TokenId): Order[];
  findByClientOrderId?(clientOrderId: string): Order | null;
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
  // Phase 2: provides harvestGainPct for the config-driven maker first rung.
  makerEntryPolicy?: () => Pick<MakerEntryPolicy, "harvestGainPct">;
  modeReader?: ProfileLadderModeReader;
  modeCandidateReader?: ProfileLadderModeCandidateReader;
  profileStateReader?: ProfileLadderProfileStateReader;
  // Adoption (Track #44) dependencies — only consulted when sellLadder.adoptExisting is enabled.
  positionRepo?: ProfileLadderPositionReader;
  orderRepo?: ProfileLadderOrderReader;
  isProfileOwned?: (tokenId: TokenId) => boolean;
  bookCache?: ProfileLadderBookCache | undefined;
  // Lets the module react to a sellLadder.adoptExisting false -> true hot-enable
  // while already started; returns an unsubscribe handle. Mirrors DustAutoCloseModule.
  onPolicyReload?: (handler: () => void) => () => void;
  // Mirrors the executor's min-order fallback gate: a conservative min-order
  // fallback for planned ladder rungs is only available in live-lite. Other
  // modes stay fail-closed when min order size cannot be hydrated.
  runtimeMode?: "simulation" | "paper" | "live-lite" | undefined;
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

// A recovery rebuild that places no live rung (e.g. the deterministic base
// clientOrderId is burned by a terminal cancelled order) is pure churn: it never
// un-sticks. After this many consecutive zero-placed rebuilds of the SAME candidate
// (ladder id + rung shape) that candidate's recovery pass is suppressed — the token
// itself is NOT made dormant, so a changed candidate or a BBO/position rebuild still
// recovers exit coverage.
export const MAX_RECOVERY_ZERO_PLACED_RECOVERIES = 3;

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

// Bounded number of `_retry<n>` clientOrderId candidates probed when the base
// recovery clientOrderId is occupied by a terminal cancelled/rejected no-fill PL
// SELL row. Keeps the recovery deterministic and prevents an unbounded probe loop.
const PROFILE_LADDER_CLIENT_ORDER_ID_MAX_RETRIES = 3;

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
  // planned_rung_count is the full target ladder size across adopted positions;
  // estimated_order_count is retained for existing operator dashboards and now
  // intentionally mirrors placed_live_rung_count under the conservative cap.
  planned_rung_count: number;
  estimated_order_count: number;
  placed_live_rung_count: number;
  planned_only_ladder_count: number;
  retryable_skip_count: number;
}

// Why a placement pass put zero rungs live, bounded to the abandonment-relevant
// distinction. `client_order_id_blocked` is the only deterministic, self-healing
// -resistant cause (a terminal-rejected base clientOrderId with no free distinct
// candidate) that may advance the abandon streak. `transient` covers every other
// zero-placement cause (post-only crossing, unknown/below min order size, missing
// market data) — conditions that a later pass can clear, so they reset the streak.
type ZeroPlacementCause = "client_order_id_blocked" | "transient" | null;

interface LiveRungAdvanceResult {
  placed: number;
  skippedUnknownMinOrderSize: number;
  attempted: boolean;
  zeroPlacementCause: ZeroPlacementCause;
}

interface BuildAndPlaceOptions {
  preservePreviousLiveRungs?: boolean;
  ladderIdSuffix?: string;
}

type LadderRebuildReason = "scale_in" | "profile_reclass" | "bbo_major" | "bbo_strong";
type PostRefillReplacementTrigger = "low_coverage" | "scale_in_stale_price";

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
  attemptFilledBaseShares?: number | undefined;
  attemptSubmittedShares?: number | undefined;
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
  trigger: PostRefillReplacementTrigger;
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
  minOrderSource: "base-market" | "book-cache" | "fallback";
}

export class ProfileLadderModule implements RuntimeModule {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly bboCooldownUntilByToken = new Map<string, number>();
  private readonly marketByToken = new Map<string, NormalizedMarket>();
  private readonly scaleInBuyPendingByToken = new Set<string>();
  private readonly pendingRungByClientOrderId = new Map<string, PendingProfileLadderRung>();
  private readonly plannedRungRetryCooldownUntilByToken = new Map<string, number>();
  // Per-token tracker of consecutive recovery rebuilds that placed zero live rungs
  // for one candidate signature. Once the count reaches the cap the matching planned/
  // no-live candidate is abandoned (its recovery pass is skipped); a different
  // signature restarts the streak so the token is never globally dormant.
  private readonly recoveryZeroPlacedByToken = new Map<
    string,
    { signature: string; count: number }
  >();
  private readonly missingLadderRecoveryCooldownUntilByToken = new Map<string, number>();
  private readonly pendingRebuildDeferCooldownUntilByToken = new Map<string, number>();
  private readonly staleLiveRungRiskEventDedupeUntilByKey = new Map<string, number>();
  private readonly shadowRiskEventDedupeUntilByKey = new Map<string, number>();
  private readonly replacementCooldownUntilByToken = new Map<string, number>();
  private readonly subMinResidualSignatureByToken = new Map<string, string>();
  private readonly exhaustedRetrySignatureByToken = new Map<string, string>();
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
      this.deps.bus.subscribe("TrackedMarketsChanged", async (event) => {
        this.handleTrackedMarketsChanged(event);
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
    this.recoveryZeroPlacedByToken.clear();
    this.missingLadderRecoveryCooldownUntilByToken.clear();
    this.pendingRebuildDeferCooldownUntilByToken.clear();
    this.pendingRungByClientOrderId.clear();
    this.marketByToken.clear();
    this.replacementCooldownUntilByToken.clear();
    this.subMinResidualSignatureByToken.clear();
    this.exhaustedRetrySignatureByToken.clear();
    this.shadowRiskEventDedupeUntilByKey.clear();
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
    if (!this.isPositionEligibleForProfileExit(position)) return;
    const exactPosition =
      this.deps.positionRepo == null
        ? position
        : this.resolveSingleActivePosition(position.tokenId);
    if (exactPosition == null) return;
    const result = await this.buildAndPlace(exactPosition, market, "ladder_placed");
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
      planned_rung_count: 0,
      estimated_order_count: 0,
      placed_live_rung_count: 0,
      planned_only_ladder_count: 0,
      retryable_skip_count: 0,
    };

    const maxPositions = this.deps.policy().maxTokensPerCycle;
    for (const position of this.findAdoptionPositions().slice(0, maxPositions)) {
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
    const exactPosition = this.resolveSingleActivePosition(tokenId);
    if (
      exactPosition == null ||
      !this.isExitStateAllowed(tokenId) ||
      isBounceOwned(exactPosition)
    ) {
      return;
    }
    const market = this.marketByToken.get(String(tokenId));
    if (market == null || !isValidLadderBbo(market.bestBid, market.bestAsk)) {
      summary.skipped_missing_market += 1;
      return;
    }
    const band = resolveLadderBand(exactPosition.avgEntryPrice, sellLadder.bands);
    if (band == null || !sellLadder.bands[band].enabled) {
      summary.skipped_band_disabled += 1;
      return;
    }
    if (this.hasOpenSellOrder(tokenId)) {
      summary.skipped_existing_sell_order += 1;
      return;
    }

    const existing = this.deps.repository.getLadder(tokenId);
    if (existing != null) {
      if (await this.reopenStaleDustLadderIfEligible(existing, exactPosition, market)) {
        summary.adopted_count += 1;
      } else {
        summary.skipped_existing_ladder += 1;
      }
      return;
    }

    summary.eligible_count += 1;
    const result = await this.buildAndPlace(exactPosition, market, "ladder_adopted", "flat");
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
    reason: LadderRebuildReason,
  ): Promise<void> {
    if (isBboReason(reason) && this.isBboCooldownActive(position.tokenId)) return;
    const existing = this.reconcileRungLiveness(this.deps.repository.getLadder(position.tokenId));
    if (existing != null && hasPersistedRecoveryAttempt(existing)) {
      this.writeCounter("profile_ladder_rebuild_deferred_for_recovery", 1, {
        band: existing.band,
        reason,
      });
      await this.retryPersistedRecoveryAttempt(existing, market);
      return;
    }
    if (this.hasPendingRungForToken(position.tokenId)) {
      const band = existing?.band ?? resolveLadderBand(position.avgEntryPrice, this.policy().bands);
      if (band != null) {
        this.writePendingRebuildDeferredCounter(position.tokenId, band);
      }
      return;
    }

    const allowHealthyCoverageReplacement = isCausalScaleInBasisIncrease(
      existing,
      position,
      reason,
    );
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
    await this.recordPostRefillFollowThrough(
      position,
      market,
      state,
      allowHealthyCoverageReplacement,
    );
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
      let state = this.deps.repository.getLadder(market.tokenId);
      if (state == null) {
        await this.recoverMissingAdoptedLadderIfReady(market);
        continue;
      }
      if (!this.isExitStateAllowed(market.tokenId)) continue;
      if (state.status === "closed") {
        const position = this.resolveSingleActivePosition(market.tokenId);
        if (position != null) await this.reopenStaleDustLadderIfEligible(state, position, market);
        continue;
      }
      if (state.status !== "active") continue;
      state = this.reconcileRungLiveness(state);

      if (hasPersistedRecoveryAttempt(state)) {
        await this.retryPersistedRecoveryAttempt(state, market);
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
      // Phase 6 patient reprice: maker-tagged positions only reprice on material BBO moves
      // (bbo_strong ≥ 10%); minor moves (bbo_major ≥ 5% < 10%) are skipped so the resting
      // sell has enough time to fill (fixes cap-fdv over-reprice 0-fill).
      if (reason === "bbo_major" && position.entryStyle === "maker") continue;
      await this.rebuildLadder(position, market, reason);
    }
  }

  private handleTrackedMarketsChanged(event: RuntimeEventMap["TrackedMarketsChanged"]): void {
    for (const tokenId of event.removedTokenIds) this.marketByToken.delete(String(tokenId));
  }

  private async handlePositionUpdated(position: Position): Promise<void> {
    if (position.status === PositionStatus.Closed || position.size <= 0) {
      this.scaleInBuyPendingByToken.delete(String(position.tokenId));
      await this.cancelLadder(position.tokenId, "position_closed");
      return;
    }
    // Release A Phase 3: a bounce owner is serviced exclusively by the bounce ladder
    // — no profile-ladder claim, no placement.
    if (!this.isPositionEligibleForProfileExit(position)) return;
    const exactPosition =
      this.deps.positionRepo == null
        ? position
        : this.resolveSingleActivePosition(position.tokenId);
    if (exactPosition == null || !this.isPositionEligibleForProfileExit(exactPosition)) return;

    const market = this.marketByToken.get(String(position.tokenId));
    if (market == null) return;

    let state = this.deps.repository.getLadder(position.tokenId);
    if (state == null) {
      await this.placeLadder(exactPosition, market);
      return;
    }
    if (state.status === "closed") {
      await this.reopenStaleDustLadderIfEligible(state, exactPosition, market);
      return;
    }
    state = this.reconcileRungLiveness(state);
    if (hasPersistedRecoveryAttempt(state)) {
      if (hasPositionBasisChanged(state, exactPosition)) {
        this.writeCounter("profile_ladder_basis_rebuild_deferred_for_recovery", 1, {
          band: state.band,
        });
      }
      await this.retryPersistedRecoveryAttempt(state, market);
      return;
    }

    if (
      this.scaleInBuyPendingByToken.has(String(position.tokenId)) ||
      hasPositionBasisChanged(state, exactPosition)
    ) {
      this.scaleInBuyPendingByToken.delete(String(position.tokenId));
      await this.rebuildLadder(exactPosition, market, "scale_in");
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
    zeroPlacementCause: ZeroPlacementCause;
  } | null> {
    const policy = this.policy();
    if (!policy.enabled) return null;
    const previous = this.reconcileRungLiveness(this.deps.repository.getLadder(position.tokenId));
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
      minOrderSize: resolveEffectiveMinOrderSize(market.minOrderSize),
      config: policy,
      previousBand: previous?.band ?? null,
      entryStyle: position.entryStyle ?? null,
      harvestGainPct: this.makerHarvestGainPct(),
    });
    if (!plan.ok) return null;
    const ladderId =
      options.ladderIdSuffix == null ? plan.ladderId : `${plan.ladderId}_${options.ladderIdSuffix}`;
    const activeRungs =
      options.preservePreviousLiveRungs === false
        ? plan.rungs.map((rung) => ({ ...rung }))
        : mergeLiveRungs(plan.rungs, previous);
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
    this.emitShadowPlanktonPolicy(
      position,
      market,
      policy,
      mode,
      ladderId,
      activeRungs.map((rung) => ({ ...rung })),
    );

    const now = this.now();
    const state: LadderState = {
      tokenId: position.tokenId,
      conditionId: position.conditionId,
      ladderId,
      band: plan.band,
      phase: policy.phase,
      status: "active",
      activeRungs,
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
      zeroPlacementCause: liveRungs.zeroPlacementCause,
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
    state = this.reconcileRungLiveness(state);
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
    // Track which zero-placement causes the pass hit so the recovery accounting can
    // tell a deterministic clientOrderId block apart from a self-healing transient.
    let sawTransientSkip = false;
    let sawClientOrderIdBlocked = false;
    for (const rung of state.activeRungs) {
      if (occupied >= cap) break;
      const submittable =
        rung.lifecycle === "planned" &&
        rung.orderId == null &&
        !pendingRungIndexes.has(rung.rungIndex);
      if (!submittable) continue;
      attempted = true;
      const residualShares = remainingRungShares(rung);
      if (residualShares <= 0) continue;
      // Plankton no-taker-sell: a post-only SELL at/below the best bid would
      // cross and execute as a taker. Skip it (it never goes live) and let the
      // loop rest the slot on the next non-crossing planned rung, if any.
      if (wouldCrossProfileLadderPostOnly(rung.price, market.bestBid)) {
        this.writeCounter("profile_ladder_skipped_crossing_post_only", 1, { band: state.band });
        sawTransientSkip = true;
        continue;
      }
      const marketData = await this.resolveOrderMarketData(state.band, market, now, {
        allowFallback: true,
      });
      if (marketData == null) {
        this.writeCounter("profile_ladder_skipped_unknown_min_order_size", 1, {
          band: state.band,
        });
        this.armPlannedRungRetryCooldown(state.tokenId, now);
        skippedUnknownMinOrderSize += 1;
        sawTransientSkip = true;
        break;
      }
      // A fallback-hydrated rung below the conservative floor is skipped, not
      // fatal: a later rung in the same pass may still clear it.
      if (!isExecutableOrderSize(residualShares, marketData.effectiveMinOrderSize)) {
        if (marketData.minOrderSource === "fallback") {
          this.writeCounter("profile_ladder_min_order_fallback_total", 1, {
            band: state.band,
            result: "below_fallback_min_order",
          });
        }
        this.recordSubMinResidual(state, residualShares, marketData.effectiveMinOrderSize);
        sawTransientSkip = true;
        continue;
      }
      if (marketData.minOrderSource === "fallback") {
        this.writeCounter("profile_ladder_min_order_fallback_total", 1, {
          band: state.band,
          result: "fallback_used",
        });
      }
      this.subMinResidualSignatureByToken.delete(String(state.tokenId));
      const signalId = this.resolveAttemptSignalId(position, state.ladderId, rung, state.band);
      if (signalId == null) {
        sawClientOrderIdBlocked = true;
        continue;
      }
      const attemptRung = {
        ...rung,
        attemptFilledBaseShares: normalizeCumulativeShares(rung.filledSizeShares, rung.sizeShares),
        attemptSubmittedShares: residualShares,
      };
      state = {
        ...state,
        activeRungs: state.activeRungs.map((candidate) =>
          candidate.rungIndex === rung.rungIndex ? attemptRung : candidate,
        ),
        updatedAtMs: now,
      };
      this.deps.repository.upsertLadder(state);
      await this.publishPlaceOrder(position, market, marketData, state.ladderId, attemptRung, now, {
        signalId,
      });
      occupied += 1;
      placed += 1;
    }
    // A transient skip anywhere in the pass dominates: only a pass blocked purely
    // on the deterministic clientOrderId guard counts toward abandonment.
    const zeroPlacementCause: ZeroPlacementCause =
      placed > 0
        ? null
        : sawTransientSkip
          ? "transient"
          : sawClientOrderIdBlocked
            ? "client_order_id_blocked"
            : null;
    return { placed, skippedUnknownMinOrderSize, attempted, zeroPlacementCause };
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
      if (!this.isExitStateAllowed(state.tokenId)) continue;
      if (this.postFillTimerByToken.has(String(state.tokenId))) continue;
      const market = this.marketByToken.get(String(state.tokenId));
      if (market == null) continue;
      const reconciled = this.reconcileRungLiveness(state);
      if (hasPersistedRecoveryAttempt(reconciled)) {
        await this.retryPersistedRecoveryAttempt(reconciled, market);
        continue;
      }
      if (await this.recoverPlannedNoLiveLadderIfReady(reconciled, market)) continue;
      await this.retryPlannedLiveRungsIfReady(reconciled, market);
    }
  }

  private async retryPersistedRecoveryAttempt(
    state: LadderState,
    market: NormalizedMarket,
  ): Promise<boolean> {
    if (state.status !== "active" || !hasPlannedNoLiveRung(state)) return false;
    if (this.postFillTimerByToken.has(String(state.tokenId))) return true;
    if (
      this.isPlannedRungRetryCooldownActive(state.tokenId) &&
      !this.hasSubMinInputsChanged(state, market)
    ) {
      return true;
    }
    if (this.hasPendingRungForToken(state.tokenId)) return true;
    if (!isValidLadderBbo(market.bestBid, market.bestAsk)) {
      this.armPlannedRungRetryCooldown(state.tokenId, this.now());
      return true;
    }
    const position = this.resolveSingleActivePosition(state.tokenId);
    if (position == null || !this.isPositionEligibleForProfileExit(position)) return true;
    const tokenOrders = this.deps.orderRepo?.findByTokenId(state.tokenId) ?? [];
    const evidence = findPersistedAttemptEvidence(state, tokenOrders);
    if (evidence.length > 0) {
      const match = resolveSingleAdoptableRungMatch(state, evidence, true);
      if (match == null) return true;
      if (match.order.status === OrderStatus.Rejected && !match.order.exchangeOrderId) {
        this.persistPreExchangeFailure(
          {
            tokenId: state.tokenId,
            ladderId: state.ladderId,
            rungIndex: state.activeRungs[match.index]!.rungIndex,
            kind: "standard",
            attemptFilledBaseShares: match.attemptFilledBaseShares,
            attemptSubmittedShares: match.attemptSubmittedShares,
          },
          this.now(),
        );
        return true;
      }
      if (!this.adoptRecoveryOrderIntoState(state, evidence, true)) return true;
      const reconciled = this.reconcileRungLiveness(this.deps.repository.getLadder(state.tokenId));
      if (reconciled == null) return true;
      state = reconciled;
      if (!hasPersistedRecoveryAttempt(state) || !hasPlannedNoLiveRung(state)) return true;
    }
    const openSellOrders = tokenOrders.filter(
      (order) => order.side === "sell" && OPEN_ORDER_STATUSES.has(order.status),
    );
    if (openSellOrders.length > 0) {
      const adopted = this.adoptRecoveryOrderIntoState(
        state,
        openSellOrders.filter(isProfileLadderOrder),
        true,
      );
      if (adopted) return true;
      this.armPlannedRungRetryCooldown(state.tokenId, this.now());
      return true;
    }
    const result = await this.advanceLiveRungs(state, market, this.now(), position);
    if (result.attempted) this.armPlannedRungRetryCooldown(state.tokenId, this.now());
    return true;
  }

  private hasSubMinInputsChanged(state: LadderState, market: NormalizedMarket): boolean {
    const prior = this.subMinResidualSignatureByToken.get(String(state.tokenId));
    if (prior == null) return false;
    const minOrderSize = market.minOrderSize;
    if (typeof minOrderSize !== "number" || !Number.isFinite(minOrderSize) || minOrderSize <= 0) {
      return false;
    }
    const rung = state.activeRungs.find(
      (candidate) => candidate.lifecycle === "planned" && candidate.orderId == null,
    );
    if (rung == null) return false;
    return prior !== `${roundQuantity(remainingRungShares(rung))}|${roundQuantity(minOrderSize)}`;
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
    state = this.reconcileRungLiveness(state);
    if (state.status !== "active") return false;
    if (hasPersistedRecoveryAttempt(state)) {
      return this.retryPersistedRecoveryAttempt(state, market);
    }
    if (this.deps.positionRepo == null || this.deps.orderRepo == null) return false;
    if (this.postFillTimerByToken.has(String(state.tokenId))) return false;
    if (!hasPlannedNoLiveRung(state)) {
      this.recoveryZeroPlacedByToken.delete(String(state.tokenId));
      return false;
    }
    if (this.isPlannedRungRetryCooldownActive(state.tokenId)) return true;
    if (this.isRecoveryCandidateAbandoned(state)) {
      this.armPlannedRungRetryCooldown(state.tokenId, this.now());
      this.writeCounter("ladder_recovery_skipped_abandoned", 1, { band: state.band });
      return true;
    }
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
        if (this.adoptRecoveryOrderIntoState(state, openProfileLadderOrders)) return true;
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
    this.recordRecoveryPlacementOutcome(
      result.state,
      result.placedLiveRungs,
      result.zeroPlacementCause,
    );
    return true;
  }

  // Only deterministic identity collisions extend the exact candidate's streak;
  // transient market/min-order skips reset it.
  private recordRecoveryPlacementOutcome(
    state: LadderState,
    placedLiveRungs: number,
    zeroPlacementCause: ZeroPlacementCause,
  ): void {
    const tokenKey = String(state.tokenId);
    if (placedLiveRungs > 0 || zeroPlacementCause !== "client_order_id_blocked") {
      this.recoveryZeroPlacedByToken.delete(tokenKey);
      return;
    }
    const signature = recoveryCandidateSignature(state);
    const previous = this.recoveryZeroPlacedByToken.get(tokenKey);
    const count = previous != null && previous.signature === signature ? previous.count + 1 : 1;
    this.recoveryZeroPlacedByToken.set(tokenKey, { signature, count });
    if (count === MAX_RECOVERY_ZERO_PLACED_RECOVERIES) {
      this.writeCounter("profile_ladder_recovery_abandoned", 1, {
        band: state.band,
        reason: "client_order_id_blocked_zero_placed",
      });
    }
  }

  private isRecoveryCandidateAbandoned(state: LadderState): boolean {
    const entry = this.recoveryZeroPlacedByToken.get(String(state.tokenId));
    return (
      entry != null &&
      entry.count >= MAX_RECOVERY_ZERO_PLACED_RECOVERIES &&
      entry.signature === recoveryCandidateSignature(state)
    );
  }

  private adoptRecoveryOrderIntoState(
    state: LadderState,
    openOrders: readonly Order[],
    exactAttempt = false,
  ): boolean {
    const match = resolveSingleAdoptableRungMatch(state, openOrders, exactAttempt);
    if (match == null) return false;
    const { order, index, attemptFilledBaseShares, attemptSubmittedShares } = match;
    const lifecycle: RungLifecycle =
      order.status === OrderStatus.PartiallyFilled ? "partially_filled" : "placed";
    const activeRungs = state.activeRungs.map((rung, rungIndex) =>
      rungIndex === index
        ? {
            ...rung,
            orderId: String(order.orderId),
            lifecycle,
            filledSizeShares: resolveAdoptedFilledSizeShares(
              order,
              rung,
              attemptFilledBaseShares,
              attemptSubmittedShares,
            ),
            attemptFilledBaseShares:
              attemptFilledBaseShares ?? rung.attemptFilledBaseShares ?? rung.filledSizeShares,
            attemptSubmittedShares:
              attemptSubmittedShares ?? rung.attemptSubmittedShares ?? order.size,
          }
        : rung,
    );
    this.deps.repository.upsertLadder({ ...state, activeRungs, updatedAtMs: this.now() });
    this.writeCounter("profile_ladder_recovery_order_adopted", 1, { band: state.band });
    this.insertRiskEvent("ladder_recovery_order_adopted", {
      tokenId: String(state.tokenId),
      conditionId: String(state.conditionId),
      band: state.band,
      ladderId: state.ladderId,
      rungIndex: activeRungs[index]!.rungIndex,
      orderId: String(order.orderId),
      lifecycle,
    });
    return true;
  }

  private canRetryPlannedLiveRungs(state: LadderState): boolean {
    state = this.reconcileRungLiveness(state);
    if (state.status !== "active") return false;
    if (this.postFillTimerByToken.has(String(state.tokenId))) return false;
    if (this.isPlannedRungRetryCooldownActive(state.tokenId)) return false;
    if (!hasPlannedNoLiveRung(state)) {
      return false;
    }
    const occupied =
      state.activeRungs.filter(
        (rung) => rung.lifecycle === "placed" || rung.lifecycle === "partially_filled",
      ).length + this.pendingRungsForToken(state.tokenId).length;
    return occupied < this.resolveLiveRungCap(state.band);
  }

  private reconcileRungLiveness(state: null): null;
  private reconcileRungLiveness(state: LadderState): LadderState;
  private reconcileRungLiveness(state: LadderState | null): LadderState | null;
  private reconcileRungLiveness(state: LadderState | null): LadderState | null {
    if (state == null || this.deps.orderRepo == null) return state;
    const orders = this.deps.orderRepo.findByTokenId(state.tokenId);
    const results = state.activeRungs.map((rung) => reconcileRungLiveness(rung, orders));
    for (const result of results) {
      if (result.changed || result.blockedReason == null) continue;
      this.writeCounter("profile_ladder_terminal_rearm_blocked", 1, {
        band: state.band,
        reason: result.blockedReason,
      });
    }
    if (results.every((result) => result.changed === false)) return state;

    const activeRungs = results.map((result) => result.rung);
    const next = { ...state, activeRungs, updatedAtMs: this.now() };
    this.deps.repository.upsertLadder(next);
    for (const result of results) {
      if (!result.changed) continue;
      this.writeCounter("profile_ladder_stale_live_rung_reconciled", 1, {
        band: state.band,
        reason: result.reason,
      });
    }
    return next;
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
    if (!this.isExitStateAllowed(market.tokenId)) return;
    if (!this.deps.isProfileOwned(market.tokenId)) return;
    if (!isValidLadderBbo(market.bestBid, market.bestAsk)) {
      this.armMissingLadderRecoveryCooldown(market.tokenId);
      return;
    }
    if (this.hasOpenSellOrder(market.tokenId)) {
      this.armMissingLadderRecoveryCooldown(market.tokenId);
      return;
    }

    const position = this.resolveSingleActivePosition(market.tokenId);
    if (position == null) return;
    if (!this.isPositionEligibleForProfileExit(position)) return;
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

  private async reopenStaleDustLadderIfEligible(
    state: LadderState,
    position: Position,
    market: NormalizedMarket,
  ): Promise<boolean> {
    if (state.status !== "closed" || position.status !== PositionStatus.Dust) return false;
    if (readCloseReason(state.metadataJson) !== "stale_no_open_position") return false;
    if (!this.isPositionEligibleForProfileExit(position)) return false;
    if (!isValidLadderBbo(market.bestBid, market.bestAsk)) return false;
    const marketData = await this.resolveOrderMarketData(state.band, market, this.now());
    if (marketData == null) {
      this.writeStaleDustReopenBlocked(state, "missing_min_order");
      return false;
    }
    const orders = this.deps.orderRepo?.findByTokenId(state.tokenId);
    if (orders == null) {
      this.writeStaleDustReopenBlocked(state, "order_reader_unavailable");
      return false;
    }
    const reconciliation = state.activeRungs.map((rung) => reconcileRungLiveness(rung, orders));
    if (reconciliation.some((result) => !result.changed && result.blockedReason != null)) {
      this.writeStaleDustReopenBlocked(state, "unusable_order_evidence");
      return false;
    }
    const now = this.now();
    const reopened: LadderState = {
      ...state,
      status: "active",
      activeRungs: reconciliation.map((result) => result.rung),
      closedAtMs: null,
      updatedAtMs: now,
    };
    this.deps.repository.upsertLadder(reopened);
    this.writeCounter("profile_ladder_stale_dust_reopened", 1, { band: state.band });
    this.insertRiskEvent("profile_ladder_stale_dust_reopened", {
      tokenId: String(state.tokenId),
      ladderId: state.ladderId,
      band: state.band,
    });
    await this.advanceLiveRungs(reopened, market, now, position);
    return true;
  }

  private writeStaleDustReopenBlocked(state: LadderState, reason: string): void {
    this.writeCounter("profile_ladder_stale_dust_reopen_blocked", 1, {
      band: state.band,
      reason,
    });
  }

  private findAdoptionPositions(): Position[] {
    const reader = this.deps.positionRepo;
    if (reader == null) return [];
    const byPositionId = new Map<string, Position>();
    for (const position of [...reader.findOpen(), ...reader.findDust()]) {
      byPositionId.set(String(position.positionId), position);
    }
    return [...byPositionId.values()];
  }

  private resolveSingleActivePosition(tokenId: TokenId): Position | null {
    const reader = this.deps.positionRepo;
    if (reader == null) return null;
    const active = reader.findActiveByTokenId(tokenId);
    if (active.length !== 1) {
      this.writeCounter("profile_ladder_position_resolution_failed", 1, {
        reason: active.length === 0 ? "missing" : "ambiguous",
      });
      return null;
    }
    const position = active[0]!;
    if (position.size <= 0) {
      this.writeCounter("profile_ladder_position_resolution_failed", 1, {
        reason: "non_sellable",
      });
      return null;
    }
    return position;
  }

  private isPositionEligibleForProfileExit(position: Position): boolean {
    if (!this.isExitStateAllowed(position.tokenId)) return false;
    if (isBounceOwned(position)) return false;
    return this.deps.isProfileOwned?.(position.tokenId) ?? true;
  }

  private isExitStateAllowed(tokenId: TokenId): boolean {
    try {
      const state = this.deps.profileStateReader?.getProfileState(tokenId) ?? null;
      return state !== "QD_HANDOFF" && state !== "CLOSED";
    } catch {
      return false;
    }
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
    const active = this.deps.positionRepo.findActiveByTokenId(state.tokenId);
    if (active.length === 1 && active[0]!.size > 0) return active[0]!;
    if (active.length > 1) {
      this.skipActiveLadderWithoutOpenPosition(state, source, "position_ambiguous");
      return null;
    }
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
    reason:
      | "open_sell_exists"
      | "position_reader_unavailable"
      | "order_reader_unavailable"
      | "position_ambiguous",
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
        minOrderSize: resolveEffectiveMinOrderSize(market.minOrderSize),
        config: policy,
        previousBand: previous?.band ?? null,
        entryStyle: position.entryStyle ?? null,
        harvestGainPct: this.makerHarvestGainPct(),
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

  private emitShadowPlanktonPolicy(
    position: Position,
    market: NormalizedMarket,
    policy: ExecutionProfilePolicy["sellLadder"],
    mode: ProfileLadderMode,
    ladderId: string,
    currentRungs: readonly LadderRung[],
  ): void {
    try {
      const config = policy.shadowPlanktonPolicy;
      if (config == null || !config.enabled) return;
      const evaluation = computeProfileLadderShadowEvaluation({
        avgEntryPrice: position.avgEntryPrice,
        costBasisUsd: position.costBasisUsdc,
        positionSizeShares: position.size,
        mode,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        tickSize: market.tickSize,
        minOrderSize: resolveEffectiveMinOrderSize(market.minOrderSize),
        config,
        currentRungs,
      });
      if (evaluation == null) return;
      const state = shadowProfileStateLabel(this.resolveProfileState(position.tokenId));
      for (const result of evaluation.results) {
        this.emitShadowCandidateCounters(result, mode, state);
        this.emitShadowCandidateRiskEvent(position, market, ladderId, result, evaluation);
      }
      if (evaluation.variantCollapse != null) {
        this.writeCounter("profile_ladder_shadow_variants_collapsed_total", 1, {
          band: evaluation.band,
          collapseType: evaluation.variantCollapse.collapseType,
        });
      }
    } catch {
      this.writeCounter("profile_ladder_shadow_candidate_evaluated_total", 1, {
        variant: "median",
        band: "gte_0_10",
        mode: "unknown",
        state: "unknown",
        result: "invalid_input",
        reason: "invalid_input",
      });
    }
  }

  private emitShadowCandidateCounters(
    result: ProfileLadderShadowCandidateResult,
    mode: ProfileLadderMode,
    state: "accumulating" | "harvesting" | "exiting" | "unknown",
  ): void {
    this.writeCounter("profile_ladder_shadow_candidate_evaluated_total", 1, {
      variant: result.variant,
      band: result.band,
      mode,
      state,
      result: result.result,
      reason: result.reason,
    });
    this.writeCounter("profile_ladder_shadow_candidate_executable_total", 1, {
      variant: result.variant,
      band: result.band,
      rungCountBucket: result.rungCountBucket,
      reason: result.reason,
    });
    this.writeCounter("profile_ladder_shadow_target_delta_bucket", 1, {
      variant: result.variant,
      band: result.band,
      deltaBucket: result.deltaBucket,
    });
    this.writeCounter("profile_ladder_shadow_first_size_fraction_bucket", 1, {
      variant: result.variant,
      band: result.band,
      fractionBucket: result.candidateFirstFractionBucket,
    });
    if (result.collapsedDueMinOrder) {
      this.writeCounter("profile_ladder_shadow_min_order_collapse_total", 1, {
        variant: result.variant,
        band: result.band,
        collapseReason: result.collapseReason,
      });
    }
    if (result.wouldAvoidLowFullExitLe110) {
      this.writeCounter("profile_ladder_shadow_low_full_exit_avoided_total", 1, {
        variant: result.variant,
        band: result.band,
        threshold: "le_1_10",
      });
    }
    if (result.hasHigherExposureCandidate) {
      this.writeCounter("profile_ladder_shadow_higher_exposure_present_total", 1, {
        variant: result.variant,
        band: result.band,
        rungCountBucket: result.rungCountBucket,
      });
    }
    if (result.pr2ProtectedExposureConflict) {
      this.writeCounter("profile_ladder_shadow_pr2_conflict_total", 1, {
        variant: result.variant,
        band: result.band,
        reason: "pr2_conflict",
      });
    }
  }

  private emitShadowCandidateRiskEvent(
    position: Position,
    market: NormalizedMarket,
    ladderId: string,
    result: ProfileLadderShadowCandidateResult,
    evaluation: ProfileLadderShadowEvaluation,
  ): void {
    const config = this.policy().shadowPlanktonPolicy;
    if (config == null || !config.writeRiskEvents) return;
    if (!this.shouldWriteShadowRiskEvent(ladderId, result, config.riskEventDedupeMs)) return;
    this.insertRiskEvent("profile_ladder_shadow_candidate_sampled", {
      tokenId: String(position.tokenId),
      conditionId: String(position.conditionId),
      ladderId,
      variant: result.variant,
      band: result.band,
      avgEntry: result.avgEntry,
      currentFirstTargetMultiple: result.currentFirstTargetMultiple,
      currentFirstSizeFraction: result.currentFirstSizeFraction,
      candidateRungs: result.candidateRungs,
      effectiveFirstTargetMultiple: result.effectiveFirstTargetMultiple,
      firstSizeFraction: result.firstSizeFraction,
      deltaBucket: result.deltaBucket,
      collapsedDueMinOrder: result.collapsedDueMinOrder,
      singleExecutableRung: result.singleExecutableRung,
      variantsCollapsedByTick: evaluation.variantCollapse != null,
      collapseType: evaluation.variantCollapse?.collapseType ?? null,
      pr2ProtectedExposureConflict: result.pr2ProtectedExposureConflict,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      minOrderSize: market.minOrderSize ?? null,
      tickSize: market.tickSize,
    });
  }

  private shouldWriteShadowRiskEvent(
    ladderId: string,
    result: ProfileLadderShadowCandidateResult,
    dedupeMs: number,
  ): boolean {
    const now = this.now();
    if (this.shadowRiskEventDedupeUntilByKey.size > 1_000) {
      for (const [key, untilMs] of this.shadowRiskEventDedupeUntilByKey) {
        if (untilMs <= now) this.shadowRiskEventDedupeUntilByKey.delete(key);
      }
    }
    const key = [ladderId, result.variant, result.band, result.deltaBucket].join("|");
    const dedupeUntilMs = this.shadowRiskEventDedupeUntilByKey.get(key) ?? 0;
    if (dedupeUntilMs > now) return false;
    this.shadowRiskEventDedupeUntilByKey.set(key, now + dedupeMs);
    return true;
  }

  private resolveAttemptSignalId(
    position: Position,
    ladderId: string,
    rung: LadderRung,
    band: ProfileLadderBand,
  ): string | null {
    const baseSignalId = `profile_ladder_${String(position.tokenId)}_${ladderId}_${rung.rungIndex}`;
    const probe = this.deps.orderRepo?.findByClientOrderId?.bind(this.deps.orderRepo);
    if (!hasPersistedRecoveryRung(rung) && probe != null) {
      for (let attempt = 0; attempt <= PROFILE_LADDER_CLIENT_ORDER_ID_MAX_RETRIES; attempt += 1) {
        const signalId = attempt === 0 ? baseSignalId : `${baseSignalId}_retry${attempt}`;
        const existing = probe(
          String(buildClientOrderId({ signalId, tokenId: position.tokenId, side: "sell" })),
        );
        if (existing == null) {
          if (attempt > 0) {
            this.writeCounter("profile_ladder_clientorderid_retry_used", 1, {
              band,
              attempt: String(attempt),
            });
          }
          return signalId;
        }
        if (!isLegacyRetrySkippableTerminalOrder(existing)) {
          this.writeCounter("profile_ladder_clientorderid_retry_blocked", 1, {
            band,
            reason: "live_or_filled",
          });
          return null;
        }
      }
      this.writeCounter("profile_ladder_clientorderid_retry_blocked", 1, {
        band,
        reason: "exhausted",
      });
      return null;
    }
    const preExchangeRetryCount = normalizeRetryCount(rung.preExchangeRetryCount);
    if (preExchangeRetryCount > PROFILE_LADDER_CLIENT_ORDER_ID_MAX_RETRIES) {
      const signature = `${ladderId}|${rung.rungIndex}|${preExchangeRetryCount}`;
      if (this.exhaustedRetrySignatureByToken.get(String(position.tokenId)) !== signature) {
        this.exhaustedRetrySignatureByToken.set(String(position.tokenId), signature);
        this.writeCounter("profile_ladder_pre_exchange_retry_exhausted", 1, { band });
        this.insertRiskEvent("profile_ladder_pre_exchange_retry_exhausted", {
          tokenId: String(position.tokenId),
          ladderId,
          rungIndex: rung.rungIndex,
          preExchangeRetryCount,
        });
      }
      return null;
    }
    this.exhaustedRetrySignatureByToken.delete(String(position.tokenId));
    return persistedAttemptSignalId(position.tokenId, ladderId, rung);
  }

  private async publishPlaceOrder(
    position: Position,
    market: NormalizedMarket,
    marketData: ProfileLadderOrderMarketData,
    ladderId: string,
    rung: LadderRung,
    timestamp: number,
    options: {
      signalId?: string;
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
    // Release A Phase 3: a bounce owner is serviced exclusively by the bounce ladder
    // — belt-and-suspenders catch for any recovery/startup path that reaches
    // placement without going through handlePositionUpdated.
    if (isBounceOwned(position)) return;
    const signalId =
      options.signalId ??
      `profile_ladder_${String(position.tokenId)}_${ladderId}_${rung.rungIndex}`;
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
      attemptFilledBaseShares: rung.attemptFilledBaseShares,
      attemptSubmittedShares: rung.attemptSubmittedShares,
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
        size: rung.attemptSubmittedShares ?? remainingRungShares(rung),
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
        positionId: position.positionId,
        metadata: {
          source: this.policy().orderTag,
          ...(marketData.cacheStatus == null ? {} : { cacheStatus: marketData.cacheStatus }),
          marketData,
          profileLadder: {
            ladderId,
            rungIndex: rung.rungIndex,
            multiplier: rung.multiplier,
            sizingFraction: rung.sizingFraction,
            attemptFilledBaseShares: rung.attemptFilledBaseShares ?? rung.filledSizeShares,
            attemptSubmittedShares: rung.attemptSubmittedShares ?? remainingRungShares(rung),
            remainingNotionalUsd:
              (rung.attemptSubmittedShares ?? remainingRungShares(rung)) * rung.price,
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
    options: { allowFallback?: boolean } = {},
  ): Promise<ProfileLadderOrderMarketData | null> {
    const marketData = this.resolveOrderMarketDataFromMarket(market);
    if (marketData != null) return marketData;

    const resolution = await this.deps.bookCache?.getFreshOrRefresh(String(market.tokenId), now);
    const book = resolution?.entry?.book;
    const minOrderSize = book?.minOrderSize;
    if (typeof minOrderSize === "number" && Number.isFinite(minOrderSize) && minOrderSize > 0) {
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
        minOrderSource: "book-cache",
      };
    }
    // Neither the base market nor the book cache yielded a usable min order size.
    // The reason distinguishes a missing book (cache refresh failed) from a book
    // that simply omits the min order size, keeping the label a closed enum.
    this.writeCounter("profile_ladder_min_order_size_hydration_miss", 1, {
      band,
      reason: book == null ? "cache_refresh_failed" : "no_market_min_order",
    });
    return this.resolveFallbackOrderMarketData(band, market, options.allowFallback ?? false);
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
      minOrderSource: "base-market",
    };
  }

  private isLiveLite(): boolean {
    return this.deps.runtimeMode === "live-lite";
  }

  // Last-resort min-order hydration for planned rungs. Mirrors the executor's
  // live-lite min-order floor: the conservative fallback is only available in
  // live-lite; every other mode stays fail-closed so unknown min order size never
  // produces a live SELL. The fallback never weakens the executor's own floor
  // because both resolve to DEFAULT_FALLBACK_MIN_ORDER_SIZE.
  private resolveFallbackOrderMarketData(
    band: ProfileLadderBand,
    market: NormalizedMarket,
    allowFallback: boolean,
  ): ProfileLadderOrderMarketData | null {
    if (!allowFallback) return null;
    if (!this.isLiveLite()) {
      this.writeCounter("profile_ladder_min_order_fallback_total", 1, {
        band,
        result: "fallback_unavailable",
      });
      return null;
    }
    const effectiveMinOrderSize = resolveEffectiveMinOrderSize(undefined);
    return {
      bookSource: market.bookSource ?? "unknown",
      minOrderSize: effectiveMinOrderSize,
      effectiveMinOrderSize,
      tickSize: market.tickSize,
      minOrderSource: "fallback",
    };
  }

  private recordSubMinResidual(
    state: LadderState,
    residualShares: number,
    minOrderSize: number,
  ): void {
    const signature = `${roundQuantity(residualShares)}|${roundQuantity(minOrderSize)}`;
    const tokenKey = String(state.tokenId);
    if (this.subMinResidualSignatureByToken.get(tokenKey) === signature) return;
    this.subMinResidualSignatureByToken.set(tokenKey, signature);
    this.writeCounter("profile_ladder_residual_below_min_order", 1, { band: state.band });
    this.insertRiskEvent("profile_ladder_residual_below_min_order", {
      tokenId: tokenKey,
      ladderId: state.ladderId,
      residualShares,
      minOrderSize,
    });
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
        ...(pending.attemptFilledBaseShares == null
          ? {}
          : { attemptFilledBaseShares: pending.attemptFilledBaseShares }),
        ...(pending.attemptSubmittedShares == null
          ? {}
          : { attemptSubmittedShares: pending.attemptSubmittedShares }),
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
    if (pending.kind === "standard") {
      if (
        reason === "duplicate_client_order_id_pre_submit" &&
        this.adoptAcceptedPersistedAttempt(pending, String(event.clientOrderId))
      ) {
        return;
      }
      this.persistPreExchangeFailure(pending, event.timestamp);
      return;
    }
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

  private adoptAcceptedPersistedAttempt(
    pending: PendingProfileLadderRung,
    clientOrderId: string,
  ): boolean {
    const state = this.deps.repository.getLadder(pending.tokenId);
    const order = this.deps.orderRepo?.findByClientOrderId?.(clientOrderId);
    if (state == null || state.ladderId !== pending.ladderId || order == null) return false;
    const match = resolveSingleAdoptableRungMatch(state, [order], true);
    if (match == null || (order.status === OrderStatus.Rejected && !order.exchangeOrderId)) {
      return false;
    }
    if (!this.adoptRecoveryOrderIntoState(state, [order], true)) return false;
    this.reconcileRungLiveness(this.deps.repository.getLadder(pending.tokenId));
    return true;
  }

  private persistPreExchangeFailure(pending: PendingProfileLadderRung, timestamp: number): void {
    const state = this.deps.repository.getLadder(pending.tokenId);
    if (state == null || state.ladderId !== pending.ladderId) return;
    let matched = false;
    const activeRungs = state.activeRungs.map((rung) => {
      if (rung.rungIndex !== pending.rungIndex) return rung;
      matched = true;
      return {
        ...rung,
        lifecycle: "planned" as const,
        orderId: null,
        attemptFilledBaseShares: normalizeCumulativeShares(
          pending.attemptFilledBaseShares ?? rung.filledSizeShares,
          rung.sizeShares,
        ),
        attemptSubmittedShares: 0,
        preExchangeRetryCount: normalizeRetryCount(rung.preExchangeRetryCount) + 1,
      };
    });
    if (!matched) return;
    this.deps.repository.upsertLadder({ ...state, activeRungs, updatedAtMs: timestamp });
    this.armPlannedRungRetryCooldown(pending.tokenId, timestamp);
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
    if (!this.isExitStateAllowed(tokenId)) return;
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

  private makerHarvestGainPct(): number {
    return this.deps.makerEntryPolicy?.().harvestGainPct ?? 0.5;
  }

  private isBboCooldownActive(tokenId: TokenId): boolean {
    return (this.bboCooldownUntilByToken.get(String(tokenId)) ?? 0) > this.now();
  }

  private async recordPostRefillFollowThrough(
    position: Position,
    market: NormalizedMarket,
    state: LadderState,
    allowHealthyCoverageReplacement: boolean,
  ): Promise<void> {
    const config = resolvePostRefillFollowThroughConfig(this.policy());
    if (!config.enabled) return;
    if (this.deps.isProfileOwned != null && !this.deps.isProfileOwned(position.tokenId)) return;

    const evaluation = evaluatePostRefillLiveRung({
      state,
      position,
      market,
      config,
      allowHealthyCoverageReplacement,
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
    this.writeCounter("profile_ladder_replacement_trigger_total", 1, {
      action: labels.action,
      band: labels.band,
      mode: labels.mode,
      state: labels.state,
      trigger: decision.trigger,
    });
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
        trigger: decision.trigger,
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
      trigger: decision.trigger,
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

// A ladder is a planned-no-live recovery candidate exactly while it still holds a
// rung that was planned but never went live (orderId null).
function hasPlannedNoLiveRung(state: LadderState): boolean {
  return state.activeRungs.some((rung) => rung.lifecycle === "planned" && rung.orderId == null);
}

function hasPersistedRecoveryAttempt(state: LadderState): boolean {
  return state.activeRungs.some(hasPersistedRecoveryRung);
}

function hasPersistedRecoveryRung(rung: LadderRung): boolean {
  return (
    (typeof rung.terminalRetryKey === "string" && rung.terminalRetryKey.length > 0) ||
    normalizeRetryCount(rung.preExchangeRetryCount) > 0
  );
}

function persistedAttemptSignalId(tokenId: TokenId, ladderId: string, rung: LadderRung): string {
  const base = `profile_ladder_${String(tokenId)}_${ladderId}_${rung.rungIndex}`;
  const terminal =
    rung.terminalRetryKey == null ? base : `${base}_terminal_retry_${rung.terminalRetryKey}`;
  const preRetry = normalizeRetryCount(rung.preExchangeRetryCount);
  return preRetry === 0 ? terminal : `${terminal}_pre_retry${preRetry}`;
}

function isLegacyRetrySkippableTerminalOrder(order: Order): boolean {
  return (
    isProfileLadderSellOrder(order) &&
    (order.status === OrderStatus.Cancelled || order.status === OrderStatus.Rejected) &&
    order.fillProgressShares === 0
  );
}

function normalizeRetryCount(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

function normalizeCumulativeShares(value: number, rungSize: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return roundQuantity(Math.min(value, Math.max(0, rungSize)));
}

function normalizeSubmittedShares(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return roundQuantity(Math.min(value, Math.max(0, maximum)));
}

function withoutRecoveryAttempt(rung: LadderRung): LadderRung {
  const cleared = { ...rung };
  delete cleared.terminalRetryKey;
  delete cleared.attemptFilledBaseShares;
  delete cleared.attemptSubmittedShares;
  delete cleared.preExchangeRetryCount;
  return cleared;
}

function readCloseReason(metadataJson: string): string | null {
  try {
    const metadata = JSON.parse(metadataJson) as { closeReason?: unknown };
    return typeof metadata.closeReason === "string" ? metadata.closeReason : null;
  } catch {
    return null;
  }
}

function recoveryCandidateSignature(state: LadderState): string {
  const rungs = state.activeRungs
    .map((rung) => `${rung.rungIndex}:${rung.lifecycle}:${rung.orderId == null ? "0" : "1"}`)
    .join("|");
  return `${state.ladderId}#${rungs}`;
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
  allowHealthyCoverageReplacement?: boolean;
}): PostRefillLiveRungEvaluation | null {
  const { allowHealthyCoverageReplacement = false, config, market, position, state } = input;
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
  const hasLowCoverage = liveCoverageRatio < config.minCoverageRatio;
  if (!hasLowCoverage && !allowHealthyCoverageReplacement) return evaluation;
  const trigger: PostRefillReplacementTrigger = hasLowCoverage
    ? "low_coverage"
    : "scale_in_stale_price";

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
    trigger,
  };
  return evaluation;
}

function isPlacedOrPartiallyFilledRung(rung: LadderRung): boolean {
  return rung.lifecycle === "placed" || rung.lifecycle === "partially_filled";
}

type RungLivenessReconciliation =
  | {
      changed: false;
      rung: LadderRung;
      blockedReason?: "missing_order" | "unusable_terminal";
    }
  | {
      changed: true;
      rung: LadderRung;
      reason: "missing_no_fill" | "terminal_no_fill" | "terminal_with_fill" | "filled";
    };

function reconcileRungLiveness(
  rung: LadderRung,
  orders: readonly Order[],
): RungLivenessReconciliation {
  if (!isPlacedOrPartiallyFilledRung(rung) || rung.orderId == null) {
    return { changed: false, rung };
  }
  const order = orders.find((candidate) => orderMatchesOrderId(candidate, rung.orderId!));
  if (order == null) {
    return { changed: false, rung, blockedReason: "missing_order" };
  }
  if (order != null && isLiveProfileLadderSellOrder(order)) {
    return { changed: false, rung };
  }

  const terminal = resolveAuthoritativeTerminalProgress(rung, order);
  if (terminal == null) {
    return { changed: false, rung, blockedReason: "unusable_terminal" };
  }
  if (terminal.cumulativeFilledShares + 1e-9 >= rung.sizeShares) {
    return {
      changed: true,
      reason: "filled",
      rung: {
        ...withoutRecoveryAttempt(rung),
        lifecycle: "filled",
        orderId: null,
        filledSizeShares: roundQuantity(rung.sizeShares),
      },
    };
  }
  return {
    changed: true,
    reason:
      terminal.cumulativeFilledShares > rung.filledSizeShares
        ? "terminal_with_fill"
        : "terminal_no_fill",
    rung: {
      ...rung,
      lifecycle: "planned",
      orderId: null,
      filledSizeShares: terminal.cumulativeFilledShares,
      terminalRetryKey: terminal.retryKey,
      attemptFilledBaseShares: terminal.cumulativeFilledShares,
      attemptSubmittedShares: 0,
      preExchangeRetryCount: 0,
    },
  };
}

function isLiveProfileLadderSellOrder(order: Order): boolean {
  return (
    order.side === "sell" &&
    isProfileLadderOrder(order) &&
    OPEN_ORDER_STATUSES.has(order.status) &&
    hasUsableOrderIdentifier(order)
  );
}

function hasUsableOrderIdentifier(order: Order): boolean {
  return String(order.orderId).length > 0 || (order.exchangeOrderId ?? "").length > 0;
}

function resolveAuthoritativeTerminalProgress(
  rung: LadderRung,
  order: Order,
): { cumulativeFilledShares: number; retryKey: string } | null {
  if (!isProfileLadderSellOrder(order)) return null;
  if (
    order.status !== OrderStatus.Cancelled &&
    order.status !== OrderStatus.Rejected &&
    order.status !== OrderStatus.Filled
  ) {
    return null;
  }
  const retryKey = order.exchangeOrderId?.trim();
  if (retryKey == null || retryKey.length === 0) return null;
  const baseline = normalizeCumulativeShares(rung.attemptFilledBaseShares ?? 0, rung.sizeShares);
  const submitted = normalizeSubmittedShares(
    rung.attemptSubmittedShares ?? order.size,
    rung.sizeShares - baseline,
  );
  const reportedProgress = order.fillProgressShares;
  const orderProgress =
    order.status === OrderStatus.Filled
      ? submitted
      : typeof reportedProgress === "number" &&
          Number.isFinite(reportedProgress) &&
          reportedProgress >= 0
        ? reportedProgress
        : null;
  if (orderProgress == null) return null;
  const cumulativeFilledShares = roundQuantity(
    Math.min(
      rung.sizeShares,
      Math.max(rung.filledSizeShares, baseline + Math.min(orderProgress, submitted)),
    ),
  );
  return { cumulativeFilledShares, retryKey };
}

function remainingRungShares(rung: LadderRung): number {
  return Math.max(0, rung.sizeShares - rung.filledSizeShares);
}

function isSubmittablePostRefillPlannedRung(rung: LadderRung, market: NormalizedMarket): boolean {
  // PR2 detection only — never a placement gate. Live PR2 placement stays
  // fail-closed via resolveOrderMarketData(...) without allowFallback. Reuse the
  // shared fallback helper instead of an ad-hoc `?? 1` to keep min-order
  // semantics in one place; the resolved value is identical for null/positive
  // min order sizes.
  const minOrderSize = resolveEffectiveMinOrderSize(market.minOrderSize);
  return (
    rung.lifecycle === "planned" &&
    rung.orderId == null &&
    rung.sizeShares >= minOrderSize &&
    !wouldCrossProfileLadderPostOnly(rung.price, market.bestBid)
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

const POSITION_AVG_ENTRY_TOLERANCE = 1e-9;
const POSITION_COST_BASIS_TOLERANCE_USDC = 1e-6;

function hasPositionBasisChanged(state: LadderState, position: Position): boolean {
  return (
    Math.abs(state.lastAvgEntry - position.avgEntryPrice) > POSITION_AVG_ENTRY_TOLERANCE ||
    Math.abs(state.lastCostBasisUsdc - position.costBasisUsdc) > POSITION_COST_BASIS_TOLERANCE_USDC
  );
}

function isCausalScaleInBasisIncrease(
  state: LadderState | null,
  position: Position,
  reason: LadderRebuildReason,
): boolean {
  return (
    reason === "scale_in" &&
    state != null &&
    Number.isFinite(state.lastCostBasisUsdc) &&
    Number.isFinite(position.costBasisUsdc) &&
    position.costBasisUsdc > state.lastCostBasisUsdc + POSITION_COST_BASIS_TOLERANCE_USDC
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

function resolveSingleAdoptableRungMatch(
  state: LadderState,
  orders: readonly Order[],
  exactAttempt = false,
): AdoptableRungMatch | null {
  const matches: AdoptableRungMatch[] = [];
  state.activeRungs.forEach((rung, index) => {
    if (rung.lifecycle !== "planned" || rung.orderId != null) return;
    for (const order of orders) {
      if (!pricesEqual(rung.price, order.price)) continue;
      const attempt = readPersistedAttempt(order, state, rung);
      if (exactAttempt && attempt == null) continue;
      matches.push({ order, index, ...attempt });
    }
  });
  return matches.length === 1 ? matches[0]! : null;
}

type PersistedAttempt = {
  attemptFilledBaseShares: number;
  attemptSubmittedShares: number;
};

type AdoptableRungMatch = Partial<PersistedAttempt> & {
  order: Order;
  index: number;
};

type PersistedAttemptMetadata = PersistedAttempt & { ladderId: string; rungIndex: number };

function findPersistedAttemptEvidence(state: LadderState, orders: readonly Order[]): Order[] {
  const identities = state.activeRungs
    .filter(
      (rung) =>
        rung.lifecycle === "planned" && rung.orderId == null && hasPersistedRecoveryRung(rung),
    )
    .map((rung) => {
      const signalId = persistedAttemptSignalId(state.tokenId, state.ladderId, rung);
      const clientOrderId = buildClientOrderId({ signalId, tokenId: state.tokenId, side: "sell" });
      return { signalId, clientOrderId: String(clientOrderId) };
    });
  return orders.filter((order) =>
    identities.some(
      (identity) =>
        order.signalId === identity.signalId ||
        String(order.clientOrderId) === identity.clientOrderId,
    ),
  );
}

function readPersistedAttempt(
  order: Order,
  state: LadderState,
  rung: LadderRung,
): PersistedAttempt | null {
  const metadata = order.metadata?.profileLadder as Partial<PersistedAttemptMetadata> | undefined;
  const baseline = metadata?.attemptFilledBaseShares;
  const submitted = metadata?.attemptSubmittedShares;
  const signalId = persistedAttemptSignalId(state.tokenId, state.ladderId, rung);
  const clientOrderId = buildClientOrderId({ signalId, tokenId: state.tokenId, side: "sell" });
  if (
    !isProfileLadderSellOrder(order) ||
    order.metadata?.source !== "profile_ladder" ||
    metadata?.ladderId !== state.ladderId ||
    metadata.rungIndex !== rung.rungIndex ||
    !Number.isFinite(baseline) ||
    !Number.isFinite(submitted) ||
    baseline! < 0 ||
    submitted! <= 0 ||
    !pricesEqual(baseline!, rung.attemptFilledBaseShares ?? rung.filledSizeShares) ||
    !pricesEqual(submitted!, rung.attemptSubmittedShares ?? order.size) ||
    !pricesEqual(submitted!, order.size) ||
    order.signalId !== signalId ||
    String(order.clientOrderId) !== String(clientOrderId)
  ) {
    return null;
  }
  return { attemptFilledBaseShares: baseline!, attemptSubmittedShares: submitted! };
}

function resolveAdoptedFilledSizeShares(
  order: Order,
  rung: LadderRung,
  attemptFilledBaseShares?: number,
  attemptSubmittedShares?: number,
): number {
  if (order.status !== OrderStatus.PartiallyFilled) return rung.filledSizeShares;
  if (!isPositiveFinite(order.fillProgressShares)) return rung.filledSizeShares;
  const baseline = normalizeCumulativeShares(
    attemptFilledBaseShares ?? rung.filledSizeShares,
    rung.sizeShares,
  );
  const submitted = normalizeSubmittedShares(
    attemptSubmittedShares ?? order.size,
    rung.sizeShares - baseline,
  );
  return roundQuantity(
    Math.min(
      rung.sizeShares,
      Math.max(rung.filledSizeShares, baseline + Math.min(order.fillProgressShares, submitted)),
    ),
  );
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

function shadowProfileStateLabel(
  state: ProfileLadderTelemetryState,
): "accumulating" | "harvesting" | "exiting" | "unknown" {
  switch (state) {
    case "ACCUMULATING":
      return "accumulating";
    case "HARVESTING":
      return "harvesting";
    case "EXITING":
      return "exiting";
    default:
      return "unknown";
  }
}

// A rung owns a real resting order once OrderPlaced has backfilled its exchange
// orderId. Such a rung must never be silently replaced by a freshly-planned
// (orderId-null) rung during a rebuild, or the live order is orphaned: untracked
// in module state yet still resting on the exchange, breaking cap, fill matching,
// and cancellation.
function mustSurviveRebuild(rung: LadderRung): boolean {
  return (
    (rung.orderId != null &&
      (rung.lifecycle === "placed" ||
        rung.lifecycle === "partially_filled" ||
        rung.lifecycle === "filled")) ||
    (rung.lifecycle === "planned" &&
      rung.orderId == null &&
      ((rung.terminalRetryKey?.length ?? 0) > 0 ||
        normalizeRetryCount(rung.preExchangeRetryCount) > 0))
  );
}

function pricesEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function mergeLiveRungs(
  planRungs: readonly LadderRung[],
  previous: LadderState | null,
): LadderRung[] {
  const liveOld = (previous?.activeRungs ?? []).filter(mustSurviveRebuild);
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
