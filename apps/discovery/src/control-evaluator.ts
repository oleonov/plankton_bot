/**
 * ControlEvaluator — scores candidates and proposes promotions by reading
 * exclusively from control.db. Runs on a timer in the discovery worker.
 *
 * Candidate scoring uses observation data (candidate_observations,
 * candidate_observation_markets). Recycle/toxicity scores come from
 * pre-published family_validation_scorecards (written by runtime).
 */

import type { Logger } from "pino";
import type { DbConnection } from "@plankton/db";
import type { FamilyCandidate, ValidationScorecard, FamilyDeployment } from "@plankton/domain";
import type { FamilyId, ProfileId } from "@plankton/domain";

type Database = DbConnection["db"];
import {
  computeRecurrenceScore,
  computeLiveViabilityScore,
  computeGateRecommendation,
  meetsPromotionThresholds,
  isWithinHealthWindow,
} from "@plankton/domain";
import {
  SqliteFamilyCandidateRepository,
  SqlitePromotionProposalRepository,
  SqliteValidationScorecardRepository,
  SqliteFamilyDeploymentRepository,
} from "@plankton/db";

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

  constructor(deps: ControlEvaluatorDeps) {
    this.db = deps.db;
    this.log = deps.log;
    this.candidateRepo = new SqliteFamilyCandidateRepository(deps.db);
    this.proposalRepo = new SqlitePromotionProposalRepository(deps.db);
    this.scorecardRepo = new SqliteValidationScorecardRepository(deps.db);
    this.deploymentRepo = new SqliteFamilyDeploymentRepository(deps.db);
  }

  run(): EvaluationStats {
    const now = new Date().toISOString();
    const candidates = this.candidateRepo.findAll();
    const candidatesScored = this.scoreCandidates(candidates, now);
    const proposalsCreated = this.evaluatePromotions();
    this.log.info({ candidatesScored, proposalsCreated }, "control evaluation complete");
    return { candidatesScored, proposalsCreated };
  }

  // ─── Candidate scoring ──────────────────────────────────────────────

  private scoreCandidates(candidates: FamilyCandidate[], now: string): number {
    let scored = 0;
    for (const cand of candidates) {
      const recurrenceMetrics = queryRecurrenceMetrics(this.db, cand.candidateId);
      const recurrence = computeRecurrenceScore(recurrenceMetrics);

      const viabilityMetrics = queryLiveViabilityMetrics(this.db, cand.candidateId, cand.horizon);
      const liveViability = computeLiveViabilityScore(viabilityMetrics);

      // Recycle/toxicity require trading data — read from pre-published scorecards
      let recycle = 0;
      let tailAdjustedPnl = 0;
      if (cand.matchedFamilyId) {
        const scorecard = this.findLatestScorecard(cand.matchedFamilyId);
        if (scorecard) {
          recycle = scorecard.recycleScore ?? 0;
          tailAdjustedPnl = scorecard.tailAdjustedPnl;
        }
      }

      const gate = computeGateRecommendation({ recurrence, recycle, liveViability, tailAdjustedPnl });

      this.candidateRepo.updateScores(cand.candidateId, {
        recurrenceScore: recurrence,
        recycleScore: recycle > 0 ? recycle : null,
        liveViabilityScore: liveViability,
        toxicityPenalty: null,
        gateRecommendation: gate,
        recommendationReason: null,
        scoresUpdatedAt: now,
      });
      scored++;
    }
    return scored;
  }

  // ─── Promotion evaluation ───────────────────────────────────────────

  private evaluatePromotions(): number {
    let created = 0;
    const profiles = this.getActiveProfiles();

    for (const profile of profiles) {
      const deployments = this.deploymentRepo.findEnabled(profile);
      for (const dep of deployments) {
        const proposed = this.checkDeploymentPromotion(dep, profile);
        if (proposed) created++;
      }
    }
    return created;
  }

  private checkDeploymentPromotion(dep: FamilyDeployment, profile: ProfileId): boolean {
    if (this.proposalRepo.hasPending(dep.familyId, profile)) return false;

    const scorecard = this.scorecardRepo.findLatest(dep.familyId, profile);
    if (!scorecard) return false;

    // repricingExits is not stored in the scorecard, but is baked into recycleScore
    // (30% weight). If recycleScore >= 0.6, repricing exits were sufficient in the
    // runtime's computation. Derive a floor from the scorecard's summary if available,
    // otherwise infer from the recycle score meeting threshold.
    const repricingExits = this.extractRepricingExits(scorecard);

    const eligible = meetsPromotionThresholds({
      repricingExits,
      distinctMarkets: scorecard.marketCount,
      tradeCount: scorecard.tradeCount,
      recycleScore: scorecard.recycleScore ?? 0,
      toxicity: scorecard.toxicityPenalty ?? 0,
      tailAdjustedPnl: scorecard.tailAdjustedPnl,
    });
    if (!eligible) return false;

    const currentState = dep.strategyStage;
    if (currentState === "scaled" || currentState === "both-sided") return false;

    this.proposalRepo.insert({
      familyId: dep.familyId,
      profile,
      currentState: currentState as any,
      proposedState: "scaled",
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
      }),
      sourceScorecardId: scorecard.scorecardId,
    });

    this.log.info(
      { familyId: String(dep.familyId), profile, scorecardId: String(scorecard.scorecardId) },
      "promotion proposed from control evaluator",
    );
    return true;
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
    const rows = this.db
      .prepare("SELECT profile_id FROM profiles")
      .all() as { profile_id: string }[];
    return rows.map((r) => r.profile_id as ProfileId);
  }
}
