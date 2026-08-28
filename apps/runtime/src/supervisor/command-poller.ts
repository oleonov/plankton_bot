import type {
  RuntimeModule,
  EventBus,
  OperatorCommandRepository,
  OperatorActionRepository,
  StateTransitionRepository,
  OperatorCommand,
} from "@krabs/domain";
import type { Logger } from "../logger.js";
import {
  canonicalInstant,
  type MakerBuyFastCancel,
} from "../modules/execution/maker-buy-fast-cancel.js";
import type { MissingBounceExitRecoveryResult } from "../modules/execution/execution-module.js";

export interface ReloadableRules {
  reload(): void;
}

export interface PatternRebuilder {
  rebuildPatterns(): void;
}

type PermanentR23ActivationResult =
  | { status: "rejected"; reason: string }
  | { status: "applied"; activationId: string; completedAt: string };
type PermanentR23FenceResult =
  | { status: "fenced"; activationId: string }
  | { status: "pending"; reason: string }
  | { status: "rejected"; reason: string };

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
  makerBuyFastCancel?: MakerBuyFastCancel;
  recoverMissingBounceExit?: (
    predecessorOrderId: string,
    operatorCommandId: number,
  ) => Promise<MissingBounceExitRecoveryResult>;
  authorizeResume?: () => Promise<boolean>;
  activatePermanentR23?: (
    command: OperatorCommand,
    expectedVersion: number,
  ) => PermanentR23ActivationResult | Promise<PermanentR23ActivationResult>;
  fencePermanentR23Deactivation?: (
    command: OperatorCommand,
    expectedVersion: number,
    activationId: string,
  ) => PermanentR23FenceResult | Promise<PermanentR23FenceResult>;
  finalizePermanentR23Deactivation?: (
    command: OperatorCommand,
    activationId: string,
    completedAt: string,
  ) => PermanentR23ActivationResult | Promise<PermanentR23ActivationResult>;
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
          if (this.deps.authorizeResume && !(await this.deps.authorizeResume())) {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
            return;
          }
          this.deps.setPaused(false);
          this.writeAudit(cmd, "bot", "runtime", now);
          break;

        case "rules_reload":
          this.applyRulesReload(now);
          this.writeAudit(cmd, "bot", "runtime", now);
          break;

        case "cancel_maker_buys": {
          const targetId = cmd.targetId;
          if (
            targetId == null ||
            canonicalInstant(targetId) == null ||
            !this.deps.makerBuyFastCancel
          ) {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
            return;
          }
          const result = await this.deps.makerBuyFastCancel.cancelSince(
            targetId,
            async (completedAt) => {
              this.writeAudit(cmd, "bot", targetId, completedAt);
              this.deps.commandRepo.updateStatus(cmd.id, "applied", completedAt);
              await this.publishApplied(cmd, completedAt);
            },
          );
          if (result === "deferred") return;
          if (result === "rejected") {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", new Date().toISOString());
            return;
          }
          this.log.info({ id: cmd.id, action: cmd.action }, "command applied");
          return;
        }

        case "recover_missing_bounce_exit": {
          const targetId = cmd.targetId;
          if (!targetId || !this.deps.recoverMissingBounceExit) {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
            return;
          }
          const result = await this.deps.recoverMissingBounceExit(targetId, cmd.id);
          if (result.status === "deferred") return;
          if (result.status === "rejected") {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", new Date().toISOString());
            return;
          }
          this.writeAudit(cmd, "order", targetId, result.completedAt);
          this.deps.commandRepo.updateStatus(cmd.id, "applied", result.completedAt);
          await this.publishApplied(cmd, result.completedAt);
          this.log.info({ id: cmd.id, action: cmd.action }, "command applied");
          return;
        }

        case "activate_permanent_r23": {
          const target = parseActivationTarget(cmd.targetId);
          if (!target || !this.deps.activatePermanentR23) {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
            return;
          }
          const result = await this.deps.activatePermanentR23(cmd, target.expectedVersion);
          if (result.status === "rejected") {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", new Date().toISOString());
            return;
          }
          await this.publishDurableApplied(cmd, result.completedAt);
          return;
        }

        case "deactivate_permanent_r23": {
          const target = parseDeactivationTarget(cmd.targetId);
          if (
            !target ||
            !this.deps.fencePermanentR23Deactivation ||
            !this.deps.finalizePermanentR23Deactivation ||
            !this.deps.makerBuyFastCancel
          ) {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
            return;
          }
          const fence = await this.deps.fencePermanentR23Deactivation(
            cmd,
            target.expectedVersion,
            target.activationId,
          );
          if (fence.status === "pending") return;
          if (fence.status === "rejected") {
            this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
            return;
          }
          let appliedAt: string | null = null;
          let drained: "applied" | "deferred" | "rejected";
          try {
            drained = await this.deps.makerBuyFastCancel.cancelPermanentActivation(
              target.activationId,
              async (completedAt) => {
                const result = await this.deps.finalizePermanentR23Deactivation!(
                  cmd,
                  target.activationId,
                  completedAt,
                );
                if (result.status === "applied") appliedAt = result.completedAt;
              },
            );
          } catch (err) {
            this.log.error({ id: cmd.id, err }, "fenced deactivation drain failed -- retrying");
            return;
          }
          if (drained !== "applied" || appliedAt === null) return;
          await this.publishDurableApplied(cmd, appliedAt);
          return;
        }

        default:
          this.log.warn({ action: cmd.action }, "unknown command action -- rejecting");
          this.deps.commandRepo.updateStatus(cmd.id, "rejected", now);
          return;
      }

      this.deps.commandRepo.updateStatus(cmd.id, "applied", now);
      this.log.info({ id: cmd.id, action: cmd.action }, "command applied");

      await this.publishApplied(cmd, now);
    } catch (err) {
      this.log.error({ id: cmd.id, action: cmd.action, err }, "command failed -- rejecting");
      this.deps.commandRepo.updateStatus(cmd.id, "rejected", new Date().toISOString());
    }
  }

  private async publishApplied(cmd: OperatorCommand, appliedAt: string): Promise<void> {
    await this.deps.bus.publish("OperatorCommandApplied", {
      commandDbId: cmd.id,
      action: cmd.action,
      reason: cmd.reason,
      initiatorType: cmd.initiatorType,
      initiator: cmd.initiator,
      appliedAt: new Date(appliedAt).getTime(),
    });
  }

  private async publishDurableApplied(cmd: OperatorCommand, appliedAt: string): Promise<void> {
    try {
      await this.publishApplied(cmd, appliedAt);
    } catch (err) {
      this.log.error({ id: cmd.id, action: cmd.action, err }, "durable command event failed");
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

function parseActivationTarget(value: string | null): { expectedVersion: number } | null {
  try {
    const parsed = JSON.parse(value ?? "null") as Record<string, unknown> | null;
    return parsed &&
      Object.keys(parsed).length === 1 &&
      Number.isSafeInteger(parsed.expectedVersion) &&
      Number(parsed.expectedVersion) >= 0
      ? { expectedVersion: Number(parsed.expectedVersion) }
      : null;
  } catch {
    return null;
  }
}

function parseDeactivationTarget(
  value: string | null,
): { expectedVersion: number; activationId: string } | null {
  try {
    const parsed = JSON.parse(value ?? "null") as Record<string, unknown> | null;
    return parsed &&
      Object.keys(parsed).length === 2 &&
      Number.isSafeInteger(parsed.expectedVersion) &&
      Number(parsed.expectedVersion) >= 0 &&
      typeof parsed.activationId === "string" &&
      parsed.activationId.trim() === parsed.activationId &&
      parsed.activationId.length > 0
      ? { expectedVersion: Number(parsed.expectedVersion), activationId: parsed.activationId }
      : null;
  } catch {
    return null;
  }
}
