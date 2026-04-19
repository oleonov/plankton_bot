import type {
  RuntimeModule,
  EventBus,
  OperatorCommandRepository,
  OperatorActionRepository,
  StateTransitionRepository,
  OperatorCommand,
} from "@plankton/domain";
import type { Logger } from "../logger.js";

export interface ReloadableRules {
  reload(): void;
}

export interface PatternRebuilder {
  rebuildPatterns(): void;
}

export interface CommandPollerDeps {
  commandRepo: OperatorCommandRepository;
  actionRepo: OperatorActionRepository;
  bus: EventBus;
  log: Logger;
  getPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  pollIntervalMs?: number;

  rulesManager?: ReloadableRules;
  normalizationModule?: PatternRebuilder;
  stateTransitionRepo?: StateTransitionRepository;
}

export class CommandPoller implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private readonly deps: CommandPollerDeps & { pollIntervalMs: number };
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

        case "rules_reload":
          this.applyRulesReload(now);
          this.writeAudit(cmd, "bot", "runtime", now);
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

  private applyRulesReload(_now: string): void {
    if (!this.deps.rulesManager) {
      throw new Error("rules_reload requires rulesManager dep");
    }
    this.deps.rulesManager.reload();
    this.deps.normalizationModule?.rebuildPatterns();
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
