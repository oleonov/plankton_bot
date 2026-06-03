import type { EventBus, RuntimeEventMap, RuntimeModule, TokenId } from "@krabs/domain";
import type { HoldResolutionStatus } from "@krabs/db";
import type { Logger } from "../../logger.js";

export interface HoldResolutionCleanupRepository {
  transitionActive(
    tokenId: TokenId,
    input: {
      readonly status: Exclude<HoldResolutionStatus, "active">;
      readonly clearedAt?: string | null;
      readonly clearReason?: string | null;
    },
  ): boolean;
}

export interface HoldResolutionCleanupModuleDeps {
  readonly bus: EventBus;
  readonly holdResolutionRepo: HoldResolutionCleanupRepository;
  readonly log: Logger;
}

export class HoldResolutionCleanupModule implements RuntimeModule {
  private readonly log: Logger;
  private unsubs: Array<() => void> = [];

  constructor(private readonly deps: HoldResolutionCleanupModuleDeps) {
    this.log = deps.log.child({ module: "hold-resolution-cleanup" });
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("PositionSettled", (event) => this.handlePositionSettled(event)),
      this.deps.bus.subscribe("PositionUpdated", (event) => this.handlePositionUpdated(event)),
      this.deps.bus.subscribe("FillReceived", (event) => this.handleFillReceived(event)),
    );
    this.log.info("hold-resolution cleanup module started");
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.log.info("hold-resolution cleanup module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true };
  }

  private async handlePositionSettled(event: RuntimeEventMap["PositionSettled"]): Promise<void> {
    const recovered = event.settlementPrice > 0;
    this.transition(event.tokenId, {
      status: recovered ? "recovered" : "resolved_zero_loss",
      clearedAt: new Date(event.timestamp).toISOString(),
      clearReason: recovered ? "position_settled_recovered" : "position_settled_zero_loss",
    });
  }

  private async handlePositionUpdated(event: RuntimeEventMap["PositionUpdated"]): Promise<void> {
    if (event.position.status !== "closed") return;
    const closedAtMs = Date.parse(event.position.closedAt ?? event.position.updatedAt);
    this.transition(event.position.tokenId, {
      status: "cancelled",
      clearedAt: new Date(Number.isFinite(closedAtMs) ? closedAtMs : Date.now()).toISOString(),
      clearReason: "position_closed",
    });
  }

  private async handleFillReceived(event: RuntimeEventMap["FillReceived"]): Promise<void> {
    if (event.side !== "sell") return;
    this.transition(event.tokenId, {
      status: "cancelled",
      clearedAt: new Date(event.timestamp).toISOString(),
      clearReason: "sell_fill_received",
    });
  }

  private transition(
    tokenId: TokenId,
    input: {
      readonly status: Exclude<HoldResolutionStatus, "active">;
      readonly clearedAt: string;
      readonly clearReason: string;
    },
  ): void {
    try {
      const transitioned = this.deps.holdResolutionRepo.transitionActive(tokenId, input);
      if (!transitioned) return;
      this.log.info(
        { tokenId: String(tokenId), status: input.status, clearReason: input.clearReason },
        "hold-resolution state transitioned",
      );
    } catch (err) {
      this.log.error(
        { err, tokenId: String(tokenId), status: input.status, clearReason: input.clearReason },
        "hold-resolution cleanup transition failed",
      );
    }
  }
}
