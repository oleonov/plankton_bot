/**
 * Signal-to-Order bridge — converts SignalApproved into PlaceOrderRequested.
 *
 * Closes the gap in the end-to-end trading path:
 *   strategy → SignalProduced → risk → SignalApproved → [this bridge] → PlaceOrderRequested → execution
 *
 * Responsibilities:
 *  - Subscribe to SignalApproved
 *  - Resolve a live CLOB book (cache/refresh) and build hard-liveness guard
 *  - Price orders from the configured edge/exit policy; postOnly in relayer mode
 *  - Enforce persistent same-price cooldowns after repeated stale cancels
 *  - Publish PlaceOrderRequested with a deterministic clientOrderId
 *
 * Does NOT evaluate risk — that already happened upstream.
 */

import type {
  CancelOrderCommand,
  DeadSideGuardMode as DomainDeadSideGuardMode,
  EventBus,
  ExecutionPolicy,
  ExecutionPolicyObservation,
  ExecutionPolicyObservationRepository,
  InventoryLotRepository,
  NormalizedMarket,
  OrderRepository,
  OrderBookSnapshot,
  PositionRepository,
  ProfileId,
  RuntimeEventMap,
  PlaceOrderCommand,
  TokenId,
  Order,
  LegStateRepository,
  RiskEventRepository,
  S1OwnershipReader,
  SellShadowAvgEntrySource,
  TrackRFeeQuote,
  TrackRFeeRateSource,
  TrackRHonestPricingPolicy,
  TrackRTakerFeeProvider,
  TrackS3MarginAwareSpreadPolicy,
  BounceRungMetadata,
} from "@krabs/domain";
import {
  canPlaceBuyOrderForMarket,
  computeEffectiveFillPrice,
  computeTrackRMinGrossExitRatio,
  createCommandId,
  isAlive,
  isSellTimeoutReplacement,
  R23_DIP_TRIGGER_RULE_ID,
  recordStageDuration,
  resolveTrackS3SpreadCap,
  shouldSkipSellPriceCap,
  GATE_ENTRY_RULE_ID,
  BOUNCE_EXIT_TARGET_RULE_ID,
  isBounceForceExit,
  isGateWhitelisted,
  resolveSellableShareFloor,
} from "@krabs/domain";
import { DEFAULT_EXECUTION_POLICY } from "../../execution-policy.js";
import { buildClientOrderId, buildPartialExitClientOrderId } from "@krabs/domain/node";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { MarketResolutionTracker } from "../resolution/market-resolution-tracker.js";
import {
  classifyNotionalBucket,
  classifyRoundLevel,
  computePricingDeltaTicks,
  clampExecutablePrice,
  floorToTick,
  normalizeTickSize,
  planktonAlignedMarkupCap,
  resolveBidAnchoredSellPrice,
  resolveBoundedMidpointPrice,
  SELL_PRICE_CEILING,
  validateExecutablePrice,
  type BoundedMidpointDiagnostics,
  type ExecutablePriceValidationFailureReason,
} from "../../executable-price.js";

// Track P F2 tier helpers live in executable-price.ts (shared with the
// algo-decision Track Q shadow). Re-exported here so existing strategy-layer
// imports/tests resolve unchanged.
export { planktonAlignedMarkupCap, SELL_PRICE_CEILING };
import {
  applyOrderBookToMarket,
  type CandidateBookCache,
  type CandidateBookCacheEntry,
  type CandidateBookResolution,
} from "./candidate-book-cache.js";
import {
  ExitBookFallbackCache,
  type ExitBookFetcher,
  type ExitBookSource,
} from "./exit-book-fallback-cache.js";
import {
  floorToMinOrderStep,
  isExecutableOrderSize,
  resolveEffectiveMinOrderSize,
} from "../../min-order-size.js";
import {
  evaluateSignalTrackAAddThrottle,
  type TrackASignalEvaluation,
} from "../dead-market-shadow/track-a-add-throttle-shadow.js";
import { computeMakerEntryPrice } from "../algo-decision/maker-entry.js";
import type { SignalPathTelemetry } from "./signal-path-telemetry.js";
import type { EffectiveResolutionGate } from "../../effective-resolution-service.js";
import type { PositionConcentrationService } from "../../position-concentration-service.js";

const BRIDGE_WS_BOOK_WAIT_MS = 25;
const MIN_SIZE_EPSILON = 1e-9;
const MIN_NOTIONAL_EPSILON = 1e-9;
const D4_RULE_ID = "D4";
const D4_MIN_EFFECTIVE_TICK_SIZE = 0.01;
const TAKER_BELOW_MARGIN_REASON = "taker-below-margin";
const PARTIAL_EXIT_WINDOW_MS = 60 * 60_000;
const DEFAULT_TRACK_R_RUNTIME_POLICY: TrackRHonestPricingPolicy = {
  enabled: false,
  safetyMargin: 0.005,
  requireFullDepth: true,
  universalFallbackRate: 0.05,
  maxSaneThreshold: 1.5,
  exitBookFallback: false,
  exitBookStalenessMs: 30_000,
  exitBookFetchTtlMs: 20_000,
  takerCapSkip: false,
  allowPartialExit: false,
  partialExitMinFraction: 0.2,
  partialExitMinShares: 1,
  partialExitMaxPerHour: 3,
};
const TRACK_A_BLOCKED_METRIC = "track_a_add_throttle_blocked_total";
const TRACK_A_SUPPRESSED_METRIC = "track_a_add_throttle_suppressed_total";
const TRACK_A_BLOCK_EVENT_TYPE = "track_a_add_throttle_blocked";
const TRACK_A_BLOCK_EPISODE_COOLDOWN_MS = 60 * 60_000;

interface TrackABlockEpisode {
  firstEmittedAt: number;
  suppressedCount: number;
}

// ADR-013 defaults exposed for callers that don't thread the policy provider
// (tests, scenario runner). Runtime always reads the live policy via
// `deps.policy()` and never the constant.
export const ENTRY_PRICE_CEILING = 0.45;
export const DEAD_SIDE_NEAR_END_ASK_CEILING = 0.02;
export const DEAD_SIDE_NEAR_END_MS = 120_000;

/** Re-export for legacy callers (tests). ADR-015 moved this into `ExecutionPolicy`. */
export type DeadSideGuardMode = DomainDeadSideGuardMode;

type PricingMarketResult = {
  market: NormalizedMarket;
  book?: OrderBookSnapshot | null;
  cacheStatus:
    | CandidateBookResolution["status"]
    | "disabled"
    | "base-market"
    | "embedded"
    | "exit-book-fallback";
};

export interface SignalToOrderBridgeDeps {
  bus: EventBus;
  log: Logger;
  orderRepo?: OrderRepository | undefined;
  positionRepo?: PositionRepository | undefined;
  /**
   * FIFO lot read access for the bounce-exit backstop's exit-loss-floor
   * pre-cancel screen (docs/plans/2026-07-20-exit-loss-floor.md §Phase 5).
   * Optional and best-effort only: the authoritative safety gate lives at
   * execution-module.ts's pre-submit checkpoint regardless of whether this is
   * wired. When unset, the screen has no lot data to confirm a loss with, so
   * it fails OPEN (never blocks the backstop on its own uncertainty).
   */
  inventoryLotRepo?: InventoryLotRepository | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
  candidateBookCache?: CandidateBookCache | undefined;
  /**
   * Track S5 P0a — secondary order-book source for the exit path. When a held-position SELL misses the
   * candidate cache and the primary heartbeat book is cold/stale, the bridge fetches the book directly
   * through this gateway. Optional: when unset the fallback runs primary-only (heartbeat).
   */
  exitBookFetcher?: ExitBookFetcher | undefined;
  /**
   * ADR-015 — live execution policy lookup. The bridge calls `policy()` on
   * every signal conversion so operator SQL edits take effect without
   * restart. When unset, falls back to `DEFAULT_EXECUTION_POLICY` so tests
   * and one-shot scripts still work.
   */
  policy?: () => ExecutionPolicy;
  /**
   * ADR-015 observability — append-only writer for every BUY/SELL signal
   * that reaches execution-term resolution (or is dead-side-enforce-skipped).
   * Optional so tests and scenario runs can skip the DB write.
   */
  observations?: ExecutionPolicyObservationRepository;
  /** Denormalized on each observation row for cross-profile aggregation. */
  profileId?: ProfileId;
  /** Runtime observability for pricing-mode and opportunistic-taker decisions. */
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  /** Per-event forensic audit for successful taker-at-profit activations. */
  riskEventRepo?: RiskEventRepository | undefined;
  /**
   * Track A live enforcement leg source. Read only for add/scale-in BUYs when
   * `policy.trackAAddThrottle.enforce` is on, to classify leg age + in-leg SELL
   * state. A null/absent repo fails open to "unknown" (never blocks).
   */
  legStateRepo?: LegStateRepository | undefined;
  /** Track R honest pricing fee source. Optional so disabled/default deployments keep old behavior. */
  trackRFeeProvider?: TrackRTakerFeeProvider | undefined;
  /**
   * Track S5 belt-and-suspenders ownership guard. Read-only view of the S1 ladder ownership map.
   * The decision planner already suppresses SELLs on S1-owned tokens upstream; this lets the bridge
   * independently neutralize the S5 exit extensions (P0a/P0b/P1) if that suppression ever regresses.
   * Optional: when unset the guard is inert and the bridge behaves exactly as before.
   */
  s1Ownership?: S1OwnershipReader | undefined;
  signalPathTelemetry?: SignalPathTelemetry | undefined;
  /**
   * Defense-in-depth BUY-side guard. Mirrors the check that
   * RiskInventoryModule.handleSignal already runs upstream, so a stale market
   * snapshot or in-flight resolution between approval and bridge cannot leak
   * a placement onto a no-longer-eligible market. Optional for tests.
   */
  resolutionTracker?: MarketResolutionTracker;
  effectiveResolution?: Pick<EffectiveResolutionGate, "toBuyPlacementFields"> | undefined;
  positionConcentration?: Pick<PositionConcentrationService, "evaluateBuy"> | undefined;
  orderLifetime?: {
    canPlaceExitOrder: (
      tokenId: TokenId,
      nowMs: number,
    ) => {
      allowed: boolean;
      reason: string | null;
      mode: string | null;
      budgetPerMinute: number | null;
      remainingBudget: number | null;
    };
  };
  samePriceCooldown?: {
    canPlaceOrder: (args: {
      tokenId: TokenId;
      side: "buy" | "sell";
      price: number;
      nowMs: number;
    }) => {
      allowed: boolean;
      reason: string | null;
      staleCancelCount: number | null;
      cooldownUntilTsUtc: number | null;
    };
  };
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
}

export class SignalToOrderBridge {
  private readonly log: Logger;
  private marketCache = new Map<string, NormalizedMarket>();
  private unsubs: Array<() => void> = [];
  private lastTakerInfoLogDay: string | null = null;
  private readonly observationQueue: ExecutionPolicyObservation[] = [];
  private observationFlushScheduled = false;
  private readonly exitBookCache: ExitBookFallbackCache;
  // Track S5 P1 — per-token partial-exit placement timestamps for the hourly
  // frequency cap. In-memory only: NOT durable across a runtime restart, which
  // is acceptable for a taker partial (a restart re-opens the budget — bounded
  // by the same cap thereafter, never amplified within a window).
  private readonly partialHistoryByToken = new Map<string, number[]>();
  private readonly trackABlockEpisodes = new Map<string, TrackABlockEpisode>();

  constructor(private readonly deps: SignalToOrderBridgeDeps) {
    this.log = deps.log.child({ component: "signal-to-order" });
    // Track S5 P0a — heartbeat books are cached passively (always warmed so a live SQL flip of
    // exitBookFallback finds the cache ready); freshness/TTL read the live policy each call.
    this.exitBookCache = new ExitBookFallbackCache({
      log: this.log,
      fetcher: deps.exitBookFetcher,
      stalenessMs: () => this.getTrackRPolicy(this.getPolicy()).exitBookStalenessMs,
      fetchTtlMs: () => this.getTrackRPolicy(this.getPolicy()).exitBookFetchTtlMs,
    });
  }

  private getPolicy(): ExecutionPolicy {
    return this.deps.policy ? this.deps.policy() : DEFAULT_EXECUTION_POLICY;
  }

  private getTakerAtProfitPolicy(policy: ExecutionPolicy): ExecutionPolicy["takerAtProfit"] {
    return policy.takerAtProfit ?? DEFAULT_EXECUTION_POLICY.takerAtProfit;
  }

  private getTrackRPolicy(policy: ExecutionPolicy): TrackRHonestPricingPolicy {
    return policy.trackR ?? DEFAULT_EXECUTION_POLICY.trackR ?? DEFAULT_TRACK_R_RUNTIME_POLICY;
  }

  private getTrackS3Policy(policy: ExecutionPolicy): TrackS3MarginAwareSpreadPolicy {
    return policy.trackS3 ?? DEFAULT_EXECUTION_POLICY.trackS3;
  }

  private isTrackRActive(policy: ExecutionPolicy): boolean {
    const cfg = this.getTrackRPolicy(policy);
    return cfg.enabled;
  }

  /**
   * Track S5 belt-and-suspenders ownership guard. The decision planner already
   * suppresses SELLs on S1-owned tokens upstream, so the bridge should never see
   * one — but if that suppression regresses, the S5 exit extensions (P0a book
   * fallback, P0b cap skip, P1 partial exit) must NOT fire on a token the ladder
   * owns. When an S1-owned SELL arrives with any S5 flag live, force those three
   * flags off for this conversion (reverting to the base Track R exit path) and
   * emit a single attribution counter. Non-SELL signals, an absent reader, an
   * unowned token, or an all-flags-off S5 config pass the policy through untouched.
   */
  private applyS5OwnershipGuard(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    policy: ExecutionPolicy,
  ): ExecutionPolicy {
    if (signal.side !== "sell") return policy;
    const reader = this.deps.s1Ownership;
    if (!reader) return policy;
    const trackR = this.getTrackRPolicy(policy);
    const anyS5Flag = trackR.exitBookFallback || trackR.takerCapSkip || trackR.allowPartialExit;
    if (!anyS5Flag) return policy;
    if (!reader.getSnapshot(signal.tokenId)?.owned) return policy;
    this.recordTrackRMetric(signal, "track_r_s5_skipped_s1_owned", {
      exit_book_fallback: trackR.exitBookFallback,
      taker_cap_skip: trackR.takerCapSkip,
      allow_partial_exit: trackR.allowPartialExit,
    });
    return {
      ...policy,
      trackR: {
        ...trackR,
        exitBookFallback: false,
        takerCapSkip: false,
        allowPartialExit: false,
      },
    };
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Every resting BOUNCE_EXIT_TARGET maker SELL rung still open for a token, FOR
   * THE SAME CYCLE as the driving signal — the bounce backstop cancels all of
   * them before submitting its full-residual taker exit. Keyed on decisionRuleId
   * (not price) so it catches every rung regardless of how close each sits to
   * the taker's bestBid-derived price. Scoped by positionId (Release A Phase 3,
   * P6) so a different/newer cycle's resting rung on the same token is never
   * cancelled by token match alone.
   */
  private findOpenBounceTargetOrders(tokenId: TokenId, positionId: string | null): Order[] {
    if (!this.deps.orderRepo) return [];
    return this.deps.orderRepo
      .findByTokenId(tokenId)
      .filter(
        (order) =>
          order.side === "sell" &&
          (order.status === "open" ||
            order.status === "pending" ||
            order.status === "partially-filled") &&
          order.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
          String(order.positionId ?? null) === String(positionId ?? null),
      );
  }

  /**
   * BUY-side admission re-check on the freshest snapshot the bridge owns.
   * Mirrors RiskInventoryModule.evaluateBuyAdmission — same precedence
   * (tracker availability → resolution → market lifecycle), same reason
   * codes. Returns null when the BUY is admitted.
   */
  private evaluateBuyAdmission(
    market: NormalizedMarket,
    gateWhitelistOverride: boolean,
  ): string | null {
    const tracker = this.deps.resolutionTracker;
    if (tracker) {
      if (!tracker.healthy()) return "resolution_tracker_unavailable";
      if (tracker.isResolved(market.conditionId)) return "market_resolved";
    }
    const placement = canPlaceBuyOrderForMarket(
      market,
      this.now(),
      this.deps.effectiveResolution?.toBuyPlacementFields(market),
      { gateWhitelistOverride },
    );
    if (!placement.allowed) return placement.reasons[0] ?? "market_not_alive";
    return null;
  }

  // Track A live enforcement: blocks an approved add/scale-in BUY before
  // PlaceOrderRequested. Uses the shared Track A add-throttle evaluator
  // (fail-open semantics: any non-throttle_candidate verdict — incl.
  // unknown/missing leg — allows). Opt-in only: returns false immediately unless
  // policy.trackAAddThrottle.enforce is on, so the kill switch is a single
  // hot-reloadable boolean with no restart. Returns true when the BUY was
  // blocked (caller must `return` without placing).
  private async enforceTrackAAddThrottle(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    policy: ExecutionPolicy,
  ): Promise<boolean> {
    const enforce = (policy.trackAAddThrottle ?? DEFAULT_EXECUTION_POLICY.trackAAddThrottle)
      .enforce;
    if (!enforce) {
      this.trackABlockEpisodes.clear();
      return false;
    }

    const nowMs = this.now();
    const evaluation = evaluateSignalTrackAAddThrottle(signal, this.deps.legStateRepo, nowMs);
    if (evaluation.result.classification !== "throttle_candidate") {
      this.clearTrackABlockEpisodesForToken(signal.tokenId);
      return false;
    }

    const { decisionType, sourceGroup, result } = evaluation;
    const episodeKey = this.trackABlockEpisodeKey(signal, evaluation);
    const suppressed = this.trackABlockEpisodeSuppressed(episodeKey, nowMs);
    if (suppressed) {
      this.recordTrackABlockSuppressedMetric(result.reason, sourceGroup, decisionType);
      await this.publishTrackAConversionSkipped(signal, evaluation, true);
      return true;
    }

    this.recordTrackABlockMetric(result.reason, sourceGroup, decisionType);
    this.recordTrackABlockRiskEvent(signal, evaluation);
    this.log.info(
      {
        signalId: signal.signalId,
        tokenId: String(signal.tokenId),
        reason: result.reason,
        sourceGroup,
        decisionType,
        legAgeMinutes: result.legAgeMinutes,
      },
      "approved add BUY blocked by Track A add-throttle (leg age>=60m, no SELL in leg)",
    );
    await this.publishTrackAConversionSkipped(signal, evaluation, false);
    return true;
  }

  private trackABlockEpisodeKey(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    evaluation: TrackASignalEvaluation,
  ): string {
    return [
      String(signal.tokenId),
      String(signal.conditionId),
      evaluation.firstBuyTs ?? "unknown_first_buy",
      evaluation.sourceGroup,
      evaluation.decisionType,
      evaluation.result.reason,
      signal.decisionRuleId ?? "unknown_rule",
      signal.reason ?? "unknown_reason",
    ].join("|");
  }

  private trackABlockEpisodeSuppressed(episodeKey: string, nowMs: number): boolean {
    this.pruneTrackABlockEpisodes(nowMs);
    const existing = this.trackABlockEpisodes.get(episodeKey);
    if (!existing) {
      this.trackABlockEpisodes.set(episodeKey, { firstEmittedAt: nowMs, suppressedCount: 0 });
      return false;
    }
    existing.suppressedCount += 1;
    return true;
  }

  private pruneTrackABlockEpisodes(nowMs: number): void {
    for (const [key, episode] of this.trackABlockEpisodes) {
      if (nowMs - episode.firstEmittedAt >= TRACK_A_BLOCK_EPISODE_COOLDOWN_MS) {
        this.trackABlockEpisodes.delete(key);
      }
    }
  }

  private clearTrackABlockEpisodesForToken(tokenId: TokenId): void {
    const prefix = `${String(tokenId)}|`;
    for (const key of this.trackABlockEpisodes.keys()) {
      if (key.startsWith(prefix)) this.trackABlockEpisodes.delete(key);
    }
  }

  private async publishTrackAConversionSkipped(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    evaluation: TrackASignalEvaluation,
    suppressed: boolean,
  ): Promise<void> {
    await this.publishConversionSkipped(
      signal,
      "track-a-add-throttle",
      [evaluation.result.reason],
      {
        sourceGroup: evaluation.sourceGroup,
        decisionType: evaluation.decisionType,
        legAgeMinutes: evaluation.result.legAgeMinutes,
        firstBuyTs: evaluation.firstBuyTs,
        hasSellInLeg: evaluation.hasSellInLeg,
        suppressed,
      },
    );
  }

  // Bounded labels only — the token is intentionally NOT a label (it would be
  // unbounded cardinality); it lives in the risk-event payload instead.
  private recordTrackABlockMetric(reason: string, sourceGroup: string, decisionType: string): void {
    try {
      this.deps.runtimeMetrics?.writeCounter(
        TRACK_A_BLOCKED_METRIC,
        1,
        JSON.stringify({ reason, sourceGroup, decisionType }),
      );
    } catch (err) {
      this.log.debug({ err }, "failed to record Track A add-throttle block metric");
    }
  }

  private recordTrackABlockSuppressedMetric(
    reason: string,
    sourceGroup: string,
    decisionType: string,
  ): void {
    try {
      this.deps.runtimeMetrics?.writeCounter(
        TRACK_A_SUPPRESSED_METRIC,
        1,
        JSON.stringify({ reason, sourceGroup, decisionType }),
      );
    } catch (err) {
      this.log.debug({ err }, "failed to record Track A add-throttle suppressed metric");
    }
  }

  private recordTrackABlockRiskEvent(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    evaluation: TrackASignalEvaluation,
  ): void {
    const repo = this.deps.riskEventRepo;
    if (!repo) return;
    try {
      repo.insert({
        eventType: TRACK_A_BLOCK_EVENT_TYPE,
        payload: {
          tokenId: String(signal.tokenId),
          conditionId: String(signal.conditionId),
          decisionRuleId: signal.decisionRuleId,
          signalReason: signal.reason,
          sourceGroup: evaluation.sourceGroup,
          decisionType: evaluation.decisionType,
          reason: evaluation.result.reason,
          legAgeMinutes: evaluation.result.legAgeMinutes,
          firstBuyTs: evaluation.firstBuyTs,
          hasSellInLeg: evaluation.hasSellInLeg,
        },
      });
    } catch (err) {
      this.log.warn(
        { err, tokenId: String(signal.tokenId) },
        "failed to record Track A add-throttle block risk event",
      );
    }
  }

  subscribe(): void {
    this.unsubs.push(
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
      this.deps.bus.subscribe("SignalApproved", (p) => this.handleApproved(p)),
      // Track S5 P0a — PASSIVE cache writer only. The bridge never produces signals/orders or a
      // re-evaluation from a heartbeat; it just records the open-position books for the exit fallback.
      // The heartbeat-isolation invariant (normalization-module.test.ts:106) must stay intact.
      this.deps.bus.subscribe("MarketSnapshotHeartbeat", (p) => this.handleHeartbeat(p)),
    );
  }

  unsubscribe(): void {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.flushObservationQueue();
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const m of payload.markets) {
      this.marketCache.set(String(m.tokenId), m);
    }
  }

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    for (const tokenId of payload.removedTokenIds) {
      this.marketCache.delete(String(tokenId));
    }
  }

  /**
   * Track S5 P0a — passive heartbeat cache write. Records the open-position books carried on the
   * heartbeat for the exit-path fallback. Deliberately does NOT touch `marketCache`, emit signals, or
   * trigger any re-evaluation: the heartbeat stays isolated from the decision cascade.
   */
  private async handleHeartbeat(
    payload: RuntimeEventMap["MarketSnapshotHeartbeat"],
  ): Promise<void> {
    if (payload.booksByToken && payload.booksByToken.size > 0) {
      this.exitBookCache.writeHeartbeatBooks(payload.booksByToken);
    }
  }

  /**
   * R23 Phase 5 — micro-live maker-entry override. Returns non-null only when all
   * conditions for a post-only BUY limit order are met and the book allows a
   * non-crossing entry. Returns null (skips the override) in all other cases.
   */
  private tryMakerEntryOverride(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
    orderSize: number,
    executionTerms: { tickSize: number },
  ): { price: number; size: number; postOnly: true; entryStyle: "maker" } | null {
    if (signal.side !== "buy") return null;
    if (signal.decisionRuleId !== R23_DIP_TRIGGER_RULE_ID) return null;
    if (signal.reason !== "probe-entry") return null;
    if (policy.makerEntry.mode !== "micro_live") return null;
    if (policy.makerEntry.whitelistConditionIds.length === 0) return null;
    if (!policy.makerEntry.whitelistConditionIds.includes(String(signal.conditionId))) return null;

    const bestBid = market.bestBid;
    if (bestBid == null || !Number.isFinite(bestBid) || bestBid <= 0) {
      this.log.warn(
        { signalId: signal.signalId, tokenId: String(signal.tokenId), bestBid },
        "maker-entry skipped — bestBid unavailable or non-positive",
      );
      return null;
    }

    const bestAsk = market.bestAsk;
    if (bestAsk == null || !Number.isFinite(bestAsk)) {
      this.log.warn(
        { signalId: signal.signalId, tokenId: String(signal.tokenId), bestAsk },
        "maker-entry skipped — bestAsk unavailable",
      );
      return null;
    }

    const tickSize = executionTerms.tickSize;
    const makerPrice = computeMakerEntryPrice(bestBid, tickSize, policy.makerEntry.bidImproveTicks);

    if (makerPrice >= bestAsk) {
      this.log.warn(
        {
          signalId: signal.signalId,
          tokenId: String(signal.tokenId),
          makerPrice,
          bestAsk,
        },
        "maker-entry would cross bestAsk — skipping",
      );
      return null;
    }

    const cappedSize = Math.min(orderSize, policy.makerEntry.microMaxOrderUsdc / makerPrice);
    return {
      price: makerPrice,
      size: cappedSize,
      postOnly: true as const,
      entryStyle: "maker" as const,
    };
  }

  private async handleApproved(payload: RuntimeEventMap["SignalApproved"]): Promise<void> {
    const bridgeStartMs = performance.now();
    try {
      const { signal, market: embeddedMarket } = payload;

      // Bounce-exit 4h force-exit (Phase 4 / Codex M6 — round 2 review): the
      // guaranteed force-exit must reach the cancel-resting-target-then-place-
      // taker sequence near the end of this function regardless of every
      // business-logic guard in between (same-price duplicate detection,
      // order-lifetime rate budget, same-price cooldown, taker-below-margin,
      // sell-price-below-signal-floor) — each one is scoped to normal SELL
      // exits and can incorrectly treat this bot's own resting target order,
      // or a temporarily unprofitable bid, as a reason to silently drop the
      // one exit that MUST happen. Computed once, up front, so every guard
      // below can gate on it consistently instead of re-deriving it (and so
      // a newly added guard in this stretch is bypassed by construction
      // rather than requiring a fresh one-off edit). Deliberately NOT bypassed:
      // market-cache-miss, hard-liveness, execution-price validity/tick-bounds,
      // and order-size-below-minimum — those reflect whether the exchange can
      // accept an order at all right now, not this bot's own bookkeeping, so
      // bypassing them would not make the exit any more guaranteed.
      const isBounceExitForceExit = isBounceForceExit(signal);

      // Snapshot the policy once so the full approval flow uses a consistent view,
      // even if the provider hot-reloads mid-decision. The S5 ownership guard may
      // return a policy with the Track S5 exit extensions forced off for an
      // S1-owned SELL (belt-and-suspenders for a planner-suppression regression).
      const policy = this.applyS5OwnershipGuard(signal, this.getPolicy());

      // Primary source: the NormalizedMarket snapshot captured at signal-generation
      // time in algo-decision-module. This is the same snapshot the pre-entry
      // gate's `isAlive` already accepted, so re-running `isAlive` here cannot
      // flip state from "healthy" to "no_bid" due to a book transition between
      // `SignalProduced` and the bridge build. `marketCache.get` stays as a
      // defensive fallback for events that may be in-flight during rollout of
      // this change; it can be removed once all in-flight events drain.
      const baseMarket = embeddedMarket ?? this.marketCache.get(String(signal.tokenId));

      if (!baseMarket) {
        this.log.warn(
          { signalId: signal.signalId, tokenId: signal.tokenId },
          "approved signal has no cached market — cannot build order command",
        );
        await this.publishConversionSkipped(signal, "market-cache-miss", ["market-cache-miss"], {
          cacheStatus: "disabled",
        });
        return;
      }

      // GATE-whitelist liveness override (docs/plans/2026-07-17-gate-isalive-plankton-
      // whitelist.md): a GATE_ENTRY first-entry BUY on a whitelisted market with a live
      // bestBid may relax the stale acceptingOrders/enableOrderBook rejection at BOTH the
      // admission gate below AND the embedded-liveness check. no_bid still blocks (enforced
      // inside canPlaceBuyOrder / isAlive). Non-GATE / non-whitelist / SELLs = strict.
      const gateWhitelistOverride =
        signal.side === "buy" &&
        signal.decisionRuleId === GATE_ENTRY_RULE_ID &&
        baseMarket.bestBid != null &&
        isGateWhitelisted(policy.gateEntry, baseMarket.conditionId);

      // BUY-side admission guard (defense-in-depth). RiskInventoryModule already
      // ran the same check upstream, but the bridge sees the freshest snapshot
      // (post candidate-book merge) and the resolution tracker may have flipped
      // a condition to resolved between approval and conversion.
      //
      // Prefer the cached snapshot here: NormalizedMarketUpdated may have arrived
      // after SignalApproved and flipped `active`/`tradable`/`endDate` — the
      // embedded snapshot is frozen at signal-generation time and would miss it.
      // Fall back to embedded if no cache entry exists yet.
      if (signal.side === "buy") {
        const cachedMarket = this.marketCache.get(String(signal.tokenId));
        const admissionMarket = cachedMarket ?? baseMarket;
        const cacheStatus = cachedMarket ? "fresh" : "embedded";
        const buyBlock = this.evaluateBuyAdmission(admissionMarket, gateWhitelistOverride);
        if (buyBlock) {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: String(signal.tokenId),
              reason: buyBlock,
              cacheStatus,
            },
            "approved BUY skipped — market not eligible for placement",
          );
          await this.publishConversionSkipped(signal, "marketability", [buyBlock], {
            conditionId: admissionMarket.conditionId,
            active: admissionMarket.active,
            tradable: admissionMarket.tradable,
            endDate: admissionMarket.endDate,
            cacheStatus,
          });
          return;
        }

        // Track A live enforcement (Krabs-specific add-throttle). Buy-only; SELLs
        // and exits never reach this gate. Blocks BEFORE PlaceOrderRequested.
        if (await this.enforceTrackAAddThrottle(signal, policy)) return;
      }

      // Hard-liveness on the embedded snapshot. Same function, same semantics as
      // algo-decision-module.ts:389 — eliminates the residual tail where the
      // book transitioned to `no_bid` in the gap between pre-entry and bridge.
      const embeddedLiveness = isAlive(
        {
          acceptingOrders: baseMarket.acceptingOrders,
          enableOrderBook: baseMarket.enableOrderBook,
          bestBid: baseMarket.bestBid,
          bestAsk: baseMarket.bestAsk,
        },
        { gateWhitelistOverride },
      );
      if (!embeddedLiveness.healthy) {
        const onlyExpectedFlags = embeddedLiveness.reasons.every(
          (r) => r === "not_accepting_orders" || r === "order_book_disabled",
        );
        const diag = {
          signalId: signal.signalId,
          tokenId: signal.tokenId,
          reasons: embeddedLiveness.reasons,
          cacheStatus: "embedded",
        };
        const msg = "approved signal skipped — market not live for order placement";
        if (onlyExpectedFlags) this.log.debug(diag, msg);
        else this.log.warn(diag, msg);
        await this.publishConversionSkipped(signal, "hard-liveness", embeddedLiveness.reasons, {
          acceptingOrders: baseMarket.acceptingOrders,
          enableOrderBook: baseMarket.enableOrderBook,
          bestBid: baseMarket.bestBid,
          bestAsk: baseMarket.bestAsk,
          cacheStatus: "embedded",
        });
        return;
      }

      // Pricing: optionally fold in a fresher candidate book on top of the
      // embedded base so the order price reflects the newest observed top of
      // book. If the fresh book is unavailable or disabled, fall back to the
      // embedded snapshot's bestBid/bestAsk.
      const pricing = await this.resolvePricingMarket(signal, baseMarket, policy);
      const market = pricing.market;
      const trackRFeeQuote = await this.resolveTrackRFeeQuote(signal, market, policy);

      const rawExecutionTerms = this.resolveExecutionTerms(
        signal,
        market,
        policy,
        pricing.book ?? null,
        trackRFeeQuote,
      );
      const canary = this.buildDeadSideCanary(signal, market, policy);
      // F2: shadow telemetry measures the raw (pre-cap) anchor; the cap only
      // governs the price that is actually placed.
      const sellPricingShadow = this.computeSellPricingShadow(signal, rawExecutionTerms, policy);
      const executionTerms = this.applySellPriceCap(rawExecutionTerms, signal, policy);

      if (executionTerms.kind === "unavailable") {
        this.log.warn(
          {
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            side: signal.side,
            bestBid: market.bestBid,
            bestAsk: market.bestAsk,
            cacheStatus: pricing.cacheStatus,
          },
          "approved signal skipped — no bestBid/bestAsk for execution price",
        );
        await this.publishConversionSkipped(
          signal,
          "execution-terms",
          ["execution-price-unavailable"],
          { cacheStatus: pricing.cacheStatus },
        );
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          sellPricingShadow,
          skippedReason: "execution-price-unavailable",
        });
        return;
      }
      if (executionTerms.kind === "invalid") {
        this.log.warn(
          {
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            side: signal.side,
            price: executionTerms.price,
            tickSize: executionTerms.tickSize,
            validationReason: executionTerms.validationReason,
            cacheStatus: pricing.cacheStatus,
          },
          "approved signal skipped — invalid execution price",
        );
        await this.publishConversionSkipped(
          signal,
          "execution-terms",
          ["execution-price-invalid"],
          {
            cacheStatus: pricing.cacheStatus,
            price: executionTerms.price,
            tickSize: executionTerms.tickSize,
            minPrice: executionTerms.minPrice,
            maxPrice: executionTerms.maxPrice,
            validationReason: executionTerms.validationReason,
          },
        );
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          sellPricingShadow,
          skippedReason: "execution-price-invalid",
        });
        return;
      }
      if (executionTerms.kind === "skip-wide-spread" || executionTerms.kind === "skip-one-sided") {
        const reason =
          executionTerms.kind === "skip-wide-spread" ? "spread-above-cap" : "one-sided-book";
        this.log.info(
          {
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            reason,
            pricingMode: policy.pricing.mode,
            ...executionTerms.diagnostics,
            cacheStatus: pricing.cacheStatus,
          },
          "approved signal skipped — bounded-midpoint pricing guardrail",
        );
        await this.publishConversionSkipped(signal, "execution-terms", [reason], {
          cacheStatus: pricing.cacheStatus,
          pricingMode: policy.pricing.mode,
          ...executionTerms.diagnostics,
        });
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          sellPricingShadow,
          skippedReason: reason,
        });
        return;
      }

      // Wrapped (not individually flagged) so any future guard added inside
      // this block is bypassed for the force-exit by construction — see
      // isBounceExitForceExit above.
      if (!isBounceExitForceExit) {
        const takerMarginBlock = this.resolveTakerBelowMarginBlock(
          signal,
          executionTerms,
          policy,
          trackRFeeQuote,
        );
        if (takerMarginBlock) {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              price: executionTerms.price,
              avgEntry: takerMarginBlock.avgEntry,
              minExit: takerMarginBlock.minExit,
              minGrossExitRatio: takerMarginBlock.minGrossExitRatio,
              blockReason: takerMarginBlock.reason,
              cacheStatus: pricing.cacheStatus,
            },
            "approved SELL skipped — taker price below configured profit margin",
          );
          this.recordTakerAtProfitMetric(signal, "blocked", TAKER_BELOW_MARGIN_REASON, {
            avgEntry: takerMarginBlock.avgEntry,
            price: executionTerms.price,
            minExit: takerMarginBlock.minExit,
            minGrossExitRatio: takerMarginBlock.minGrossExitRatio,
            reason_detail: takerMarginBlock.reason,
          });
          await this.publishConversionSkipped(
            signal,
            "execution-terms",
            [TAKER_BELOW_MARGIN_REASON],
            {
              cacheStatus: pricing.cacheStatus,
              price: executionTerms.price,
              avgEntry: takerMarginBlock.avgEntry,
              minExit: takerMarginBlock.minExit,
              minGrossExitRatio: takerMarginBlock.minGrossExitRatio,
              reason: takerMarginBlock.reason,
            },
          );
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: TAKER_BELOW_MARGIN_REASON,
          });
          return;
        }
      }

      if (signal.side === "buy" && executionTerms.price > policy.entryPriceCeiling) {
        this.log.info(
          {
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            price: executionTerms.price,
            ceiling: policy.entryPriceCeiling,
            cacheStatus: pricing.cacheStatus,
          },
          "approved signal skipped — BUY price above entry ceiling",
        );
        await this.publishConversionSkipped(
          signal,
          "execution-terms",
          ["price-above-entry-ceiling"],
          {
            cacheStatus: pricing.cacheStatus,
            price: executionTerms.price,
            ceiling: policy.entryPriceCeiling,
          },
        );
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          sellPricingShadow,
          skippedReason: "price-above-entry-ceiling",
        });
        return;
      }

      const nowMs = this.now();

      if (
        !isBounceExitForceExit &&
        signal.side === "sell" &&
        executionTerms.kind === "ok" &&
        shouldSkipSellBelowSignalFloor(
          signal.suggestedPrice,
          executionTerms.price,
          policy.pricing.minExitPriceSignalRatio,
        )
      ) {
        const floor = signal.suggestedPrice * policy.pricing.minExitPriceSignalRatio;
        this.log.info(
          {
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            signalPrice: signal.suggestedPrice,
            executionPrice: executionTerms.price,
            minRatio: policy.pricing.minExitPriceSignalRatio,
            floor,
            cacheStatus: pricing.cacheStatus,
          },
          "approved SELL skipped — execution price below signal-distance floor",
        );
        await this.publishConversionSkipped(
          signal,
          "execution-terms",
          ["sell-price-below-signal-floor"],
          {
            cacheStatus: pricing.cacheStatus,
            signalPrice: signal.suggestedPrice,
            executionPrice: executionTerms.price,
            minRatio: policy.pricing.minExitPriceSignalRatio,
            floor,
          },
        );
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          sellPricingShadow,
          skippedReason: "sell-price-below-signal-floor",
        });
        return;
      }

      if (canary) {
        const diagnostics = {
          ...canary,
          cacheStatus: pricing.cacheStatus,
          price: executionTerms.price,
        };
        if (policy.deadSideGuard.mode === "enforce" && canary.enforceHit) {
          this.log.info(
            { signalId: signal.signalId, tokenId: signal.tokenId, ...diagnostics },
            "approved signal skipped — BUY on dead side near endDate",
          );
          await this.publishConversionSkipped(
            signal,
            "execution-terms",
            ["dead-side-near-end"],
            diagnostics,
          );
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: "dead-side-near-end",
          });
          return;
        }
        // observe mode, or enforce mode but outside configured X: emit the shadow
        // canary marker so metrics can choose the enforcement X post-hoc. Covers
        // *every* BUY with bestAsk ≤ askCeiling regardless of timeToEndMs bucket.
        // Gated by policy.telemetry.deadSideCanary — enforcement always runs above.
        if (policy.telemetry.deadSideCanary) {
          this.log.info(
            { signalId: signal.signalId, tokenId: signal.tokenId, ...diagnostics },
            "dead-side-near-end canary observation",
          );
        }
      }

      let orderSize =
        executionTerms.kind === "ok" && executionTerms.size != null
          ? executionTerms.size
          : resolveOrderSize(signal, executionTerms.price);
      // Ladder min-order rollover (docs/plans/2026-07-16-bounce-exit-ladder-
      // redesign.md) needs the ladder's fixed original basis (for the merged
      // fraction math) and the residual available right now (as an oversell
      // ceiling) — both carried on the signal by decision-planner.ts, rather
      // than back-derived from `orderSize`/`fraction` here (that back-
      // derivation degenerates whenever the residual, not the fraction, was
      // the binding constraint on this rung's own size).
      const bounceOriginalPositionSize = signal.bounceRung?.originalPositionSize ?? null;
      const bounceRemainingPositionSize = signal.bounceRung?.remainingPositionSize ?? null;
      // Codex H4 fix: when sellableFlow is on, decision-planner.ts carries the
      // fill-aware `uncommittedRemainder` on the rung metadata — prefer it as
      // the rollover's oversell ceiling so a merge never expands past what is
      // genuinely still uncommitted (soldShares + openCommitment already
      // account for actual fills/resting orders the leg-level
      // remainingPositionSize can't see). Absent when the flag is off, so the
      // rollover falls back to the original leg-level basis unchanged.
      const bounceRolloverCeiling =
        signal.bounceRung?.uncommittedRemainder ?? bounceRemainingPositionSize;
      // Micro cap enforcement, sizing side (docs/plans/2026-07-15-gate-bounce-
      // live-experiment.md, Phase 4 / Codex C3): GATE BUY notional must never
      // exceed gateEntry.microMaxOrderUsdc. execution-module.ts enforces the
      // same cap independently (defense-in-depth) right before submission.
      if (
        signal.side === "buy" &&
        signal.decisionRuleId === GATE_ENTRY_RULE_ID &&
        policy.gateEntry.microMaxOrderUsdc > 0 &&
        executionTerms.price > 0
      ) {
        const gateCapSize = policy.gateEntry.microMaxOrderUsdc / executionTerms.price;
        orderSize = Math.min(orderSize, gateCapSize);
      }
      // Bounce-exit rung micro cap: a resting SELL rung's notional must never
      // exceed bounceExit.microMaxOrderUsdc while the ladder mechanism is
      // validated live with real money — same rationale as the gateEntry cap
      // above. Applied before the ladder rollover below, which only ever
      // grows the size back up to clear the exchange minimum — never
      // re-capped afterward, since the exchange floor takes precedence over
      // this soft risk cap once rolling forward is already required.
      // CAP-EXEMPT for the Phase-3 residual "cleanup" rung (docs/plans/
      // 2026-07-19-sellable-sizing-bounce-for-all.md): that order was
      // deliberately sized to clear the ladder's fill-aware uncommitted
      // remainder in one shot — re-fragmenting it below that size here would
      // strand shares the same way the cleanup rung exists to prevent.
      if (
        signal.side === "sell" &&
        signal.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
        signal.bounceRung?.isCleanupRung !== true &&
        policy.bounceExit.microMaxOrderUsdc > 0 &&
        executionTerms.price > 0
      ) {
        const bounceCapSize = policy.bounceExit.microMaxOrderUsdc / executionTerms.price;
        orderSize = Math.min(orderSize, bounceCapSize);
      }
      const effectiveMinOrderSize = resolveEffectiveMinOrderSize(market.minOrderSize);

      // Sellable-sizing floor (Phase 2, docs/plans/2026-07-19-sellable-sizing-
      // bounce-for-all.md): a FLAT FIRST ENTRY (buyCount===0, i.e. signal.reason
      // === "probe-entry" — same idiom tryMakerEntryOverride above already uses
      // for this concept) must be sized so every bounce-ladder rung clears the
      // exchange min_order_size, or the position has no legal SELL later
      // (bot_pnl_exit_root_cause_2026-07-19.md: 352 held-to-zero positions,
      // -$387). Scale-ins/adds are NEVER bumped (H6 — averaging down is
      // plankton's #1 realized loss driver). Gated behind sellableFlow.enabled
      // — OFF is byte-identical to today.
      const isFlatFirstEntryBuy = signal.side === "buy" && signal.reason === "probe-entry";
      let sellableShareFloor: number | null = null;
      if (policy.sellableFlow.enabled && isFlatFirstEntryBuy) {
        sellableShareFloor = resolveSellableShareFloor({
          minOrderSize: market.minOrderSize,
          ladderFractions: policy.bounceExit.ladderFractions,
          buffer: policy.sellableFlow.buffer,
        });
        if (sellableShareFloor == null) {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              minOrderSize: market.minOrderSize ?? null,
            },
            "approved BUY skipped — sellable-sizing floor unknown (min_order_size unknown)",
          );
          await this.publishConversionSkipped(signal, "execution-terms", ["entry_unknown_min"], {
            cacheStatus: pricing.cacheStatus,
            minOrderSize: market.minOrderSize ?? null,
          });
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: "entry_unknown_min",
          });
          return;
        }
        const sellableFloorNotionalUsdc = sellableShareFloor * executionTerms.price;
        if (sellableFloorNotionalUsdc > policy.sellableFlow.maxEntryUsdc) {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              sellableShareFloor,
              sellableFloorNotionalUsdc,
              maxEntryUsdc: policy.sellableFlow.maxEntryUsdc,
            },
            "approved BUY skipped — sellable-sizing floor exceeds max entry notional",
          );
          await this.publishConversionSkipped(signal, "execution-terms", ["entry_not_sellable"], {
            cacheStatus: pricing.cacheStatus,
            sellableShareFloor,
            sellableFloorNotionalUsdc,
            maxEntryUsdc: policy.sellableFlow.maxEntryUsdc,
          });
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: "entry_not_sellable",
          });
          return;
        }
        // Never down-size (H6-safe): only ever bumps orderSize up to the floor.
        orderSize = Math.max(orderSize, sellableShareFloor);
      }

      let positionConcentrationMetadata: Record<string, unknown> | null = null;
      if (signal.side === "buy" && this.deps.positionConcentration) {
        const concentrationDecision = this.deps.positionConcentration.evaluateBuy({
          tokenId: signal.tokenId,
          conditionId: signal.conditionId,
          candidateNotionalUsdc: orderSize * executionTerms.price,
          minExecutableNotionalUsdc:
            sellableShareFloor != null
              ? Math.max(effectiveMinOrderSize, sellableShareFloor) * executionTerms.price
              : effectiveMinOrderSize * executionTerms.price,
          policy: policy.positionConcentration,
          stage: "signal_to_order",
          signalReason: signal.reason,
          decisionRuleId: signal.decisionRuleId,
        });
        if (concentrationDecision.action === "skip") {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              reason: concentrationDecision.reason,
              concentrationKey: concentrationDecision.concentrationKey,
              keyType: concentrationDecision.keyType,
              requestedNotionalUsdc: orderSize * executionTerms.price,
              minExecutableNotionalUsdc: effectiveMinOrderSize * executionTerms.price,
            },
            "approved BUY skipped — position concentration cap",
          );
          await this.publishConversionSkipped(
            signal,
            "execution-terms",
            [`position-concentration-${concentrationDecision.reason}`],
            {
              cacheStatus: pricing.cacheStatus,
              reason: concentrationDecision.reason,
              keyType: concentrationDecision.keyType,
              requestedNotionalUsdc: orderSize * executionTerms.price,
              minExecutableNotionalUsdc: effectiveMinOrderSize * executionTerms.price,
              metrics: concentrationDecision.metrics,
            },
          );
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: `position-concentration-${concentrationDecision.reason}`,
          });
          return;
        }
        if (concentrationDecision.action === "clamp") {
          orderSize = concentrationDecision.effectiveNotionalUsdc / executionTerms.price;
        }
        positionConcentrationMetadata = {
          action: concentrationDecision.action,
          reason: concentrationDecision.reason,
          keyType: concentrationDecision.keyType,
          fallbackReason: concentrationDecision.fallbackReason,
          requestedNotionalUsdc: signal.suggestedSizeUsdc,
          effectiveNotionalUsdc: concentrationDecision.effectiveNotionalUsdc,
          metrics: concentrationDecision.metrics,
        };
      }
      let bounceRungOverride: BounceRungMetadata | null = null;
      if (!isExecutableOrderSize(orderSize, market.minOrderSize)) {
        const rollover =
          signal.bounceRung && bounceOriginalPositionSize != null && bounceRolloverCeiling != null
            ? resolveBounceRungRollover(
                signal.bounceRung,
                bounceOriginalPositionSize,
                bounceRolloverCeiling,
                policy.bounceExit.ladderFractions,
                market.minOrderSize,
              )
            : null;
        // The $2 bounce micro cap (applied above, pre-rollover) only bounded
        // THIS rung's own size — a merge can grow the size back past it to
        // clear the exchange minimum. Re-check post-merge: if the exchange
        // floor cannot be satisfied within the cap, skip rather than place an
        // over-cap order (the cap is a hard risk ceiling while the ladder is
        // validated live, so it must win over "always place something").
        const rolloverNotionalUsdc =
          rollover && executionTerms.price > 0 ? rollover.size * executionTerms.price : null;
        const rolloverOverCap =
          rollover != null &&
          signal.side === "sell" &&
          signal.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
          policy.bounceExit.microMaxOrderUsdc > 0 &&
          rolloverNotionalUsdc != null &&
          rolloverNotionalUsdc > policy.bounceExit.microMaxOrderUsdc;
        if (rollover && rolloverOverCap) {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              rolloverSize: rollover.size,
              rolloverNotionalUsdc,
              microMaxOrderUsdc: policy.bounceExit.microMaxOrderUsdc,
              rungIndicesCovered: rollover.metadata.rungIndicesCovered ?? null,
            },
            "approved SELL skipped — bounce ladder rollover exceeds micro order cap",
          );
          await this.publishConversionSkipped(
            signal,
            "execution-terms",
            ["bounce-rollover-exceeds-micro-cap"],
            {
              cacheStatus: pricing.cacheStatus,
              rolloverSize: rollover.size,
              rolloverNotionalUsdc,
              microMaxOrderUsdc: policy.bounceExit.microMaxOrderUsdc,
            },
          );
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: "bounce-rollover-exceeds-micro-cap",
          });
          return;
        }
        if (rollover) {
          orderSize = rollover.size;
          bounceRungOverride = rollover.metadata;
        } else {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              side: signal.side,
              orderSize,
              minOrderSize: market.minOrderSize ?? null,
              effectiveMinOrderSize,
              cacheStatus: pricing.cacheStatus,
            },
            "approved signal skipped — order size below exchange minimum",
          );
          await this.publishConversionSkipped(
            signal,
            "execution-terms",
            ["order-size-below-minimum"],
            {
              cacheStatus: pricing.cacheStatus,
              orderSize,
              minOrderSize: market.minOrderSize ?? null,
              effectiveMinOrderSize,
            },
          );
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: "order-size-below-minimum",
          });
          return;
        }
      }

      // The resting BOUNCE_EXIT_TARGET maker order this signal is about to
      // cancel is itself an open SELL, and its price can easily sit inside
      // the same-price tolerance window of a falling bestBid (e.g.
      // target=0.19, bestBid=0.18, 2-tick window=0.02). Without this bypass,
      // findSamePriceOpenSellOrder below would treat that resting order as a
      // reason to skip this force-exit signal (see isBounceExitForceExit
      // above for the full guard-bypass rationale).
      // For a regular (non-backstop) bounce rung, the generic same-PRICE
      // guard is the wrong identity check: adjacent rungs are tick-rounded
      // and can legitimately share a price or land inside the tolerance
      // window, so it would treat a distinct, not-yet-placed rung as a
      // duplicate of an earlier resting rung, skip it without ever
      // persisting its metadata, and the planner would re-emit the same
      // rung forever (Codex Phase-2 fix). Narrow the guard to the ladder's
      // own identity — same ladderId AND an overlapping rung index — so a
      // different rungIndex is never treated as a duplicate, while a true
      // re-processing of the same rung(s) still is.
      const effectiveBounceRung = bounceRungOverride ?? signal.bounceRung ?? null;
      const duplicateSell = isBounceExitForceExit
        ? null
        : effectiveBounceRung
          ? this.findDuplicateBounceRungOrder(signal.tokenId, effectiveBounceRung)
          : this.findSamePriceOpenSellOrder(
              signal.tokenId,
              signal.side,
              executionTerms.price,
              market.tickSize,
              policy,
            );
      if (duplicateSell) {
        const timedOutSizeReplacement = isSellTimeoutReplacement({
          existingOrder: duplicateSell,
          requestedSize: orderSize,
          nowMs,
          sellTimeoutMs: policy.sellTimeoutMs,
        });
        if (timedOutSizeReplacement) {
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              existingOrderId: duplicateSell.orderId,
              existingSize: duplicateSell.size,
              requestedSize: orderSize,
              existingPrice: duplicateSell.price,
              executionPrice: executionTerms.price,
            },
            "approved SELL continuing — timed-out sell size escalation",
          );
        } else {
          this.log.debug(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              existingOrderId: duplicateSell.orderId,
              existingPrice: duplicateSell.price,
              executionPrice: executionTerms.price,
              cacheStatus: pricing.cacheStatus,
            },
            "approved SELL skipped — acceptable-price sell order already open",
          );
          await this.publishConversionSkipped(
            signal,
            "execution-terms",
            ["sell-order-acceptable-price-already-open"],
            {
              cacheStatus: pricing.cacheStatus,
              existingOrderId: String(duplicateSell.orderId),
              existingPrice: duplicateSell.price,
              executionPrice: executionTerms.price,
            },
          );
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: "sell-order-acceptable-price-already-open",
          });
          return;
        }
      }

      if (signal.side === "sell" && !isBounceExitForceExit && this.deps.orderLifetime) {
        const placementDecision = this.deps.orderLifetime.canPlaceExitOrder(signal.tokenId, nowMs);
        if (!placementDecision.allowed) {
          const reason = placementDecision.reason ?? "order-lifetime-placement-blocked";
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              mode: placementDecision.mode,
              budgetPerMinute: placementDecision.budgetPerMinute,
              remainingBudget: placementDecision.remainingBudget,
            },
            "approved SELL skipped — order lifetime placement gate",
          );
          await this.publishConversionSkipped(signal, "execution-terms", [reason], {
            cacheStatus: pricing.cacheStatus,
            mode: placementDecision.mode,
            budgetPerMinute: placementDecision.budgetPerMinute,
            remainingBudget: placementDecision.remainingBudget,
          });
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms,
            canary,
            sellPricingShadow,
            skippedReason: reason,
          });
          return;
        }
      }

      // R23 Phase 5 / Fix #6 — resolve the maker-entry override BEFORE the same-price
      // cooldown check so the cooldown (and its diagnostics + persisted observation)
      // key off the price a maker BUY will actually rest at, not the pre-override
      // taker price the signal started with. tryMakerEntryOverride is pure and is
      // computed exactly ONCE here; the later maker-BUY handling below reuses this
      // SAME result instead of calling it again. When there is no override (the
      // overwhelming majority of signals, and every non-BUY / non-R23 signal),
      // cooldownPrice === executionTerms.price and this block is byte-identical to
      // the prior behavior.
      const makerOverride = this.tryMakerEntryOverride(
        signal,
        market,
        policy,
        orderSize,
        executionTerms,
      );
      const cooldownPrice = makerOverride?.price ?? executionTerms.price;

      if (!isBounceExitForceExit && this.deps.samePriceCooldown) {
        const placementDecision = this.deps.samePriceCooldown.canPlaceOrder({
          tokenId: signal.tokenId,
          side: signal.side,
          price: cooldownPrice,
          nowMs,
        });
        if (!placementDecision.allowed) {
          const reason = placementDecision.reason ?? "same-price-cooldown";
          const sample =
            this.deps.signalPathTelemetry?.recordLateCooldown(
              signal.signalId,
              String(signal.tokenId),
              signal.side === "buy" ? "BUY" : "SELL",
              cooldownPrice,
              market.tickSize,
            ) ?? false;
          if (sample) {
            this.log.info(
              {
                signalId: signal.signalId,
                tokenId: signal.tokenId,
                side: signal.side,
                executionPrice: cooldownPrice,
                staleCancelCount: placementDecision.staleCancelCount,
                cooldownUntilTsUtc: placementDecision.cooldownUntilTsUtc,
                cacheStatus: pricing.cacheStatus,
              },
              "signal_debug_sample",
            );
          }
          await this.publishConversionSkipped(signal, "execution-terms", [reason], {
            cacheStatus: pricing.cacheStatus,
            executionPrice: cooldownPrice,
            staleCancelCount: placementDecision.staleCancelCount,
            cooldownUntilTsUtc: placementDecision.cooldownUntilTsUtc,
          });
          this.writeObservation({
            signal,
            clientOrderId: null,
            market,
            policy,
            executionTerms:
              cooldownPrice === executionTerms.price
                ? executionTerms
                : { ...executionTerms, price: cooldownPrice },
            canary,
            sellPricingShadow,
            skippedReason: reason,
          });
          return;
        }
      }

      if (makerOverride != null) {
        orderSize = makerOverride.size;
      }

      // The maker-entry override can (a) shrink orderSize back BELOW the sellable
      // floor via its own micro-cap, or (b) RAISE the entry price so the sellable
      // floor's notional (size × price) exceeds maxEntryUsdc — the pre-override
      // maxEntryUsdc/floor checks used the un-overridden price (Codex audit r2).
      // On a flat first entry with sellableFlow on, SKIP rather than enter an
      // un-sellable / over-budget position — the floor guarantee must survive it.
      const finalEntryPrice = makerOverride != null ? makerOverride.price : executionTerms.price;
      // Effective (post-override) pricing mode — makerOverride converts an opportunistic taker into a
      // genuine maker (postOnly:true, non-crossing price). Computed once and used CONSISTENTLY in both
      // cmd.metadata (the first-entry adaptive-TTL discriminator) and the conversion log/metric below,
      // so persisted orders and observability never disagree.
      const effectivePricingMode = makerOverride != null ? "maker" : executionTerms.pricedMode;
      const belowFloor = sellableShareFloor != null && orderSize + 1e-9 < sellableShareFloor;
      const overMaxEntry =
        finalEntryPrice > 0 &&
        orderSize * finalEntryPrice > policy.sellableFlow.maxEntryUsdc + 1e-9;
      if (policy.sellableFlow.enabled && isFlatFirstEntryBuy && (belowFloor || overMaxEntry)) {
        this.log.info(
          {
            signalId: signal.signalId,
            tokenId: signal.tokenId,
            orderSize,
            sellableShareFloor,
            finalEntryPrice,
            finalNotionalUsdc: orderSize * finalEntryPrice,
            maxEntryUsdc: policy.sellableFlow.maxEntryUsdc,
            reason: belowFloor ? "below_floor_after_override" : "over_max_entry_after_override",
          },
          "approved BUY skipped — sellable-sizing invariant broken after maker-entry override",
        );
        await this.publishConversionSkipped(signal, "execution-terms", ["entry_not_sellable"], {
          cacheStatus: pricing.cacheStatus,
          orderSize,
          sellableShareFloor,
          finalNotionalUsdc: orderSize * finalEntryPrice,
          maxEntryUsdc: policy.sellableFlow.maxEntryUsdc,
        });
        this.writeObservation({
          signal,
          clientOrderId: null,
          market,
          policy,
          executionTerms,
          canary,
          sellPricingShadow,
          skippedReason: "entry_not_sellable",
        });
        return;
      }

      // Track S5 P1 — a partial exit (size override present) uses a slot-bucketed
      // clientOrderId so two partials inside one 5-minute slot dedupe at the CLOB
      // while a fresh slot mints a new id; full exits keep the signal-derived id.
      const clientOrderId =
        executionTerms.kind === "ok" && executionTerms.size != null
          ? buildPartialExitClientOrderId({ tokenId: signal.tokenId, nowMs: this.now() })
          : buildClientOrderId({
              signalId: signal.signalId,
              tokenId: signal.tokenId,
              side: signal.side,
            });

      const cmd: PlaceOrderCommand = {
        type: "PlaceOrderCommand",
        commandId: createCommandId(randomUUID()),
        clientOrderId,
        source: signal.reason === "operator" ? "operator" : "strategy",
        tokenId: signal.tokenId,
        conditionId: signal.conditionId,
        side: signal.side,
        size: orderSize,
        price: makerOverride != null ? makerOverride.price : executionTerms.price,
        // Bounce-exit resting target (Phase 4 / Codex M3): a real maker order,
        // same provenance marker as tryMakerEntryOverride's BUY-side maker
        // entries — makerOverride is BUY-only (R23_DIP_TRIGGER_RULE_ID), so
        // this SELL case is handled as its own branch here.
        ...(makerOverride != null || executionTerms.pricedMode === "bounce-exit-target"
          ? { postOnly: true as const, entryStyle: "maker" as const }
          : executionTerms.postOnly !== undefined
            ? { postOnly: executionTerms.postOnly }
            : {}),
        orderType: "GTC",
        tickSize: executionTerms.tickSize,
        negRisk: market.negRisk,
        sequenceInTick: signal.sequenceInTick,
        signalReason: signal.reason,
        signalId: signal.signalId,
        decisionRuleId: signal.decisionRuleId,
        signalTimestamp: signal.generatedAt,
        positionId: signal.positionId ?? null,
        metadata: {
          // Effective (post-override) pricing mode — the first-entry adaptive TTL reads this to keep
          // marketable-taker residuals on the short probe leash. "maker" when makerOverride converts an
          // opportunistic taker into a genuine maker, else the resolver mode. See effectivePricingMode.
          executionPricingMode: effectivePricingMode,
          cacheStatus: pricing.cacheStatus,
          marketData: {
            bookSource: market.bookSource ?? "unknown",
            minOrderSize: market.minOrderSize ?? null,
            effectiveMinOrderSize,
          },
          ...(positionConcentrationMetadata
            ? { positionConcentration: positionConcentrationMetadata }
            : {}),
          // Bounce-exit ladder rung identity (docs/plans/2026-07-16-bounce-
          // exit-ladder-redesign.md), persisted on the order so the next
          // planning cycle's placedBounceRungIndices lookup can tell rungs
          // apart — every rung shares the same decisionRuleId. Prefer the
          // rollover override (rungIndicesCovered set) when the min-order
          // merge above fired.
          ...(bounceRungOverride
            ? { bounceRung: bounceRungOverride }
            : signal.bounceRung
              ? { bounceRung: signal.bounceRung }
              : {}),
        },
      };

      this.log.info(
        {
          signalId: signal.signalId,
          clientOrderId: String(clientOrderId),
          side: signal.side,
          price: cmd.price,
          size: cmd.size,
          postOnly: cmd.postOnly ?? null,
          pricingMode: policy.pricing.mode,
          executionPricingMode: effectivePricingMode,
          ...(executionTerms.pricingDiagnostics
            ? { pricingDiagnostics: executionTerms.pricingDiagnostics }
            : {}),
          ...(executionTerms.pricingShadow ? { pricingShadow: executionTerms.pricingShadow } : {}),
        },
        "signal converted to order command",
      );
      this.recordPricingMetrics(signal, executionTerms);
      this.recordTakerAtProfitActivation(signal, market, executionTerms, policy);

      this.writeObservation({
        signal,
        clientOrderId: String(clientOrderId),
        market,
        policy,
        executionTerms,
        canary,
        sellPricingShadow,
        skippedReason: null,
      });

      // Release A Phase 3 (P7 rework — durable executor-owned B1): the bounce-exit
      // backstop no longer cancels resting BOUNCE_EXIT_TARGET rungs then places the
      // taker on the SAME tick (that race could leave dual orders on a failed
      // cancel, or no-target+no-backstop on a post-cancel loss-floor reject). The
      // executor owns the ENTIRE transition durably: on receiving this backstop
      // command it preflights the loss floor, opens the P6 transition barrier to
      // cancel + CONFIRM the cycle's rungs, and records a persisted deferred-intent
      // (`pendingBackstops`) that the executor itself fires — reconciling the
      // residual from the authoritative wallet balance and resubmitting with a
      // stable clientOrderId — once the barrier reaches quiescent. This does NOT
      // depend on the planner re-emitting the signal; the bridge just publishes the
      // backstop command below and the executor's own barrier-close hook takes it
      // from there even across tick/liveness gaps.
      this.recordPartialPlacementOnSend(signal, executionTerms, nowMs);
      await this.deps.bus.publish("PlaceOrderRequested", {
        command: cmd,
        timestamp: Date.now(),
      });
    } finally {
      recordStageDuration("signal_to_order_bridge", performance.now() - bridgeStartMs);
    }
  }

  /**
   * ADR-015 observability writer. Records one append-only row per BUY/SELL
   * signal that reached execution-term resolution — successful placements
   * plus every skip (dead-side enforce, spread caps, one-sided, invalid/
   * unavailable price, entry-ceiling) so canary analytics see the full
   * distribution. Failures are logged but never throw, so a DB hiccup
   * cannot block an order from going out.
   */
  private writeObservation(params: {
    signal: RuntimeEventMap["SignalApproved"]["signal"];
    clientOrderId: string | null;
    market: NormalizedMarket;
    policy: ExecutionPolicy;
    executionTerms: ExecutionTermsResolution;
    canary: DeadSideCanary | null;
    sellPricingShadow: SellPricingShadow | null;
    skippedReason: string | null;
  }): void {
    const { observations, profileId } = this.deps;
    if (!observations || !profileId) return;
    const {
      signal,
      clientOrderId,
      market,
      policy,
      executionTerms,
      canary,
      sellPricingShadow,
      skippedReason,
    } = params;
    try {
      const { selectedPrice, diagnostics, boundedOutcome } = summarizeExecutionTerms(
        executionTerms,
        policy.pricing.mode,
      );
      const pricingDeltaTicks = computePricingDeltaTicks(
        signal.side,
        selectedPrice,
        market.bestBid,
        market.bestAsk,
        market.tickSize,
      );
      const roundLevelHit = classifyRoundLevel(selectedPrice, market.tickSize);
      const row: ExecutionPolicyObservation = {
        profileId: String(profileId),
        signalId: signal.signalId,
        clientOrderId,
        decisionRuleId: signal.decisionRuleId,
        sizingRuleId: signal.sizingRuleId,
        notionalBucket: classifyNotionalBucket(signal.suggestedSizeUsdc),
        tokenId: String(signal.tokenId),
        marketSlug: market.slug ?? null,
        side: signal.side === "buy" ? "BUY" : "SELL",
        signalReason: signal.reason,
        selectedPricingMode: policy.pricing.mode,
        selectedPrice,
        edgePrice: diagnostics?.edgePrice ?? null,
        boundedPrice: diagnostics?.finalPrice ?? null,
        boundedOutcome,
        spreadTicks: diagnostics?.spreadTicks ?? null,
        improvementTicks: diagnostics?.improvementTicks ?? null,
        deadSideObserved: canary !== null,
        deadSideBucket: canary?.bucket ?? null,
        deadSideEnforceHit: canary?.enforceHit ?? false,
        deadSideX60: canary?.shadowHits.x60_000 ?? false,
        deadSideX120: canary?.shadowHits.x120_000 ?? false,
        deadSideX300: canary?.shadowHits.x300_000 ?? false,
        deadSideX900: canary?.shadowHits.x900_000 ?? false,
        timeToEndMs: canary?.timeToEndMs ?? null,
        skippedReason,
        pricingDeltaTicks,
        roundLevelHit,
        sellShadowAvgEntry: sellPricingShadow?.avgEntry ?? null,
        sellShadowAvgEntrySource: sellPricingShadow?.avgEntrySource ?? null,
        sellShadowSignalPrice: sellPricingShadow?.signalPrice ?? null,
        sellShadowExecutionPrice: sellPricingShadow?.executionPrice ?? null,
        sellShadowExecutionVsSignalRatio: sellPricingShadow?.executionVsSignalRatio ?? null,
        sellShadowExecutionVsAvgEntryRatio: sellPricingShadow?.executionVsAvgEntryRatio ?? null,
        sellShadowCap5Violation: sellPricingShadow?.cap5Violation ?? null,
        sellShadowCap10Violation: sellPricingShadow?.cap10Violation ?? null,
        sellShadowExitPricingMode: sellPricingShadow?.exitPricingMode ?? null,
        sellShadowExitAnchorMode: sellPricingShadow?.exitAnchorMode ?? null,
      };
      this.enqueueObservation(row, signal);
    } catch (err) {
      this.log.error(
        { err, signalId: signal.signalId, tokenId: signal.tokenId },
        "failed to write execution policy observation",
      );
    }
  }

  private enqueueObservation(
    row: ExecutionPolicyObservation,
    signal: RuntimeEventMap["SignalApproved"]["signal"],
  ): void {
    this.observationQueue.push(row);
    if (this.observationFlushScheduled) return;
    this.observationFlushScheduled = true;
    setImmediate(() => {
      try {
        this.flushObservationQueue();
      } catch (err) {
        this.log.error(
          { err, signalId: signal.signalId, tokenId: signal.tokenId },
          "failed to flush execution policy observation queue",
        );
      }
    }).unref?.();
  }

  private flushObservationQueue(): void {
    const { observations } = this.deps;
    if (!observations) return;
    this.observationFlushScheduled = false;
    const rows = this.observationQueue.splice(0, this.observationQueue.length);
    for (const row of rows) {
      try {
        observations.insert(row);
      } catch (err) {
        this.log.error(
          { err, signalId: row.signalId, tokenId: row.tokenId },
          "failed to write execution policy observation",
        );
      }
    }
    if (this.observationQueue.length > 0) {
      this.observationFlushScheduled = true;
      setImmediate(() => this.flushObservationQueue()).unref?.();
    }
  }

  /**
   * Return a pricing-oriented market snapshot for a signal: the embedded
   * base (already accepted by the pre-entry hard-liveness gate) optionally
   * overlaid with a fresher `CandidateBookCache` entry for bestBid/bestAsk.
   *
   * Liveness is NOT re-checked here — that already happened on the embedded
   * snapshot upstream. This lookup is purely for order pricing freshness.
   */
  private async resolvePricingMarket(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    baseMarket: NormalizedMarket,
    policy: ExecutionPolicy,
  ): Promise<PricingMarketResult> {
    if (!this.deps.candidateBookCache) {
      return this.withExitBookFallback(signal, baseMarket, policy, {
        market: baseMarket,
        cacheStatus: "disabled",
      });
    }

    const nowMs = Date.now();
    const freshEntry = this.deps.candidateBookCache.getFreshEntry(String(signal.tokenId), nowMs);
    if (freshEntry) {
      return this.candidateHit(signal, baseMarket, freshEntry, "fresh-cache");
    }

    // A usable base market carries only top-of-book (no depth ladder); a Track R SELL still needs
    // the full book, so route through the exit-book fallback before settling for base-market pricing.
    if (canUseBaseMarketForPricing(baseMarket)) {
      return this.withExitBookFallback(signal, baseMarket, policy, {
        market: baseMarket,
        cacheStatus: "base-market",
      });
    }

    const wsEntry = await this.deps.candidateBookCache.waitForFreshEntry(
      String(signal.tokenId),
      BRIDGE_WS_BOOK_WAIT_MS,
      nowMs,
    );
    if (wsEntry) {
      return this.candidateHit(signal, baseMarket, wsEntry, "fresh-cache");
    }

    const resolution = await this.deps.candidateBookCache.getFreshOrRefresh(
      String(signal.tokenId),
      nowMs,
    );
    if (resolution.entry) {
      return this.candidateHit(signal, baseMarket, resolution.entry, resolution.status);
    }

    return this.withExitBookFallback(signal, baseMarket, policy, {
      market: baseMarket,
      cacheStatus: resolution.status,
    });
  }

  private candidateHit(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    baseMarket: NormalizedMarket,
    entry: CandidateBookCacheEntry,
    cacheStatus: PricingMarketResult["cacheStatus"],
  ): PricingMarketResult {
    if (signal.side === "sell") {
      this.recordTrackRMetric(signal, "track_r_exit_book_cache_hit", {});
    }
    return { market: applyOrderBookToMarket(baseMarket, entry), book: entry.book, cacheStatus };
  }

  /**
   * Track S5 P0a — on a candidate-book miss for a held-position SELL with `exitBookFallback` on, fall
   * back to the open-position book source: passive heartbeat primary, then secondary direct fetch.
   * Returns the bookless `fallthrough` for BUYs, when the flag is off, or when no book is available
   * (downstream then records `missing_book` as today).
   */
  private async withExitBookFallback(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    baseMarket: NormalizedMarket,
    policy: ExecutionPolicy,
    fallthrough: { market: NormalizedMarket; cacheStatus: PricingMarketResult["cacheStatus"] },
  ): Promise<PricingMarketResult> {
    if (signal.side !== "sell") return fallthrough;
    if (!this.getTrackRPolicy(policy).exitBookFallback) return fallthrough;

    this.recordTrackRMetric(signal, "track_r_exit_book_cache_miss", {});
    const nowMs = Date.now();
    const resolved = await this.exitBookCache.resolve(signal.tokenId, nowMs);
    if (!resolved) {
      this.recordTrackRMetric(signal, "track_r_exit_book_fetch_failed", {});
      return fallthrough;
    }
    this.recordTrackRMetric(signal, "track_r_exit_book_fetch_fallback", {
      source: resolved.source,
    });
    const entry = this.toExitBookEntry(signal, resolved.book, resolved.source, nowMs);
    return {
      market: applyOrderBookToMarket(baseMarket, entry),
      book: resolved.book,
      cacheStatus: "exit-book-fallback",
    };
  }

  private toExitBookEntry(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    book: OrderBookSnapshot,
    source: ExitBookSource,
    nowMs: number,
  ): CandidateBookCacheEntry {
    return {
      tokenId: String(signal.tokenId),
      snapshotTs: book.timestamp,
      cachedAtMs: nowMs,
      sourcePolledAtMs: book.timestamp,
      bookSource: "clob",
      sourceKind: source === "heartbeat" ? "ws" : "rest",
      book,
    };
  }

  private async resolveTrackRFeeQuote(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
  ): Promise<TrackRFeeQuote | null> {
    const cfg = this.getTrackRPolicy(policy);
    if (!this.isTrackRActive(policy)) return null;
    if (signal.side !== "sell" || !this.getTakerAtProfitPolicy(policy).enabled) return null;

    const fallbackQuote: TrackRFeeQuote = {
      rate: cfg.universalFallbackRate,
      exponent: 1,
      source: "fallback_universal",
    };

    try {
      const quote = await this.deps.trackRFeeProvider?.resolveFeeQuote({
        conditionId: signal.conditionId,
        tokenId: signal.tokenId,
        category: market.regime,
        feeSchedule: policy.feeSchedule,
        policy: cfg,
        nowMs: this.now(),
      });
      if (quote && Number.isFinite(quote.rate) && quote.rate >= 0) {
        this.recordTrackRFeeSourceMetric(signal, quote.source);
        return quote;
      }
    } catch (err) {
      this.log.warn(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "Track R fee provider failed; using universal fallback",
      );
    }

    this.recordTrackRFeeSourceMetric(signal, fallbackQuote.source);
    return fallbackQuote;
  }

  /**
   * Dead-side shadow canary: runs on every BUY with bestAsk ≤ askCeiling and a
   * valid endDate, regardless of timeToEndMs. The returned payload tags the
   * `bucket` (from the audit spec) and a `shadowHits` map for each audited X
   * threshold (60/120/300/900 s) so the log aggregator can pick an enforcement
   * X post-hoc. `enforceHit` reflects the configured `maxTimeToEndMs` and is
   * the single bit the caller uses to decide a skip.
   *
   * Upper-bound only: `timeToEndMs ≤ X` — negative (post-end) time-to-end also
   * hits, matching the prod sample of 2 fills evaluated after endDate.
   *
   * Returns `null` when the guard is off, when the signal is not a BUY, when
   * bestAsk is absent / above the ceiling, or when endDate is unparseable.
   */
  private buildDeadSideCanary(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
  ): DeadSideCanary | null {
    const guard = policy.deadSideGuard;
    if (guard.mode === "off") return null;
    if (signal.side !== "buy") return null;
    if (market.bestAsk == null) return null;
    if (market.bestAsk > guard.askCeiling) return null;
    if (market.endDate == null) return null;
    const endMs = Date.parse(market.endDate);
    if (!Number.isFinite(endMs)) return null;
    const nowMs = Date.now();
    const timeToEndMs = endMs - nowMs;
    const enforceX = guard.maxTimeToEndMs;
    return {
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      endDate: market.endDate,
      timeToEndMs,
      secondsToEnd: Math.round(timeToEndMs / 1000),
      bucket: bucketForTimeToEndMs(timeToEndMs),
      shadowHits: {
        x60_000: timeToEndMs <= 60_000,
        x120_000: timeToEndMs <= 120_000,
        x300_000: timeToEndMs <= 300_000,
        x900_000: timeToEndMs <= 900_000,
      },
      askCeiling: guard.askCeiling,
      enforceX,
      xMs: enforceX,
      enforceHit: timeToEndMs <= enforceX,
      guardMode: guard.mode,
    };
  }

  private async publishConversionSkipped(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    stage: RuntimeEventMap["SignalConversionSkipped"]["stage"],
    reasons: readonly string[],
    diagnostics: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.deps.bus.publish("SignalConversionSkipped", {
      signal,
      stage,
      reasons,
      diagnostics,
      skippedAt: Date.now(),
    });
  }

  private computeSellPricingShadow(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    executionTerms: ExecutionTermsResolution,
    policy: ExecutionPolicy,
  ): SellPricingShadow | null {
    if (signal.side !== "sell") return null;
    const executionPrice = resolveShadowExecutionPrice(executionTerms);
    const signalPrice = finitePositiveOrNull(signal.suggestedPrice);
    const avgEntry = this.resolveSellShadowAvgEntry(signal);
    const executionVsSignalRatio = computePositiveRatio(executionPrice, signalPrice);
    const executionVsAvgEntryRatio = computePositiveRatio(executionPrice, avgEntry.value);

    return {
      avgEntry: avgEntry.value,
      avgEntrySource: avgEntry.source,
      signalPrice,
      executionPrice,
      executionVsSignalRatio,
      executionVsAvgEntryRatio,
      cap5Violation: executionVsAvgEntryRatio == null ? null : executionVsAvgEntryRatio > 5,
      cap10Violation: executionVsAvgEntryRatio == null ? null : executionVsAvgEntryRatio > 10,
      exitPricingMode: policy.exitPricingMode,
      exitAnchorMode: resolveShadowExitAnchorMode(executionTerms),
    };
  }

  private resolveSellShadowAvgEntry(signal: RuntimeEventMap["SignalApproved"]["signal"]): {
    value: number | null;
    source: SellShadowAvgEntrySource;
  } {
    const repo = this.deps.positionRepo;
    if (!repo) return { value: null, source: "missing_position_repo" };
    try {
      const position = repo.findByTokenId(signal.tokenId);
      if (!position) return { value: null, source: "missing_position" };
      const avgEntry = finitePositiveOrNull(position.avgEntryPrice);
      if (avgEntry == null) return { value: null, source: "invalid_avg_entry" };
      return { value: avgEntry, source: "position_repo" };
    } catch (err) {
      this.log.warn(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "SELL shadow telemetry could not read avg entry",
      );
      return { value: null, source: "error" };
    }
  }

  private resolveSellPositionSize(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
  ): number | null {
    const repo = this.deps.positionRepo;
    if (!repo) return null;
    try {
      const position = repo.findByTokenId(signal.tokenId);
      return finitePositiveOrNull(position?.size ?? null);
    } catch (err) {
      this.log.warn(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "Track R could not read position size",
      );
      return null;
    }
  }

  /**
   * Track P F2 — clamp a resolved SELL execution price to the Plankton tier cap
   * (avgEntry * markup, ceiling 0.97). Applied after the SELL pricing shadow is
   * computed so the observe-only telemetry keeps measuring the raw (pre-cap)
   * anchor. BUY orders and non-`ok` resolutions pass through untouched.
   */
  private applySellPriceCap(
    resolution: ExecutionTermsResolution,
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    policy: ExecutionPolicy,
  ): ExecutionTermsResolution {
    if (signal.side !== "sell" || resolution.kind !== "ok") return resolution;
    // Bounce-exit target bypass (docs/plans/2026-07-15-gate-bounce-live-experiment.md,
    // Phase 4 / Codex M4): the +25.7% target IS the plankton-derived markup —
    // the generic tier cap (1.17x at avgEntry>=0.15) would clip it back down to
    // +17%, double-clamping a price that's already the intended markup. Placed
    // after the `kind !== "ok"` guard above, so the bypass only applies once the
    // target has already passed validateExecutablePrice/tick-bounds validation
    // in resolveExecutionTerms.
    if (signal.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID) return resolution;
    const avgEntry = this.resolveSellShadowAvgEntry(signal).value;
    const trackR = this.getTrackRPolicy(policy);
    const tier = planktonMarkupTierLabel(avgEntry);
    // The Plankton cap is a maker-oriented entry-aligned markup ceiling. For a
    // taker the live bid already prices the exit; capping down can falsely drop
    // it below the fee-aware margin floor. The skip is taker-only; the post-cap
    // Track R invariant (resolveTakerBelowMarginBlock) remains the loss-guard.
    if (
      shouldSkipSellPriceCap({
        pricedMode: resolution.pricedMode,
        bestBid: resolution.price,
        cap: resolvePlanktonSellCap(avgEntry),
        context: {
          trackS3BehaviorChanged: resolution.takerAtProfit?.trackS3BehaviorChanged === true,
          takerCapSkip: trackR.takerCapSkip,
          safetyMargin: trackR.safetyMargin,
        },
      })
    ) {
      this.recordTrackRMetric(signal, "track_r_taker_cap_skipped", { tier });
      return resolution;
    }
    const capped = capSellPriceToPlanktonTier(resolution.price, avgEntry, resolution.tickSize);
    if (capped === resolution.price) return resolution;
    // track_r_taker_cap_applied is taker-only forensics for the P0b skip carve-out.
    // A maker SELL is still clipped here, but it must not inflate the taker counter.
    if (resolution.pricedMode === "taker") {
      this.recordTrackRMetric(signal, "track_r_taker_cap_applied", { tier });
    }
    return { ...resolution, price: capped };
  }

  /**
   * ADR-006 D1 (edge mode): BUY = bestBid, SELL = bestAsk.
   * R93 sell-exit guard: default SELL exits are midpoint-anchored while
   * bid-anchored remains available for config rollback.
   * ADR-014 (bounded-midpoint mode): price improves toward midpoint, bounded by
   * spread cap + improvement cap + no-cross clamp. Single formula for all runtime
   * modes; mode selector is `policy.pricing.mode`. Postonly remains relayer-only (D2).
   */
  private resolveExecutionTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
    book: OrderBookSnapshot | null,
    trackRFeeQuote: TrackRFeeQuote | null,
  ): ExecutionTermsResolution {
    const isRelayer = this.deps.liveLiteGuard?.getWalletMode() === "relayer";
    const pricing = policy.pricing;
    const effectiveTick = resolveEffectiveOrderTickSize(signal, market);
    const pricingTickSize = resolvePricingTickSize(signal, market, effectiveTick.tickSize);
    const ladderTargetPrice =
      signal.side === "buy" && signal.ladderTargetPrice != null ? signal.ladderTargetPrice : null;

    if (ladderTargetPrice != null) {
      if (
        market.bestAsk != null &&
        Number.isFinite(market.bestAsk) &&
        ladderTargetPrice >= market.bestAsk
      ) {
        return { kind: "unavailable" };
      }
      if (
        !Number.isFinite(ladderTargetPrice) ||
        ladderTargetPrice <= 0 ||
        !Number.isFinite(pricingTickSize)
      ) {
        return { kind: "unavailable" };
      }
      const validation = validateExecutablePrice(ladderTargetPrice, pricingTickSize);
      if (!validation.ok) {
        this.log.warn(
          {
            signalId: signal.signalId,
            tokenId: String(signal.tokenId),
            ladderTargetPrice,
            tickSize: pricingTickSize,
            validationReason: validation.reason,
          },
          "ladder target price failed executable-price validation",
        );
        return {
          kind: "invalid",
          price: ladderTargetPrice,
          tickSize: validation.tickSize,
          minPrice: validation.minPrice,
          maxPrice: validation.maxPrice,
          validationReason: validation.reason,
        };
      }
      const ok: ExecutionTermsResolution = isRelayer
        ? {
            kind: "ok",
            price: ladderTargetPrice,
            tickSize: effectiveTick.tickSize,
            postOnly: true,
            pricedMode: "ladder",
          }
        : {
            kind: "ok",
            price: ladderTargetPrice,
            tickSize: effectiveTick.tickSize,
            pricedMode: "ladder",
          };
      return normalizeExecutionTerms(ok, signal, effectiveTick);
    }

    // Bounce-exit resting rung (docs/plans/2026-07-16-bounce-exit-ladder-
    // redesign.md): the rung's price is the ladder target computed upstream
    // by decision-planner.ts (evaluateBounceExit) and carried verbatim as
    // signal.suggestedPrice — unconditional (no config gating), same
    // rationale as the ladder-price branch above. Only tick-bounds validation
    // applies; the plankton sell-cap is bypassed separately in
    // applySellPriceCap. A post-only price that would cross the live bid is
    // caught downstream by execution-module.ts's generic
    // getPostOnlyCrossPreSubmitSkip (reprice next tick), not here.
    if (signal.side === "sell" && signal.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID) {
      const targetPrice = signal.suggestedPrice;
      if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(pricingTickSize)) {
        return { kind: "unavailable" };
      }
      const validation = validateExecutablePrice(targetPrice, pricingTickSize);
      if (!validation.ok) {
        return {
          kind: "invalid",
          price: targetPrice,
          tickSize: validation.tickSize,
          minPrice: validation.minPrice,
          maxPrice: validation.maxPrice,
          validationReason: validation.reason,
        };
      }
      const ok: ExecutionTermsResolution = {
        kind: "ok",
        price: targetPrice,
        tickSize: effectiveTick.tickSize,
        postOnly: true,
        pricedMode: "bounce-exit-target",
      };
      return normalizeExecutionTerms(ok, signal, effectiveTick);
    }

    // Bounce-exit backstop force-exit (docs/plans/2026-07-16-bounce-exit-
    // ladder-redesign.md): a dedicated, unconditional marketable-taker price —
    // deliberately NOT routed through resolveTakerAtProfitTerms/
    // resolveOpportunisticTakerTerms, both of which are config/allowlist-gated
    // and could silently fail to activate, defeating the force-exit's
    // purpose. Uses the live best bid directly; no postOnly. Live since Phase
    // 3: decision-planner.ts computes backstopEligible for real via
    // evaluateBounceBackstopEligibility (qd-pre-resolution-exit.ts), reusing
    // Sub-Track Q.D's Mode-A/B near-resolution activation logic scoped to the
    // GATE band (avgEntryPrice <= gateEntry.maxPrice, inclusive) and gated on
    // bounceExit.backstopTtcHours.
    if (isBounceForceExit(signal)) {
      const bestBid = market.bestBid;
      if (
        bestBid == null ||
        !Number.isFinite(bestBid) ||
        bestBid <= 0 ||
        !Number.isFinite(pricingTickSize)
      ) {
        return { kind: "unavailable" };
      }
      const validation = validateExecutablePrice(bestBid, pricingTickSize);
      if (!validation.ok) {
        return {
          kind: "invalid",
          price: bestBid,
          tickSize: validation.tickSize,
          minPrice: validation.minPrice,
          maxPrice: validation.maxPrice,
          validationReason: validation.reason,
        };
      }
      const ok: ExecutionTermsResolution = {
        kind: "ok",
        price: bestBid,
        tickSize: effectiveTick.tickSize,
        pricedMode: "taker",
      };
      return normalizeExecutionTerms(ok, signal, effectiveTick);
    }

    const takerAtProfitTerms = this.resolveTakerAtProfitTerms(
      signal,
      market,
      policy,
      pricingTickSize,
      effectiveTick,
      book,
      trackRFeeQuote,
    );
    if (takerAtProfitTerms) return takerAtProfitTerms;

    // Tight-spread taker mode intentionally wins over bounded-midpoint: both
    // price at/near the opposite top of book, but this path explicitly disables
    // postOnly to copy R51's observed taker fills.
    const takerTerms = this.resolveOpportunisticTakerTerms(signal, market, policy, pricingTickSize);
    if (takerTerms) return takerTerms;

    if (pricing.mode === "bounded-midpoint") {
      const maxSpreadTicks =
        signal.side === "buy" ? pricing.maxEntrySpreadTicks : pricing.maxExitSpreadTicks;
      const outcome = resolveBoundedMidpointPrice({
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        tickSize: pricingTickSize,
        side: signal.side,
        maxSpreadTicks,
        maxImprovementTicks: pricing.maxImprovementTicks,
        wideSpreadPolicy: pricing.wideSpreadPolicy,
        oneSidedPolicy: pricing.oneSidedPolicy,
      });
      if (outcome.kind === "skip") {
        return outcome.reason === "wide-spread"
          ? { kind: "skip-wide-spread", diagnostics: outcome.diagnostics }
          : { kind: "skip-one-sided", diagnostics: outcome.diagnostics };
      }
      if (outcome.kind === "invalid") {
        const validation = validateExecutablePrice(outcome.price, pricingTickSize);
        return {
          kind: "invalid",
          price: outcome.price,
          tickSize: validation.tickSize,
          minPrice: validation.minPrice,
          maxPrice: validation.maxPrice,
          validationReason: outcome.reason,
        };
      }
      const ok: ExecutionTermsResolution = isRelayer
        ? {
            kind: "ok",
            price: outcome.price,
            tickSize: effectiveTick.tickSize,
            postOnly: true,
            pricedMode: "bounded-midpoint",
            pricingDiagnostics: outcome.diagnostics,
          }
        : {
            kind: "ok",
            price: outcome.price,
            tickSize: effectiveTick.tickSize,
            pricedMode: "bounded-midpoint",
            pricingDiagnostics: outcome.diagnostics,
          };
      return normalizeExecutionTerms(ok, signal, effectiveTick);
    }

    const priced = this.resolveEdgeExecutionPrice(signal, market, policy, pricingTickSize);
    const price = priced?.price ?? null;
    if (price == null || !Number.isFinite(price) || price <= 0) return { kind: "unavailable" };
    const validation = validateExecutablePrice(price, pricingTickSize);
    if (!validation.ok) {
      return {
        kind: "invalid",
        price,
        tickSize: validation.tickSize,
        minPrice: validation.minPrice,
        maxPrice: validation.maxPrice,
        validationReason: validation.reason,
      };
    }
    // ADR-014 canary: in edge mode still compute the bounded-midpoint candidate
    // and attach its diagnostics as `pricingShadow`. Enables a non-regression
    // A/B read (edge vs shadow) before flipping `EXECUTION_PRICING_MODE` to
    // `bounded-midpoint`. Skip/invalid shadow outcomes are logged the same way
    // so canary analysis can see them. Gated by policy.telemetry.pricingShadow.
    const pricingShadow = policy.telemetry.pricingShadow
      ? this.computePricingShadow(signal, market, policy)
      : undefined;
    const ok: ExecutionTermsResolution = isRelayer
      ? {
          kind: "ok",
          price,
          tickSize: effectiveTick.tickSize,
          postOnly: true,
          pricedMode: priced?.mode ?? "edge",
        }
      : { kind: "ok", price, tickSize: effectiveTick.tickSize, pricedMode: priced?.mode ?? "edge" };
    if (priced?.anchorTicksUsed !== undefined) {
      ok.anchorTicksUsed = priced.anchorTicksUsed;
    }
    if (priced?.exitAnchorMode !== undefined) {
      ok.exitAnchorMode = priced.exitAnchorMode;
    }
    if (pricingShadow && ok.kind === "ok") {
      ok.pricingShadow = pricingShadow;
    }
    return normalizeExecutionTerms(ok, signal, effectiveTick);
  }

  private resolveEdgeExecutionPrice(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
    pricingTickSize: number,
  ): {
    price: number;
    mode: OrderPricedMode;
    anchorTicksUsed?: number;
    exitAnchorMode?: ExitAnchorMode;
  } | null {
    if (signal.side === "sell" && policy.exitPricingMode === "midpoint-anchored") {
      const midpointPrice = resolveMidpointAnchoredSellPriceWithMode(
        market.bestBid,
        market.bestAsk,
        pricingTickSize,
        policy.exitMidpointAnchorTicks,
      );
      if (midpointPrice != null) {
        return {
          price: midpointPrice.price,
          mode: "midpoint-anchored",
          anchorTicksUsed: policy.exitMidpointAnchorTicks,
          exitAnchorMode: midpointPrice.anchorMode,
        };
      }
    }

    if (signal.side === "sell" && policy.exitPricingMode === "bid-anchored") {
      if (
        market.bestBid == null ||
        !Number.isFinite(market.bestBid) ||
        !Number.isFinite(pricingTickSize) ||
        pricingTickSize <= 0
      ) {
        return null;
      }
      return {
        price: resolveBidAnchoredSellPrice(
          market.bestBid,
          market.bestAsk,
          pricingTickSize,
          policy.exitBidAnchorTicks,
        ),
        mode: "bid-anchored",
        anchorTicksUsed: policy.exitBidAnchorTicks,
      };
    }
    const price = signal.side === "buy" ? market.bestBid : market.bestAsk;
    return price == null ? null : { price, mode: "edge" };
  }

  private resolveTakerAtProfitTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
    pricingTickSize: number,
    effectiveTick: EffectiveOrderTickSize,
    book: OrderBookSnapshot | null,
    trackRFeeQuote: TrackRFeeQuote | null,
  ): ExecutionTermsResolution | null {
    const cfg = this.getTakerAtProfitPolicy(policy);
    if (!cfg.enabled || signal.side !== "sell") return null;
    this.recordTakerAtProfitMetric(signal, "evaluated", null);

    if (!isTakerAtProfitRuleAllowed(signal, cfg.rules)) {
      this.recordTakerAtProfitMetric(signal, "blocked", "rule_excluded");
      return null;
    }

    const bestBid = finitePositiveOrNull(market.bestBid);
    const bestAsk = finitePositiveOrNull(market.bestAsk);
    const avgEntry = this.resolveSellShadowAvgEntry(signal).value;
    if (bestBid == null || bestAsk == null || avgEntry == null) {
      this.recordTakerAtProfitMetric(signal, "blocked", "missing_data", {
        hasBestBid: bestBid != null,
        hasBestAsk: bestAsk != null,
        hasAvgEntry: avgEntry != null,
      });
      return null;
    }
    if (
      !Number.isFinite(pricingTickSize) ||
      pricingTickSize <= 0 ||
      !Number.isFinite(bestAsk - bestBid) ||
      bestAsk < bestBid
    ) {
      this.recordTakerAtProfitMetric(signal, "blocked", "invalid_book");
      return null;
    }

    const spreadTicks = Math.round((bestAsk - bestBid) / pricingTickSize);
    const trackS3 = this.getTrackS3Policy(policy);
    if (!trackS3.enabled && cfg.maxSpreadTicks !== null && spreadTicks > cfg.maxSpreadTicks) {
      this.recordTakerAtProfitMetric(signal, "blocked", "spread_too_wide", {
        spreadTicks,
        maxSpreadTicks: cfg.maxSpreadTicks,
      });
      return null;
    }

    let minGrossExitRatio = cfg.minGrossExitRatio;
    let effectiveFillPrice: number | null = null;
    let worstFillPrice: number | null = null;
    let liquidityAvailable: number | null = null;
    let targetSize: number | null = null;
    let depthExhausted: boolean | null = null;
    let feeRate: number | null = null;
    let feeExponent: number | null = null;
    let feeSource: TrackRFeeRateSource | null = null;
    let trackS3Margin: number | null = null;
    let trackS3BaseSpreadTicks: number | null = null;
    let trackS3AllowedSpreadTicks: number | null = null;
    let trackS3Tier: string | null = null;
    let trackS3DynamicCapUsed: boolean | null = null;
    let trackS3BehaviorChanged: boolean | null = null;
    // Track S5 P1 — partial-exit state, set only when an exhausted book is sold
    // down to the available top-of-book liquidity. `partialSizeCap` overrides the
    // order size and switches the command to a slot-bucketed clientOrderId.
    let partialSizeCap: number | null = null;
    let isPartial = false;
    let partialNowMs = 0;
    const trackR = this.getTrackRPolicy(policy);

    if (this.isTrackRActive(policy)) {
      const positionSize = this.resolveSellPositionSize(signal);
      targetSize = positionSize ?? null;
      if (!book || positionSize == null) {
        this.recordTrackRBlockedDepth(signal, {
          reason: !book ? "missing_book" : "missing_position_size",
          liquidity_available: null,
          target_size: targetSize,
        });
        if (trackR.enabled) return null;
      } else {
        const fill = computeEffectiveFillPrice(book, positionSize, "sell");
        effectiveFillPrice = fill.effectiveFillPrice;
        worstFillPrice = fill.worstFillPrice;
        liquidityAvailable = fill.liquidityAvailable;
        targetSize = fill.targetSize;
        depthExhausted = fill.exhausted;
        this.recordTrackRMetric(signal, "track_r_effective_fill_used", {
          effective_fill_price: effectiveFillPrice,
          best_bid: bestBid,
          target_size: targetSize,
          liquidity_available: liquidityAvailable,
          exhausted: depthExhausted,
        });
        if (
          effectiveFillPrice != null &&
          bestBid > 0 &&
          (bestBid - effectiveFillPrice) / bestBid > 0.05
        ) {
          this.recordTrackRMetric(signal, "track_r_effective_fill_thin_book", {
            effective_fill_price: effectiveFillPrice,
            best_bid: bestBid,
            slippage_pct: (bestBid - effectiveFillPrice) / bestBid,
          });
        }
        if (fill.exhausted) {
          // Track S5 P1 (Option A): allowPartialExit takes priority over
          // requireFullDepth — sell only the available top-of-book liquidity.
          if (trackR.allowPartialExit) {
            const effectiveMin = resolveEffectiveMinOrderSize(
              market.minOrderSize,
              trackR.partialExitMinShares,
            );
            const partialFloor = Math.max(
              effectiveMin,
              trackR.partialExitMinFraction * positionSize,
            );
            partialNowMs = this.now();
            if (
              this.isPartialFrequencyLimited(
                signal.tokenId,
                partialNowMs,
                trackR.partialExitMaxPerHour,
              )
            ) {
              this.recordTrackRMetric(signal, "track_r_partial_exit_frequency_limited", {
                liquidity_available: fill.liquidityAvailable,
                max_per_hour: trackR.partialExitMaxPerHour,
              });
              return null;
            }
            if (fill.liquidityAvailable + 1e-9 < partialFloor) {
              this.recordTrackRMetric(signal, "track_r_partial_exit_too_small", {
                liquidity_available: fill.liquidityAvailable,
                partial_floor: partialFloor,
              });
              return null;
            }
            partialSizeCap = floorToMinOrderStep(
              fill.liquidityAvailable,
              market.minOrderSize,
              trackR.partialExitMinShares,
            );
            isPartial = true;
          } else if (trackR.requireFullDepth) {
            this.recordTrackRBlockedDepth(signal, {
              reason: "insufficient_full_depth",
              liquidity_available: fill.liquidityAvailable,
              target_size: fill.targetSize,
            });
            return null;
          }
          // else: requireFullDepth=false, allowPartialExit=false → legacy
          // proceed-on-full behavior; fall through with the full target size.
        }
        const feeQuote = trackRFeeQuote ?? {
          rate: trackR.universalFallbackRate,
          exponent: 1,
          source: "fallback_universal" as const,
        };
        feeRate = feeQuote.rate;
        feeExponent = feeQuote.exponent;
        feeSource = feeQuote.source;
        if (effectiveFillPrice != null) {
          minGrossExitRatio = computeTrackRMinGrossExitRatio({
            effectiveFillPrice,
            rate: feeQuote.rate,
            exponent: feeQuote.exponent,
            safetyMargin: trackR.safetyMargin,
          });
          this.recordTrackRThresholdSample(signal, {
            effectiveFillPrice,
            avgEntry,
            minGrossExitRatio,
            feeQuote,
            mode: "gate",
          });
        }
        const invalidThreshold =
          !Number.isFinite(minGrossExitRatio) || minGrossExitRatio > trackR.maxSaneThreshold;
        const minExit = avgEntry * minGrossExitRatio;
        if (invalidThreshold || effectiveFillPrice == null || effectiveFillPrice + 1e-9 < minExit) {
          // Track S5 P1 — a partial that fails the fee-aware floor gets its own
          // dedicated counter (the partial VWAP is already `effectiveFillPrice`).
          if (isPartial) {
            this.recordTrackRMetric(signal, "track_r_partial_exit_blocked_margin", {
              avg_entry: avgEntry,
              effective_fill_price: effectiveFillPrice,
              min_exit: minExit,
              min_gross_exit_ratio: minGrossExitRatio,
              fee_source: feeQuote.source,
              fee_rate: feeQuote.rate,
            });
          } else {
            this.recordTrackRBlockedMargin(signal, {
              mode: "gate",
              avg_entry: avgEntry,
              effective_fill_price: effectiveFillPrice,
              min_exit: minExit,
              min_gross_exit_ratio: minGrossExitRatio,
              fee_source: feeQuote.source,
              fee_rate: feeQuote.rate,
            });
          }
          if (trackR.enabled) return null;
        } else {
          this.recordTrackRMetric(signal, "track_r_taker_at_profit_passed", {
            effective_fill_price: effectiveFillPrice,
            min_exit: minExit,
            min_gross_exit_ratio: minGrossExitRatio,
            fee_source: feeQuote.source,
          });
        }
      }
    } else {
      const minExit = avgEntry * cfg.minGrossExitRatio;
      if (bestBid + 1e-9 < minExit) {
        this.recordTakerAtProfitMetric(signal, "blocked", "below_profit_margin", {
          avgEntry,
          bestBid,
          minExit,
          minGrossExitRatio: cfg.minGrossExitRatio,
        });
        return null;
      }
    }

    const trackS3Decision = this.resolveTrackS3SpreadDecision({
      policy,
      cfg,
      avgEntry,
      effectiveFillPrice,
      spreadTicks,
    });
    if (trackS3Decision.applies) {
      trackS3Margin = trackS3Decision.margin;
      trackS3BaseSpreadTicks = trackS3Decision.baseCap;
      trackS3AllowedSpreadTicks = trackS3Decision.allowedCap;
      trackS3Tier = trackS3Decision.tier;
      trackS3DynamicCapUsed = trackS3Decision.dynamicCapUsed;
      trackS3BehaviorChanged = trackS3Decision.behaviorChanged;
      this.recordTrackS3Evaluation(signal, trackS3Decision);
      this.recordTrackS3DynamicCapApplied(signal, market, {
        avgEntry,
        bestBid,
        bestAsk,
        spreadTicks,
        effectiveFillPrice: effectiveFillPrice!,
        decision: trackS3Decision,
      });
      if (spreadTicks > trackS3Decision.allowedCap) {
        this.recordTrackS3StillBlocked(signal, trackS3Decision);
        this.recordTakerAtProfitMetric(signal, "blocked", "spread_too_wide", {
          trackS3: {
            enabled: true,
            tier: trackS3Decision.tier,
            dynamic_cap_used: trackS3Decision.dynamicCapUsed,
          },
        });
        return null;
      }
    } else if (
      trackS3Decision.staticMaxSpreadTicks !== null &&
      spreadTicks > trackS3Decision.staticMaxSpreadTicks
    ) {
      this.recordTakerAtProfitMetric(signal, "blocked", "spread_too_wide", {
        spreadTicks,
        maxSpreadTicks: trackS3Decision.staticMaxSpreadTicks,
      });
      return null;
    }

    const minSizeBlock = this.resolveTakerMinSizeBlock(
      signal,
      market,
      bestBid,
      policy.opportunisticTaker,
      partialSizeCap ?? undefined,
    );
    if (minSizeBlock) {
      this.recordTakerMinSizeDisabledMetric(signal, minSizeBlock);
      this.recordTakerAtProfitMetric(signal, "blocked", "min_size");
      return null;
    }

    const validation = validateExecutablePrice(bestBid, pricingTickSize);
    if (!validation.ok) {
      return {
        kind: "invalid",
        price: bestBid,
        tickSize: validation.tickSize,
        minPrice: validation.minPrice,
        maxPrice: validation.maxPrice,
        validationReason: validation.reason,
      };
    }

    return normalizeExecutionTerms(
      {
        kind: "ok",
        price: bestBid,
        tickSize: effectiveTick.tickSize,
        postOnly: false,
        pricedMode: "taker",
        spreadTicks,
        ...(isPartial && partialSizeCap != null ? { size: partialSizeCap } : {}),
        takerAtProfit: {
          avgEntry,
          bestBid,
          minGrossExitRatio,
          spreadTicks,
          effectiveFillPrice,
          worstFillPrice,
          liquidityAvailable,
          targetSize,
          depthExhausted,
          feeRate,
          feeExponent,
          feeSource,
          trackS3Margin,
          trackS3BaseSpreadTicks,
          trackS3AllowedSpreadTicks,
          trackS3Tier,
          trackS3DynamicCapUsed,
          trackS3BehaviorChanged,
        },
      },
      signal,
      effectiveTick,
    );
  }

  private resolveTrackS3SpreadDecision(input: {
    policy: ExecutionPolicy;
    cfg: ExecutionPolicy["takerAtProfit"];
    avgEntry: number;
    effectiveFillPrice: number | null;
    spreadTicks: number;
  }): TrackS3SpreadDecision {
    const policy = this.getTrackS3Policy(input.policy);
    if (!policy.enabled) {
      return { applies: false, staticMaxSpreadTicks: null };
    }
    if (!this.isTrackRActive(input.policy) || input.effectiveFillPrice == null) {
      return { applies: false, staticMaxSpreadTicks: input.cfg.maxSpreadTicks };
    }
    const cheapLongshotMaxAvgEntry =
      input.policy.trackS1?.cheapLongshotMaxAvgEntry ??
      DEFAULT_EXECUTION_POLICY.trackS1.cheapLongshotMaxAvgEntry;
    if (input.avgEntry < cheapLongshotMaxAvgEntry) {
      return { applies: false, staticMaxSpreadTicks: input.cfg.maxSpreadTicks };
    }
    const margin = input.effectiveFillPrice / input.avgEntry;
    if (!Number.isFinite(margin) || margin <= 0) {
      return { applies: false, staticMaxSpreadTicks: input.cfg.maxSpreadTicks };
    }

    const baseCap = input.cfg.maxSpreadTicks ?? policy.baseCap;
    const cap = resolveTrackS3SpreadCap({ margin, baseCap, tiers: policy.tiers });
    return {
      applies: true,
      staticMaxSpreadTicks: null,
      margin,
      baseCap,
      allowedCap: cap.allowedSpreadTicks,
      tier: cap.tier,
      dynamicCapUsed: cap.dynamicCapUsed,
      behaviorChanged: input.spreadTicks > baseCap && input.spreadTicks <= cap.allowedSpreadTicks,
    };
  }

  private resolveOpportunisticTakerTerms(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
    pricingTickSize: number,
  ): ExecutionTermsResolution | null {
    const taker = policy.opportunisticTaker;
    if (!taker) return null;
    if (!taker.enabled) return null;
    if (
      market.bestBid == null ||
      market.bestAsk == null ||
      !Number.isFinite(market.bestBid) ||
      !Number.isFinite(market.bestAsk) ||
      !Number.isFinite(pricingTickSize) ||
      pricingTickSize <= 0
    ) {
      return null;
    }
    const spread = market.bestAsk - market.bestBid;
    if (!Number.isFinite(spread) || spread < 0) return null;
    const spreadTicks = Math.round(spread / pricingTickSize);
    if (spreadTicks > taker.maxSpreadTicks) return null;

    const price = signal.side === "buy" ? market.bestAsk : market.bestBid;
    const minSizeBlock = this.resolveTakerMinSizeBlock(signal, market, price, taker);
    if (minSizeBlock) {
      this.recordTakerMinSizeDisabledMetric(signal, minSizeBlock);
      return null;
    }

    const validation = validateExecutablePrice(price, pricingTickSize);
    if (!validation.ok) {
      return {
        kind: "invalid",
        price,
        tickSize: validation.tickSize,
        minPrice: validation.minPrice,
        maxPrice: validation.maxPrice,
        validationReason: validation.reason,
      };
    }
    const effectiveTick = resolveEffectiveOrderTickSize(signal, market);
    return normalizeExecutionTerms(
      {
        kind: "ok",
        price,
        tickSize: effectiveTick.tickSize,
        postOnly: false,
        pricedMode: "taker",
        spreadTicks,
      },
      signal,
      effectiveTick,
    );
  }

  private resolveTakerMinSizeBlock(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    price: number,
    taker: ExecutionPolicy["opportunisticTaker"],
    // Track S5 P1 — when a partial exit caps the size below the full position,
    // the min-size gate must score the capped size/notional, not the signal's.
    sizeOverride?: number,
  ): TakerMinSizeBlock | null {
    const marketMinOrderSize =
      typeof market.minOrderSize === "number" &&
      Number.isFinite(market.minOrderSize) &&
      market.minOrderSize > 0
        ? market.minOrderSize
        : null;

    const shareSize = sizeOverride ?? signal.suggestedSize;
    if (
      marketMinOrderSize !== null &&
      shareSize + MIN_SIZE_EPSILON < marketMinOrderSize * taker.safetyBuffer
    ) {
      return {
        reason: "share_min_size",
        marketMinOrderSize,
        minNotionalUsdc: null,
        notionalUsdc: sizeOverride != null ? sizeOverride * price : signal.suggestedSizeUsdc,
        safetyBuffer: taker.safetyBuffer,
        requestedSizeShares: shareSize,
      };
    }

    const notionalUsdc =
      sizeOverride != null
        ? sizeOverride * price
        : Number.isFinite(signal.suggestedSizeUsdc) && signal.suggestedSizeUsdc > 0
          ? signal.suggestedSizeUsdc
          : signal.suggestedSize * price;
    const configuredBuyMinNotional =
      signal.side === "buy"
        ? this.deps.liveLiteGuard?.getMinEntryNotionalUsdc?.(taker.marketableBuyMinNotionalUsdc)
        : null;
    const minNotionalUsdc =
      configuredBuyMinNotional ??
      (marketMinOrderSize === null ? taker.fallbackMinNotionalUsdc : null);

    if (
      minNotionalUsdc !== null &&
      Number.isFinite(minNotionalUsdc) &&
      minNotionalUsdc > 0 &&
      notionalUsdc + MIN_NOTIONAL_EPSILON < minNotionalUsdc * taker.safetyBuffer
    ) {
      return {
        reason: "notional_min_size",
        marketMinOrderSize,
        minNotionalUsdc,
        notionalUsdc,
        safetyBuffer: taker.safetyBuffer,
        requestedSizeShares: shareSize,
      };
    }

    return null;
  }

  private computePricingShadow(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    policy: ExecutionPolicy,
  ): BoundedMidpointDiagnostics | undefined {
    const pricing = policy.pricing;
    const maxSpreadTicks =
      signal.side === "buy" ? pricing.maxEntrySpreadTicks : pricing.maxExitSpreadTicks;
    const outcome = resolveBoundedMidpointPrice({
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      tickSize: market.tickSize,
      side: signal.side,
      maxSpreadTicks,
      maxImprovementTicks: pricing.maxImprovementTicks,
      wideSpreadPolicy: pricing.wideSpreadPolicy,
      oneSidedPolicy: pricing.oneSidedPolicy,
    });
    return outcome.diagnostics;
  }

  private resolveTakerBelowMarginBlock(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    executionTerms: Extract<ExecutionTermsResolution, { kind: "ok" }>,
    policy: ExecutionPolicy,
    trackRFeeQuote: TrackRFeeQuote | null,
  ): {
    avgEntry: number | null;
    minExit: number | null;
    minGrossExitRatio: number;
    reason: "avg_entry_unavailable" | "below_margin";
  } | null {
    const cfg = this.getTakerAtProfitPolicy(policy);
    if (!cfg.enabled || signal.side !== "sell") return null;
    if (executionTerms.pricedMode !== "taker") return null;

    // Taker-at-profit owns its own safety gate. Q.F only blocks below-entry
    // wide books in the planner; tight-book taker SELLs can still arrive here.
    // Therefore this invariant intentionally covers every taker SELL while the
    // feature flag is enabled, not only the new taker-at-profit resolver.
    const avgEntry = this.resolveSellShadowAvgEntry(signal).value;
    if (avgEntry == null) {
      return {
        avgEntry: null,
        minExit: null,
        minGrossExitRatio: cfg.minGrossExitRatio,
        reason: "avg_entry_unavailable",
      };
    }

    let minGrossExitRatio = cfg.minGrossExitRatio;
    if (this.isTrackRActive(policy)) {
      const trackR = this.getTrackRPolicy(policy);
      const feeQuote = trackRFeeQuote ?? {
        rate: trackR.universalFallbackRate,
        exponent: 1,
        source: "fallback_universal" as const,
      };
      minGrossExitRatio = computeTrackRMinGrossExitRatio({
        effectiveFillPrice: executionTerms.price,
        rate: feeQuote.rate,
        exponent: feeQuote.exponent,
        safetyMargin: trackR.safetyMargin,
      });
      this.recordTrackRThresholdSample(signal, {
        effectiveFillPrice: executionTerms.price,
        avgEntry,
        minGrossExitRatio,
        feeQuote,
        mode: "invariant",
      });
      if (!Number.isFinite(minGrossExitRatio) || minGrossExitRatio > trackR.maxSaneThreshold) {
        this.recordTrackRBlockedMargin(signal, {
          mode: "invariant",
          avg_entry: avgEntry,
          effective_fill_price: executionTerms.price,
          min_exit: null,
          min_gross_exit_ratio: minGrossExitRatio,
          fee_source: feeQuote.source,
          fee_rate: feeQuote.rate,
        });
        return {
          avgEntry,
          minExit: null,
          minGrossExitRatio,
          reason: "below_margin",
        };
      }
    }

    const minExit = avgEntry * minGrossExitRatio;
    if (executionTerms.price + 1e-9 >= minExit) return null;
    if (this.isTrackRActive(policy)) {
      const trackR = this.getTrackRPolicy(policy);
      const feeQuote = trackRFeeQuote ?? {
        rate: trackR.universalFallbackRate,
        exponent: 1,
        source: "fallback_universal" as const,
      };
      this.recordTrackRBlockedMargin(signal, {
        mode: "invariant",
        avg_entry: avgEntry,
        effective_fill_price: executionTerms.price,
        min_exit: minExit,
        min_gross_exit_ratio: minGrossExitRatio,
        fee_source: feeQuote.source,
        fee_rate: feeQuote.rate,
      });
    }
    return {
      avgEntry,
      minExit,
      minGrossExitRatio,
      reason: "below_margin",
    };
  }

  private findSamePriceOpenSellOrder(
    tokenId: TokenId,
    side: "buy" | "sell",
    executionPrice: number,
    tickSize: number,
    policy: ExecutionPolicy,
  ): Order | null {
    if (side !== "sell" || !this.deps.orderRepo) return null;
    const toleranceTicks = policy.sellReplaceMinPriceDeltaTicks ?? 2;
    const acceptablePriceWindow = toleranceTicks * tickSize + 1e-9;
    const orders = this.deps.orderRepo.findByTokenId(tokenId);
    return (
      orders.find(
        (order) =>
          order.side === "sell" &&
          isOpenOrderStatus(order.status) &&
          Math.abs(order.price - executionPrice) < acceptablePriceWindow,
      ) ?? null
    );
  }

  /**
   * Identity-scoped duplicate check for a bounce-exit rung (docs/plans/
   * 2026-07-16-bounce-exit-ladder-redesign.md, Phase 2 Codex fix): matches
   * an existing non-cancelled/rejected BOUNCE_EXIT_TARGET SELL order for this
   * token, on the SAME ladderId, whose own placed rung index (or, for a
   * rolled-forward merge, any of its `rungIndicesCovered`) overlaps this
   * rung's own index set. A different rungIndex on the same ladder is never
   * a match, even at an identical or near price — adjacent rungs are tick-
   * rounded and can legitimately land within the generic same-price
   * tolerance window; treating that as a duplicate silently drops the rung
   * (no metadata ever persisted) and the planner re-emits it forever.
   * Mirrors algo-decision-module.ts's `placedBounceRungIndices` matching.
   */
  private findDuplicateBounceRungOrder(
    tokenId: TokenId,
    bounceRung: BounceRungMetadata,
  ): Order | null {
    if (!this.deps.orderRepo) return null;
    const targetIndices = new Set<number>(
      bounceRung.rungIndicesCovered && bounceRung.rungIndicesCovered.length > 0
        ? bounceRung.rungIndicesCovered
        : [bounceRung.rungIndex],
    );
    const orders = this.deps.orderRepo.findByTokenId(tokenId);
    return (
      orders.find((order) => {
        if (order.side !== "sell") return false;
        if (order.decisionRuleId !== BOUNCE_EXIT_TARGET_RULE_ID) return false;
        if (order.status === "cancelled" || order.status === "rejected") return false;
        const existingRung = order.metadata?.bounceRung as
          | {
              ladderId?: string;
              rungIndex?: number;
              rungIndicesCovered?: number[];
              isCleanupRung?: boolean;
            }
          | undefined;
        if (!existingRung || existingRung.ladderId !== bounceRung.ladderId) return false;
        // Codex C2 fix: a cleanup rung deliberately reuses the LAST
        // configured rung's own index (docs/plans/2026-07-19-sellable-
        // sizing-bounce-for-all.md, Phase 3), which the ordinary ladder
        // already marks "placed" — matching by index would make the
        // duplicate check always collide with that earlier, unrelated
        // order and the cleanup rung would never place. A cleanup rung is
        // only a duplicate of ANOTHER already-resting cleanup rung, which
        // still enforces "only one cleanup rung open at a time".
        // Codex r2 fix: only a still-OPEN cleanup rung is a duplicate. A
        // TERMINAL (filled) cleanup can carry a within-tolerance shortfall
        // leaving a real >=min residual; the planner must be able to emit a
        // fresh cleanup for it rather than have the bridge suppress it as a
        // "duplicate" of the filled one and strand the residual.
        if (bounceRung.isCleanupRung === true) {
          return existingRung.isCleanupRung === true && isOpenOrderStatus(order.status);
        }
        const existingIndices = Array.isArray(existingRung.rungIndicesCovered)
          ? existingRung.rungIndicesCovered
          : typeof existingRung.rungIndex === "number"
            ? [existingRung.rungIndex]
            : [];
        return existingIndices.some((idx) => targetIndices.has(idx));
      }) ?? null
    );
  }

  private recordPricingMetrics(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    executionTerms: Extract<ExecutionTermsResolution, { kind: "ok" }>,
  ): void {
    try {
      const capturedAt = new Date(this.now()).toISOString();
      this.deps.runtimeMetrics?.writeCounter(
        "order_priced_mode_total",
        1,
        JSON.stringify({ mode: executionTerms.pricedMode, side: signal.side }),
      );
      if (executionTerms.pricedMode === "taker") {
        this.deps.runtimeMetrics?.writeCounter(
          "taker_decision_total",
          1,
          JSON.stringify({ side: signal.side, spread_ticks: executionTerms.spreadTicks ?? null }),
        );
        this.deps.runtimeMetrics?.writeCounter(
          "taker_attempt_total",
          1,
          JSON.stringify({ side: signal.side, mode: "success" }),
        );
        const day = capturedAt.slice(0, 10);
        if (this.lastTakerInfoLogDay !== day) {
          this.lastTakerInfoLogDay = day;
          this.log.info(
            {
              signalId: signal.signalId,
              tokenId: String(signal.tokenId),
              side: signal.side,
              spreadTicks: executionTerms.spreadTicks ?? null,
              executionPrice: executionTerms.price,
            },
            "opportunistic taker pricing selected",
          );
        }
      }
      if (executionTerms.pricedMode === "bid-anchored") {
        this.deps.runtimeMetrics?.writeCounter(
          "bid_anchored_decision_total",
          1,
          JSON.stringify({
            side: signal.side,
            anchor_ticks_used: executionTerms.anchorTicksUsed ?? null,
          }),
        );
      }
      if (executionTerms.d4EffectiveTickFloor != null) {
        this.deps.runtimeMetrics?.writeCounter(
          "d4_effective_tick_floor_applied_total",
          1,
          JSON.stringify({
            side: signal.side,
            from_tick_size: executionTerms.d4EffectiveTickFloor.fromTickSize,
            to_tick_size: executionTerms.d4EffectiveTickFloor.toTickSize,
          }),
        );
      }
      if (signal.side === "sell" && executionTerms.exitAnchorMode) {
        this.deps.runtimeMetrics?.writeCounter(
          "exit_anchor_mode_total",
          1,
          JSON.stringify({ mode: executionTerms.exitAnchorMode }),
        );
      }
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "failed to record pricing metrics",
      );
    }
  }

  private recordTakerAtProfitMetric(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    mode: "evaluated" | "activated" | "blocked",
    reason: string | null,
    details: Record<string, unknown> = {},
  ): void {
    try {
      const metricName =
        mode === "evaluated"
          ? "taker_at_profit_evaluated_total"
          : mode === "activated"
            ? "taker_at_profit_activated_total"
            : "taker_at_profit_blocked_total";
      this.deps.runtimeMetrics?.writeCounter(
        metricName,
        1,
        JSON.stringify({
          side: signal.side,
          rule: signal.decisionRuleId ?? null,
          reason,
          ...details,
        }),
      );
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "failed to record taker-at-profit metric",
      );
    }
  }

  private recordTrackRFeeSourceMetric(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    source: TrackRFeeRateSource,
  ): void {
    const suffix =
      source === "fallback_universal"
        ? "fallback_universal"
        : source === "fallback_category"
          ? "fallback_category"
          : source;
    this.recordTrackRMetric(signal, `track_r_fee_rate_source_${suffix}`, {});
  }

  private recordTrackRMetric(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    name: string,
    details: Record<string, unknown>,
  ): void {
    try {
      this.deps.runtimeMetrics?.writeCounter(
        name,
        1,
        JSON.stringify({
          side: signal.side,
          rule: signal.decisionRuleId ?? null,
          ...details,
        }),
      );
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId), metric: name },
        "failed to record Track R metric",
      );
    }
  }

  private recordTrackRBlockedDepth(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    details: Record<string, unknown>,
  ): void {
    this.recordTrackRMetric(signal, "track_r_taker_at_profit_blocked_depth", details);
  }

  private recordTrackRBlockedMargin(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    details: Record<string, unknown>,
  ): void {
    this.recordTrackRMetric(signal, "track_r_taker_at_profit_blocked_margin", details);
  }

  // Track S5 P1 — hourly partial-exit cap. Counts placements within the trailing
  // window and blocks once the per-token budget is reached.
  private isPartialFrequencyLimited(tokenId: TokenId, nowMs: number, maxPerHour: number): boolean {
    const history = this.partialHistoryByToken.get(String(tokenId));
    if (!history) return false;
    const recent = history.filter((t) => nowMs - t < PARTIAL_EXIT_WINDOW_MS).length;
    return recent >= maxPerHour;
  }

  private recordPartialPlacement(tokenId: TokenId, nowMs: number): void {
    const key = String(tokenId);
    const recent = (this.partialHistoryByToken.get(key) ?? []).filter(
      (t) => nowMs - t < PARTIAL_EXIT_WINDOW_MS,
    );
    recent.push(nowMs);
    this.partialHistoryByToken.set(key, recent);
  }

  // Track S5 P1 (BLOCKER 2) — charge the hourly frequency budget and emit the
  // `track_r_partial_exit_taken` outcome counter only when a partial exit has
  // cleared every late gate (order size, duplicate open sell, order-lifetime,
  // same-price cooldown) and is about to be published. Accounting at resolve
  // time over-counts partials that a late gate later cancels, starving the
  // budget on orders that never reach the exchange.
  private recordPartialPlacementOnSend(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    executionTerms: ExecutionTermsResolution,
    nowMs: number,
  ): void {
    if (executionTerms.kind !== "ok" || executionTerms.size == null) return;
    const taker = executionTerms.takerAtProfit;
    const effectiveFillPrice = taker?.effectiveFillPrice ?? null;
    const avgEntry = taker?.avgEntry ?? null;
    this.recordPartialPlacement(signal.tokenId, nowMs);
    this.recordTrackRMetric(signal, "track_r_partial_exit_taken", {
      tier: partialExitMarginTierLabel(
        effectiveFillPrice != null && avgEntry != null && avgEntry > 0
          ? effectiveFillPrice / avgEntry
          : null,
      ),
      size: executionTerms.size,
      liquidity_available: taker?.liquidityAvailable ?? null,
    });
  }

  private recordTrackRThresholdSample(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    input: {
      effectiveFillPrice: number;
      avgEntry: number;
      minGrossExitRatio: number;
      feeQuote: TrackRFeeQuote;
      mode: "gate" | "invariant";
    },
  ): void {
    this.recordTrackRMetric(signal, "track_r_margin_threshold_sampled_total", {
      mode: input.mode,
      fee_source: input.feeQuote.source,
    });
  }

  private recordTrackS3Evaluation(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    decision: AppliedTrackS3SpreadDecision,
  ): void {
    this.recordTrackS3Metric(signal, "track_s3_tier_breakdown", decision.tier);
    if (decision.dynamicCapUsed) {
      this.recordTrackS3Metric(signal, "track_s3_dynamic_cap_used", decision.tier);
    }
    if (decision.behaviorChanged) {
      this.recordTrackS3Metric(
        signal,
        "track_s3_taker_at_profit_allowed_wide_spread",
        decision.tier,
      );
    }
  }

  private recordTrackS3StillBlocked(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    decision: AppliedTrackS3SpreadDecision,
  ): void {
    this.recordTrackS3Metric(
      signal,
      "track_s3_taker_at_profit_still_blocked_spread",
      decision.tier,
    );
  }

  private recordTrackS3Metric(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    name: string,
    tier: string,
  ): void {
    try {
      this.deps.runtimeMetrics?.writeCounter(
        name,
        1,
        JSON.stringify({ side: signal.side, rule: signal.decisionRuleId ?? null, tier }),
      );
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId), metric: name },
        "failed to record Track S3 metric",
      );
    }
  }

  private recordTrackS3DynamicCapApplied(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    input: TrackS3RiskEventInput,
  ): void {
    if (input.decision.margin + 1e-12 < 1.5) return;
    try {
      this.deps.riskEventRepo?.insert({
        eventType: "s3_dynamic_cap_applied",
        payload: {
          tokenId: String(signal.tokenId),
          conditionId: String(signal.conditionId),
          slug: market.slug,
          question: market.question,
          decisionRuleId: signal.decisionRuleId ?? null,
          avgEntryPrice: input.avgEntry,
          effectiveFillPrice: input.effectiveFillPrice,
          margin: input.decision.margin,
          bestBid: input.bestBid,
          bestAsk: input.bestAsk,
          spreadTicks: input.spreadTicks,
          baseCap: input.decision.baseCap,
          allowedCap: input.decision.allowedCap,
          tier: input.decision.tier,
          behaviorChanged: input.decision.behaviorChanged,
          timestamp: new Date(this.now()).toISOString(),
        },
      });
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "failed to write Track S3 dynamic cap event",
      );
    }
  }

  private recordTakerAtProfitActivation(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    market: NormalizedMarket,
    executionTerms: Extract<ExecutionTermsResolution, { kind: "ok" }>,
    policy: ExecutionPolicy,
  ): void {
    if (signal.side !== "sell" || executionTerms.takerAtProfit == null) return;
    const cfg = this.getTakerAtProfitPolicy(policy);
    const payload = {
      tokenId: String(signal.tokenId),
      conditionId: String(signal.conditionId),
      slug: market.slug,
      question: market.question,
      decisionRuleId: signal.decisionRuleId ?? null,
      signalReason: signal.reason,
      price: executionTerms.price,
      postOnly: executionTerms.postOnly ?? null,
      avgEntryPrice: executionTerms.takerAtProfit.avgEntry,
      bestBid: executionTerms.takerAtProfit.bestBid,
      bestAsk: market.bestAsk ?? null,
      spreadTicks: executionTerms.takerAtProfit.spreadTicks,
      minGrossExitRatio: executionTerms.takerAtProfit.minGrossExitRatio,
      effectiveFillPrice: executionTerms.takerAtProfit.effectiveFillPrice,
      worstFillPrice: executionTerms.takerAtProfit.worstFillPrice,
      liquidityAvailable: executionTerms.takerAtProfit.liquidityAvailable,
      targetSize: executionTerms.takerAtProfit.targetSize,
      depthExhausted: executionTerms.takerAtProfit.depthExhausted,
      feeRate: executionTerms.takerAtProfit.feeRate,
      feeExponent: executionTerms.takerAtProfit.feeExponent,
      feeSource: executionTerms.takerAtProfit.feeSource,
      trackS3Margin: executionTerms.takerAtProfit.trackS3Margin,
      trackS3BaseSpreadTicks: executionTerms.takerAtProfit.trackS3BaseSpreadTicks,
      trackS3AllowedSpreadTicks: executionTerms.takerAtProfit.trackS3AllowedSpreadTicks,
      trackS3Tier: executionTerms.takerAtProfit.trackS3Tier,
      trackS3DynamicCapUsed: executionTerms.takerAtProfit.trackS3DynamicCapUsed,
      trackS3BehaviorChanged: executionTerms.takerAtProfit.trackS3BehaviorChanged,
      maxSpreadTicks: cfg.maxSpreadTicks,
      timestamp: new Date(this.now()).toISOString(),
    };
    this.recordTakerAtProfitMetric(signal, "activated", null, {
      spread_ticks: executionTerms.takerAtProfit.spreadTicks,
      min_gross_exit_ratio: executionTerms.takerAtProfit.minGrossExitRatio,
      effective_fill_price: executionTerms.takerAtProfit.effectiveFillPrice,
      fee_source: executionTerms.takerAtProfit.feeSource,
    });
    try {
      this.deps.riskEventRepo?.insert({
        eventType: "taker_at_profit_activated",
        payload,
      });
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "failed to write taker-at-profit risk event",
      );
    }
  }

  private recordTakerMinSizeDisabledMetric(
    signal: RuntimeEventMap["SignalApproved"]["signal"],
    block: TakerMinSizeBlock,
  ): void {
    try {
      const labels = {
        side: signal.side,
        token_id: String(signal.tokenId),
        reason: block.reason,
        market_min_order_size: block.marketMinOrderSize,
        min_notional_usdc: block.minNotionalUsdc,
        requested_size_shares: block.requestedSizeShares,
        requested_size_usdc: block.notionalUsdc,
        required_size_shares:
          block.marketMinOrderSize === null ? null : block.marketMinOrderSize * block.safetyBuffer,
        required_notional_usdc:
          block.minNotionalUsdc === null ? null : block.minNotionalUsdc * block.safetyBuffer,
        safety_buffer: block.safetyBuffer,
      };
      this.deps.runtimeMetrics?.writeCounter(
        "taker_disabled_min_size_total",
        1,
        JSON.stringify(labels),
      );
      this.deps.runtimeMetrics?.writeCounter(
        "taker_attempt_total",
        1,
        JSON.stringify({ side: signal.side, mode: "rejected", reason: "min_size" }),
      );
      this.deps.runtimeMetrics?.writeCounter(
        "taker_disabled_fraction_over_threshold",
        1,
        JSON.stringify({ side: signal.side, bucket: takerFractionBucket(block) }),
      );
    } catch (err) {
      this.log.debug(
        { err, signalId: signal.signalId, tokenId: String(signal.tokenId) },
        "failed to record taker min-size metric",
      );
    }
  }
}

function canUseBaseMarketForPricing(market: NormalizedMarket): boolean {
  return market.bookSource === "clob" || market.bookSource === "simulation";
}

function takerFractionBucket(
  block: TakerMinSizeBlock,
): "0-0.5" | "0.5-0.8" | "0.8-0.95" | "0.95-1.0" {
  const requiredShares =
    block.marketMinOrderSize === null ? null : block.marketMinOrderSize * block.safetyBuffer;
  const requiredNotional =
    block.minNotionalUsdc === null ? null : block.minNotionalUsdc * block.safetyBuffer;
  const fraction =
    block.reason === "share_min_size" && requiredShares !== null && requiredShares > 0
      ? block.requestedSizeShares / requiredShares
      : block.reason === "notional_min_size" && requiredNotional !== null && requiredNotional > 0
        ? block.notionalUsdc / requiredNotional
        : 0;
  if (fraction < 0.5) return "0-0.5";
  if (fraction < 0.8) return "0.5-0.8";
  if (fraction < 0.95) return "0.8-0.95";
  return "0.95-1.0";
}

/**
 * Resolves SELL price using an ask-side midpoint anchor.
 *
 * EXIT-FIX-2 keeps the midpoint+N tick floor but undercuts the visible ask when doing so
 * stays passive and above that floor. This matches the 2026-05-22 Plankton evidence:
 * low-entry high-multiple exits are predominantly maker-like and fill near best ask.
 *
 * Returns null if bestBid, tickSize, or anchorTicks are unavailable or non-positive.
 * Missing bestAsk falls back to a one-sided bestBid+N tick anchor.
 */
export function resolveMidpointAnchoredSellPrice(
  bestBid: number | null,
  bestAsk: number | null,
  tickSize: number,
  anchorTicks: number,
): number | null {
  return (
    resolveMidpointAnchoredSellPriceWithMode(bestBid, bestAsk, tickSize, anchorTicks)?.price ?? null
  );
}

type ExitAnchorMode = "midpoint" | "ask_undercut" | "ask_fallback";

function resolveMidpointAnchoredSellPriceWithMode(
  bestBid: number | null,
  bestAsk: number | null,
  tickSize: number,
  anchorTicks: number,
): { price: number; anchorMode: ExitAnchorMode } | null {
  if (
    bestBid == null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(tickSize) ||
    !Number.isFinite(anchorTicks) ||
    bestBid <= 0 ||
    tickSize <= 0
  ) {
    return null;
  }

  const hasValidAsk = bestAsk != null && Number.isFinite(bestAsk) && bestAsk > 0;
  const midpoint = hasValidAsk ? (bestBid + bestAsk) / 2 : bestBid;
  const base = floorToTick(midpoint + anchorTicks * tickSize, tickSize);
  if (!hasValidAsk || bestAsk <= midpoint) {
    return { price: base, anchorMode: "midpoint" };
  }

  const askUnder = floorToTick(bestAsk - tickSize, tickSize);
  if (askUnder <= bestBid) {
    return { price: floorToTick(bestAsk, tickSize), anchorMode: "ask_fallback" };
  }
  if (askUnder >= base) {
    return { price: askUnder, anchorMode: "ask_undercut" };
  }
  return { price: base, anchorMode: "midpoint" };
}

/**
 * Track P F2 — caps a computed SELL price to the lower of the Plankton tier
 * target (avgEntry * markup) and the 0.97 ceiling, floored to a valid tick.
 *
 * When the computed price is already at/below the cap the original price is
 * returned unchanged (existing anchored pricing preserved). When avgEntry is
 * unknown only the ceiling applies. A cap that would floor below one tick is
 * ignored so the function can never produce a non-executable price.
 */
/** Raw Plankton sell-price cap (pre tick-flooring): min(ceiling, avgEntry × markupCap). */
export function resolvePlanktonSellCap(avgEntry: number | null): number {
  let cap = SELL_PRICE_CEILING;
  if (avgEntry != null && Number.isFinite(avgEntry) && avgEntry > 0) {
    cap = Math.min(cap, avgEntry * planktonAlignedMarkupCap(avgEntry));
  }
  return cap;
}

/** Bounded-cardinality tier label for Track S5 P0b cap-skip telemetry. */
function planktonMarkupTierLabel(avgEntry: number | null): string {
  if (avgEntry == null || !Number.isFinite(avgEntry) || avgEntry <= 0) return "ceiling";
  return `markup_${planktonAlignedMarkupCap(avgEntry)}`;
}

export function capSellPriceToPlanktonTier(
  price: number,
  avgEntry: number | null,
  tickSize: number,
): number {
  const cap = resolvePlanktonSellCap(avgEntry);
  if (!Number.isFinite(price) || price <= cap) return price;
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  const cappedTick = floorToTick(cap, tickSize);
  if (cappedTick < tickSize) return price;
  return cappedTick;
}

interface EffectiveOrderTickSize {
  readonly tickSize: number;
  readonly fromTickSize: number;
  readonly floorApplied: boolean;
}

function resolveEffectiveOrderTickSize(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  market: NormalizedMarket,
): EffectiveOrderTickSize {
  const rawTickSize = market.tickSize;
  if (signal.decisionRuleId !== D4_RULE_ID) {
    return { tickSize: rawTickSize, fromTickSize: rawTickSize, floorApplied: false };
  }

  const normalizedTickSize = normalizeTickSize(rawTickSize);
  const tickSize = Math.max(normalizedTickSize, D4_MIN_EFFECTIVE_TICK_SIZE);
  return {
    tickSize,
    fromTickSize: rawTickSize,
    floorApplied: tickSize !== rawTickSize,
  };
}

function resolvePricingTickSize(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  market: NormalizedMarket,
  effectiveTickSize: number,
): number {
  if (
    signal.decisionRuleId === D4_RULE_ID &&
    (!Number.isFinite(market.tickSize) || market.tickSize <= 0 || market.tickSize >= 1)
  ) {
    return effectiveTickSize;
  }
  return market.tickSize;
}

function normalizeExecutionTerms(
  resolution: ExecutionTermsResolution,
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  effectiveTick: EffectiveOrderTickSize,
): ExecutionTermsResolution {
  if (resolution.kind !== "ok") return resolution;
  if (signal.decisionRuleId !== D4_RULE_ID) {
    return { ...resolution, tickSize: effectiveTick.tickSize };
  }

  const originalValidation = validateExecutablePrice(resolution.price, effectiveTick.tickSize);
  if (resolution.pricedMode === "taker" && !originalValidation.ok) {
    return {
      kind: "invalid",
      price: resolution.price,
      tickSize: originalValidation.tickSize,
      minPrice: originalValidation.minPrice,
      maxPrice: originalValidation.maxPrice,
      validationReason: originalValidation.reason,
    };
  }

  const price = clampExecutablePrice(resolution.price, effectiveTick.tickSize, signal.side);
  const validation = validateExecutablePrice(price, effectiveTick.tickSize);
  if (!validation.ok) {
    return {
      kind: "invalid",
      price,
      tickSize: validation.tickSize,
      minPrice: validation.minPrice,
      maxPrice: validation.maxPrice,
      validationReason: validation.reason,
    };
  }

  return {
    ...resolution,
    price,
    tickSize: effectiveTick.tickSize,
    ...(effectiveTick.floorApplied
      ? {
          d4EffectiveTickFloor: {
            fromTickSize: effectiveTick.fromTickSize,
            toTickSize: effectiveTick.tickSize,
          },
        }
      : {}),
  };
}

function resolveOrderSize(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  executionPrice: number,
): number {
  if (signal.side !== "buy") return signal.suggestedSize;
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return signal.suggestedSize;
  return signal.suggestedSizeUsdc / executionPrice;
}

/**
 * Ladder min-order rollover (docs/plans/2026-07-16-bounce-exit-ladder-redesign.md):
 * a single rung's own fraction of the original position can fall below the
 * exchange's minimum tradable size (this is expected — `microMaxOrderUsdc`
 * caps the whole position at a few dollars, split across up to 3 rungs). Full-
 * position clamping would defeat the point of a ladder, and skipping the rung
 * entirely would silently strand size. Instead, merge this rung forward with
 * however many of the NEXT rungs' fractions are needed to clear the minimum,
 * place one order at the current (lowest reachable) rung's price, and mark
 * every absorbed index as placed via `rungIndicesCovered` so the next
 * planning cycle resumes at the rung after the last one covered. Returns null
 * when no forward combination clears the minimum (exhausted the ladder) —
 * callers fall through to the existing generic below-minimum skip.
 *
 * Fractions are computed against `originalPositionSize` (fixed at first
 * entry, Codex Phase-2 fix — see decision-planner.ts) so a merge of several
 * rungs' fractions still reflects their true share of the position; the
 * merged size is then capped to `oversellCeiling` so the roll-forward never
 * oversells beyond what is actually still available to sell. The caller
 * passes the fill-aware `uncommittedRemainder` here when sellableFlow is on
 * (Codex H4 fix), and the leg-level `remainingPositionSize` otherwise —
 * this function itself is agnostic to which basis it received.
 */
function resolveBounceRungRollover(
  bounceRung: BounceRungMetadata,
  originalPositionSize: number,
  oversellCeiling: number,
  ladderFractions: readonly number[],
  minOrderSize: number | null | undefined,
): { size: number; metadata: BounceRungMetadata } | null {
  if (!(originalPositionSize > 0) || !(oversellCeiling > 0)) return null;
  let cumulativeFraction = 0;
  const rungIndicesCovered: number[] = [];
  for (let idx = bounceRung.rungIndex; idx < ladderFractions.length; idx++) {
    cumulativeFraction += ladderFractions[idx] ?? 0;
    rungIndicesCovered.push(idx);
    const mergedSize = Math.min(cumulativeFraction * originalPositionSize, oversellCeiling);
    if (isExecutableOrderSize(mergedSize, minOrderSize)) {
      return {
        size: mergedSize,
        metadata: { ...bounceRung, fraction: cumulativeFraction, rungIndicesCovered },
      };
    }
  }
  return null;
}

function resolveShadowExecutionPrice(executionTerms: ExecutionTermsResolution): number | null {
  if (executionTerms.kind === "ok" || executionTerms.kind === "invalid") {
    return finitePositiveOrNull(executionTerms.price);
  }
  return null;
}

function resolveShadowExitAnchorMode(executionTerms: ExecutionTermsResolution): string | null {
  if (executionTerms.kind !== "ok") return null;
  return executionTerms.exitAnchorMode ?? executionTerms.pricedMode;
}

function finitePositiveOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

// Track S5 P1 — bounded-cardinality label for the partial fill VWAP relative to
// the average entry. Telemetry only (segments `track_r_partial_exit_taken`); no
// behavior depends on it, so the exact boundaries are observational.
function partialExitMarginTierLabel(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return "unknown";
  if (ratio < 1.0) return "below_entry";
  if (ratio < 1.05) return "flat";
  if (ratio < 1.2) return "profit";
  return "high_profit";
}

function computePositiveRatio(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null) return null;
  return numerator / denominator;
}

function isTakerAtProfitRuleAllowed(
  signal: RuntimeEventMap["SignalApproved"]["signal"],
  rules: ExecutionPolicy["takerAtProfit"]["rules"],
): boolean {
  const reason = String(signal.reason);
  const rule = signal.decisionRuleId ?? "";
  if (isDustOrRedeemLike(reason) || isDustOrRedeemLike(rule)) return false;
  if (rules === "all-sell") return true;
  return rule.length > 0 && rules.includes(rule);
}

function isDustOrRedeemLike(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("dust") || normalized.includes("redeem");
}

function isOpenOrderStatus(status: Order["status"]): boolean {
  return status === "pending" || status === "open" || status === "partially-filled";
}

interface TakerMinSizeBlock {
  reason: "share_min_size" | "notional_min_size";
  marketMinOrderSize: number | null;
  minNotionalUsdc: number | null;
  notionalUsdc: number;
  safetyBuffer: number;
  // Track S5 P1 (LOW 1) — the share size the gate actually scored: the partial
  // override when present, else the signal's full suggested size. Forensics and
  // the fraction bucket must reflect this, not always `signal.suggestedSize`.
  requestedSizeShares: number;
}

interface TakerAtProfitExecution {
  avgEntry: number;
  bestBid: number;
  minGrossExitRatio: number;
  spreadTicks: number;
  effectiveFillPrice?: number | null;
  worstFillPrice?: number | null;
  liquidityAvailable?: number | null;
  targetSize?: number | null;
  depthExhausted?: boolean | null;
  feeRate?: number | null;
  feeExponent?: number | null;
  feeSource?: TrackRFeeRateSource | null;
  trackS3Margin?: number | null;
  trackS3BaseSpreadTicks?: number | null;
  trackS3AllowedSpreadTicks?: number | null;
  trackS3Tier?: string | null;
  trackS3DynamicCapUsed?: boolean | null;
  trackS3BehaviorChanged?: boolean | null;
}

type TrackS3SpreadDecision =
  | { applies: false; staticMaxSpreadTicks: number | null }
  | {
      applies: true;
      staticMaxSpreadTicks: null;
      margin: number;
      baseCap: number;
      allowedCap: number;
      tier: string;
      dynamicCapUsed: boolean;
      behaviorChanged: boolean;
    };

type AppliedTrackS3SpreadDecision = Extract<TrackS3SpreadDecision, { applies: true }>;

interface TrackS3RiskEventInput {
  avgEntry: number;
  bestBid: number;
  bestAsk: number;
  spreadTicks: number;
  effectiveFillPrice: number;
  decision: AppliedTrackS3SpreadDecision;
}

interface SellPricingShadow {
  avgEntry: number | null;
  avgEntrySource: SellShadowAvgEntrySource;
  signalPrice: number | null;
  executionPrice: number | null;
  executionVsSignalRatio: number | null;
  executionVsAvgEntryRatio: number | null;
  cap5Violation: boolean | null;
  cap10Violation: boolean | null;
  exitPricingMode: ExecutionPolicy["exitPricingMode"];
  exitAnchorMode: string | null;
}

type ExecutionTermsResolution =
  | {
      kind: "ok";
      price: number;
      tickSize: number;
      postOnly?: boolean;
      pricedMode: OrderPricedMode;
      // Track S5 P1 — partial-exit size override. When set, the order fills only
      // the available top-of-book liquidity instead of the full position size,
      // and the command is keyed with a slot-bucketed partial clientOrderId.
      size?: number;
      spreadTicks?: number;
      anchorTicksUsed?: number;
      exitAnchorMode?: ExitAnchorMode;
      pricingDiagnostics?: BoundedMidpointDiagnostics;
      pricingShadow?: BoundedMidpointDiagnostics;
      d4EffectiveTickFloor?: { fromTickSize: number; toTickSize: number };
      takerAtProfit?: TakerAtProfitExecution;
    }
  | { kind: "unavailable" }
  | {
      kind: "invalid";
      price: number;
      tickSize: number;
      minPrice: number;
      maxPrice: number;
      validationReason: ExecutablePriceValidationFailureReason;
    }
  | { kind: "skip-wide-spread"; diagnostics: BoundedMidpointDiagnostics }
  | { kind: "skip-one-sided"; diagnostics: BoundedMidpointDiagnostics };

type OrderPricedMode =
  | "edge"
  | "bid-anchored"
  | "midpoint-anchored"
  | "bounded-midpoint"
  | "taker"
  | "ladder"
  | "bounce-exit-target";

export type DeadSideBucket = "<0" | "<1m" | "1-5m" | "5-15m" | "15-60m" | "1-4h" | ">4h";

export interface DeadSideCanary {
  bestBid: number | null;
  bestAsk: number | null;
  endDate: string;
  timeToEndMs: number;
  secondsToEnd: number;
  bucket: DeadSideBucket;
  shadowHits: {
    x60_000: boolean;
    x120_000: boolean;
    x300_000: boolean;
    x900_000: boolean;
  };
  askCeiling: number;
  enforceX: number;
  /** Alias of enforceX preserved for existing log consumers. */
  xMs: number;
  enforceHit: boolean;
  guardMode: DeadSideGuardMode;
}

/**
 * Collapse an ExecutionTermsResolution into the fields the observation row
 * needs: selectedPrice (null when no price was chosen), pricing diagnostics
 * (bounded-midpoint details when available), and `boundedOutcome` bucket.
 *
 * `ok` → selectedPrice + diagnostics (live pricing or shadow); outcome derived
 *        from diagnostics (ok/edge-fallback/not-computed).
 * `invalid` → selectedPrice = the rejected price; outcome = "invalid".
 * `unavailable` → selectedPrice = null; outcome = "not-computed".
 * `skip-*` → selectedPrice = null; diagnostics from bounded-midpoint resolver;
 *            outcome = "skip".
 */
function summarizeExecutionTerms(
  terms: ExecutionTermsResolution,
  mode: ExecutionPolicy["pricing"]["mode"],
): {
  selectedPrice: number | null;
  diagnostics: BoundedMidpointDiagnostics | null;
  boundedOutcome: ExecutionPolicyObservation["boundedOutcome"];
} {
  if (terms.kind === "ok") {
    const diagnostics = terms.pricingDiagnostics ?? terms.pricingShadow ?? null;
    return {
      selectedPrice: terms.price,
      diagnostics,
      boundedOutcome: deriveOkBoundedOutcome(mode, diagnostics),
    };
  }
  if (terms.kind === "invalid") {
    return { selectedPrice: terms.price, diagnostics: null, boundedOutcome: "invalid" };
  }
  if (terms.kind === "skip-wide-spread" || terms.kind === "skip-one-sided") {
    return { selectedPrice: null, diagnostics: terms.diagnostics, boundedOutcome: "skip" };
  }
  return { selectedPrice: null, diagnostics: null, boundedOutcome: "not-computed" };
}

function deriveOkBoundedOutcome(
  _mode: ExecutionPolicy["pricing"]["mode"],
  diagnostics: BoundedMidpointDiagnostics | null,
): ExecutionPolicyObservation["boundedOutcome"] {
  if (!diagnostics) return "not-computed";
  if (diagnostics.finalPrice == null) return "skip";
  if (diagnostics.improvementTicks != null && Math.abs(diagnostics.improvementTicks) >= 1 - 1e-9) {
    return "ok";
  }
  return "edge-fallback";
}

function shouldSkipSellBelowSignalFloor(
  signalPrice: number,
  executionPrice: number,
  minRatio: number,
): boolean {
  if (!Number.isFinite(minRatio) || minRatio <= 0) return false;
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return false;
  if (!Number.isFinite(executionPrice) || executionPrice <= 0) return false;
  return executionPrice < signalPrice * minRatio;
}

function bucketForTimeToEndMs(timeToEndMs: number): DeadSideBucket {
  if (timeToEndMs < 0) return "<0";
  if (timeToEndMs <= 60_000) return "<1m";
  if (timeToEndMs <= 5 * 60_000) return "1-5m";
  if (timeToEndMs <= 15 * 60_000) return "5-15m";
  if (timeToEndMs <= 60 * 60_000) return "15-60m";
  if (timeToEndMs <= 4 * 60 * 60_000) return "1-4h";
  return ">4h";
}
