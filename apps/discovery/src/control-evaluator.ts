/**
 * ControlEvaluator — scores candidates and proposes promotions by reading
 * exclusively from control.db. Runs on a timer in the discovery worker.
 *
 * Candidate scoring uses observation data (candidate_observations,
 * candidate_observation_markets). Recycle/toxicity scores come from
 * pre-published family_validation_scorecards (written by runtime).
 */

import type { Logger } from "pino";
import { type DbConnection, withImmediate } from "@plankton/db";
import type { FamilyCandidate, ValidationScorecard, FamilyDeployment } from "@plankton/domain";
import type { FamilyId, ProfileId } from "@plankton/domain";

type Database = DbConnection["db"];
import {
  computeRecurrenceScore,
  computeLiveViabilityScore,
  computeGateRecommendation,
  meetsPromotionThresholds,
  isWithinHealthWindow,
  emptyExecutionTelemetrySnapshot,
  evaluateExecutionCanaryGate,
  isPromotionBlockedByExecutionCanary,
  parseValidationScorecardSummary,
} from "@plankton/domain";
import {
  SqliteFamilyCandidateRepository,
  SqlitePromotionProposalRepository,
  SqliteValidationScorecardRepository,
  SqliteFamilyDeploymentRepository,
} from "@plankton/db";
import { DISMISSED_PROPOSAL_COOLDOWN_MS, recentDismissalCutoffIso } from "./promotion-policy.js";
import { type AutoAcceptorConfig, autoAcceptAndPromote } from "./auto-acceptor.js";

type ScoreUpdate = {
  recurrenceScore: number | null;
  recycleScore: number | null;
  liveViabilityScore: number | null;
  toxicityPenalty: number | null;
  gateRecommendation: string;
  recommendationReason: string | null;
  scoresUpdatedAt: string;
};

// ─── Metric helpers (ported from ScoreComputer, adapted for control.db) ────

interface RecurrenceMetrics {
  spanDays: number;
  presenceDays: number;
  totalDays: number;
  cadenceStddev: number;
  cadenceMean: number;
  distinctConditions: number;
}

interface LiveViabilityMetrics {
  activeMarketCount: number;
  healthyEndDateFraction: number;
  clusterVolume24h: number;
}

function computeGapStats(sortedDates: string[]): { mean: number; stddev: number } {
  if (sortedDates.length < 2) return { mean: 0, stddev: 0 };
  const gaps: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1]!).getTime();
    const curr = new Date(sortedDates[i]!).getTime();
    gaps.push((curr - prev) / (1000 * 60 * 60 * 24));
  }
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  return { mean, stddev: Math.sqrt(variance) };
}

function queryRecurrenceMetrics(db: Database, candidateId: string): RecurrenceMetrics {
  const span = db
    .prepare(
      `SELECT julianday(MAX(observed_at)) - julianday(MIN(observed_at)) AS v
       FROM candidate_observations WHERE candidate_id = ?`,
    )
    .get(candidateId) as { v: number | null } | undefined;

  const presenceDays = db
    .prepare(
      `SELECT COUNT(DISTINCT date(observed_at)) AS v
       FROM candidate_observations
       WHERE candidate_id = ? AND active_market_count >= 2`,
    )
    .get(candidateId) as { v: number } | undefined;

  const totalDays = db
    .prepare(
      `SELECT COUNT(DISTINCT date(observed_at)) AS v
       FROM candidate_observations WHERE candidate_id = ?`,
    )
    .get(candidateId) as { v: number } | undefined;

  const distinctConditions = db
    .prepare(
      `SELECT COUNT(DISTINCT condition_id) AS v
       FROM candidate_observation_markets WHERE candidate_id = ?`,
    )
    .get(candidateId) as { v: number } | undefined;

  const dateRows = db
    .prepare(
      `SELECT DISTINCT date(observed_at) AS d
       FROM candidate_observations WHERE candidate_id = ?
       ORDER BY d`,
    )
    .all(candidateId) as { d: string }[];

  const { mean, stddev } = computeGapStats(dateRows.map((r) => r.d));

  return {
    spanDays: span?.v ?? 0,
    presenceDays: presenceDays?.v ?? 0,
    totalDays: totalDays?.v ?? 0,
    cadenceMean: mean,
    cadenceStddev: stddev,
    distinctConditions: distinctConditions?.v ?? 0,
  };
}

function queryLiveViabilityMetrics(
  db: Database,
  candidateId: string,
  horizon: string,
): LiveViabilityMetrics {
  const candidateRow = db
    .prepare(
      `SELECT active_market_count, cluster_volume_24h
       FROM family_candidates WHERE candidate_id = ?`,
    )
    .get(candidateId) as { active_market_count: number; cluster_volume_24h: number } | undefined;

  if (!candidateRow) {
    return { activeMarketCount: 0, healthyEndDateFraction: 0, clusterVolume24h: 0 };
  }

  const latestObs = db
    .prepare(
      `SELECT observed_at FROM candidate_observations
       WHERE candidate_id = ? ORDER BY observed_at DESC LIMIT 1`,
    )
    .get(candidateId) as { observed_at: string } | undefined;

  let healthyFraction = 0;
  if (latestObs) {
    const markets = db
      .prepare(
        `SELECT end_date FROM candidate_observation_markets
         WHERE candidate_id = ? AND observed_at = ?`,
      )
      .all(candidateId, latestObs.observed_at) as { end_date: string | null }[];

    if (markets.length > 0) {
      const now = new Date();
      const healthy = markets.filter((m) => isWithinHealthWindow(horizon, m.end_date, now));
      healthyFraction = healthy.length / markets.length;
    }
  }

  return {
    activeMarketCount: candidateRow.active_market_count,
    healthyEndDateFraction: healthyFraction,
    clusterVolume24h: candidateRow.cluster_volume_24h,
  };
}

// ─── ControlEvaluator ─────────────────────────────────────────────────────

export interface ControlEvaluatorDeps {
  db: Database;
  log: Logger;
  now?: () => Date;
  dismissCooldownMs?: number;
  autoAcceptorConfig?: AutoAcceptorConfig;
}

export interface EvaluationStats {
  candidatesScored: number;
  proposalsCreated: number;
}

export class ControlEvaluator {
  private readonly db: Database;
  private readonly log: Logger;
  private readonly candidateRepo: SqliteFamilyCandidateRepository;
  private readonly proposalRepo: SqlitePromotionProposalRepository;
  private readonly scorecardRepo: SqliteValidationScorecardRepository;
  private readonly deploymentRepo: SqliteFamilyDeploymentRepository;
  private readonly now: () => Date;
  private readonly dismissCooldownMs: number;
  private readonly autoAcceptorConfig: AutoAcceptorConfig | undefined;
  private rescoring = false;
  private promoting = false;
  private lastRescoreCompletedAt = 0;

  constructor(deps: ControlEvaluatorDeps) {
    this.db = deps.db;
    this.log = deps.log;
    this.candidateRepo = new SqliteFamilyCandidateRepository(deps.db);
    this.proposalRepo = new SqlitePromotionProposalRepository(deps.db);
    this.scorecardRepo = new SqliteValidationScorecardRepository(deps.db);
    this.deploymentRepo = new SqliteFamilyDeploymentRepository(deps.db);
    this.now = deps.now ?? (() => new Date());
    this.dismissCooldownMs = deps.dismissCooldownMs ?? DISMISSED_PROPOSAL_COOLDOWN_MS;
    this.autoAcceptorConfig = deps.autoAcceptorConfig;
  }

  async run(): Promise<EvaluationStats> {
    const scoreStats = await this.recomputeScores();
    const promoStats = await this.evaluatePromotions();
    return {
      candidatesScored: scoreStats.candidatesScored,
      proposalsCreated: promoStats.proposalsCreated,
    };
  }

  async recomputeScores(): Promise<{ candidatesScored: number }> {
    if (this.rescoring) return { candidatesScored: 0 };
    this.rescoring = true;
    try {
      const nowIso = this.now().toISOString();
      let candidatesVisited = 0;
      const scoreUpdates: Array<{ candidateId: string; scores: ScoreUpdate }> = [];
      for (const cand of this.candidateRepo.iterateScorable()) {
        candidatesVisited++;
        const update = this.computeScoreForCandidate(cand, nowIso);
        if (update) scoreUpdates.push(update);
      }

      const candidateRepo = this.candidateRepo;
      withImmediate(this.db, () => {
        for (const upd of scoreUpdates) {
          candidateRepo.updateScores(upd.candidateId, upd.scores);
        }
      });

      this.lastRescoreCompletedAt = Date.now();
      this.log.info(
        { candidatesVisited, candidatesUpdated: scoreUpdates.length },
        "candidate rescore complete",
      );
      return { candidatesScored: scoreUpdates.length };
    } finally {
      this.rescoring = false;
    }
  }

  async evaluatePromotions(): Promise<{ proposalsCreated: number }> {
    if (this.promoting) return { proposalsCreated: 0 };
    this.promoting = true;
    try {
      const now = this.now();
      const proposalInserts = this.computePromotions(now);

      const proposalRepo = this.proposalRepo;
      withImmediate(this.db, () => {
        for (const ins of proposalInserts) {
          proposalRepo.insert(ins.proposal);
        }
      });

      this.log.info(
        { proposalsCreated: proposalInserts.length },
        "promotion evaluation complete",
      );

      if (this.autoAcceptorConfig?.enabled) {
        const result = await autoAcceptAndPromote(this.db, this.autoAcceptorConfig, this.log);
        if (result.accepted > 0 || result.promoted > 0 || result.skippedAtCap > 0) {
          this.log.info(result, "auto-accept/promote pass");
        }
      }

      return { proposalsCreated: proposalInserts.length };
    } finally {
      this.promoting = false;
    }
  }

  getLastRescoreCompletedAt(): number {
    return this.lastRescoreCompletedAt;
  }

  // ─── Candidate scoring (read + compute only) ──────────────────────

  private computeScoreForCandidate(
    cand: FamilyCandidate,
    now: string,
  ): { candidateId: string; scores: ScoreUpdate } | null {
    const recurrenceMetrics = queryRecurrenceMetrics(this.db, cand.candidateId);
    const recurrence = computeRecurrenceScore(recurrenceMetrics);

    const viabilityMetrics = queryLiveViabilityMetrics(this.db, cand.candidateId, cand.horizon);
    const liveViability = computeLiveViabilityScore(viabilityMetrics);

    let recycle = 0;
    let tailAdjustedPnl = 0;
    if (cand.matchedFamilyId) {
      const scorecard = this.findLatestScorecard(cand.matchedFamilyId);
      if (scorecard) {
        recycle = scorecard.recycleScore ?? 0;
        tailAdjustedPnl = scorecard.tailAdjustedPnl;
      }
    }

    const gate = computeGateRecommendation({
      recurrence,
      recycle,
      liveViability,
      tailAdjustedPnl,
    });

    const newRecycle = recycle > 0 ? recycle : null;
    if (
      cand.scoresUpdatedAt !== null &&
      nearlyEqual(cand.recurrenceScore, recurrence) &&
      nearlyEqual(cand.recycleScore, newRecycle) &&
      nearlyEqual(cand.liveViabilityScore, liveViability) &&
      cand.gateRecommendation === gate
    ) {
      return null;
    }

    return {
      candidateId: cand.candidateId,
      scores: {
        recurrenceScore: recurrence,
        recycleScore: newRecycle,
        liveViabilityScore: liveViability,
        toxicityPenalty: null,
        gateRecommendation: gate,
        recommendationReason: null,
        scoresUpdatedAt: now,
      },
    };
  }

  // ─── Promotion evaluation (read + compute only) ────────────────────

  private computePromotions(now: Date) {
    type ProposalInsert = Omit<
      import("@plankton/domain").PromotionProposal,
      "id" | "status" | "createdAt" | "resolvedAt" | "resolvedBy"
    >;
    const inserts: { proposal: ProposalInsert }[] = [];
    const profiles = this.getActiveProfiles();

    for (const profile of profiles) {
      const deployments = this.deploymentRepo.findEnabled(profile);
      for (const dep of deployments) {
        const proposal = this.buildProposalIfEligible(dep, profile, now);
        if (proposal) inserts.push(proposal);
      }
    }
    return inserts;
  }

  private buildProposalIfEligible(
    dep: FamilyDeployment,
    profile: ProfileId,
    now: Date,
  ): {
    proposal: Omit<
      import("@plankton/domain").PromotionProposal,
      "id" | "status" | "createdAt" | "resolvedAt" | "resolvedBy"
    >;
  } | null {
    if (this.proposalRepo.hasPending(dep.familyId, profile)) return null;
    if (
      this.dismissCooldownMs > 0 &&
      this.proposalRepo.hasDismissedSince(
        dep.familyId,
        recentDismissalCutoffIso(now, this.dismissCooldownMs),
        profile,
      )
    ) {
      this.log.debug(
        { familyId: String(dep.familyId), profile, dismissCooldownMs: this.dismissCooldownMs },
        "promotion suppressed by recent dismissal cooldown",
      );
      return null;
    }

    const scorecard = this.scorecardRepo.findLatest(dep.familyId, profile);
    if (!scorecard) return null;
    const familyPolicy = this.db
      .prepare(
        `SELECT primary_category, fee_tier, live_wallet_requirement, requires_post_only_for_live
         FROM family_catalog
         WHERE family_id = ?`,
      )
      .get(dep.familyId) as
      | {
          primary_category: string;
          fee_tier: string | null;
          live_wallet_requirement: string | null;
          requires_post_only_for_live: number | null;
        }
      | undefined;
    const scorecardSummary = parseValidationScorecardSummary(scorecard.summaryJson);
    const executionCanary = evaluateExecutionCanaryGate({
      primaryCategory: familyPolicy?.primary_category ?? "other",
      feeTier:
        (familyPolicy?.fee_tier as import("@plankton/domain").FeeTier | null | undefined) ?? null,
      liveWalletRequirement:
        (familyPolicy?.live_wallet_requirement as
          | import("@plankton/domain").LiveWalletRequirement
          | null
          | undefined) ?? null,
      requiresPostOnlyForLive:
        familyPolicy?.requires_post_only_for_live == null
          ? null
          : familyPolicy.requires_post_only_for_live === 1,
      executionTelemetry:
        scorecardSummary?.executionTelemetry24h ?? emptyExecutionTelemetrySnapshot(),
    });
    if (isPromotionBlockedByExecutionCanary(profile, executionCanary)) {
      this.log.info(
        {
          familyId: String(dep.familyId),
          profile,
          blockers: executionCanary.blockers.filter((blocker) => !blocker.passed),
        },
        "promotion blocked by execution canary",
      );
      return null;
    }

    const repricingExits = this.extractRepricingExits(scorecard);

    const eligible = meetsPromotionThresholds({
      repricingExits,
      distinctMarkets: scorecard.marketCount,
      tradeCount: scorecard.tradeCount,
      recycleScore: scorecard.recycleScore ?? 0,
      toxicity: scorecard.toxicityPenalty ?? 0,
      tailAdjustedPnl: scorecard.tailAdjustedPnl,
    });
    if (!eligible) return null;

    const currentState = dep.strategyStage;
    if (currentState === "scaled" || currentState === "both-sided") return null;

    this.log.info(
      { familyId: String(dep.familyId), profile, scorecardId: String(scorecard.scorecardId) },
      "promotion proposed from control evaluator",
    );

    return {
      proposal: {
        familyId: dep.familyId,
        profile,
        currentState: currentState as any,
        proposedState: "scaled" as const,
        reason: `Auto: recycle=${(scorecard.recycleScore ?? 0).toFixed(2)}, toxicity=${(scorecard.toxicityPenalty ?? 0).toFixed(2)}, trades=${scorecard.tradeCount}`,
        scoresSnapshot: JSON.stringify({
          recurrence: scorecard.recurrenceScore,
          recycle: scorecard.recycleScore,
          liveViability: scorecard.liveViabilityScore,
          toxicity: scorecard.toxicityPenalty,
          tradeCount: scorecard.tradeCount,
          marketCount: scorecard.marketCount,
          tailAdjustedPnl: scorecard.tailAdjustedPnl,
          evidenceStatus: scorecard.evidenceStatus,
          executionCanary24h: executionCanary,
        }),
        sourceScorecardId: scorecard.scorecardId,
      },
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /** Extract repricingExits from scorecard's summaryJson, or infer from recycleScore. */
  private extractRepricingExits(scorecard: ValidationScorecard): number {
    if (scorecard.summaryJson) {
      try {
        const summary = JSON.parse(scorecard.summaryJson);
        if (typeof summary.repricingExits === "number") return summary.repricingExits;
      } catch {
        // malformed JSON — fall through to inference
      }
    }
    // Recycle score >= 0.6 implies repricing exits contributed meaningfully
    return (scorecard.recycleScore ?? 0) >= 0.6 ? 3 : 0;
  }

  private findLatestScorecard(familyId: FamilyId): ValidationScorecard | null {
    // Find the latest scorecard across all profiles for this family
    const scorecards = this.scorecardRepo.findByFamily(familyId);
    return scorecards.length > 0 ? scorecards[0]! : null;
  }

  private getActiveProfiles(): ProfileId[] {
    const rows = this.db.prepare("SELECT profile_id FROM profiles").all() as {
      profile_id: string;
    }[];
    return rows.map((r) => r.profile_id as ProfileId);
  }
}

function nearlyEqual(a: number | null, b: number | null, epsilon = 1e-6): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) < epsilon;
}
