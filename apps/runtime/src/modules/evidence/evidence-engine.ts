/**
 * FamilyEvidenceEngine — RuntimeModule that periodically recomputes
 * scoring metrics for candidates and deployed families, proposes
 * promotions when thresholds are met, and enqueues demotions when
 * toxicity is unacceptable.
 */

import type { EventBus, RuntimeModule } from "@plankton/domain";
import type {
  FamilyCandidate,
  FamilyCandidateRepository,
  FamilyEvidenceRepository,
  PromotionProposalRepository,
  OperatorCommandRepository,
  StateTransitionRepository,
  FamilyStateRepository,
  FamilyRulesProvider,
} from "@plankton/domain";
import {
  computeRecurrenceScore,
  computeRecycleScore,
  computeLiveViabilityScore,
  computeToxicityPenalty,
  computeGateRecommendation,
  meetsPromotionThresholds,
  OperatorActionType,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { ScoreComputer } from "./score-computer.js";

const DEFAULT_RECOMPUTE_INTERVAL_MS = 3_600_000; // 1 hour
const TOXICITY_DEMOTION_THRESHOLD = 0.6;

export interface EvidenceEngineDeps {
  bus: EventBus;
  log: Logger;
  scoreComputer: ScoreComputer;
  candidateRepo: FamilyCandidateRepository;
  evidenceRepo: FamilyEvidenceRepository;
  proposalRepo: PromotionProposalRepository;
  commandRepo: OperatorCommandRepository;
  stateTransitionRepo: StateTransitionRepository;
  familyStateRepo: FamilyStateRepository;
  rulesProvider: FamilyRulesProvider;
  recomputeIntervalMs?: number;
}

export class FamilyEvidenceEngine implements RuntimeModule {
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly sc: ScoreComputer;
  private readonly candidateRepo: FamilyCandidateRepository;
  private readonly evidenceRepo: FamilyEvidenceRepository;
  private readonly proposalRepo: PromotionProposalRepository;
  private readonly commandRepo: OperatorCommandRepository;
  private readonly stateTransitionRepo: StateTransitionRepository;
  private readonly familyStateRepo: FamilyStateRepository;
  private readonly rulesProvider: FamilyRulesProvider;
  private readonly intervalMs: number;

  private unsubscribers: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private quickCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastRecomputeAt: string | null = null;
  /** Tracks wall-clock ISO timestamp when tail first went negative per family. Persists across recomputes but not restarts — on restart, falls back to DB query. */
  private firstNegativeTailAt = new Map<string, string>();

  constructor(deps: EvidenceEngineDeps) {
    this.bus = deps.bus;
    this.log = deps.log;
    this.sc = deps.scoreComputer;
    this.candidateRepo = deps.candidateRepo;
    this.evidenceRepo = deps.evidenceRepo;
    this.proposalRepo = deps.proposalRepo;
    this.commandRepo = deps.commandRepo;
    this.stateTransitionRepo = deps.stateTransitionRepo;
    this.familyStateRepo = deps.familyStateRepo;
    this.rulesProvider = deps.rulesProvider;
    this.intervalMs = deps.recomputeIntervalMs ?? DEFAULT_RECOMPUTE_INTERVAL_MS;
  }

  async start(): Promise<void> {
    this.unsubscribers = [
      this.bus.subscribe("FillReceived", async () => {
        this.log.debug("FillReceived noted — will recompute on next cycle");
      }),
      this.bus.subscribe("PositionSettled", async () => {
        this.log.debug("PositionSettled noted — will recompute on next cycle");
      }),
      this.bus.subscribe("FamilyExposureChanged", async () => {
        this.log.debug("FamilyExposureChanged noted — will recompute on next cycle");
      }),
      this.bus.subscribe("ReconciliationComplete", async () => {
        this.log.info("ReconciliationComplete — triggering out-of-cycle recompute");
        await this.recompute();
      }),
    ];

    this.timer = setInterval(() => {
      this.recompute().catch((err) =>
        this.log.error({ err }, "evidence recompute failed"),
      );
    }, this.intervalMs);

    // 5-minute quick-check for unscored candidates
    this.quickCheckTimer = setInterval(() => {
      this.quickCheckUnscored().catch((err) =>
        this.log.error({ err }, "quick-check unscored failed"),
      );
    }, 300_000);

    await this.recompute();
    this.log.info("FamilyEvidenceEngine started");
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.quickCheckTimer) {
      clearInterval(this.quickCheckTimer);
      this.quickCheckTimer = null;
    }

    this.log.info("FamilyEvidenceEngine stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true, detail: `lastRecompute=${this.lastRecomputeAt ?? "never"}` };
  }

  // ─── Core recompute ──────────────────────────────────────────────────

  async recompute(): Promise<void> {
    const now = new Date().toISOString();
    const candidates = this.candidateRepo.findAll();
    this.scoreCandidates(candidates, now);
    this.scoreDeployedFamilies(candidates, now);
    this.lastRecomputeAt = now;
  }

  private quickCheckUnscored(): Promise<void> {
    const unscored = this.candidateRepo.findUnscored();
    if (unscored.length === 0) return Promise.resolve();
    this.log.info({ count: unscored.length }, "quick-check: scoring unscored candidates");
    this.scoreCandidates(unscored, new Date().toISOString());
    return Promise.resolve();
  }

  private scoreCandidates(candidates: FamilyCandidate[], now: string): void {
    for (const cand of candidates) {
      const recurrenceMetrics = this.sc.computeRecurrenceMetrics(cand.candidateId);
      const recurrence = computeRecurrenceScore(recurrenceMetrics);

      const viabilityMetrics = this.sc.computeLiveViabilityMetrics(
        cand.candidateId,
        cand.horizon,
      );
      const liveViability = computeLiveViabilityScore(viabilityMetrics);

      // Recycle score needs a deployed family — use matchedFamilyId if available
      let recycle = 0;
      let tailAdjustedPnl = 0;
      if (cand.matchedFamilyId) {
        const recycleMetrics = this.sc.computeRecycleMetrics(String(cand.matchedFamilyId));
        recycle = computeRecycleScore(recycleMetrics);
        tailAdjustedPnl = recycleMetrics.tailAdjustedPnl;
      }

      const gate = computeGateRecommendation({
        recurrence,
        recycle,
        liveViability,
        tailAdjustedPnl,
      });

      this.candidateRepo.updateScores(cand.candidateId, {
        recurrenceScore: recurrence,
        recycleScore: recycle > 0 ? recycle : null,
        liveViabilityScore: liveViability,
        toxicityPenalty: null,
        gateRecommendation: gate,
        recommendationReason: null,
        scoresUpdatedAt: now,
      });

      this.log.debug(
        { candidateId: cand.candidateId, recurrence, liveViability, gate },
        "candidate scores updated",
      );
    }
  }

  private scoreDeployedFamilies(candidates: FamilyCandidate[], now: string): void {
    const families = this.rulesProvider.getAllFamilies();

    // Preserve find() semantics: first matching candidate wins
    const candidateByFamily = new Map<string, FamilyCandidate>();
    for (const c of candidates) {
      if (c.matchedFamilyId && !candidateByFamily.has(String(c.matchedFamilyId))) {
        candidateByFamily.set(String(c.matchedFamilyId), c);
      }
    }

    for (const identity of families) {
      const familyId = identity.familyId;
      const familyIdStr = String(familyId);

      const recycleMetrics = this.sc.computeRecycleMetrics(familyIdStr);
      const recycle = computeRecycleScore(recycleMetrics);

      const toxicityMetrics = this.sc.computeToxicityMetrics(familyIdStr);
      const toxicity = computeToxicityPenalty(toxicityMetrics);

      let recurrence: number | null = null;
      let liveViability: number | null = null;
      const matchingCandidate = candidateByFamily.get(familyIdStr);
      if (matchingCandidate) {
        const recurrenceMetrics = this.sc.computeRecurrenceMetrics(matchingCandidate.candidateId);
        recurrence = computeRecurrenceScore(recurrenceMetrics);
        const viabilityMetrics = this.sc.computeLiveViabilityMetrics(
          matchingCandidate.candidateId,
          matchingCandidate.horizon,
        );
        liveViability = computeLiveViabilityScore(viabilityMetrics);
      }

      this.evidenceRepo.updateScores(familyId, {
        recurrenceScore: recurrence,
        recycleScore: recycle,
        liveViabilityScore: liveViability,
        toxicityPenalty: toxicity,
        repricingExitCount: recycleMetrics.repricingExits,
        scoresUpdatedAt: now,
      });

      // If probe-only with sufficient evidence but not meeting promotion thresholds → retained
      const evidence = this.evidenceRepo.getEvidence(familyId);
      if (evidence?.promotionState === "probe-only" && recycleMetrics.tradeCount >= 20) {
        const eligible = meetsPromotionThresholds({
          repricingExits: recycleMetrics.repricingExits,
          distinctMarkets: recycleMetrics.distinctMarkets,
          tradeCount: recycleMetrics.tradeCount,
          recycleScore: recycle,
          toxicity,
          tailAdjustedPnl: recycleMetrics.tailAdjustedPnl,
        });
        if (!eligible) {
          this.evidenceRepo.updateProbeSubstate(familyId, "retained");
        } else {
          // Thresholds met — clear substate, proposal panel shows promotion pending
          this.evidenceRepo.updateProbeSubstate(familyId, null);
        }
      }

      this.checkPromotion(familyId, recycleMetrics, recycle, toxicity, now);
      this.checkDemotion(familyId, {
        toxicity,
        tailAdjustedPnl: recycleMetrics.tailAdjustedPnl,
        horizon: identity.horizon,
        regime: identity.regime,
      });

      this.log.debug(
        { familyId: familyIdStr, recycle, toxicity },
        "family evidence scores updated",
      );
    }
  }

  // ─── Promotion ─────────────────────────────────────────────────────────

  private checkPromotion(
    familyId: import("@plankton/domain").FamilyId,
    recycleMetrics: import("./score-computer.js").RecycleMetrics,
    recycleScore: number,
    toxicity: number,
    _now: string,
  ): void {
    if (this.proposalRepo.hasPending(familyId)) return;

    const eligible = meetsPromotionThresholds({
      repricingExits: recycleMetrics.repricingExits,
      distinctMarkets: recycleMetrics.distinctMarkets,
      tradeCount: recycleMetrics.tradeCount,
      recycleScore,
      toxicity,
      tailAdjustedPnl: recycleMetrics.tailAdjustedPnl,
    });

    if (!eligible) return;

    const evidence = this.evidenceRepo.getEvidence(familyId);
    const currentState = evidence?.promotionState ?? "probe-only";
    if (currentState === "scaled") return; // already at highest

    const recurrence = evidence?.recurrenceScore ?? null;
    const liveViability = evidence?.liveViabilityScore ?? null;

    this.proposalRepo.insert({
      familyId,
      currentState,
      proposedState: "scaled",
      reason: `Auto: recycle=${recycleScore.toFixed(2)}, toxicity=${toxicity.toFixed(2)}, trades=${recycleMetrics.tradeCount}`,
      scoresSnapshot: JSON.stringify({
        recurrence,
        recycle: recycleScore,
        liveViability,
        toxicity,
        tradeCount: recycleMetrics.tradeCount,
        distinctMarkets: recycleMetrics.distinctMarkets,
        repricingExits: recycleMetrics.repricingExits,
        tailAdjustedPnl: recycleMetrics.tailAdjustedPnl,
      }),
    });

    this.bus
      .publish("FamilyPromotionProposed", {
        familyId,
        currentState,
        proposedState: "scaled",
        reason: "auto-promotion: thresholds met",
        scores: {
          recurrence: recurrence ?? 0,
          recycle: recycleScore,
          liveViability: liveViability ?? 0,
          toxicity,
        },
        timestamp: Date.now(),
      })
      .catch((err) => this.log.error({ err }, "failed to publish FamilyPromotionProposed"));

    this.log.info({ familyId: String(familyId) }, "promotion proposed");
  }

  // ─── Demotion ──────────────────────────────────────────────────────────

  private checkDemotion(
    familyId: import("@plankton/domain").FamilyId,
    metrics: {
      toxicity: number;
      tailAdjustedPnl: number;
      horizon: string;
      regime: string;
    },
  ): void {
    const state = this.familyStateRepo.get(familyId);
    const currentMode = state?.runtimeMode ?? "active";

    // Already quarantined or restricted — nothing to do
    if (currentMode === "quarantine") return;

    // Already reduce-only — only escalate to quarantine
    if (currentMode === "reduce-only") {
      if (metrics.toxicity > 0.8) {
        this.enqueueDemotion(
          familyId,
          OperatorActionType.FamilyQuarantine,
          `escalation from reduce-only: severe toxicity ${metrics.toxicity.toFixed(2)}`,
        );
      }
      return;
    }

    // Threshold regime: immediate quarantine on negative tail (HR12)
    if (metrics.regime === "threshold" && metrics.tailAdjustedPnl < 0) {
      this.enqueueDemotion(
        familyId,
        OperatorActionType.FamilyQuarantine,
        `threshold regime, negative tail ${metrics.tailAdjustedPnl.toFixed(2)} (HR12)`,
      );
      return;
    }

    // Toxicity > 0.8: quarantine
    if (metrics.toxicity > 0.8) {
      this.enqueueDemotion(
        familyId,
        OperatorActionType.FamilyQuarantine,
        `severe toxicity ${metrics.toxicity.toFixed(2)}`,
      );
      return;
    }

    // Toxicity > 0.6: reduce-only
    if (metrics.toxicity > TOXICITY_DEMOTION_THRESHOLD) {
      this.enqueueDemotion(
        familyId,
        OperatorActionType.FamilyReduceOnly,
        `toxicity ${metrics.toxicity.toFixed(2)}`,
      );
      return;
    }

    // Horizon-aware negative tail window: DB-persisted wall-clock timestamp
    const familyIdStr = String(familyId);
    if (metrics.tailAdjustedPnl < 0) {
      const DEMOTION_WINDOWS: Record<string, number> = {
        "intraday-4h": 2,
        daily: 5,
        deadline: 10,
        "ad-hoc": 7,
      };
      const windowDays = DEMOTION_WINDOWS[metrics.horizon] ?? 7;

      // Record wall-clock time when tail first went negative (persist to DB)
      if (!this.firstNegativeTailAt.has(familyIdStr)) {
        // Check DB first (survives restart)
        const state = this.familyStateRepo.get(familyId);
        if (state?.firstNegativeTailAt) {
          this.firstNegativeTailAt.set(familyIdStr, state.firstNegativeTailAt);
        } else {
          const now = new Date().toISOString();
          this.firstNegativeTailAt.set(familyIdStr, now);
          // Persist to DB so it survives restart
          if (state) {
            this.familyStateRepo.save({ ...state, firstNegativeTailAt: now });
          }
        }
      }
      const firstNegAt = new Date(this.firstNegativeTailAt.get(familyIdStr)!);
      const elapsedMs = Date.now() - firstNegAt.getTime();
      const elapsedHours = elapsedMs / 3_600_000;
      const windowHours = windowDays * 24;

      if (elapsedHours >= windowHours) {
        this.enqueueDemotion(
          familyId,
          OperatorActionType.FamilyReduceOnly,
          `persistent negative tail ${metrics.tailAdjustedPnl.toFixed(2)} for ${elapsedHours.toFixed(0)}h (${metrics.horizon} window: ${windowDays}d)`,
        );
      }
    } else {
      // Tail recovered — clear timestamp from memory and DB
      if (this.firstNegativeTailAt.has(familyIdStr)) {
        this.firstNegativeTailAt.delete(familyIdStr);
        const state = this.familyStateRepo.get(familyId);
        if (state?.firstNegativeTailAt) {
          this.familyStateRepo.save({ ...state, firstNegativeTailAt: null });
        }
      }
    }
  }

  /** Enqueue a demotion command. State transition is written by CommandPoller after apply. */
  private enqueueDemotion(
    familyId: import("@plankton/domain").FamilyId,
    action: typeof OperatorActionType.FamilyReduceOnly | typeof OperatorActionType.FamilyQuarantine,
    reason: string,
  ): void {
    // Dedup: skip if an equal-or-stronger pending command already exists for this family.
    // Escalation (reduce-only pending → quarantine requested) must NOT be blocked.
    const pending = this.commandRepo.getPending();
    const familyPending = pending.filter(
      (c) => c.targetId === String(familyId) && (c.action === "family_reduce_only" || c.action === "family_quarantine"),
    );
    if (familyPending.length > 0) {
      // Same action already pending → skip
      if (familyPending.some((c) => c.action === action)) return;
      // Stronger action already pending → skip
      if (familyPending.some((c) => c.action === "family_quarantine")) return;
      // Only weaker pending — allow escalation
    }

    this.commandRepo.insert({
      action,
      targetId: String(familyId),
      reason: `Auto-demotion: ${reason}`,
      createdAt: new Date().toISOString(),
      initiatorType: "system",
      initiator: "evidence-engine",
    });

    this.log.warn(
      { familyId: String(familyId), action, reason },
      "demotion command enqueued",
    );
  }
}
