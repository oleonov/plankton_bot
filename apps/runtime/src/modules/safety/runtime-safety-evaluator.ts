/**
 * RuntimeSafetyEvaluator -- RuntimeModule that periodically evaluates
 * deployed families for toxicity-based demotion. Writes directly to
 * family_deployments.operator_mode and state_transitions (control DB).
 *
 * Extracted from FamilyEvidenceEngine to separate scoring (evidence)
 * from safety enforcement (this module).
 */

import type { EventBus, RuntimeModule } from "@plankton/domain";
import type {
  FamilyDeploymentRepository,
  FamilyStateRepository,
  FamilyRulesProvider,
  StateTransitionRepository,
} from "@plankton/domain";
import { computeToxicityPenalty, OperatorMode } from "@plankton/domain";
import type { ProfileId, FamilyId } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { ScoreComputer } from "../evidence/score-computer.js";

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
  deploymentRepo: FamilyDeploymentRepository;
  stateTransitionRepo: StateTransitionRepository;
  familyStateRepo: FamilyStateRepository;
  rulesProvider: FamilyRulesProvider;
  activeProfile: ProfileId;
  evalIntervalMs?: number;
}

export class RuntimeSafetyEvaluator implements RuntimeModule {
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly sc: ScoreComputer;
  private readonly deploymentRepo: FamilyDeploymentRepository;
  private readonly stateTransitionRepo: StateTransitionRepository;
  private readonly familyStateRepo: FamilyStateRepository;
  private readonly rulesProvider: FamilyRulesProvider;
  private readonly activeProfile: ProfileId;
  private readonly intervalMs: number;

  private unsubscribers: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastEvalAt: string | null = null;
  /** Tracks wall-clock ISO timestamp when tail first went negative per family. */
  private firstNegativeTailAt = new Map<string, string>();

  constructor(deps: SafetyEvaluatorDeps) {
    this.bus = deps.bus;
    this.log = deps.log;
    this.sc = deps.scoreComputer;
    this.deploymentRepo = deps.deploymentRepo;
    this.stateTransitionRepo = deps.stateTransitionRepo;
    this.familyStateRepo = deps.familyStateRepo;
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

      this.checkDemotion(familyId, {
        toxicity,
        tailAdjustedPnl: recycleMetrics.tailAdjustedPnl,
        horizon: identity.horizon,
        regime: identity.regime,
      });
    }

    this.lastEvalAt = new Date().toISOString();
  }

  // ─── Demotion logic ─────────────────────────────────────────────────────

  private checkDemotion(
    familyId: FamilyId,
    metrics: {
      toxicity: number;
      tailAdjustedPnl: number;
      horizon: string;
      regime: string;
    },
  ): void {
    const deployment = this.deploymentRepo.find(familyId, this.activeProfile);
    const currentMode = deployment?.operatorMode ?? OperatorMode.Active;

    if (currentMode === OperatorMode.Quarantine) return;

    // Already reduce-only -- only escalate to quarantine
    if (currentMode === OperatorMode.ReduceOnly) {
      if (metrics.toxicity > 0.8) {
        this.applyDemotion(
          familyId,
          currentMode,
          OperatorMode.Quarantine,
          `escalation from reduce-only: severe toxicity ${metrics.toxicity.toFixed(2)}`,
        );
      }
      return;
    }

    // Threshold regime: immediate quarantine on negative tail (HR12)
    if (metrics.regime === "threshold" && metrics.tailAdjustedPnl < 0) {
      this.applyDemotion(
        familyId,
        currentMode,
        OperatorMode.Quarantine,
        `threshold regime, negative tail ${metrics.tailAdjustedPnl.toFixed(2)} (HR12)`,
      );
      return;
    }

    // Toxicity > 0.8: quarantine
    if (metrics.toxicity > 0.8) {
      this.applyDemotion(
        familyId,
        currentMode,
        OperatorMode.Quarantine,
        `severe toxicity ${metrics.toxicity.toFixed(2)}`,
      );
      return;
    }

    // Toxicity > 0.6: reduce-only
    if (metrics.toxicity > TOXICITY_DEMOTION_THRESHOLD) {
      this.applyDemotion(
        familyId,
        currentMode,
        OperatorMode.ReduceOnly,
        `toxicity ${metrics.toxicity.toFixed(2)}`,
      );
      return;
    }

    // Horizon-aware negative tail window
    this.checkNegativeTailWindow(familyId, currentMode, metrics);
  }

  private checkNegativeTailWindow(
    familyId: FamilyId,
    currentMode: string,
    metrics: { tailAdjustedPnl: number; horizon: string },
  ): void {
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
        this.applyDemotion(
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

  // ─── Write demotion to deployment + transition ──────────────────────────

  private applyDemotion(
    familyId: FamilyId,
    fromMode: string,
    toMode: typeof OperatorMode.ReduceOnly | typeof OperatorMode.Quarantine,
    reason: string,
  ): void {
    this.deploymentRepo.updateOperatorMode(
      familyId,
      this.activeProfile,
      toMode,
      `Auto-demotion: ${reason}`,
    );

    this.stateTransitionRepo.insert({
      entityType: "family_deployment",
      entityId: String(familyId),
      fromState: fromMode,
      toState: toMode,
      triggerType: "system",
      initiator: "safety-evaluator",
      reason: `Auto-demotion: ${reason}`,
      scoresSnapshot: null,
    });

    this.log.warn(
      { familyId: String(familyId), fromMode, toMode, reason },
      "safety demotion applied",
    );
  }
}
