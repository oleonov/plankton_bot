/**
 * Risk + Inventory Module — the gating and inventory state tracker.
 *
 * Subscribes to:
 *  - SignalProduced → evaluate via RiskGate → publish SignalApproved / SignalRejected
 *  - FillReceived → apply to inventory → publish PositionUpdated + FamilyExposureChanged
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
  RuntimeEventMap,
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
  log: Logger;
  db: Database.Database;
  liveLiteGuard?: LiveLiteGuard | undefined;
}

export class RiskInventoryModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly riskGate: RiskGateImpl;
  private readonly inventory: InventoryHandler;
  private readonly exposure: FamilyExposureCalculator;
  private unsubs: Array<() => void> = [];
  private started = false;
  private signalsProcessed = 0;
  private fillsProcessed = 0;

  constructor(private readonly deps: RiskInventoryModuleDeps) {
    this.log = deps.log.child({ module: "risk-inventory" });
    this.riskGate = new RiskGateImpl(
      deps.rulesProvider,
      deps.familyStateRepo,
      deps.positionRepo,
      this.log,
      deps.liveLiteGuard,
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
      detail: `signals=${this.signalsProcessed} fills=${this.fillsProcessed}`,
    };
  }

  // ─── Signal evaluation ────────────────────────────────────────────

  private async handleSignal(
    payload: RuntimeEventMap["SignalProduced"],
  ): Promise<void> {
    const { signal } = payload;
    this.signalsProcessed++;

    try {
      const decision = await this.riskGate.evaluate(signal);

      if (decision.approved) {
        this.log.info(
          { signalId: signal.signalId, checks: decision.checksPassed },
          "signal approved",
        );
        await this.deps.bus.publish("SignalApproved", {
          signal,
          approvedAt: Date.now(),
        });
      } else {
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
    } catch (err) {
      this.log.error(
        { err, fillId: payload.fillId, tokenId: payload.tokenId },
        "fill application failed",
      );
    }
  }
}
