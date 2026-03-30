import type Database from "better-sqlite3";
import type { ValidationScorecardRepository, ValidationScorecard } from "@plankton/domain";
import type { FamilyId } from "@plankton/domain";
import { createScorecardId } from "@plankton/domain";
import type { ProfileId, EvidenceStatus } from "@plankton/domain";

export class SqliteValidationScorecardRepository implements ValidationScorecardRepository {
  constructor(private readonly db: Database.Database) {}

  save(scorecard: ValidationScorecard): void {
    this.db
      .prepare(
        `INSERT INTO family_validation_scorecards
         (scorecard_id, family_id, profile, evidence_status, evidence_score,
          recurrence_score, recycle_score, live_viability_score, toxicity_penalty,
          trade_count, market_count, realized_pnl, tail_adjusted_pnl,
          both_sided_eligible, heavy_campaign_eligible, active_window_edge_score,
          summary_json, validated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scorecard_id) DO UPDATE SET
           evidence_status = excluded.evidence_status,
           evidence_score = excluded.evidence_score,
           recurrence_score = excluded.recurrence_score,
           recycle_score = excluded.recycle_score,
           live_viability_score = excluded.live_viability_score,
           toxicity_penalty = excluded.toxicity_penalty,
           trade_count = excluded.trade_count,
           market_count = excluded.market_count,
           realized_pnl = excluded.realized_pnl,
           tail_adjusted_pnl = excluded.tail_adjusted_pnl,
           both_sided_eligible = excluded.both_sided_eligible,
           heavy_campaign_eligible = excluded.heavy_campaign_eligible,
           active_window_edge_score = excluded.active_window_edge_score,
           summary_json = excluded.summary_json,
           validated_at = excluded.validated_at`,
      )
      .run(
        scorecard.scorecardId,
        scorecard.familyId,
        scorecard.profile,
        scorecard.evidenceStatus,
        scorecard.evidenceScore,
        scorecard.recurrenceScore,
        scorecard.recycleScore,
        scorecard.liveViabilityScore,
        scorecard.toxicityPenalty,
        scorecard.tradeCount,
        scorecard.marketCount,
        scorecard.realizedPnl,
        scorecard.tailAdjustedPnl,
        scorecard.bothSidedEligible ? 1 : 0,
        scorecard.heavyCampaignEligible ? 1 : 0,
        scorecard.activeWindowEdgeScore,
        scorecard.summaryJson,
        scorecard.validatedAt,
      );

    // Update materialized latest view
    this.db
      .prepare(
        `INSERT INTO family_validation_latest (family_id, profile, scorecard_id)
         VALUES (?, ?, ?)
         ON CONFLICT(family_id, profile) DO UPDATE SET
           scorecard_id = excluded.scorecard_id`,
      )
      .run(scorecard.familyId, scorecard.profile, scorecard.scorecardId);
  }

  findLatest(familyId: FamilyId, profile: ProfileId): ValidationScorecard | null {
    const row = this.db
      .prepare(
        `SELECT s.* FROM family_validation_scorecards s
         INNER JOIN family_validation_latest l
           ON s.scorecard_id = l.scorecard_id
         WHERE l.family_id = ? AND l.profile = ?`,
      )
      .get(familyId, profile) as Record<string, unknown> | undefined;
    return row ? rowToScorecard(row) : null;
  }

  findByFamily(familyId: FamilyId): ValidationScorecard[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM family_validation_scorecards WHERE family_id = ? ORDER BY validated_at DESC",
      )
      .all(familyId) as Record<string, unknown>[];
    return rows.map(rowToScorecard);
  }

  findByFamilyAndProfile(familyId: FamilyId, profile: ProfileId): ValidationScorecard[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM family_validation_scorecards
         WHERE family_id = ? AND profile = ?
         ORDER BY validated_at DESC`,
      )
      .all(familyId, profile) as Record<string, unknown>[];
    return rows.map(rowToScorecard);
  }
}

function rowToScorecard(row: Record<string, unknown>): ValidationScorecard {
  return {
    scorecardId: createScorecardId(row.scorecard_id as string),
    familyId: row.family_id as FamilyId,
    profile: row.profile as ProfileId,
    evidenceStatus: row.evidence_status as EvidenceStatus,
    evidenceScore: row.evidence_score as number,
    recurrenceScore: (row.recurrence_score as number) ?? null,
    recycleScore: (row.recycle_score as number) ?? null,
    liveViabilityScore: (row.live_viability_score as number) ?? null,
    toxicityPenalty: (row.toxicity_penalty as number) ?? null,
    tradeCount: row.trade_count as number,
    marketCount: row.market_count as number,
    realizedPnl: row.realized_pnl as number,
    tailAdjustedPnl: row.tail_adjusted_pnl as number,
    bothSidedEligible: row.both_sided_eligible === 1,
    heavyCampaignEligible: row.heavy_campaign_eligible === 1,
    activeWindowEdgeScore: (row.active_window_edge_score as number) ?? null,
    summaryJson: (row.summary_json as string) ?? null,
    validatedAt: row.validated_at as string,
  };
}
