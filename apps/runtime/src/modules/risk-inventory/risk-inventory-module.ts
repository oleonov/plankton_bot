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
import type {
  RuntimeModule,
  EventBus,
  PositionRepository,
  InventoryLotRepository,
  OrderRepository,
  FillRepository,
  RuntimeEventMap,
  ProfileId,
} from "@plankton/domain";
import { canPlaceBuyOrderForMarket } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { findActivePositions } from "../../active-positions.js";
import { resolveOpenPositionStatus } from "../../position-status.js";
import { AlgoRiskGateImpl } from "./algo-risk-gate.js";
import { InventoryHandler } from "./inventory-handler.js";
import type { MarketResolutionTracker } from "../resolution/market-resolution-tracker.js";
import type { WalletBudgetControlDb } from "../../wallet-buy-budget.js";

export interface RiskInventoryModuleDeps {
  bus: EventBus;
  positionRepo: PositionRepository;
  inventoryLotRepo: InventoryLotRepository;
  orderRepo: OrderRepository;
  fillRepo: Pick<FillRepository, "markReconciled">;
  log: Logger;
  db: Database.Database;
  liveLiteGuard?: LiveLiteGuard | undefined;
  controlDb?: WalletBudgetControlDb | undefined;
  activeProfile?: ProfileId | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
  /**
   * Optional fail-closed BUY-side guard. When supplied, BUYs are pre-screened
   * against `canPlaceBuyOrder(market)` and `resolutionTracker.isResolved(...)`
   * before reaching the risk gate. Missing tracker = guard disabled (legacy
   * tests, scenario harness).
   */
  resolutionTracker?: MarketResolutionTracker | undefined;
  /** Override for tests; defaults to Date.now. */
  now?: () => number;
}

/** Full diagnostics snapshot returned by getDiagnostics(). */
export interface RiskDiagnostics {
  signalsProcessed: number;
  signalsApproved: number;
  signalsRejected: number;
  fillsProcessed: number;
  markToMarketUpdates: number;
}

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

  private getLatestMinOrderSize(
    tokenId: RuntimeEventMap["FillReceived"]["tokenId"],
  ): number | null {
    return this.tokenMinOrderSize.get(String(tokenId)) ?? null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
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
  ): string | null {
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
    const { signal, market } = payload;
    this.signalsProcessed++;

    // BUY-side admission guard (defense-in-depth before riskGate). Blocks new
    // BUYs on markets that have already ended, gone inactive, lost tradability,
    // resolved, or aren't physically capable of accepting an order. SELL and
    // REDEEM signals bypass this check entirely.
    const buyBlock = signal.side === "buy" ? this.evaluateBuyAdmission(market) : null;
    if (buyBlock) {
      this.signalsRejectedCount++;
      this.log.info(
        { signalId: signal.signalId, tokenId: String(signal.tokenId), reason: buyBlock },
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
        this.log.info(
          { signalId: signal.signalId, checks: decision.checksPassed },
          "signal approved",
        );
        await this.deps.bus.publish("SignalApproved", {
          signal,
          market,
          approvedAt: this.now(),
        });
      } else {
        this.signalsRejectedCount++;
        this.log.info(
          { signalId: signal.signalId, reasons: decision.rejectionReasons },
          "signal rejected",
        );
        await this.deps.bus.publish("SignalRejected", {
          signal,
          market,
          reason: decision.rejectionReasons.join("; "),
          rejectedAt: this.now(),
        });
      }
    } catch (err) {
      this.signalsRejectedCount++;
      this.log.error({ err, signalId: signal.signalId }, "signal evaluation failed");
      await this.deps.bus.publish("SignalRejected", {
        signal,
        market,
        reason: "internal error during risk evaluation",
        rejectedAt: this.now(),
      });
    }
  }

  // ─── Fill application ─────────────────────────────────────────────

  private async handleFill(payload: RuntimeEventMap["FillReceived"]): Promise<void> {
    this.fillsProcessed++;

    try {
      const position = this.inventory.applyFill({
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
    // Build lookup: tokenId → live midPrice
    const priceMap = new Map<string, number>();
    for (const m of payload.markets) {
      if (
        typeof m.minOrderSize === "number" &&
        Number.isFinite(m.minOrderSize) &&
        m.minOrderSize > 0
      ) {
        this.tokenMinOrderSize.set(String(m.tokenId), m.minOrderSize);
      }
      if (m.midPrice !== null) {
        priceMap.set(String(m.tokenId), m.midPrice);
      }
    }
    if (priceMap.size === 0) return;

    // Revalue all non-closed wallet inventory; dust can become open again.
    const openPositions = findActivePositions(this.deps.positionRepo);
    let updated = 0;
    for (const pos of openPositions) {
      const livePrice = priceMap.get(String(pos.tokenId));
      if (livePrice === undefined) continue;

      const newValue = pos.size * livePrice;
      const nextStatus = pos.status === "closed" ? "closed" : resolveOpenPositionStatus(newValue);
      if (
        pos.currentValueUsdc !== null &&
        Math.abs(newValue - pos.currentValueUsdc) < 0.001 &&
        pos.status === nextStatus
      ) {
        continue; // Skip if value hasn't meaningfully changed
      }

      this.deps.positionRepo.save({
        ...pos,
        currentValueUsdc: newValue,
        status: nextStatus,
        updatedAt: new Date().toISOString(),
      });
      updated++;
    }

    if (updated > 0) {
      this.mtmUpdates++;
      this.log.debug({ updated, total: openPositions.length }, "mark-to-market update");
    }
  }
}
