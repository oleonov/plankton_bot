/**
 * FamilyEvidenceEngine — RuntimeModule that periodically recomputes
 * scoring metrics for deployed families and writes to ledger's family_evidence.
 *
 * Candidate scoring and promotion proposals are handled by ControlEvaluator
 * in the discovery service, reading from control.db scorecards.
 * Safety enforcement (demotion/quarantine) is handled by RuntimeSafetyEvaluator.
 */

import type { EventBus, RuntimeModule } from "@plankton/domain";
import type { FamilyEvidenceRepository, FamilyRulesProvider } from "@plankton/domain";
import {
  computeRecycleScore,
  computeToxicityPenalty,
  meetsPromotionThresholds,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { ScoreComputer } from "./score-computer.js";

const DEFAULT_RECOMPUTE_INTERVAL_MS = 3_600_000; // 1 hour

export interface EvidenceEngineDeps {
  bus: EventBus;
  log: Logger;
  scoreComputer: ScoreComputer;
  evidenceRepo: FamilyEvidenceRepository;
  rulesProvider: FamilyRulesProvider;
  recomputeIntervalMs?: number;
}

export class FamilyEvidenceEngine implements RuntimeModule {
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly sc: ScoreComputer;
  private readonly evidenceRepo: FamilyEvidenceRepository;
  private readonly rulesProvider: FamilyRulesProvider;
  private readonly intervalMs: number;

  private unsubscribers: (() => void)[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRecomputeAt: string | null = null;

  constructor(deps: EvidenceEngineDeps) {
    this.bus = deps.bus;
    this.log = deps.log;
    this.sc = deps.scoreComputer;
    this.evidenceRepo = deps.evidenceRepo;
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

    this.log.info("FamilyEvidenceEngine stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return { ok: true, detail: `lastRecompute=${this.lastRecomputeAt ?? "never"}` };
  }

  // ─── Core recompute ──────────────────────────────────────────────────

  async recompute(): Promise<void> {
    const now = new Date().toISOString();
    this.scoreDeployedFamilies(now);
    this.lastRecomputeAt = now;
  }

  private scoreDeployedFamilies(now: string): void {
    const families = this.rulesProvider.getAllFamilies();

    for (const identity of families) {
      const familyId = identity.familyId;
      const familyIdStr = String(familyId);

      const recycleMetrics = this.sc.computeRecycleMetrics(familyIdStr);
      const recycle = computeRecycleScore(recycleMetrics);

      const toxicityMetrics = this.sc.computeToxicityMetrics(familyIdStr);
      const toxicity = computeToxicityPenalty(toxicityMetrics);

      this.evidenceRepo.updateScores(familyId, {
        recurrenceScore: null,
        recycleScore: recycle,
        liveViabilityScore: null,
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
          this.evidenceRepo.updateProbeSubstate(familyId, null);
        }
      }

      this.log.debug(
        { familyId: familyIdStr, recycle, toxicity },
        "family evidence scores updated",
      );
    }
  }
}
