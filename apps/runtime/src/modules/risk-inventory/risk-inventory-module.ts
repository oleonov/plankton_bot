/**
 * Risk + Inventory Module — the gating and inventory state tracker.
 *
 * Subscribes to:
 *  - SignalProduced → evaluate via RiskGate → publish SignalApproved / SignalRejected
 *  - FillReceived → apply to inventory → publish PositionUpdated + FamilyExposureChanged
 *  - NormalizedMarketUpdated → mark-to-market revaluation of open positions (P2-1)
 *
 * Exposes:
 *  - getDiagnostics() → operator-facing signal/rejection stats per family (P2-2)
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
  FamilyRulesProvider,
  FamilyStateRepository,
  PositionRepository,
  InventoryLotRepository,
  OrderRepository,
  FillRepository,
  RuntimeEventMap,
  NormalizedMarket,
  FamilyId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { RiskGateImpl } from "./risk-gate.js";
import { InventoryHandler } from "./inventory-handler.js";
import { FamilyExposureCalculator } from "./family-exposure.js";

export interface RiskInventoryModuleDeps {
  bus: EventBus;
  rulesProvider: FamilyRulesProvider;
  familyStateRepo: FamilyStateRepository;
  positionRepo: PositionRepository;
  inventoryLotRepo: InventoryLotRepository;
  orderRepo: OrderRepository;
  fillRepo: Pick<FillRepository, "markReconciled">;
  log: Logger;
  db: Database.Database;
  liveLiteGuard?: LiveLiteGuard | undefined;
}

/** Per-family diagnostic counters (P2-2). */
export interface FamilyDiagnostics {
  signalsApproved: number;
  signalsRejected: number;
  lastRejectionReason: string | null;
  lastSignalReason: string | null;
  lastSignalAt: string | null;
}

/** Full diagnostics snapshot returned by getDiagnostics(). */
export interface RiskDiagnostics {
  signalsProcessed: number;
  signalsApproved: number;
  signalsRejected: number;
  fillsProcessed: number;
  markToMarketUpdates: number;
  families: Record<string, FamilyDiagnostics>;
}

export class RiskInventoryModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly riskGate: RiskGateImpl;
  private readonly inventory: InventoryHandler;
  private readonly exposure: FamilyExposureCalculator;
  private unsubs: Array<() => void> = [];
  private started = false;
  private signalsProcessed = 0;
  private signalsApprovedCount = 0;
  private signalsRejectedCount = 0;
  private fillsProcessed = 0;
  private mtmUpdates = 0;

  /** Per-family diagnostic counters (P2-2). */
  private readonly familyDiag = new Map<string, FamilyDiagnostics>();

  /** Per-family in-flight order counter (B2.2). */
  private readonly familyInFlight = new Map<string, number>();

  /** Orders already decremented from in-flight (prevents double-decrement on multi-fill orders). */
  private readonly inFlightDecremented = new Set<string>();

  constructor(private readonly deps: RiskInventoryModuleDeps) {
    this.log = deps.log.child({ module: "risk-inventory" });
    this.riskGate = new RiskGateImpl(
      deps.rulesProvider,
      deps.familyStateRepo,
      deps.positionRepo,
      this.log,
      deps.liveLiteGuard,
      (fid) => this.getInFlightCount(fid),
    );
    this.inventory = new InventoryHandler(
      deps.positionRepo,
      deps.inventoryLotRepo,
      this.log,
      deps.db,
    );
    this.exposure = new FamilyExposureCalculator(
      deps.familyStateRepo,
      deps.positionRepo,
      deps.inventoryLotRepo,
      this.log,
    );
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("SignalProduced", (p) =>
        this.handleSignal(p),
      ),
      this.deps.bus.subscribe("FillReceived", (p) =>
        this.handleFill(p),
      ),
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) =>
        this.handleMarketUpdate(p),
      ),
      this.deps.bus.subscribe("PlaceOrderRequested", (p) => {
        this.incrementInFlight(p.command.familyId);
        return Promise.resolve();
      }),
      this.deps.bus.subscribe("OrderRejected", (p) => {
        this.decrementInFlight(p.familyId);
        return Promise.resolve();
      }),
      this.deps.bus.subscribe("OrderCancelled", (p) => {
        this.decrementInFlight(p.familyId);
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

  /** Operator-facing diagnostics snapshot (P2-2). */
  getDiagnostics(): RiskDiagnostics {
    const families: Record<string, FamilyDiagnostics> = {};
    for (const [key, diag] of this.familyDiag) {
      families[key] = { ...diag };
    }
    return {
      signalsProcessed: this.signalsProcessed,
      signalsApproved: this.signalsApprovedCount,
      signalsRejected: this.signalsRejectedCount,
      fillsProcessed: this.fillsProcessed,
      markToMarketUpdates: this.mtmUpdates,
      families,
    };
  }

  // ─── Diagnostics helpers (P2-2) ───────────────────────────────────

  private getFamilyDiag(familyId: FamilyId): FamilyDiagnostics {
    const key = String(familyId);
    let d = this.familyDiag.get(key);
    if (!d) {
      d = {
        signalsApproved: 0,
        signalsRejected: 0,
        lastRejectionReason: null,
        lastSignalReason: null,
        lastSignalAt: null,
      };
      this.familyDiag.set(key, d);
    }
    return d;
  }

  // ─── In-flight counter helpers (B2.2) ────────────────────────────

  private incrementInFlight(familyId: FamilyId): void {
    const fid = String(familyId);
    this.familyInFlight.set(fid, (this.familyInFlight.get(fid) ?? 0) + 1);
  }

  private decrementInFlight(familyId: FamilyId): void {
    const fid = String(familyId);
    this.familyInFlight.set(fid, Math.max(0, (this.familyInFlight.get(fid) ?? 0) - 1));
  }

  private getInFlightCount(familyId: FamilyId): number {
    return this.familyInFlight.get(String(familyId)) ?? 0;
  }

  // ─── Signal evaluation ────────────────────────────────────────────

  private async handleSignal(
    payload: RuntimeEventMap["SignalProduced"],
  ): Promise<void> {
    const { signal } = payload;
    this.signalsProcessed++;

    const diag = this.getFamilyDiag(signal.familyId);
    diag.lastSignalReason = signal.reason;
    diag.lastSignalAt = signal.generatedAt;

    try {
      const decision = await this.riskGate.evaluate(signal);

      if (decision.approved) {
        this.signalsApprovedCount++;
        diag.signalsApproved++;
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
        diag.signalsRejected++;
        diag.lastRejectionReason = decision.rejectionReasons.join("; ");
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
      diag.signalsRejected++;
      diag.lastRejectionReason = "internal error during risk evaluation";
      this.log.error({ err, signalId: signal.signalId }, "signal evaluation failed");
      await this.deps.bus.publish("SignalRejected", {
        signal,
        reason: "internal error during risk evaluation",
        rejectedAt: Date.now(),
      });
    }
  }

  // ─── Fill application ─────────────────────────────────────────────

  private async handleFill(
    payload: RuntimeEventMap["FillReceived"],
  ): Promise<void> {
    this.fillsProcessed++;

    try {
      const position = this.inventory.applyFill({
        fillId: payload.fillId,
        tokenId: payload.tokenId,
        familyId: payload.familyId,
        side: payload.side,
        price: payload.price,
        size: payload.size,
        sizeUsdc: payload.sizeUsdc,
        fee: payload.fee,
        timestamp: payload.timestamp,
      });

      this.deps.fillRepo.markReconciled([payload.fillId]);

      await this.deps.bus.publish("PositionUpdated", { position });

      // Recompute family exposure
      const familyState = this.exposure.recompute(
        payload.familyId,
        payload.side === "buy",
      );

      await this.deps.bus.publish("FamilyExposureChanged", {
        familyId: payload.familyId,
        totalExposureUsdc: familyState.openValueUsdc,
        openPositionCount: familyState.openPositionCount,
        familyState,
        timestamp: Date.now(),
      });

      const oid = String(payload.orderId);
      const order = this.deps.orderRepo.findById(payload.orderId);
      if (order && order.status === "filled" && !this.inFlightDecremented.has(oid)) {
        this.inFlightDecremented.add(oid);
        this.decrementInFlight(payload.familyId);
      }
    } catch (err) {
      this.log.error(
        { err, fillId: payload.fillId, tokenId: payload.tokenId },
        "fill application failed",
      );
    }
  }

  // ─── Mark-to-market (P2-1) ────────────────────────────────────────

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    // Build lookup: tokenId → live midPrice
    const priceMap = new Map<string, number>();
    for (const m of payload.markets) {
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
      if (pos.currentValueUsdc !== null && Math.abs(newValue - pos.currentValueUsdc) < 0.001) {
        continue; // Skip if value hasn't meaningfully changed
      }

      this.deps.positionRepo.save({
        ...pos,
        currentValueUsdc: newValue,
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
