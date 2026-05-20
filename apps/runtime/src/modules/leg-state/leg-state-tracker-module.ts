import type {
  EventBus,
  LegStateRepository,
  LegStateTransitionRepository,
  PositionRepository,
  RuntimeModule,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import {
  recordLegStateClearTransition,
  updateLegStateForFill,
} from "./update-leg-state-for-fill.js";
import type { LegStateTransitionBackfillResult } from "./leg-state-transition-backfill.js";

export interface LegStateTrackerModuleDeps {
  bus: EventBus;
  legStateRepo: LegStateRepository;
  legStateTransitionRepo?: LegStateTransitionRepository;
  positionRepo?: PositionRepository;
  transitionBackfill?: () => LegStateTransitionBackfillResult;
  log: Logger;
}

export class LegStateTrackerModule implements RuntimeModule {
  private readonly log: Logger;
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: LegStateTrackerModuleDeps) {
    this.log = deps.log.child({ module: "leg-state-tracker" });
  }

  async start(): Promise<void> {
    this.runTransitionBackfill();
    this.unsubs.push(
      this.deps.bus.subscribe("FillReceived", (p) => this.handleFill(p)),
      this.deps.bus.subscribe("PositionUpdated", (p) => this.handlePositionUpdated(p)),
      this.deps.bus.subscribe("PositionSettled", (p) => this.handleSettled(p)),
    );
    this.cleanupOrphanLegStates();
    this.log.info("leg-state-tracker module started");
  }

  /**
   * Sweep stale leg_states whose token has no open position. The leg-state
   * tracker is started AFTER risk-inventory in the supervisor, so any
   * PositionUpdated emitted by `replayUnreconciledFills` (during
   * RiskInventoryModule.start) fires before this module's subscriptions
   * exist — leaving leg rows that reference closed positions. Without this
   * sweep, AlgoDecisionModule keeps emitting D7 SELL signals against
   * size-0 positions, which ExecutionModule then rejects as
   * `reserved-token-limit` once per scan tick.
   */
  private cleanupOrphanLegStates(): void {
    const positionRepo = this.deps.positionRepo;
    if (!positionRepo) return;

    const allLegs = this.deps.legStateRepo.getAll();
    let cleared = 0;
    for (const leg of allLegs) {
      const position = positionRepo.findByTokenId(leg.tokenId);
      if (position && position.status !== "closed" && position.size > 0) continue;

      recordLegStateClearTransition({
        transitionRepo: this.deps.legStateTransitionRepo,
        tokenId: leg.tokenId,
        existing: leg,
        positionId: position?.positionId ?? null,
        action: "CLEAR",
        reason: "orphan_leg_cleanup_at_startup",
        occurredAt: new Date().toISOString(),
        log: this.log,
      });
      this.deps.legStateRepo.delete(leg.tokenId);
      void this.deps.bus.publish("LegStateCleared", {
        tokenId: leg.tokenId,
        reason: "orphan_leg_cleanup_at_startup",
        timestamp: Date.now(),
      });
      cleared++;
    }
    if (cleared > 0) {
      this.log.warn(
        { cleared, scanned: allLegs.length },
        "leg-state-tracker swept orphan leg states at startup",
      );
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.log.info("leg-state-tracker module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true };
  }

  private async handleFill(
    p: import("@krabs/domain").RuntimeEventMap["FillReceived"],
  ): Promise<void> {
    const position = this.deps.positionRepo?.findByTokenId(p.tokenId);
    updateLegStateForFill(
      this.deps.legStateRepo,
      {
        tokenId: p.tokenId,
        side: p.side,
        price: p.price,
        filledAt: new Date(p.timestamp).toISOString(),
        fillId: p.fillId,
        orderId: p.orderId,
        clientOrderId: p.clientOrderId,
        conditionId: p.conditionId,
        positionId: position?.positionId ?? null,
        size: p.size,
        sizeUsdc: p.sizeUsdc,
      },
      this.log,
      new Date().toISOString(),
      {
        transitionRepo: this.deps.legStateTransitionRepo,
        reason: "fill_received",
      },
    );
    const updated = this.deps.legStateRepo.get(p.tokenId);
    if (updated) {
      await this.deps.bus.publish("LegStateUpdated", {
        legState: updated,
        timestamp: p.timestamp,
      });
    }
  }

  private async handlePositionUpdated(
    p: import("@krabs/domain").RuntimeEventMap["PositionUpdated"],
  ): Promise<void> {
    if (p.position.size === 0) {
      const existing = this.deps.legStateRepo.get(p.position.tokenId);
      recordLegStateClearTransition({
        transitionRepo: this.deps.legStateTransitionRepo,
        tokenId: p.position.tokenId,
        existing,
        positionId: p.position.positionId,
        action: "CLEAR",
        reason: "position_size_zero",
        occurredAt: p.position.updatedAt,
        log: this.log,
      });
      this.deps.legStateRepo.delete(p.position.tokenId);
      await this.deps.bus.publish("LegStateCleared", {
        tokenId: p.position.tokenId,
        reason: "position_size_zero",
        timestamp: Date.parse(p.position.updatedAt),
      });
      this.log.info(
        { tokenId: String(p.position.tokenId) },
        "leg state cleared after position sold to zero",
      );
    }
  }

  private async handleSettled(
    p: import("@krabs/domain").RuntimeEventMap["PositionSettled"],
  ): Promise<void> {
    const existing = this.deps.legStateRepo.get(p.tokenId);
    recordLegStateClearTransition({
      transitionRepo: this.deps.legStateTransitionRepo,
      tokenId: p.tokenId,
      existing,
      positionId: p.positionId,
      action: "SETTLE",
      reason: `position_settled:${p.resolution}`,
      occurredAt: new Date(p.timestamp).toISOString(),
      log: this.log,
    });
    this.deps.legStateRepo.delete(p.tokenId);
    await this.deps.bus.publish("LegStateCleared", {
      tokenId: p.tokenId,
      reason: `position_settled:${p.resolution}`,
      timestamp: p.timestamp,
    });
    this.log.info({ tokenId: String(p.tokenId) }, "leg state cleared after settlement");
  }

  private runTransitionBackfill(): void {
    if (!this.deps.transitionBackfill) return;
    try {
      this.deps.transitionBackfill();
    } catch (err) {
      this.log.warn({ err }, "leg phase transition backfill failed");
    }
  }
}
