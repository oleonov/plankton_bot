import type Database from "better-sqlite3";
import type { PromotionProposalRepository, PromotionProposal } from "@plankton/domain";
import { createFamilyId } from "@plankton/domain";
import type { FamilyId, PromotionState } from "@plankton/domain";

interface ProposalRow {
  id: number;
  family_id: string;
  current_state: string;
  proposed_state: string;
  reason: string;
  scores_snapshot: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

function rowToProposal(row: ProposalRow): PromotionProposal {
  return {
    id: row.id,
    familyId: createFamilyId(row.family_id),
    currentState: row.current_state as PromotionState,
    proposedState: row.proposed_state as PromotionState,
    reason: row.reason,
    scoresSnapshot: row.scores_snapshot,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

export class SqlitePromotionProposalRepository implements PromotionProposalRepository {
  constructor(private readonly db: Database.Database) {}

  insert(
    proposal: Omit<PromotionProposal, "id" | "status" | "createdAt" | "resolvedAt" | "resolvedBy">,
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO promotion_proposals
           (family_id, current_state, proposed_state, reason, scores_snapshot,
            status, created_at, resolved_at, resolved_by)
         VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'), NULL, NULL)`,
      )
      .run(
        proposal.familyId,
        proposal.currentState,
        proposal.proposedState,
        proposal.reason,
        proposal.scoresSnapshot,
      );
    return Number(info.lastInsertRowid);
  }

  findPending(): PromotionProposal[] {
    const rows = this.db
      .prepare("SELECT * FROM promotion_proposals WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as ProposalRow[];
    return rows.map(rowToProposal);
  }

  findByFamily(familyId: FamilyId): PromotionProposal[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM promotion_proposals WHERE family_id = ? ORDER BY created_at DESC",
      )
      .all(familyId) as ProposalRow[];
    return rows.map(rowToProposal);
  }

  hasPending(familyId: FamilyId): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM promotion_proposals WHERE family_id = ? AND status = 'pending' LIMIT 1",
      )
      .get(familyId);
    return row !== undefined;
  }

  resolve(id: number, status: string, resolvedBy: string): void {
    this.db
      .prepare(
        `UPDATE promotion_proposals
         SET status = ?, resolved_at = datetime('now'), resolved_by = ?
         WHERE id = ?`,
      )
      .run(status, resolvedBy, id);
  }
}
