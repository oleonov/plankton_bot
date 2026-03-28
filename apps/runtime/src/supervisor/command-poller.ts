import type {
  RuntimeModule,
  EventBus,
  OperatorCommandRepository,
  OperatorActionRepository,
  FamilyStateRepository,
  OperatorCommand,
  RuntimeMode,
} from "@plankton/domain";
import { createFamilyId } from "@plankton/domain";
import type { Logger } from "../logger.js";

export interface CommandPollerDeps {
  commandRepo: OperatorCommandRepository;
  actionRepo: OperatorActionRepository;
  familyStateRepo: FamilyStateRepository;
  bus: EventBus;
  log: Logger;
  /** Reference to supervisor pause state -- getter/setter pair */
  getPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  /** Polling interval in ms. Default: 5000 */
  pollIntervalMs?: number;
}

export class CommandPoller implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly deps: Required<Omit<CommandPollerDeps, "pollIntervalMs">> & {
    pollIntervalMs: number;
  };
  private readonly log: Logger;

  constructor(deps: CommandPollerDeps) {
    this.deps = { pollIntervalMs: 5_000, ...deps };
    this.log = deps.log.child({ component: "command-poller" });
  }

  async start(): Promise<void> {
    this.log.info({ intervalMs: this.deps.pollIntervalMs }, "starting command poller");
    await this.poll();
    this.timer = setInterval(() => {
      this.poll().catch((err) => this.log.error({ err }, "poll error"));
    }, this.deps.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("command poller stopped");
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true, detail: "poller active" };
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const pending = this.deps.commandRepo.getPending();
      if (pending.length === 0) return;

      this.log.info({ count: pending.length }, "processing pending commands");

      for (const cmd of pending) {
        await this.applyCommand(cmd);
      }
    } finally {
      this.polling = false;
    }
  }

  private async applyCommand(cmd: OperatorCommand): Promise<void> {
    const now = new Date().toISOString();
    try {
      switch (cmd.action) {
        case "pause":
          this.deps.setPaused(true);
          this.writeAudit(cmd, "bot", "runtime", now);
          break;

        case "resume":
          this.deps.setPaused(false);
          this.writeAudit(cmd, "bot", "runtime", now);
          break;

        case "family_reduce_only":
          this.applyFamilyModeChange(cmd, "reduce-only", now);
          break;

        case "family_quarantine":
          this.applyFamilyModeChange(cmd, "quarantine", now);
          break;

        case "family_activate":
          this.applyFamilyModeChange(cmd, "active", now);
          break;

        default:
          this.log.warn({ action: cmd.action }, "unknown command action -- rejecting");
          this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
          return;
      }

      this.deps.commandRepo.updateStatus(cmd.id, "applied", now);
      this.log.info({ id: cmd.id, action: cmd.action }, "command applied");

      await this.deps.bus.publish("OperatorCommandApplied", {
        commandDbId: cmd.id,
        action: cmd.action,
        targetFamilyId: cmd.targetId ? createFamilyId(cmd.targetId) : null,
        reason: cmd.reason,
        initiatorType: cmd.initiatorType,
        initiator: cmd.initiator,
        appliedAt: Date.now(),
      });
    } catch (err) {
      this.log.error({ id: cmd.id, action: cmd.action, err }, "command failed -- rejecting");
      this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
    }
  }

  private applyFamilyModeChange(cmd: OperatorCommand, targetMode: RuntimeMode, now: string): void {
    if (!cmd.targetId) {
      throw new Error(`${cmd.action} requires targetId (familyId)`);
    }

    const familyId = createFamilyId(cmd.targetId);
    const state = this.deps.familyStateRepo.get(familyId);

    if (!state) {
      throw new Error(`Family ${cmd.targetId} not found in runtime state`);
    }

    this.deps.familyStateRepo.save({
      ...state,
      runtimeMode: targetMode,
      quarantineReason: targetMode === "quarantine" ? (cmd.reason ?? "operator command") : null,
      updatedAt: now,
    });

    this.writeAudit(cmd, "family", cmd.targetId, now);
  }

  private writeAudit(
    cmd: OperatorCommand,
    targetType: "bot" | "family" | "market" | "order",
    targetId: string,
    now: string,
  ): void {
    this.deps.actionRepo.insert({
      action: cmd.action,
      targetType,
      targetId,
      reason: cmd.reason,
      performedAt: now,
    });
  }
}
