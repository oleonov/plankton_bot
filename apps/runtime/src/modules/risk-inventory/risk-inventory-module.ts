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
  TokenId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { resolveOpenPositionStatus } from "../../position-status.js";
import { AlgoRiskGateImpl } from "./algo-risk-gate.js";
import { InventoryHandler } from "./inventory-handler.js";

export interface RiskInventoryModuleDeps {
  bus: EventBus;
  positionRepo: PositionRepository;
  inventoryLotRepo: InventoryLotRepository;
  orderRepo: OrderRepository;
  fillRepo: Pick<FillRepository, "markReconciled">;
  log: Logger;
  db: Database.Database;
  liveLiteGuard?: LiveLiteGuard | undefined;
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

  /** Per-token in-flight buy order counter (generalized, all buy-side commands). */
  private readonly tokenInFlight = new Map<string, number>();
  /** Latest known exchange minimum share size per token from live market updates. */
  private readonly tokenMinOrderSize = new Map<string, number>();

  /** Orders already decremented from in-flight (prevents double-decrement on multi-fill orders). */
  private readonly inFlightDecremented = new Set<string>();

  constructor(private readonly deps: RiskInventoryModuleDeps) {
    this.log = deps.log.child({ module: "risk-inventory" });
    this.riskGate = new AlgoRiskGateImpl(
      deps.orderRepo,
      deps.positionRepo,
      this.log,
      (tid) => this.getLatestMinOrderSize(tid),
      (tid) => this.getTokenInFlightCount(tid),
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
      this.deps.bus.subscribe("PlaceOrderRequested", (p) => {
        this.incrementInFlight(p.command);
        return Promise.resolve();
      }),
      this.deps.bus.subscribe("OrderRejected", (p) => {
        this.decrementTokenInFlight(String(p.tokenId));
        return Promise.resolve();
      }),
      this.deps.bus.subscribe("OrderCancelled", (p) => {
        this.decrementTokenInFlight(String(p.tokenId));
        return Promise.resolve();
      }),
    );
    this.started = true;
    this.log.info("risk-inventory module started");
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

  // ─── In-flight counter helpers ────────────────────────────────────

  private incrementInFlight(command: RuntimeEventMap["PlaceOrderRequested"]["command"]): void {
    if (command.side !== "buy") return;
    const key = String(command.tokenId);
    this.tokenInFlight.set(key, (this.tokenInFlight.get(key) ?? 0) + 1);
  }

  private decrementTokenInFlight(tokenId: string): void {
    this.tokenInFlight.set(tokenId, Math.max(0, (this.tokenInFlight.get(tokenId) ?? 0) - 1));
  }

  private getTokenInFlightCount(tokenId: TokenId): number {
    return this.tokenInFlight.get(String(tokenId)) ?? 0;
  }

  private getLatestMinOrderSize(
    tokenId: RuntimeEventMap["FillReceived"]["tokenId"],
  ): number | null {
    return this.tokenMinOrderSize.get(String(tokenId)) ?? null;
  }

  // ─── Signal evaluation ────────────────────────────────────────────

  private async handleSignal(payload: RuntimeEventMap["SignalProduced"]): Promise<void> {
    const { signal } = payload;
    this.signalsProcessed++;

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
          approvedAt: Date.now(),
        });
      } else {
        this.signalsRejectedCount++;
        this.log.info(
          { signalId: signal.signalId, reasons: decision.rejectionReasons },
          "signal rejected",
        );
        await this.deps.bus.publish("SignalRejected", {
          signal,
          reason: decision.rejectionReasons.join("; "),
          rejectedAt: Date.now(),
        });
      }
    } catch (err) {
      this.signalsRejectedCount++;
      this.log.error({ err, signalId: signal.signalId }, "signal evaluation failed");
      await this.deps.bus.publish("SignalRejected", {
        signal,
        reason: "internal error during risk evaluation",
        rejectedAt: Date.now(),
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

      const oid = String(payload.orderId);
      const order = this.deps.orderRepo.findById(payload.orderId);
      if (order && order.status === "filled" && !this.inFlightDecremented.has(oid)) {
        this.inFlightDecremented.add(oid);
        this.decrementTokenInFlight(String(payload.tokenId));
      }
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

    // Revalue open positions that have a live price
    const openPositions = this.deps.positionRepo.findOpen();
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
