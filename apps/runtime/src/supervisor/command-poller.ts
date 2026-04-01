import type {
  RuntimeModule,
  EventBus,
  OperatorCommandRepository,
  OperatorActionRepository,
  FamilyStateRepository,
  FamilyEvidenceRepository,
  FamilyRulesSnapshotRepository,
  FamilyCandidateRepository,
  StateTransitionRepository,
  OperatorCommand,
  RuntimeMode,
  PromotionState,
} from "@plankton/domain";
import { createFamilyId } from "@plankton/domain";
import type { Logger } from "../logger.js";

/** Minimal interface for the reloadable rules manager. */
export interface ReloadableRules {
  reload(): void;
}

/** Minimal interface for the normalization module's pattern cache. */
export interface PatternRebuilder {
  rebuildPatterns(): void;
}

/** Minimal interface for the DB family rules repository (overwrite on reset / promote). */
export interface FamilyRulesDbWriter {
  overwriteRules(familyId: import("@plankton/domain").FamilyId, rulesJson: string): void;
  updateToScaledDefaults(
    familyId: import("@plankton/domain").FamilyId,
    caps?: { maxOpenValueUsdc?: number; maxActiveMarkets?: number; maxDustPositions?: number },
  ): void;
}

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

  // ── Optional deps for discovery commands ─────────────────────────────
  rulesManager?: ReloadableRules;
  normalizationModule?: PatternRebuilder;
  familyEvidenceRepo?: FamilyEvidenceRepository;
  familyRulesSnapshotRepo?: FamilyRulesSnapshotRepository;
  familyCandidateRepo?: FamilyCandidateRepository;
  stateTransitionRepo?: StateTransitionRepository;
  familyRulesDbWriter?: FamilyRulesDbWriter;
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
      // Capture previous lifecycle state BEFORE applying changes (needed for transitions)
      const previousPromotionState = cmd.targetId
        ? (this.deps.familyEvidenceRepo?.getEvidence(createFamilyId(cmd.targetId))
            ?.promotionState ?? "unknown")
        : "unknown";

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
          this.syncPromotionState(cmd, "reduce-only");
          break;

        case "family_quarantine":
          this.applyFamilyModeChange(cmd, "quarantine", now);
          this.syncPromotionState(cmd, "quarantine");
          break;

        case "family_activate":
          this.applyFamilyModeChange(cmd, "active", now);
          break;

        case "rules_reload":
          this.applyRulesReload(now);
          this.writeAudit(cmd, "bot", "runtime", now);
          break;

        case "family_promote_scaled":
          this.applyPromoteScaled(cmd, now);
          break;

        case "family_reset_to_probe":
          this.applyResetToProbe(cmd, now);
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

      // System-initiated demotions: write state transition and publish event
      if (
        cmd.initiatorType === "system" &&
        cmd.targetId &&
        (cmd.action === "family_reduce_only" || cmd.action === "family_quarantine")
      ) {
        const newState = cmd.action === "family_reduce_only" ? "reduce-only" : "quarantine";

        this.deps.stateTransitionRepo?.insert({
          entityType: "family",
          entityId: cmd.targetId,
          fromState: previousPromotionState,
          toState: newState,
          triggerType: cmd.initiatorType,
          initiator: cmd.initiator ?? null,
          reason: cmd.reason ?? "system demotion",
          scoresSnapshot: null,
        });

        await this.deps.bus.publish("FamilyDemotionApplied", {
          familyId: createFamilyId(cmd.targetId),
          previousState: previousPromotionState,
          newState,
          reason: cmd.reason ?? "system demotion",
          timestamp: Date.now(),
        });
      }
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

  /** Sync promotion_state in family_evidence when runtime mode changes. */
  private syncPromotionState(cmd: OperatorCommand, promotionState: PromotionState): void {
    if (!cmd.targetId || !this.deps.familyEvidenceRepo) return;
    const familyId = createFamilyId(cmd.targetId);
    this.deps.familyEvidenceRepo.updatePromotionState(familyId, promotionState);
    // Transitioning out of probe clears substate
    this.deps.familyEvidenceRepo.updateProbeSubstate(familyId, null);
  }

  private applyRulesReload(_now: string): void {
    if (!this.deps.rulesManager) {
      throw new Error("rules_reload requires rulesManager dep");
    }
    this.deps.rulesManager.reload();
    this.deps.normalizationModule?.rebuildPatterns();

    // Promote materialized candidates to deployed
    if (this.deps.familyCandidateRepo) {
      const materialized = this.deps.familyCandidateRepo.findByStatus("materialized");
      for (const c of materialized) {
        this.deps.familyCandidateRepo.updateStatus(c.candidateId, "deployed");
      }
      if (materialized.length > 0) {
        this.log.info(
          { count: materialized.length },
          "promoted materialized candidates to deployed",
        );
      }
    }
  }

  private applyPromoteScaled(cmd: OperatorCommand, now: string): void {
    if (!cmd.targetId) {
      throw new Error("family_promote_scaled requires targetId (familyId)");
    }
    const familyId = createFamilyId(cmd.targetId);

    const state = this.deps.familyStateRepo.get(familyId);
    if (!state) {
      throw new Error(`Family ${cmd.targetId} not found in runtime state`);
    }

    // Update family_rules to scaled defaults before reloading
    if (!this.deps.familyRulesDbWriter) {
      throw new Error("family_promote_scaled requires familyRulesDbWriter dep");
    }

    // Parse optional caps from reason JSON (set by promote API)
    let caps:
      | { maxOpenValueUsdc?: number; maxActiveMarkets?: number; maxDustPositions?: number }
      | undefined;
    if (cmd.reason) {
      try {
        const parsed = JSON.parse(cmd.reason) as { caps?: typeof caps };
        caps = parsed.caps;
      } catch {
        // reason is plain text, not JSON — use defaults
      }
    }
    this.deps.familyRulesDbWriter.updateToScaledDefaults(familyId, caps);

    // Reload rules to pick up the DB changes
    this.deps.rulesManager?.reload();
    this.deps.normalizationModule?.rebuildPatterns();

    // Set runtime_mode to active
    this.deps.familyStateRepo.save({
      ...state,
      runtimeMode: "active",
      quarantineReason: null,
      updatedAt: now,
    });

    // Read previous promotion state before updating
    const prevPromotionState =
      this.deps.familyEvidenceRepo?.getEvidence(familyId)?.promotionState ?? "unknown";

    // Set promotion_state to scaled, clear probe substate
    this.deps.familyEvidenceRepo?.updatePromotionState(familyId, "scaled");
    this.deps.familyEvidenceRepo?.updateProbeSubstate(familyId, null);

    // Write state transition using lifecycle states
    this.deps.stateTransitionRepo?.insert({
      entityType: "family",
      entityId: cmd.targetId,
      fromState: prevPromotionState,
      toState: "scaled",
      triggerType: cmd.initiatorType,
      initiator: cmd.initiator ?? null,
      reason: cmd.reason ?? "promote to scaled",
      scoresSnapshot: null,
    });

    this.writeAudit(cmd, "family", cmd.targetId, now);
  }

  private applyResetToProbe(cmd: OperatorCommand, now: string): void {
    if (!cmd.targetId) {
      throw new Error("family_reset_to_probe requires targetId (familyId)");
    }
    const familyId = createFamilyId(cmd.targetId);

    const state = this.deps.familyStateRepo.get(familyId);
    if (!state) {
      throw new Error(`Family ${cmd.targetId} not found in runtime state`);
    }

    // Read probe-baseline snapshot
    if (!this.deps.familyRulesSnapshotRepo) {
      throw new Error("family_reset_to_probe requires familyRulesSnapshotRepo dep");
    }
    const snapshot = this.deps.familyRulesSnapshotRepo.findLatest(familyId);
    if (!snapshot) {
      throw new Error(`No probe-baseline snapshot found for family ${cmd.targetId}`);
    }

    // Overwrite family_rules with snapshot JSON
    if (!this.deps.familyRulesDbWriter) {
      throw new Error("family_reset_to_probe requires familyRulesDbWriter dep");
    }
    this.deps.familyRulesDbWriter.overwriteRules(familyId, snapshot.snapshot);

    // Reload rules and patterns
    this.deps.rulesManager?.reload();
    this.deps.normalizationModule?.rebuildPatterns();

    // Set runtime_mode to active — probe behavior is enforced by entry_mode/scale_mode
    // in the rules, not by runtime_mode. Setting probe-only would block repricing exits.
    this.deps.familyStateRepo.save({
      ...state,
      runtimeMode: "active",
      quarantineReason: null,
      updatedAt: now,
    });

    // Read previous promotion state before updating
    const prevPromotionState =
      this.deps.familyEvidenceRepo?.getEvidence(familyId)?.promotionState ?? "unknown";

    // Set promotion_state to probe-only with reset substate
    this.deps.familyEvidenceRepo?.updatePromotionState(familyId, "probe-only");
    this.deps.familyEvidenceRepo?.updateProbeSubstate(familyId, "reset-probe");

    // Write state transition using lifecycle states
    this.deps.stateTransitionRepo?.insert({
      entityType: "family",
      entityId: cmd.targetId,
      fromState: prevPromotionState,
      toState: "probe-only",
      triggerType: cmd.initiatorType,
      initiator: cmd.initiator ?? null,
      reason: cmd.reason ?? "reset to probe",
      scoresSnapshot: snapshot.snapshot,
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
