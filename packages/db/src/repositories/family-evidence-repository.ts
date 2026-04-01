import type Database from "better-sqlite3";
import type {
  FamilyEvidenceRepository,
  FamilyEvidence,
  FamilyId,
  PromotionState,
} from "@plankton/domain";
import { createFamilyId } from "@plankton/domain";
import type { EvidenceStatus } from "@plankton/domain";

export class SqliteFamilyEvidenceRepository implements FamilyEvidenceRepository {
  constructor(private readonly db: Database.Database) {}

  updateScores(
    familyId: FamilyId,
    scores: {
      recurrenceScore: number | null;
      recycleScore: number | null;
      liveViabilityScore: number | null;
      toxicityPenalty: number | null;
      repricingExitCount: number;
      scoresUpdatedAt: string;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE family_evidence
         SET recurrence_score = ?, recycle_score = ?, live_viability_score = ?,
             toxicity_penalty = ?, repricing_exit_count = ?,
             scores_updated_at = ?, updated_at = datetime('now')
         WHERE family_id = ?`,
      )
      .run(
        scores.recurrenceScore,
        scores.recycleScore,
        scores.liveViabilityScore,
        scores.toxicityPenalty,
        scores.repricingExitCount,
        scores.scoresUpdatedAt,
        familyId,
      );
  }

  updatePromotionState(familyId: FamilyId, promotionState: PromotionState): void {
    this.db
      .prepare(
        `UPDATE family_evidence
         SET promotion_state = ?, updated_at = datetime('now')
         WHERE family_id = ?`,
      )
      .run(promotionState, familyId);
  }

  updateProbeSubstate(familyId: FamilyId, substate: string | null): void {
    this.db
      .prepare(
        `UPDATE family_evidence
         SET probe_substate = ?, updated_at = datetime('now')
         WHERE family_id = ?`,
      )
      .run(substate, familyId);
  }

  getEvidence(familyId: FamilyId): FamilyEvidence | null {
    const row = this.db
      .prepare("SELECT * FROM family_evidence WHERE family_id = ?")
      .get(familyId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      familyId: createFamilyId(row.family_id as string),
      evidenceStatus: row.evidence_status as EvidenceStatus,
      evidenceScore: row.evidence_score as number,
      promotionState: row.promotion_state as PromotionState,
      localTradeCount: row.local_trade_count as number,
      localMarketCount: row.local_market_count as number,
      localRealizedPnlFifo: row.local_realized_pnl_fifo as number,
      openTailCostUsdc: row.open_tail_cost_usdc as number,
      tailAdjustedPnl: row.tail_adjusted_pnl as number,
      remoteClosedRealizedPnl: (row.remote_closed_realized_pnl as number) ?? null,
      openPositionCount: (row.open_position_count as number) ?? null,
      openDustCount: (row.open_dust_count as number) ?? null,
      bothSidedEligible: Boolean(row.both_sided_eligible),
      heavyCampaignEligible: Boolean(row.heavy_campaign_eligible),
      activeWindowEdgeScore: (row.active_window_edge_score as number) ?? null,
      recurrenceScore: (row.recurrence_score as number) ?? null,
      recycleScore: (row.recycle_score as number) ?? null,
      liveViabilityScore: (row.live_viability_score as number) ?? null,
      toxicityPenalty: (row.toxicity_penalty as number) ?? null,
      lastValidatedAt: (row.last_validated_at as string) ?? null,
      probeSubstate: (row.probe_substate as string) ?? null,
      repricingExitCount: (row.repricing_exit_count as number) ?? 0,
    };
  }
}
