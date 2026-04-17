import type { EventBus, LegStateRepository, RuntimeModule } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { updateLegStateForFill } from "./update-leg-state-for-fill.js";

export interface LegStateTrackerModuleDeps {
  bus: EventBus;
  legStateRepo: LegStateRepository;
  log: Logger;
}

export class LegStateTrackerModule implements RuntimeModule {
  private readonly log: Logger;
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: LegStateTrackerModuleDeps) {
    this.log = deps.log.child({ module: "leg-state-tracker" });
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("FillReceived", (p) => this.handleFill(p)),
      this.deps.bus.subscribe("PositionUpdated", (p) => this.handlePositionUpdated(p)),
      this.deps.bus.subscribe("PositionSettled", (p) => this.handleSettled(p)),
    );
    this.log.info("leg-state-tracker module started");
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
    p: import("@plankton/domain").RuntimeEventMap["FillReceived"],
  ): Promise<void> {
    updateLegStateForFill(
      this.deps.legStateRepo,
      {
        tokenId: p.tokenId,
        side: p.side,
        price: p.price,
        filledAt: new Date(p.timestamp).toISOString(),
      },
      this.log,
      new Date().toISOString(),
    );
  }

  private async handlePositionUpdated(
    p: import("@plankton/domain").RuntimeEventMap["PositionUpdated"],
  ): Promise<void> {
    if (p.position.size === 0) {
      this.deps.legStateRepo.delete(p.position.tokenId);
      this.log.info(
        { tokenId: String(p.position.tokenId) },
        "leg state cleared after position sold to zero",
      );
    }
  }

  private async handleSettled(
    p: import("@plankton/domain").RuntimeEventMap["PositionSettled"],
  ): Promise<void> {
    this.deps.legStateRepo.delete(p.tokenId);
    this.log.info({ tokenId: String(p.tokenId) }, "leg state cleared after settlement");
  }
}
