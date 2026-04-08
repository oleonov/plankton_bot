import type Database from "better-sqlite3";
import type {
  PositionRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
  Position,
  PositionId,
  FamilyId,
} from "@plankton/domain";
import type { MergeCandidate } from "./merge-candidate-service.js";

export class MergeSettler {
  private readonly db: Database.Database;

  constructor(
    private readonly positionRepo: PositionRepository,
    private readonly lotRepo: InventoryLotRepository,
    private readonly mergeLedgerRepo: MergeLedgerRepository,
    db: Database.Database,
  ) {
    this.db = db;
  }

  applyMerge(candidate: MergeCandidate): void {
    const runMerge = this.db.transaction(() => {
      // 1. Fetch positions (must be open)
      const yesPos = this.positionRepo.findByTokenId(candidate.yesTokenId);
      const noPos = this.positionRepo.findByTokenId(candidate.noTokenId);

      if (!yesPos || !noPos || yesPos.status === "closed" || noPos.status === "closed") {
        throw new Error(`Cannot merge: one or both positions are missing or closed`);
      }

      // 2. Consume lots (FIFO)
      const yesLots = this.lotRepo.consumeFifo(yesPos.positionId, candidate.mergeAmount);
      const noLots = this.lotRepo.consumeFifo(noPos.positionId, candidate.mergeAmount);

      // 3. Calculate spread PnL
      // Total merge value is 1.0 * amount.
      // Profit/Loss is (1.0 - combined_cost_basis) * amount.
      const yesCostBasis = yesLots.reduce((sum, l) => sum + l.consumed * l.lot.entryPrice, 0);
      const noCostBasis = noLots.reduce((sum, l) => sum + l.consumed * l.lot.entryPrice, 0);
      const totalCost = yesCostBasis + noCostBasis;
      const spreadPnl = candidate.mergeAmount - totalCost;

      // 4. Record in merge_ledger
      this.mergeLedgerRepo.save({
        mergeId: `merge-${candidate.conditionId}-${Date.now()}`,
        conditionId: candidate.conditionId,
        familyId: String(candidate.familyId),
        mergedAmount: candidate.mergeAmount,
        spreadPnl,
        mergedAt: new Date().toISOString(),
      });

      // 5. Update positions
      this.updatePositionAfterMerge(yesPos, candidate.mergeAmount, yesCostBasis, spreadPnl / 2);
      this.updatePositionAfterMerge(noPos, candidate.mergeAmount, noCostBasis, spreadPnl / 2);
    });

    runMerge();
  }

  private updatePositionAfterMerge(
    position: Position,
    mergedSize: number,
    costBasisConsumed: number,
    pnlShare: number,
  ): void {
    const newSize = position.size - mergedSize;
    const isClosed = newSize <= 0.000001; // Handle precision

    this.positionRepo.save({
      ...position,
      size: isClosed ? 0 : newSize,
      costBasisUsdc: Math.max(0, position.costBasisUsdc - costBasisConsumed),
      realizedPnl: position.realizedPnl + pnlShare,
      status: isClosed ? "closed" : position.status,
      closedAt: isClosed ? new Date().toISOString() : position.closedAt,
      updatedAt: new Date().toISOString(),
    });
  }
}
