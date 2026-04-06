/**
 * RuntimeSafetyEvaluator -- RuntimeModule that periodically evaluates
 * deployed families for toxicity-based demotion and execution canary freezes.
 * Syncs control-plane deployment mode with runtime_state and family_evidence.
 *
 * Extracted from FamilyEvidenceEngine to separate scoring (evidence)
 * from safety enforcement (this module).
 */

import type { EventBus, RuntimeModule } from "@plankton/domain";
import type {
  FamilyDeploymentRepository,
  FamilyEvidenceRepository,
  FamilyStateRepository,
  FamilyRulesProvider,
  StateTransitionRepository,
  StateTransition,
} from "@plankton/domain";
import {
  computeToxicityPenalty,
  evaluateExecutionCanaryGate,
  OperatorMode,
  ProfileId,
  PromotionState,
} from "@plankton/domain";
import type { FamilyId, FamilyIdentity, FamilyState, RuntimeMode } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { ScoreComputer } from "../evidence/score-computer.js";
import type { ValidationMetricsReader } from "../publisher/validation-metrics-reader.js";

const DEFAULT_EVAL_INTERVAL_MS = 3_600_000; // 1 hour
const TOXICITY_DEMOTION_THRESHOLD = 0.6;

const DEMOTION_WINDOWS: Record<string, number> = {
  "intraday-4h": 2,
  daily: 5,
  deadline: 10,
  "ad-hoc": 7,
};

export interface SafetyEvaluatorDeps {
  bus: EventBus;
  log: Logger;
  scoreComputer: ScoreComputer;
  executionTelemetryReader: Pick<ValidationMetricsReader, "readExecutionTelemetry">;
  deploymentRepo: FamilyDeploymentRepository;
  stateTransitionRepo: StateTransitionRepository;
  familyStateRepo: FamilyStateRepository;
  familyEvidenceRepo: FamilyEvidenceRepository;
  rulesProvider: FamilyRulesProvider;
  activeProfile: ProfileId;
  evalIntervalMs?: number;
}

export class RuntimeSafetyEvaluator implements RuntimeModule {
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly sc: ScoreComputer;
  private readonly executionTelemetryReader: Pick<
    ValidationMetricsReader,
    "readExecutionTelemetry"
  >;
  private readonly deploymentRepo: FamilyDeploymentRepository;
  private readonly stateTransitionRepo: StateTransitionRepository;
  private readonly familyStateRepo: FamilyStateRepository;
  private readonly familyEvidenceRepo: FamilyEvidenceRepository;
  private readonly rulesProvider: FamilyRulesProvider;
  private readonly activeProfile: ProfileId;
  private readonly intervalMs: number;

  private unsubscribers: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastEvalAt: string | null = null;
  /** Tracks wall-clock ISO timestamp when tail first went negative per family. */
  private firstNegativeTailAt = new Map<string, string>();
  /** Consecutive clean evaluation passes per family (for auto-recovery hysteresis). */
  private readonly consecutiveCleanCounts = new Map<string, number>();

  constructor(deps: SafetyEvaluatorDeps) {
    this.bus = deps.bus;
    this.log = deps.log;
    this.sc = deps.scoreComputer;
    this.executionTelemetryReader = deps.executionTelemetryReader;
    this.deploymentRepo = deps.deploymentRepo;
    this.stateTransitionRepo = deps.stateTransitionRepo;
    this.familyStateRepo = deps.familyStateRepo;
    this.familyEvidenceRepo = deps.familyEvidenceRepo;
    this.rulesProvider = deps.rulesProvider;
    this.activeProfile = deps.activeProfile;
    this.intervalMs = deps.evalIntervalMs ?? DEFAULT_EVAL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    this.unsubscribers = [
      this.bus.subscribe("ReconciliationComplete", async () => {
        this.log.info("ReconciliationComplete -- safety re-evaluation triggered");
        await this.evaluate();
      }),
    ];

    this.timer = setInterval(() => {
      this.evaluate().catch((err) => this.log.error({ err }, "safety evaluation failed"));
    }, this.intervalMs);

    await this.evaluate();
    this.log.info("RuntimeSafetyEvaluator started");
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log.info("RuntimeSafetyEvaluator stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true, detail: `lastEval=${this.lastEvalAt ?? "never"}` };
  }

  // ─── Core evaluation ────────────────────────────────────────────────────

  async evaluate(): Promise<void> {
    const families = this.rulesProvider.getAllFamilies();

    for (const identity of families) {
      const familyId = identity.familyId;
      const familyIdStr = String(familyId);

      const toxicityMetrics = this.sc.computeToxicityMetrics(familyIdStr);
      const toxicity = computeToxicityPenalty(toxicityMetrics);

      const recycleMetrics = this.sc.computeRecycleMetrics(familyIdStr);

      await this.checkDemotion(identity, {
        toxicity,
        tailAdjustedPnl: recycleMetrics.tailAdjustedPnl,
      });

      await this.checkRecovery(familyId, identity, toxicity, recycleMetrics.tailAdjustedPnl);
    }

    this.lastEvalAt = new Date().toISOString();
  }

  // ─── Demotion logic ─────────────────────────────────────────────────────

  private async checkDemotion(
    identity: FamilyIdentity,
    metrics: {
      toxicity: number;
      tailAdjustedPnl: number;
    },
  ): Promise<void> {
    const familyId = identity.familyId;
    const deployment = this.deploymentRepo.find(familyId, this.activeProfile);
    const currentMode = deployment?.operatorMode ?? OperatorMode.Active;

    if (currentMode === OperatorMode.Quarantine) return;

    // Already reduce-only -- only escalate to quarantine
    if (currentMode === OperatorMode.ReduceOnly) {
      if (metrics.toxicity > 0.8) {
        await this.applyDemotion(
          familyId,
          "reduce-only",
          OperatorMode.Quarantine,
          `escalation from reduce-only: severe toxicity ${metrics.toxicity.toFixed(2)}`,
        );
      }
      return;
    }

    // Threshold regime: immediate quarantine on negative tail (HR12)
    if (identity.regime === "threshold" && metrics.tailAdjustedPnl < 0) {
      await this.applyDemotion(
        familyId,
        "active",
        OperatorMode.Quarantine,
        `threshold regime, negative tail ${metrics.tailAdjustedPnl.toFixed(2)} (HR12)`,
      );
      return;
    }

    // Toxicity > 0.8: quarantine
    if (metrics.toxicity > 0.8) {
      await this.applyDemotion(
        familyId,
        "active",
        OperatorMode.Quarantine,
        `severe toxicity ${metrics.toxicity.toFixed(2)}`,
      );
      return;
    }

    // Toxicity > 0.6: reduce-only
    if (metrics.toxicity > TOXICITY_DEMOTION_THRESHOLD) {
      await this.applyDemotion(
        familyId,
        "active",
        OperatorMode.ReduceOnly,
        `toxicity ${metrics.toxicity.toFixed(2)}`,
      );
      return;
    }

    if (this.activeProfile === ProfileId.LiveLite) {
      const executionCanary = evaluateExecutionCanaryGate({
        primaryCategory: identity.primaryCategory,
        feeTier: identity.feeTier ?? null,
        liveWalletRequirement: identity.liveWalletRequirement ?? null,
        requiresPostOnlyForLive: identity.requiresPostOnlyForLive ?? null,
        executionTelemetry: this.executionTelemetryReader.readExecutionTelemetry(String(familyId)),
      });
      if (this.shouldAutoFreezeForExecutionCanary(executionCanary)) {
        await this.applyDemotion(
          familyId,
          "active",
          OperatorMode.ReduceOnly,
          this.formatExecutionCanaryReason(executionCanary),
        );
        return;
      }
    }

    // Horizon-aware negative tail window
    await this.checkNegativeTailWindow(familyId, "active", {
      tailAdjustedPnl: metrics.tailAdjustedPnl,
      horizon: identity.horizon,
    });
  }

  private async checkNegativeTailWindow(
    familyId: FamilyId,
    currentMode: string,
    metrics: { tailAdjustedPnl: number; horizon: string },
  ): Promise<void> {
    const familyIdStr = String(familyId);

    if (metrics.tailAdjustedPnl < 0) {
      const windowDays = DEMOTION_WINDOWS[metrics.horizon] ?? 7;

      // Record wall-clock time when tail first went negative (persist to DB)
      if (!this.firstNegativeTailAt.has(familyIdStr)) {
        const state = this.familyStateRepo.get(familyId);
        if (state?.firstNegativeTailAt) {
          this.firstNegativeTailAt.set(familyIdStr, state.firstNegativeTailAt);
        } else {
          const now = new Date().toISOString();
          this.firstNegativeTailAt.set(familyIdStr, now);
          if (state) {
            this.familyStateRepo.save({ ...state, firstNegativeTailAt: now });
          }
        }
      }

      const firstNegAt = new Date(this.firstNegativeTailAt.get(familyIdStr)!);
      const elapsedHours = (Date.now() - firstNegAt.getTime()) / 3_600_000;
      const windowHours = windowDays * 24;

      if (elapsedHours >= windowHours) {
        await this.applyDemotion(
          familyId,
          currentMode,
          OperatorMode.ReduceOnly,
          `persistent negative tail ${metrics.tailAdjustedPnl.toFixed(2)} for ${elapsedHours.toFixed(0)}h (${metrics.horizon} window: ${windowDays}d)`,
        );
      }
    } else {
      // Tail recovered -- clear timestamp from memory and DB
      if (this.firstNegativeTailAt.has(familyIdStr)) {
        this.firstNegativeTailAt.delete(familyIdStr);
        const state = this.familyStateRepo.get(familyId);
        if (state?.firstNegativeTailAt) {
          this.familyStateRepo.save({ ...state, firstNegativeTailAt: null });
        }
      }
    }
  }

  // ─── Auto-recovery from system-induced reduce-only ─────────────────────

  private async checkRecovery(
    familyId: FamilyId,
    identity: FamilyIdentity,
    toxicity: number,
    tailAdjustedPnl: number,
  ): Promise<void> {
    const familyState = this.familyStateRepo.get(familyId);
    if (!familyState || familyState.runtimeMode !== "reduce-only") {
      this.consecutiveCleanCounts.delete(String(familyId));
      return;
    }

    const lastDemotion = this.stateTransitionRepo.findLastTransitionTo(
      String(familyId),
      "reduce-only",
      this.activeProfile,
    );
    if (!lastDemotion || lastDemotion.triggerType !== "system") return;

    const demotionAgeMs = Date.now() - new Date(lastDemotion.createdAt).getTime();
    if (demotionAgeMs < 24 * 60 * 60 * 1000) return;

    const key = String(familyId);

    // Metrics gate: toxicity, tail PnL, and execution canary must all be clean
    if (toxicity >= 0.3 || tailAdjustedPnl < 0) {
      this.consecutiveCleanCounts.delete(key);
      return;
    }

    // Execution canary must pass (live-lite only)
    if (this.activeProfile === ProfileId.LiveLite) {
      const canary = evaluateExecutionCanaryGate({
        primaryCategory: identity.primaryCategory,
        feeTier: identity.feeTier ?? null,
        liveWalletRequirement: identity.liveWalletRequirement ?? null,
        requiresPostOnlyForLive: identity.requiresPostOnlyForLive ?? null,
        executionTelemetry: this.executionTelemetryReader.readExecutionTelemetry(String(familyId)),
      });
      if (this.shouldAutoFreezeForExecutionCanary(canary)) {
        this.consecutiveCleanCounts.delete(key);
        return;
      }
    }

    const cleanCount = (this.consecutiveCleanCounts.get(key) ?? 0) + 1;
    this.consecutiveCleanCounts.set(key, cleanCount);
    if (cleanCount < 2) return;

    await this.applyRecovery(familyId, familyState, lastDemotion);
  }

  private async applyRecovery(
    familyId: FamilyId,
    state: FamilyState,
    lastDemotion: StateTransition,
  ): Promise<void> {
    const previousPromotionState = lastDemotion.fromState as PromotionState;
    const now = new Date().toISOString();

    this.familyStateRepo.save({
      ...state,
      runtimeMode: "active",
      quarantineReason: null,
      updatedAt: now,
    });

    this.deploymentRepo.updateOperatorMode(
      familyId,
      this.activeProfile,
      OperatorMode.Active,
      "auto-recovery",
    );

    this.familyEvidenceRepo.updatePromotionState(familyId, previousPromotionState);

    this.stateTransitionRepo.insert({
      entityType: "family",
      entityId: String(familyId),
      profile: this.activeProfile,
      fromState: "reduce-only",
      toState: previousPromotionState,
      triggerType: "system",
      initiator: "safety-evaluator",
      reason: "auto-recovery: metrics clean for 2+ consecutive passes",
      scoresSnapshot: null,
    });

    this.consecutiveCleanCounts.delete(String(familyId));

    this.log.info(
      { familyId: String(familyId), previousState: previousPromotionState },
      "auto-recovered family from reduce-only",
    );
  }

  // ─── Write demotion to deployment + transition ──────────────────────────

  private applyDemotion(
    familyId: FamilyId,
    fallbackFromState: string,
    toMode: typeof OperatorMode.ReduceOnly | typeof OperatorMode.Quarantine,
    reason: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const runtimeMode: RuntimeMode =
      toMode === OperatorMode.Quarantine ? "quarantine" : "reduce-only";
    const previousState =
      this.familyEvidenceRepo.getEvidence(familyId)?.promotionState ?? fallbackFromState;

    this.deploymentRepo.updateOperatorMode(
      familyId,
      this.activeProfile,
      toMode,
      `Auto-demotion: ${reason}`,
    );

    const familyState = this.familyStateRepo.get(familyId);
    if (familyState) {
      this.familyStateRepo.save({
        ...familyState,
        runtimeMode,
        quarantineReason: runtimeMode === "quarantine" ? `Auto-demotion: ${reason}` : null,
        updatedAt: now,
      });
    }

    this.familyEvidenceRepo.updatePromotionState(familyId, runtimeMode);
    this.familyEvidenceRepo.updateProbeSubstate(familyId, null);

    this.stateTransitionRepo.insert({
      entityType: "family",
      entityId: String(familyId),
      profile: this.activeProfile,
      fromState: previousState,
      toState: runtimeMode,
      triggerType: "system",
      initiator: "safety-evaluator",
      reason: `Auto-demotion: ${reason}`,
      scoresSnapshot: null,
    });

    this.log.warn(
      { familyId: String(familyId), fromMode: previousState, toMode: runtimeMode, reason },
      "safety demotion applied",
    );

    return this.bus.publish("FamilyDemotionApplied", {
      familyId,
      previousState,
      newState: runtimeMode,
      reason: `Auto-demotion: ${reason}`,
      timestamp: Date.now(),
    });
  }

  private shouldAutoFreezeForExecutionCanary(executionCanary: {
    required: boolean;
    eligible: boolean;
    blockers: Array<{ metric: string; current: number; passed: boolean }>;
  }): boolean {
    if (!executionCanary.required || executionCanary.eligible) return false;
    return executionCanary.blockers.some(
      (blocker) =>
        !blocker.passed && blocker.metric !== "24h fills" && blocker.metric !== "Maker ratio %",
    );
  }

  private formatExecutionCanaryReason(executionCanary: {
    blockers: Array<{ metric: string; current: number; passed: boolean }>;
  }): string {
    const failures = executionCanary.blockers.filter(
      (blocker) =>
        !blocker.passed && blocker.metric !== "24h fills" && blocker.metric !== "Maker ratio %",
    );
    const summary = failures
      .map((blocker) => {
        if (blocker.metric === "Explicit fees (USDC)") return `$${blocker.current} fees`;
        if (blocker.metric === "Fee leakage %") return `${blocker.current}% leakage`;
        return `${blocker.current} ${blocker.metric.toLowerCase()}`;
      })
      .join(", ");
    return `execution canary breach (${summary})`;
  }
}
