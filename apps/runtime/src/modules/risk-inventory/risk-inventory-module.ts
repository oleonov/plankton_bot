/**
 * Risk + Inventory Module — the gating and inventory state tracker.
 *
 * Subscribes to:
 *  - SignalProduced → evaluate via RiskGate → publish SignalApproved / SignalRejected
 *  - FillReceived → apply to inventory → publish PositionUpdated
 *  - NormalizedMarketUpdated → mark-to-market revaluation of open positions
 *
 * Does NOT:
 *  - place/cancel orders (execution's job)
 *  - decide what trades to make (strategy's job)
 *  - reconcile with exchange (reconciliation's job)
 *  - dedup signals (algo-decision-module's pendingEntries map does this)
 */

import type Database from "better-sqlite3";
import { parseLedgerInstantMs, withImmediate } from "@krabs/db";
import { performance } from "node:perf_hooks";
import type {
  RuntimeModule,
  EventBus,
  PositionRepository,
  InventoryLotRepository,
  OrderRepository,
  FillRepository,
  RuntimeEventMap,
  ProfileId,
  ClientOrderId,
  RuntimeControl,
  ExecutionPolicy,
  MarketRepository,
  Position,
  TokenId,
} from "@krabs/domain";
import {
  DEFAULT_EXECUTION_POLICY,
  SignalReason,
  canPlaceBuyOrderForMarket,
  evaluateD3NearDeathGuard,
  evaluatePostSellBuybackGuard,
  recordStageDuration,
  roundToTick,
  isGateWhitelisted,
  BOUNCE_EXIT_TARGET_RULE_ID,
  GATE_ENTRY_RULE_ID,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { findActivePositionRows } from "../../active-positions.js";
import { resolveDustPromotion } from "../../open-position-conflict.js";
import { resolveOpenPositionStatus } from "../../position-status.js";
import { normalizeReasonCode } from "../../risk-event-codes.js";
import { AlgoRiskGateImpl } from "./algo-risk-gate.js";
import { InventoryHandler } from "./inventory-handler.js";
import { resolveNewPositionExitOwner } from "../exit-ownership/resolve-new-position-exit-owner.js";
import type { MarketResolutionTracker } from "../resolution/market-resolution-tracker.js";
import {
  PER_TOKEN_SELL_LIMIT_REASON,
  type OrderCapacityMetricsSample,
  type WalletBudgetControlDb,
} from "../../wallet-buy-budget.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import { countActiveOpenMarkets } from "../../exposure-calculator.js";
import {
  priceToX10000,
  SAME_PRICE_COOLDOWN_REASON,
} from "../same-price-cooldown/same-price-cooldown-module.js";
import type { CooldownRegistry } from "../same-price-cooldown/cooldown-registry.js";
import type { SignalPathTelemetry } from "../strategy/signal-path-telemetry.js";
import type { EffectiveResolutionGate } from "../../effective-resolution-service.js";
import type { ExecutionProfileStateRecord } from "../execution-profile/types.js";
import type { PositionConcentrationService } from "../../position-concentration-service.js";
import type { TimerRegistry } from "../../periodic-timers.js";
import type { StrandedFillAlertEmitter } from "../../stranded-fill-alert.js";

const EXECUTION_PROFILE_SCALE_IN_RULE_ID = "EXECUTION_PROFILE_SCALE_IN";
const LIVE_LITE_ACTIVE_MARKETS_CAP_FULL_REASON = "live_lite_active_markets_cap_full";

type SellCoverageInputs = {
  suggestedSize: RuntimeEventMap["SignalProduced"]["signal"]["suggestedSize"];
  suggestedPrice: RuntimeEventMap["SignalProduced"]["signal"]["suggestedPrice"];
  positionId: RuntimeEventMap["SignalProduced"]["signal"]["positionId"];
  bounceRung: RuntimeEventMap["SignalProduced"]["signal"]["bounceRung"];
  signalMarketMinOrderSize: RuntimeEventMap["SignalProduced"]["market"]["minOrderSize"];
  riskMinOrderSizeAtEvaluation: number | null;
};

export interface RiskInventoryModuleDeps {
  tokenMinimum?: import("@krabs/domain").TokenMinimumSource | undefined;
  bus: EventBus;
  positionRepo: PositionRepository;
  inventoryLotRepo: InventoryLotRepository;
  orderRepo: OrderRepository;
  marketRepo?: Pick<MarketRepository, "findByTokenId"> | undefined;
  fillRepo: Pick<FillRepository, "findUnreconciled" | "claimForReconciliation"> &
    Partial<Pick<FillRepository, "findByOrderId" | "findByOrderIds">>;
  log: Logger;
  db: Database.Database;
  liveLiteGuard?: LiveLiteGuard | undefined;
  controlDb?: WalletBudgetControlDb | undefined;
  activeProfile?: ProfileId | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
  executionPolicy?: (() => ExecutionPolicy) | undefined;
  capacityMetricsSink?: ((sample: OrderCapacityMetricsSample) => void) | undefined;
  profileOwnedOpenPositionCount?: (() => number) | undefined;
  profileStateReader?: Pick<
    import("../execution-profile/types.js").ExecutionProfileStateRepository,
    "getState"
  >;
  redeemInFlightGuard?: ((conditionId: string) => boolean) | undefined;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  runtimeControl?: RuntimeControl | undefined;
  cooldownRegistry?: CooldownRegistry | undefined;
  signalPathTelemetry?: SignalPathTelemetry | undefined;
  rejectionLogCooldownMs?: number | undefined;
  /**
   * Optional fail-closed BUY-side guard. When supplied, BUYs are pre-screened
   * against `canPlaceBuyOrder(market)` and `resolutionTracker.isResolved(...)`
   * before reaching the risk gate. Missing tracker = guard disabled (legacy
   * tests, scenario harness).
   */
  resolutionTracker?: MarketResolutionTracker | undefined;
  effectiveResolution?:
    | (Pick<EffectiveResolutionGate, "toBuyPlacementFields"> &
        Partial<Pick<EffectiveResolutionGate, "toBuyRunwayFields">>)
    | undefined;
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
  /** Optional kill switch; live-lite market-data marks are gated per position. */
  markToMarketEnabled?: boolean | undefined;
  latestUsablePriceForToken?: ((tokenId: TokenId) => number | null) | undefined;
  positionConcentration?: Pick<PositionConcentrationService, "recordFill"> | undefined;
  timers?: TimerRegistry | undefined;
  unreconciledReplayIntervalMs?: number | undefined;
  emitStrandedFillAlert: StrandedFillAlertEmitter;
}

/** Full diagnostics snapshot returned by getDiagnostics(). */
export interface RiskDiagnostics {
  signalsProcessed: number;
  signalsApproved: number;
  signalsRejected: number;
  fillsProcessed: number;
  markToMarketUpdates: number;
  fillApplicationFailures: number;
  unreconciledFillCount: number;
}

const DEFAULT_REJECTION_LOG_COOLDOWN_MS = 60 * 60 * 1000;
const IMPOSSIBLE_PRICE_EPSILON = 1e-9;
const UNRECONCILED_REPLAY_BATCH_SIZE = 25;
const DEFAULT_UNRECONCILED_REPLAY_INTERVAL_MS = 5 * 60_000;
const STRANDED_FILL_ALERT_AGE_MS = 15 * 60_000;

export const W4_STALENESS_FALLBACK_MS = 60_000;

export class RiskInventoryModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly riskGate: AlgoRiskGateImpl;
  private readonly inventory: InventoryHandler;
  private unsubs: Array<() => void> = [];
  private started = false;
  private signalsProcessed = 0;
  private signalsApprovedCount = 0;
  private signalsRejectedCount = 0;
  private fillsProcessed = 0;
  private mtmUpdates = 0;
  private fillApplicationFailures = 0;
  private unreconciledFillCount = 0;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private replayWorker: Promise<void> | null = null;
  private backfillWorker: Promise<void> | null = null;
  private acceptingReplayWork = false;
  private lifecycleGeneration = 0;
  private readonly minimumGenerations = new Map<string, number>();
  private readonly fillFailureLogState = new Map<string, number>();
  private readonly rejectionLogState = new Map<
    string,
    { lastLoggedAt: number; suppressed: number }
  >();
  private pausedSignalLogState: { lastLoggedAt: number; suppressed: number } | null = null;

  /** Latest known exchange minimum share size per token from live market updates. */
  private readonly tokenMinOrderSize = new Map<string, number>();

  constructor(private readonly deps: RiskInventoryModuleDeps) {
    this.log = deps.log.child({ module: "risk-inventory" });
    this.riskGate = new AlgoRiskGateImpl(
      deps.orderRepo,
      deps.positionRepo,
      this.log,
      (tid) => this.getLatestMinOrderSize(tid),
      {
        controlDb: deps.controlDb,
        activeProfile: deps.activeProfile,
        walletBufferPct: deps.walletBufferPct,
        walletBufferMinUsdc: deps.walletBufferMinUsdc,
      },
      () => deps.executionPolicy?.().buyCapacity ?? undefined,
      deps.executionPolicy,
      deps.capacityMetricsSink,
      deps.marketRepo,
      deps.redeemInFlightGuard,
      (sample) =>
        deps.runtimeMetrics?.writeEvent(
          "buy_rejected_due_to_redeem_in_flight_total",
          1,
          JSON.stringify({ side: sample.side, condition_id: sample.conditionId }),
          new Date(deps.now?.() ?? Date.now()).toISOString(),
        ),
      deps.profileOwnedOpenPositionCount,
      deps.fillRepo,
    );
    this.inventory = new InventoryHandler(
      deps.positionRepo,
      deps.inventoryLotRepo,
      this.log,
      deps.db,
      (tokenId) => this.getLatestMinOrderSize(tokenId),
      // Release A Phase 2 — assign a new position's sticky exit_owner at first fill,
      // mirroring today's bounce-exit routing (inert by default).
      (fill, entryLane, openedAt) =>
        resolveNewPositionExitOwner(
          {
            entryLane,
            conditionId: String(fill.conditionId),
            openedAt,
            firstTradeAt: new Date(fill.timestamp).toISOString(),
          },
          deps.executionPolicy?.(),
        ),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.clearReplayTimer();
    this.acceptingReplayWork = true;
    const generation = ++this.lifecycleGeneration;
    this.unsubs.push(
      this.deps.bus.subscribe("SignalProduced", (p) => this.handleSignal(p)),
      this.deps.bus.subscribe("FillReceived", (p) => this.handleFill(p)),
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
    );
    const backfill = this.backfillStaleCurrentValues(generation).finally(() => {
      if (this.backfillWorker === backfill) this.backfillWorker = null;
    });
    this.backfillWorker = backfill;
    await backfill;
    await this.runReplay(generation, "startup");
    if (!this.acceptingReplayWork || generation !== this.lifecycleGeneration) return;
    this.replayTimer =
      this.deps.timers?.every(
        "unreconciled_fill_replay",
        this.deps.unreconciledReplayIntervalMs ?? DEFAULT_UNRECONCILED_REPLAY_INTERVAL_MS,
        () => {
          void this.runReplay(generation, "periodic").catch((err) =>
            this.log.error({ err, source: "periodic" }, "unreconciled fill replay failed"),
          );
        },
      ) ?? null;
    this.started = true;
    this.log.info("risk-inventory module started");
  }

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    for (const tokenId of payload.removedTokenIds) {
      this.tokenMinOrderSize.delete(String(tokenId));
      this.minimumGenerations.set(
        String(tokenId),
        (this.minimumGenerations.get(String(tokenId)) ?? 0) + 1,
      );
    }
  }

  private runReplay(generation: number, source: "startup" | "periodic"): Promise<void> {
    if (!this.acceptingReplayWork || generation !== this.lifecycleGeneration)
      return Promise.resolve();
    if (this.replayWorker) return this.replayWorker;
    const worker = this.replayUnreconciledFills(generation, source).finally(() => {
      if (this.replayWorker === worker) this.replayWorker = null;
    });
    this.replayWorker = worker;
    return worker;
  }

  private async replayUnreconciledFills(
    generation: number,
    source: "startup" | "periodic",
  ): Promise<void> {
    const allFills = this.deps.fillRepo.findUnreconciled();
    this.unreconciledFillCount = allFills.length;
    const fills =
      source === "periodic" ? allFills.slice(0, UNRECONCILED_REPLAY_BATCH_SIZE) : allFills;
    if (fills.length === 0) return;

    this.log.warn(
      { count: fills.length, total: allFills.length, source },
      "replaying unreconciled fills",
    );
    for (const fill of fills) {
      if (generation !== this.lifecycleGeneration) return;
      await this.handleFill({
        fillId: fill.fillId,
        orderId: fill.orderId,
        clientOrderId: `replay-${fill.fillId}` as ClientOrderId,
        tokenId: fill.tokenId,
        conditionId: fill.conditionId,
        side: fill.side,
        price: fill.price,
        size: fill.size,
        sizeUsdc: fill.sizeUsdc,
        liquidityRole: fill.liquidityRole,
        fee: fill.fee,
        feeRateBps: fill.feeRateBps,
        signalReason: null,
        signalId: fill.signalId ?? null,
        decisionRuleId: fill.decisionRuleId ?? null,
        signalTimestamp: fill.signalTimestamp ?? null,
        timestamp: new Date(fill.filledAt).getTime(),
      });
    }
    if (generation === this.lifecycleGeneration) this.readUnreconciledState(this.now());
  }

  private async backfillStaleCurrentValues(generation: number): Promise<void> {
    // Every non-closed row, not one winner per token: a dust row that shares its token with an open
    // row would otherwise never be revalued, and its current_value_usdc would stay stale forever.
    // Promotion to a second `open` row is prevented by the guard below, not by narrowing the read.
    const positions = findActivePositionRows(this.deps.positionRepo);
    if (positions.length === 0) return;

    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    let backfilled = 0;

    for (const pos of positions) {
      if (generation !== this.lifecycleGeneration) return;
      if (!this.needsStartupCurrentValueBackfill(pos)) continue;

      const markPrice = this.deps.latestUsablePriceForToken
        ? this.deps.latestUsablePriceForToken(pos.tokenId)
        : null;
      const newValue =
        markPrice !== null && Number.isFinite(markPrice) ? pos.size * markPrice : null;
      const stored = pos.currentValueUsdc;
      const valueChanged =
        (stored === null) !== (newValue === null) ||
        (newValue !== null && stored !== null && Math.abs(newValue - stored) >= 0.001);
      const nextStatus: Position["status"] =
        pos.status === "closed"
          ? "closed"
          : newValue !== null
            ? resolveOpenPositionStatus(newValue, {
                size: pos.size,
                minOrderSize: this.getLatestMinOrderSize(pos.tokenId),
              })
            : pos.status;
      const statusChanged = pos.status !== nextStatus;
      if (!valueChanged && !statusChanged && stored !== null) continue;

      const updated: Position = {
        ...pos,
        currentValueUsdc: newValue,
        status: nextStatus,
        updatedAt: nowIso,
      };
      const toSave = resolveDustPromotion(
        this.deps.positionRepo,
        this.log,
        pos,
        updated,
        "backfillStaleCurrentValues",
      );
      if (toSave === null) continue;
      this.deps.positionRepo.save(toSave);
      await this.publishOpenToDustTransition(pos, toSave);
      backfilled++;
    }

    if (backfilled > 0) {
      this.log.info({ backfilled }, "startup mark-to-market backfill");
    }
  }

  async stop(): Promise<void> {
    await this.quiescePeriodicReplay();
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("risk-inventory module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "not started" };
    }
    const state = this.readUnreconciledState(this.now());
    if (state.stale) {
      return {
        ok: false,
        detail: `unreconciled fills=${state.count} oldestAgeMs=${state.oldestAgeMs}`,
      };
    }
    return {
      ok: true,
      detail: `signals=${this.signalsProcessed} approved=${this.signalsApprovedCount} rejected=${this.signalsRejectedCount} fills=${this.fillsProcessed} mtm=${this.mtmUpdates}`,
    };
  }

  /** Operator-facing diagnostics snapshot. */
  getDiagnostics(): RiskDiagnostics {
    return {
      signalsProcessed: this.signalsProcessed,
      signalsApproved: this.signalsApprovedCount,
      signalsRejected: this.signalsRejectedCount,
      fillsProcessed: this.fillsProcessed,
      markToMarketUpdates: this.mtmUpdates,
      fillApplicationFailures: this.fillApplicationFailures,
      unreconciledFillCount: this.unreconciledFillCount,
    };
  }

  public getLatestMinOrderSize(tokenId: RuntimeEventMap["FillReceived"]["tokenId"]): number | null {
    if (this.deps.tokenMinimum) return this.deps.tokenMinimum.read(String(tokenId)).remembered;
    return this.tokenMinOrderSize.get(String(tokenId)) ?? null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private clearReplayTimer(): void {
    if (!this.replayTimer) return;
    clearInterval(this.replayTimer);
    this.replayTimer = null;
  }

  async quiescePeriodicReplay(): Promise<void> {
    this.acceptingReplayWork = false;
    ++this.lifecycleGeneration;
    this.clearReplayTimer();
    const workers = [this.replayWorker, this.backfillWorker].filter(
      (worker): worker is Promise<void> => worker !== null,
    );
    await Promise.all(workers);
  }

  private readUnreconciledState(nowMs: number): {
    count: number;
    oldestAgeMs: number;
    stale: boolean;
  } {
    const rows = this.deps.fillRepo.findUnreconciled();
    this.unreconciledFillCount = rows.length;
    const unreconciledIds = new Set(rows.map((row) => String(row.fillId)));
    for (const fillId of this.fillFailureLogState.keys()) {
      if (!unreconciledIds.has(fillId)) this.fillFailureLogState.delete(fillId);
    }
    const oldestAgeMs =
      rows.length === 0 ? 0 : Math.max(0, nowMs - parseLedgerInstantMs(rows[0]!.filledAt));
    const state = {
      count: rows.length,
      oldestAgeMs,
      stale: oldestAgeMs >= STRANDED_FILL_ALERT_AGE_MS,
    };
    this.deps.emitStrandedFillAlert(state, nowMs);
    return state;
  }

  private isMissingCurrentValue(pos: Position): boolean {
    const stored = pos.currentValueUsdc;
    return typeof stored !== "number" || !Number.isFinite(stored);
  }

  private hasImplausibleCurrentValue(pos: Position): boolean {
    const stored = pos.currentValueUsdc;
    if (typeof stored !== "number" || !Number.isFinite(stored)) return false;
    return (
      typeof pos.size === "number" &&
      Number.isFinite(pos.size) &&
      pos.size > 0 &&
      stored / pos.size > 1.0 + IMPOSSIBLE_PRICE_EPSILON
    );
  }

  private needsStartupCurrentValueBackfill(pos: Position): boolean {
    return this.isMissingCurrentValue(pos) || this.hasImplausibleCurrentValue(pos);
  }

  private shouldApplyMarketDataMark(pos: Position, nowMs: number): boolean {
    if (this.needsStartupCurrentValueBackfill(pos)) return true;
    const updatedAtMs = pos.updatedAt ? parseLedgerInstantMs(pos.updatedAt) : 0;
    if (!Number.isFinite(updatedAtMs)) return true;
    return nowMs - updatedAtMs > W4_STALENESS_FALLBACK_MS;
  }

  /**
   * Migration 032's partial unique index allows exactly one `open` row per token, and
   * `findByTokenId` — the row a subsequent fill actually resolves against — ranks deterministically
   * (newest `openedAt`, `positionId` tie-break). `findDust()` has no ORDER BY, so a revaluation loop
   * iterating two dust rows for the same token could otherwise promote whichever one it reaches
   * first. If that is not the `findByTokenId` winner, the next fill still resolves to the true
   * winner, recomputes it to `open` too, and collides with this promotion via
   * `blockedByConflictingOpenPosition` forever. Only the `findByTokenId` winner may be promoted.
   *
   * Declining a promotion must not also drop the refreshed valuation — a `dust` sibling still needs
   * `current_value_usdc` to track price every cycle. Returns `updated` unchanged when no promotion
   * is in play or nothing declines it; the row to persist instead with `status` forced back to the
   * stored `dust` when a promotion is declined; or null when the stored row was not `dust` (an
   * abnormal open-row conflict this fallback is not designed to downgrade — the caller keeps its
   * pre-existing skip for that case).
   *
   * `ignorePositionId`, when supplied by site C, is the token's incumbent `open` row that this same
   * batch has already queued for demotion — see `handleMarketUpdate` for why that ordering is safe.
   * It is intentionally NOT used to relax the `findByTokenId` winner check above: if the demoted row
   * is itself the winner (newer than this dust candidate), the candidate must stay dust — promoting
   * a non-winner would make a later fill resolve back to the demoted row, recompute it to `open`,
   * and collide with this promotion forever, the exact permanent-fill-failure this guard exists to
   * prevent. That case is fail-closed by design; consolidating open+dust per token is tracked as
   * follow-up #143.
   */
  private rejectionLogCooldownMs(): number {
    return this.deps.rejectionLogCooldownMs ?? DEFAULT_REJECTION_LOG_COOLDOWN_MS;
  }

  private logRejectedSignal(
    details: {
      signalId: string;
      tokenId: string;
      reasons: readonly string[];
      sellCoverageInputs?: SellCoverageInputs;
    },
    message: string,
  ): void {
    const now = this.now();
    const reasonKey = normalizeReasonCode(details.reasons.join("; "));
    const state = this.rejectionLogState.get(reasonKey);
    if (state && now - state.lastLoggedAt < this.rejectionLogCooldownMs()) {
      state.suppressed++;
      return;
    }

    this.rejectionLogState.set(reasonKey, { lastLoggedAt: now, suppressed: 0 });
    this.log.info(
      {
        ...details,
        reasonCode: reasonKey,
        suppressedSinceLast: state?.suppressed ?? 0,
      },
      message,
    );
  }

  private logPausedSignalIgnored(signal: RuntimeEventMap["SignalProduced"]["signal"]): void {
    const now = this.now();
    const state = this.pausedSignalLogState;
    if (state && now - state.lastLoggedAt < this.rejectionLogCooldownMs()) {
      state.suppressed++;
      return;
    }

    this.pausedSignalLogState = { lastLoggedAt: now, suppressed: 0 };
    this.log.info(
      {
        signalId: signal.signalId,
        tokenId: String(signal.tokenId),
        side: signal.side,
        suppressedSinceLast: state?.suppressed ?? 0,
      },
      "signal ignored while runtime is paused",
    );
  }

  /**
   * Returns a single block-reason code for a BUY, or null when admission is
   * cleared. Reason precedence: tracker availability → resolution → market
   * lifecycle (canPlaceBuyOrder reasons in fixed order).
   *
   * Fail-closed: when the tracker is configured but unhealthy, every BUY is
   * rejected with `resolution_tracker_unavailable` rather than risking a
   * placement on a market that may be silently resolved.
   */
  private evaluateBuyAdmission(
    market: RuntimeEventMap["SignalProduced"]["market"],
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

  private evaluateD3BuyGuard(
    signal: RuntimeEventMap["SignalProduced"]["signal"],
    market: RuntimeEventMap["SignalProduced"]["market"],
  ): string | null {
    if (signal.side !== "buy") return null;
    if (!isPostEntryAddReason(signal.reason)) return null;
    const buyGuards = this.deps.executionPolicy?.().buyGuards;
    if (buyGuards == null) return null;
    const position = this.deps.positionRepo.findByTokenId(signal.tokenId);
    const runway = this.deps.effectiveResolution?.toBuyRunwayFields?.(market, this.now()) ?? null;
    const decision = evaluateD3NearDeathGuard({
      policy: buyGuards.d3NearDeathGuard,
      addPrice: signal.suggestedPrice,
      avgEntryPrice: position?.avgEntryPrice ?? null,
      runway,
    });
    if (decision.action !== "block") return null;
    this.deps.runtimeMetrics?.writeCounter(
      "d3_near_death_scale_in_suppressed_total",
      1,
      JSON.stringify({
        reason: decision.reason,
        marketClass: decision.marketClass,
        confidence: decision.confidence,
        thresholdBucket: decision.thresholdBucket,
        action: "block",
      }),
    );
    return decision.reason;
  }

  private evaluateHarvestingBuyGuard(
    signal: RuntimeEventMap["SignalProduced"]["signal"],
  ): string | null {
    if (signal.side !== "buy") return null;
    if (signal.decisionRuleId === EXECUTION_PROFILE_SCALE_IN_RULE_ID) return null;
    if (!isPostEntryAddReason(signal.reason)) return null;
    const policy = this.deps.executionPolicy?.().executionProfile.scaleIn.harvestingGuard;
    if (policy == null || !policy.enabled) return null;
    const state = this.deps.profileStateReader?.getState(signal.tokenId);
    if (!isHarvestingState(state)) return null;

    const decision = evaluatePostSellBuybackGuard(
      {
        buyPrice: signal.suggestedPrice,
        lastSellPrice: numericMetadata(state.metadata, "lastSellPrice"),
        lastSellAtMs: numericMetadata(state.metadata, "lastSellAtMs"),
        nowMs: this.now(),
        signals: { recovery60: null, range60: null, std60: null, usable: false },
      },
      policy,
    );
    if (decision.action !== "block") return null;
    this.deps.runtimeMetrics?.writeCounter(
      "harvesting_buy_above_last_sell_suppressed_total",
      1,
      JSON.stringify({
        band: state.profile,
        mode: "legacy",
        thresholdBucket: bucketHarvestingRatio(decision.ratio),
        overrideStatus: decision.overrideStatus,
      }),
    );
    return decision.reason;
  }

  private evaluateActiveMarketCapBuyGuard(
    signal: RuntimeEventMap["SignalProduced"]["signal"],
  ): string | null {
    if (signal.side !== "buy") return null;
    const guard = this.deps.liveLiteGuard;
    if (!guard?.isActive) return null;

    const activeMarkets = countActiveOpenMarkets(this.deps.positionRepo);
    if (activeMarkets.has(String(signal.tokenId))) return null;
    if (!guard.wouldExceedActiveMarketsCap(activeMarkets.size, 1)) return null;

    this.deps.runtimeMetrics?.writeCounter(
      "probe_entry_active_market_cap_suppressed_total",
      1,
      JSON.stringify({
        reason: LIVE_LITE_ACTIVE_MARKETS_CAP_FULL_REASON,
        rule: signal.decisionRuleId ?? "unknown",
        source: signal.reason,
        profile: this.deps.activeProfile ?? "unknown",
        mode: "live-lite",
        action: "suppress",
      }),
    );
    return LIVE_LITE_ACTIVE_MARKETS_CAP_FULL_REASON;
  }

  // ─── Signal evaluation ────────────────────────────────────────────

  private async handleSignal(payload: RuntimeEventMap["SignalProduced"]): Promise<void> {
    const startMs = performance.now();
    try {
      const { signal } = payload;
      const generation = this.lifecycleGeneration;
      const tokenGeneration = this.minimumGenerations.get(String(signal.tokenId));
      if (
        this.deps.tokenMinimum &&
        this.getLatestMinOrderSize(signal.tokenId) === null &&
        signal.tokenId === payload.market.tokenId &&
        signal.conditionId === payload.market.conditionId &&
        !this.deps.runtimeControl?.isPaused()
      ) {
        try {
          const receipt = await this.deps.tokenMinimum.resolve(String(signal.tokenId));
          this.deps.tokenMinimum.consume(receipt);
        } catch {
          /* The ordinary unknown-minimum outcome remains recoverable upstream. */
        }
        if (
          generation !== this.lifecycleGeneration ||
          tokenGeneration !== this.minimumGenerations.get(String(signal.tokenId))
        )
          return;
      }
      const market = this.deps.tokenMinimum
        ? { ...payload.market, minOrderSize: this.getLatestMinOrderSize(signal.tokenId) }
        : payload.market;
      this.signalsProcessed++;

      if (this.deps.runtimeControl?.isPaused()) {
        this.logPausedSignalIgnored(signal);
        return;
      }

      if (this.shouldSuppressEarlySellCooldown(signal, market)) {
        this.deps.signalPathTelemetry?.recordEarlyCooldown(
          signal.signalId,
          String(signal.tokenId),
          signal.side === "buy" ? "BUY" : "SELL",
          signal.suggestedPrice,
          market.tickSize,
        );
        this.deps.cooldownRegistry?.recordEarlySuppression(signal.tokenId);
        await this.deps.bus.publish("SignalConversionSkipped", {
          signal,
          stage: "execution-terms",
          reasons: [SAME_PRICE_COOLDOWN_REASON],
          diagnostics: {
            gate: "early-same-price-cooldown",
            price: signal.suggestedPrice,
          },
          skippedAt: this.now(),
        });
        return;
      }

      // BUY-side admission guard (defense-in-depth before riskGate). Blocks new
      // BUYs on markets that have already ended, gone inactive, lost tradability,
      // resolved, or aren't physically capable of accepting an order. SELL and
      // REDEEM signals bypass this check entirely.
      // GATE-whitelist liveness override (docs/plans/2026-07-17-gate-isalive-plankton-
      // whitelist.md): only a GATE_ENTRY first-entry BUY on a whitelisted market with a
      // live bestBid may relax the stale acceptingOrders/enableOrderBook rejection.
      const gateWhitelistOverride =
        signal.side === "buy" &&
        signal.decisionRuleId === GATE_ENTRY_RULE_ID &&
        market.bestBid != null &&
        isGateWhitelisted(this.deps.executionPolicy?.().gateEntry, market.conditionId);
      const buyBlock =
        signal.side === "buy" ? this.evaluateBuyAdmission(market, gateWhitelistOverride) : null;
      if (buyBlock) {
        this.signalsRejectedCount++;
        this.deps.signalPathTelemetry?.recordRejected(signal.signalId, buyBlock);
        this.logRejectedSignal(
          {
            signalId: signal.signalId,
            tokenId: String(signal.tokenId),
            reasons: [buyBlock],
          },
          "BUY signal rejected — market not eligible for placement",
        );
        await this.deps.bus.publish("SignalRejected", {
          signal,
          market,
          reason: buyBlock,
          rejectedAt: this.now(),
        });
        return;
      }

      const activeMarketCapBlock = this.evaluateActiveMarketCapBuyGuard(signal);
      if (activeMarketCapBlock) {
        this.signalsRejectedCount++;
        this.deps.signalPathTelemetry?.recordRejected(signal.signalId, activeMarketCapBlock);
        this.logRejectedSignal(
          {
            signalId: signal.signalId,
            tokenId: String(signal.tokenId),
            reasons: [activeMarketCapBlock],
          },
          "BUY signal rejected — live-lite active market cap full",
        );
        await this.deps.bus.publish("SignalRejected", {
          signal,
          market,
          reason: activeMarketCapBlock,
          rejectedAt: this.now(),
        });
        return;
      }

      const d3BuyGuardBlock = this.evaluateD3BuyGuard(signal, market);
      if (d3BuyGuardBlock) {
        this.signalsRejectedCount++;
        this.deps.signalPathTelemetry?.recordRejected(signal.signalId, d3BuyGuardBlock);
        this.logRejectedSignal(
          {
            signalId: signal.signalId,
            tokenId: String(signal.tokenId),
            reasons: [d3BuyGuardBlock],
          },
          "BUY signal rejected — D3 near-death guard",
        );
        await this.deps.bus.publish("SignalRejected", {
          signal,
          market,
          reason: d3BuyGuardBlock,
          rejectedAt: this.now(),
        });
        return;
      }

      const harvestingBuyGuardBlock = this.evaluateHarvestingBuyGuard(signal);
      if (harvestingBuyGuardBlock) {
        this.signalsRejectedCount++;
        this.deps.signalPathTelemetry?.recordRejected(signal.signalId, harvestingBuyGuardBlock);
        this.logRejectedSignal(
          {
            signalId: signal.signalId,
            tokenId: String(signal.tokenId),
            reasons: [harvestingBuyGuardBlock],
          },
          "BUY signal rejected — harvesting buyback guard",
        );
        await this.deps.bus.publish("SignalRejected", {
          signal,
          market,
          reason: harvestingBuyGuardBlock,
          rejectedAt: this.now(),
        });
        return;
      }

      try {
        if (
          signal.tokenId === market.tokenId &&
          signal.conditionId === market.conditionId &&
          !this.tokenMinOrderSize.has(String(signal.tokenId))
        ) {
          this.rememberMinOrderSize(signal.tokenId, market.minOrderSize);
        }
        const riskMinOrderSizeAtEvaluation = this.getLatestMinOrderSize(signal.tokenId);
        const decision = await this.riskGate.evaluate(signal);

        if (decision.approved) {
          this.signalsApprovedCount++;
          const sample = this.deps.signalPathTelemetry?.recordApproved(signal.signalId) ?? false;
          if (sample) {
            this.log.info(
              { signalId: signal.signalId, checks: decision.checksPassed },
              "signal_debug_sample",
            );
          }
          await this.deps.bus.publish("SignalApproved", {
            signal,
            market,
            approvedAt: this.now(),
          });
        } else {
          this.signalsRejectedCount++;
          const reason = decision.rejectionReasons.join("; ");
          const sellCoverageInputs =
            signal.side === "sell" &&
            signal.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID &&
            decision.rejectionReasons.includes(PER_TOKEN_SELL_LIMIT_REASON)
              ? {
                  suggestedSize: signal.suggestedSize,
                  suggestedPrice: signal.suggestedPrice,
                  positionId: signal.positionId,
                  bounceRung: signal.bounceRung,
                  signalMarketMinOrderSize: market.minOrderSize,
                  riskMinOrderSizeAtEvaluation,
                }
              : undefined;
          this.deps.signalPathTelemetry?.recordRejected(signal.signalId, reason);
          this.logRejectedSignal(
            {
              signalId: signal.signalId,
              tokenId: String(signal.tokenId),
              reasons: decision.rejectionReasons,
              ...(sellCoverageInputs ? { sellCoverageInputs } : {}),
            },
            "signal rejected",
          );
          await this.deps.bus.publish("SignalRejected", {
            signal,
            market,
            reason,
            rejectedAt: this.now(),
          });
        }
      } catch (err) {
        this.signalsRejectedCount++;
        this.deps.signalPathTelemetry?.recordRejected(
          signal.signalId,
          "internal error during risk evaluation",
        );
        this.log.error({ err, signalId: signal.signalId }, "signal evaluation failed");
        await this.deps.bus.publish("SignalRejected", {
          signal,
          market,
          reason: "internal error during risk evaluation",
          rejectedAt: this.now(),
        });
      }
    } finally {
      recordStageDuration("risk_signal_approval", performance.now() - startMs);
    }
  }

  private shouldSuppressEarlySellCooldown(
    signal: RuntimeEventMap["SignalProduced"]["signal"],
    market: RuntimeEventMap["SignalProduced"]["market"],
  ): boolean {
    // A bounce owner's immutable target is its exit coverage, not a fresh same-price decision.
    if (signal.side !== "sell" || signal.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID)
      return false;
    const registry = this.deps.cooldownRegistry;
    if (!registry) return false;
    const tickRoundedPrice = roundToTick(signal.suggestedPrice, market.tickSize);
    const active = registry.get(
      signal.tokenId,
      signal.side,
      priceToX10000(tickRoundedPrice),
      this.now(),
    );
    return active != null;
  }

  // ─── Fill application ─────────────────────────────────────────────

  private async handleFill(payload: RuntimeEventMap["FillReceived"]): Promise<void> {
    this.fillsProcessed++;

    try {
      const position = withImmediate(this.deps.db, () => {
        if (!this.deps.fillRepo.claimForReconciliation(payload.fillId)) return null;
        const positionBefore = this.deps.positionRepo.findByTokenId(payload.tokenId);
        const origOrder = this.deps.orderRepo.findById(payload.orderId);
        const applied = this.inventory.applyFill({
          fillId: payload.fillId,
          tokenId: payload.tokenId,
          conditionId: payload.conditionId,
          side: payload.side,
          price: payload.price,
          size: payload.size,
          sizeUsdc: payload.sizeUsdc,
          fee: payload.fee,
          signalReason: payload.signalReason,
          timestamp: payload.timestamp,
          entryStyle: origOrder?.entryStyle ?? null,
          decisionRuleId: origOrder?.decisionRuleId ?? payload.decisionRuleId ?? null,
        });
        this.deps.positionConcentration?.recordFill({
          fill: {
            tokenId: payload.tokenId,
            conditionId: payload.conditionId,
            side: payload.side,
            price: payload.price,
            sizeUsdc: payload.sizeUsdc,
            filledAt: new Date(payload.timestamp).toISOString(),
            orderId: payload.orderId,
          },
          policy:
            this.deps.executionPolicy?.().positionConcentration ??
            DEFAULT_EXECUTION_POLICY.positionConcentration,
          positionBefore,
          positionAfter: applied,
        });
        return applied;
      });

      if (position === null) return;
      await this.deps.bus.publish("PositionUpdated", { position });
    } catch (err) {
      this.fillApplicationFailures++;
      const now = this.now();
      const lastLoggedAt = this.fillFailureLogState.get(String(payload.fillId));
      if (lastLoggedAt === undefined || now - lastLoggedAt >= DEFAULT_REJECTION_LOG_COOLDOWN_MS) {
        this.fillFailureLogState.set(String(payload.fillId), now);
        this.log.error(
          { err, fillId: payload.fillId, tokenId: payload.tokenId },
          "fill application failed",
        );
      }
    }
  }

  // ─── Mark-to-market ───────────────────────────────────────────────

  private rememberMinOrderSize(tokenId: TokenId, minOrderSize: unknown): void {
    if (typeof minOrderSize === "number" && Number.isFinite(minOrderSize) && minOrderSize > 0) {
      this.tokenMinOrderSize.set(String(tokenId), minOrderSize);
    }
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    const markPriceByToken = new Map<string, number>();
    for (const m of payload.markets) {
      this.rememberMinOrderSize(m.tokenId, m.minOrderSize);
      if (typeof m.midPrice === "number" && Number.isFinite(m.midPrice)) {
        markPriceByToken.set(String(m.tokenId), m.midPrice);
      }
    }
    if (this.deps.markToMarketEnabled === false) return;
    if (markPriceByToken.size === 0) return;

    // Revalue all non-closed wallet inventory; dust can become open again. Same reason as the
    // startup backfill: read every row, and let the guard — not a narrowed read — stop the illegal
    // second `open` row.
    const openPositions = findActivePositionRows(this.deps.positionRepo);
    const nowMs = this.now();
    const updates: Array<{ previous: Position; next: Position }> = [];
    // `blockedByConflictingOpenPosition` only sees PERSISTED state, so two dust rows on one token
    // that both revalue to `open` in this same tick would both pass it and only collide inside
    // `saveBatch` — as a raw SQLITE_CONSTRAINT that rolls back every other token's mark. Track the
    // open rows this batch has already accepted so the second one is demoted back to dust, not
    // thrown into the batch.
    const openTokensInBatch = new Set<string>();
    // A token's incumbent `open` row demoting in THIS batch is also read-stale for the guard: it is
    // still `open` in the database until `saveBatch` runs. `findActivePositionRows` returns
    // `findOpen()` before `findDust()`, so by the time a dust row for that token reaches this loop,
    // its incumbent's demotion (if any) is already in `updates` — and will be SAVED FIRST inside the
    // transaction, since SQLite enforces the partial unique index per statement. That ordering is
    // what makes it safe to pass the demoted row's id down as `ignorePositionId`.
    const demotedOpenPositionIdByToken = new Map<string, string>();
    for (const pos of openPositions) {
      const markPrice = markPriceByToken.get(String(pos.tokenId));
      if (markPrice === undefined) continue;
      if (!this.shouldApplyMarketDataMark(pos, nowMs)) continue;

      const newValue = pos.size * markPrice;
      const nextStatus: Position["status"] =
        pos.status === "closed"
          ? "closed"
          : resolveOpenPositionStatus(newValue, {
              size: pos.size,
              minOrderSize: this.getLatestMinOrderSize(pos.tokenId),
            });
      if (
        typeof pos.currentValueUsdc === "number" &&
        Number.isFinite(pos.currentValueUsdc) &&
        Math.abs(newValue - pos.currentValueUsdc) < 0.001 &&
        pos.status === nextStatus
      ) {
        continue; // Skip if value hasn't meaningfully changed
      }

      const updatedPosition: Position = {
        ...pos,
        currentValueUsdc: newValue,
        status: nextStatus,
        updatedAt: new Date(nowMs).toISOString(),
      };
      // The guard runs BEFORE the row joins the batch: saveBatch is a single transaction, so one
      // declined promotion would otherwise roll back every other position's mark in the same tick.
      const tokenKey = String(pos.tokenId);
      let toSave = resolveDustPromotion(
        this.deps.positionRepo,
        this.log,
        pos,
        updatedPosition,
        "handleMarketUpdate",
        demotedOpenPositionIdByToken.get(tokenKey) ?? null,
      );
      if (toSave === null) continue;
      if (toSave.status === "open") {
        if (openTokensInBatch.has(tokenKey)) {
          this.log.error(
            {
              site: "handleMarketUpdate",
              tokenId: toSave.tokenId,
              positionId: toSave.positionId,
            },
            "refusing to promote a second open position for a token already promoted in this batch",
          );
          if (pos.status !== "dust") continue;
          toSave = { ...toSave, status: "dust" };
        } else {
          openTokensInBatch.add(tokenKey);
        }
      }
      updates.push({ previous: pos, next: toSave });
      if (pos.status === "open" && toSave.status !== "open") {
        demotedOpenPositionIdByToken.set(tokenKey, String(pos.positionId));
      }
    }

    if (updates.length === 0) return;

    const saveBatch = this.deps.db.transaction(
      (rows: Array<{ previous: Position; next: Position }>) => {
        for (const row of rows) {
          this.deps.positionRepo.save(row.next);
        }
      },
    );
    saveBatch(updates);

    for (const row of updates) {
      await this.publishOpenToDustTransition(row.previous, row.next);
    }

    const updated = updates.length;
    if (updated > 0) {
      this.mtmUpdates++;
      this.log.debug({ updated, total: openPositions.length }, "mark-to-market update");
    }
  }

  private async publishOpenToDustTransition(previous: Position, next: Position): Promise<void> {
    if (previous.status !== "open" || next.status !== "dust") return;
    await this.deps.bus.publish("PositionUpdated", { position: next });
  }
}

function isPostEntryAddReason(reason: string): boolean {
  return (
    reason === SignalReason.ConfirmScale ||
    reason === SignalReason.ScaleIn ||
    reason === SignalReason.HeavyScale
  );
}

function isHarvestingState(
  state: ExecutionProfileStateRecord | null | undefined,
): state is ExecutionProfileStateRecord {
  return state?.state === "HARVESTING";
}

function numericMetadata(
  metadata: Readonly<Record<string, unknown>> | null,
  key: string,
): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bucketHarvestingRatio(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return "unknown";
  if (ratio > 1.05) return "gt_1_05";
  if (ratio > 1.03) return "gt_1_03";
  return "lte_1_03";
}
