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
import { withImmediate } from "@krabs/db";
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
import { canPlaceBuyOrderForMarket, recordStageDuration, roundToTick } from "@krabs/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { findActivePositions } from "../../active-positions.js";
import { resolveOpenPositionStatus } from "../../position-status.js";
import { normalizeReasonCode } from "../../risk-event-codes.js";
import { AlgoRiskGateImpl } from "./algo-risk-gate.js";
import { InventoryHandler } from "./inventory-handler.js";
import type { MarketResolutionTracker } from "../resolution/market-resolution-tracker.js";
import type { OrderCapacityMetricsSample, WalletBudgetControlDb } from "../../wallet-buy-budget.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import {
  priceToX10000,
  SAME_PRICE_COOLDOWN_REASON,
} from "../same-price-cooldown/same-price-cooldown-module.js";
import type { CooldownRegistry } from "../same-price-cooldown/cooldown-registry.js";
import type { SignalPathTelemetry } from "../strategy/signal-path-telemetry.js";

export interface RiskInventoryModuleDeps {
  bus: EventBus;
  positionRepo: PositionRepository;
  inventoryLotRepo: InventoryLotRepository;
  orderRepo: OrderRepository;
  marketRepo?: Pick<MarketRepository, "findByTokenId"> | undefined;
  fillRepo: Pick<FillRepository, "findUnreconciled" | "markReconciled">;
  log: Logger;
  db: Database.Database;
  liveLiteGuard?: LiveLiteGuard | undefined;
  controlDb?: WalletBudgetControlDb | undefined;
  activeProfile?: ProfileId | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
  executionPolicy?: (() => ExecutionPolicy) | undefined;
  capacityMetricsSink?: ((sample: OrderCapacityMetricsSample) => void) | undefined;
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
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
  /** Optional kill switch; live-lite market-data marks are gated per position. */
  markToMarketEnabled?: boolean | undefined;
  latestUsablePriceForToken?: ((tokenId: TokenId) => number | null) | undefined;
}

/** Full diagnostics snapshot returned by getDiagnostics(). */
export interface RiskDiagnostics {
  signalsProcessed: number;
  signalsApproved: number;
  signalsRejected: number;
  fillsProcessed: number;
  markToMarketUpdates: number;
}

const DEFAULT_REJECTION_LOG_COOLDOWN_MS = 60 * 60 * 1000;
const IMPOSSIBLE_PRICE_EPSILON = 1e-9;

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
    );
    this.inventory = new InventoryHandler(
      deps.positionRepo,
      deps.inventoryLotRepo,
      this.log,
      deps.db,
    );
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("SignalProduced", (p) => this.handleSignal(p)),
      this.deps.bus.subscribe("FillReceived", (p) => this.handleFill(p)),
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
    );
    await this.backfillStaleCurrentValues();
    await this.replayUnreconciledFills();
    this.started = true;
    this.log.info("risk-inventory module started");
  }

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    for (const tokenId of payload.removedTokenIds) {
      this.tokenMinOrderSize.delete(String(tokenId));
    }
  }

  private async replayUnreconciledFills(): Promise<void> {
    const fills = this.deps.fillRepo.findUnreconciled();
    if (fills.length === 0) return;

    this.log.warn({ count: fills.length }, "replaying unreconciled fills before startup");
    for (const fill of fills) {
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
  }

  private async backfillStaleCurrentValues(): Promise<void> {
    const positions = findActivePositions(this.deps.positionRepo);
    if (positions.length === 0) return;

    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    let backfilled = 0;

    for (const pos of positions) {
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
      const nextStatus =
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

      this.deps.positionRepo.save({
        ...pos,
        currentValueUsdc: newValue,
        status: nextStatus,
        updatedAt: nowIso,
      });
      backfilled++;
    }

    if (backfilled > 0) {
      this.log.info({ backfilled }, "startup mark-to-market backfill");
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("risk-inventory module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "not started" };
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
    };
  }

  public getLatestMinOrderSize(tokenId: RuntimeEventMap["FillReceived"]["tokenId"]): number | null {
    return this.tokenMinOrderSize.get(String(tokenId)) ?? null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
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
    const updatedAtMs = pos.updatedAt ? Date.parse(pos.updatedAt) : 0;
    if (!Number.isFinite(updatedAtMs)) return true;
    return nowMs - updatedAtMs > W4_STALENESS_FALLBACK_MS;
  }

  private rejectionLogCooldownMs(): number {
    return this.deps.rejectionLogCooldownMs ?? DEFAULT_REJECTION_LOG_COOLDOWN_MS;
  }

  private logRejectedSignal(
    details: { signalId: string; tokenId: string; reasons: readonly string[] },
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
  private evaluateBuyAdmission(market: RuntimeEventMap["SignalProduced"]["market"]): string | null {
    const tracker = this.deps.resolutionTracker;
    if (tracker) {
      if (!tracker.healthy()) return "resolution_tracker_unavailable";
      if (tracker.isResolved(market.conditionId)) return "market_resolved";
    }
    const placement = canPlaceBuyOrderForMarket(market, this.now());
    if (!placement.allowed) return placement.reasons[0] ?? "market_not_alive";
    return null;
  }

  // ─── Signal evaluation ────────────────────────────────────────────

  private async handleSignal(payload: RuntimeEventMap["SignalProduced"]): Promise<void> {
    const startMs = performance.now();
    try {
      const { signal, market } = payload;
      this.signalsProcessed++;

      if (this.deps.runtimeControl?.isPaused()) {
        this.logPausedSignalIgnored(signal);
        return;
      }

      if (this.shouldSuppressEarlySellCooldown(signal, market)) {
        this.deps.signalPathTelemetry?.recordEarlyCooldown(signal.signalId);
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
      const buyBlock = signal.side === "buy" ? this.evaluateBuyAdmission(market) : null;
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

      try {
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
          this.deps.signalPathTelemetry?.recordRejected(signal.signalId, reason);
          this.logRejectedSignal(
            {
              signalId: signal.signalId,
              tokenId: String(signal.tokenId),
              reasons: decision.rejectionReasons,
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
    if (signal.side !== "sell") return false;
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
        });
        this.deps.fillRepo.markReconciled([payload.fillId]);
        return applied;
      });

      await this.deps.bus.publish("PositionUpdated", { position });
    } catch (err) {
      this.log.error(
        { err, fillId: payload.fillId, tokenId: payload.tokenId },
        "fill application failed",
      );
    }
  }

  // ─── Mark-to-market ───────────────────────────────────────────────

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    const markPriceByToken = new Map<string, number>();
    for (const m of payload.markets) {
      if (
        typeof m.minOrderSize === "number" &&
        Number.isFinite(m.minOrderSize) &&
        m.minOrderSize > 0
      ) {
        this.tokenMinOrderSize.set(String(m.tokenId), m.minOrderSize);
      }
      if (typeof m.midPrice === "number" && Number.isFinite(m.midPrice)) {
        markPriceByToken.set(String(m.tokenId), m.midPrice);
      }
    }
    if (this.deps.markToMarketEnabled === false) return;
    if (markPriceByToken.size === 0) return;

    // Revalue all non-closed wallet inventory; dust can become open again.
    const openPositions = findActivePositions(this.deps.positionRepo);
    const nowMs = this.now();
    let updated = 0;
    for (const pos of openPositions) {
      const markPrice = markPriceByToken.get(String(pos.tokenId));
      if (markPrice === undefined) continue;
      if (!this.shouldApplyMarketDataMark(pos, nowMs)) continue;

      const newValue = pos.size * markPrice;
      const nextStatus =
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

      this.deps.positionRepo.save({
        ...pos,
        currentValueUsdc: newValue,
        status: nextStatus,
        updatedAt: new Date(nowMs).toISOString(),
      });
      updated++;
    }

    if (updated > 0) {
      this.mtmUpdates++;
      this.log.debug({ updated, total: openPositions.length }, "mark-to-market update");
    }
  }
}
