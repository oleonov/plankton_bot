import type Database from "better-sqlite3";
import type { FamilyCandidateRepository, FamilyCandidate } from "@plankton/domain";

interface CandidateRow {
  candidate_id: string;
  family_key: string;
  regime: string;
  horizon: string;
  cadence: string;
  pattern_confidence: string;
  primary_category: string;
  strategy_profile: string;
  slug_pattern: string | null;
  matched_family_id: string | null;
  active_market_count: number;
  nearest_end_date: string | null;
  cluster_volume_24h: number;
  recurrence_score: number | null;
  recycle_score: number | null;
  live_viability_score: number | null;
  toxicity_penalty: number | null;
  gate_recommendation: string;
  recommendation_reason: string | null;
  scores_updated_at: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  reviewed_at: string | null;
  materialized_at: string | null;
}

function rowToCandidate(row: CandidateRow): FamilyCandidate {
  return {
    candidateId: row.candidate_id,
    familyKey: row.family_key,
    regime: row.regime as FamilyCandidate["regime"],
    horizon: row.horizon,
    cadence: row.cadence,
    patternConfidence: row.pattern_confidence,
    primaryCategory: row.primary_category,
    strategyProfile: row.strategy_profile as FamilyCandidate["strategyProfile"],
    slugPattern: row.slug_pattern,
    matchedFamilyId: row.matched_family_id as FamilyCandidate["matchedFamilyId"],
    activeMarketCount: row.active_market_count,
    nearestEndDate: row.nearest_end_date,
    clusterVolume24h: row.cluster_volume_24h,
    recurrenceScore: row.recurrence_score,
    recycleScore: row.recycle_score,
    liveViabilityScore: row.live_viability_score,
    toxicityPenalty: row.toxicity_penalty,
    gateRecommendation: row.gate_recommendation,
    recommendationReason: row.recommendation_reason,
    scoresUpdatedAt: row.scores_updated_at,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    reviewedAt: row.reviewed_at,
    materializedAt: row.materialized_at,
  };
}

export class SqliteFamilyCandidateRepository implements FamilyCandidateRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(c: FamilyCandidate): void {
    this.db
      .prepare(
        `INSERT INTO family_candidates
           (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
            primary_category, strategy_profile, slug_pattern, matched_family_id,
            active_market_count, nearest_end_date, cluster_volume_24h,
            recurrence_score, recycle_score, live_viability_score, toxicity_penalty,
            gate_recommendation, recommendation_reason, scores_updated_at,
            status, first_seen_at, last_seen_at, reviewed_at, materialized_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(candidate_id) DO UPDATE SET
           family_key = excluded.family_key,
           regime = excluded.regime,
           horizon = excluded.horizon,
           cadence = excluded.cadence,
           pattern_confidence = excluded.pattern_confidence,
           primary_category = excluded.primary_category,
           strategy_profile = excluded.strategy_profile,
           slug_pattern = excluded.slug_pattern,
           matched_family_id = excluded.matched_family_id,
           active_market_count = excluded.active_market_count,
           nearest_end_date = excluded.nearest_end_date,
           cluster_volume_24h = excluded.cluster_volume_24h,
           gate_recommendation = excluded.gate_recommendation,
           recommendation_reason = excluded.recommendation_reason,
           status = excluded.status,
           last_seen_at = excluded.last_seen_at,
           reviewed_at = excluded.reviewed_at,
           materialized_at = excluded.materialized_at`,
      )
      .run(
        c.candidateId,
        c.familyKey,
        c.regime,
        c.horizon,
        c.cadence,
        c.patternConfidence,
        c.primaryCategory,
        c.strategyProfile,
        c.slugPattern,
        c.matchedFamilyId,
        c.activeMarketCount,
        c.nearestEndDate,
        c.clusterVolume24h,
        c.recurrenceScore,
        c.recycleScore,
        c.liveViabilityScore,
        c.toxicityPenalty,
        c.gateRecommendation,
        c.recommendationReason,
        c.scoresUpdatedAt,
        c.status,
        c.firstSeenAt,
        c.lastSeenAt,
        c.reviewedAt,
        c.materializedAt,
      );
  }

  findById(candidateId: string): FamilyCandidate | null {
    const row = this.db
      .prepare("SELECT * FROM family_candidates WHERE candidate_id = ?")
      .get(candidateId) as CandidateRow | undefined;
    return row ? rowToCandidate(row) : null;
  }

  findAll(): FamilyCandidate[] {
    const rows = this.db.prepare("SELECT * FROM family_candidates").all() as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  findByStatus(status: string): FamilyCandidate[] {
    const rows = this.db
      .prepare("SELECT * FROM family_candidates WHERE status = ?")
      .all(status) as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  findUnscored(): FamilyCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM family_candidates
         WHERE status IN ('discovered', 'reviewed') AND scores_updated_at IS NULL`,
      )
      .all() as CandidateRow[];
    return rows.map(rowToCandidate);
  }

  updateStatus(candidateId: string, status: string): void {
    this.db
      .prepare("UPDATE family_candidates SET status = ? WHERE candidate_id = ?")
      .run(status, candidateId);
  }

  updateScores(
    candidateId: string,
    scores: {
      recurrenceScore: number | null;
      recycleScore: number | null;
      liveViabilityScore: number | null;
      toxicityPenalty: number | null;
      gateRecommendation: string;
      recommendationReason: string | null;
      scoresUpdatedAt: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE family_candidates
         SET recurrence_score = ?, recycle_score = ?, live_viability_score = ?,
             toxicity_penalty = ?, gate_recommendation = ?, recommendation_reason = ?,
             scores_updated_at = ?
         WHERE candidate_id = ?`,
      )
      .run(
        scores.recurrenceScore,
        scores.recycleScore,
        scores.liveViabilityScore,
        scores.toxicityPenalty,
        scores.gateRecommendation,
        scores.recommendationReason,
        scores.scoresUpdatedAt,
        candidateId,
      );
  }
}
