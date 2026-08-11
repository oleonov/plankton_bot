import type Database from "better-sqlite3";
import type {
  PositionRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
  Position,
} from "@krabs/domain";
import type { MergeCandidate } from "./merge-candidate-service.js";

/** Both legs exactly as this merge left them — including a leg the merge closed. */
export interface MergedPositions {
  yes: Position;
  no: Position;
}

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

  /**
   * `mergeId` is the SAME id `InventoryManagerModule` already recorded as 'pending'/'onchain'
   * before this ran — it is passed in, not generated here, so this transaction advances that exact
   * row to 'applied' instead of inserting an unrelated second one.
   *
   * Returns both post-merge legs because the caller CANNOT read them back: a merge that consumes a
   * leg entirely closes it, and `PositionRepository.findByTokenId` filters `status != 'closed'`, so
   * a re-read silently drops exactly the leg whose closure subscribers most need to hear about.
   */
  applyMerge(candidate: MergeCandidate, mergeId: string): MergedPositions {
    const runMerge = this.db.transaction((): MergedPositions => {
      // 1. Fetch positions (must be open). Anchored to the candidate's positionId, not re-selected by
      // token: the candidate's identity was captured before an irreversible on-chain settlement, and
      // a `findByTokenId` re-read here could resolve to a row a SELL+BUY replaced in the meantime,
      // debiting the wrong row's lots.
      const yesPos = this.positionRepo.findById(candidate.yesPositionId);
      const noPos = this.positionRepo.findById(candidate.noPositionId);

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

      // 4. Advance the ledger row that already recorded this merge's intent ('pending' then
      // 'onchain') to 'applied', in the SAME transaction as the position/lot mutations below —
      // that is what guarantees the ledger and the positions can never disagree with each other.
      this.mergeLedgerRepo.markApplied({
        mergeId,
        conditionId: candidate.conditionId,
        mergedAmount: candidate.mergeAmount,
        spreadPnl,
        mergedAt: new Date().toISOString(),
        status: "applied",
      });

      // 5. Update positions
      return {
        yes: this.updatePositionAfterMerge(
          yesPos,
          candidate.mergeAmount,
          yesCostBasis,
          spreadPnl / 2,
        ),
        no: this.updatePositionAfterMerge(noPos, candidate.mergeAmount, noCostBasis, spreadPnl / 2),
      };
    });

    return runMerge();
  }

  private updatePositionAfterMerge(
    position: Position,
    mergedSize: number,
    costBasisConsumed: number,
    pnlShare: number,
  ): Position {
    const newSize = position.size - mergedSize;
    const isClosed = newSize <= 0.000001; // Handle precision
    const newCostBasis = Math.max(0, position.costBasisUsdc - costBasisConsumed);

    const updated: Position = {
      ...position,
      size: isClosed ? 0 : newSize,
      avgEntryPrice: isClosed ? 0 : newCostBasis / newSize,
      costBasisUsdc: newCostBasis,
      currentValueUsdc: isClosed ? 0 : null, // Defer revaluation to next tick
      realizedPnl: position.realizedPnl + pnlShare,
      status: isClosed ? "closed" : position.status,
      closedAt: isClosed ? new Date().toISOString() : position.closedAt,
      updatedAt: new Date().toISOString(),
    };
    this.positionRepo.save(updated);
    return updated;
  }
}
