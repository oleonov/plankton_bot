// Money-critical safety envelope for exit SELLs
// (docs/plans/2026-07-20-exit-loss-floor.md). Never let an exit SELL SUBMISSION
// realize a fee-adjusted loss beyond `maxExitLossFraction` on the shares it
// consumes. Pure — no I/O; the runtime wires this at the exchange-submission
// boundary.
//
// DESIGN (max-lot, decided 2026-07-20 after two adversarial code-review rounds —
// research_plankton/exit_loss_floor_maxlot_decision_2026-07-20.md): bound the
// realized loss by the position's MOST EXPENSIVE remaining lot. Any share
// consumed — in any fill order, partial fill, concurrency pattern, or after any
// cancellation — has `entryPrice ≤ maxLot`, so
//
//     consumed average cost ≤ maxLot
//     netPrice ≥ (1 − floor) × maxLot ≥ (1 − floor) × consumed average cost
//     ⇒ realized loss ≤ floor.
//
// This is UNCONDITIONALLY safe with a per-order check that needs no sell size,
// priority, reservation, exclusion, or competing-order-set reconstruction — it
// sidesteps the whole class of concurrent-SELL / exchange-only / FIFO-slice /
// survivor-set / partial-fill defects a precise slice planner has to chase. Its
// only cost is conservatism (it can over-block a cheap-lot exit on a
// heterogeneous position), which for this fail-to-HOLD invariant is
// strategy-aligned: plankton never dumps and holds losers to resolution, so an
// over-blocked exit simply becomes a HOLD. The floor exists to isolate the true
// >50% dump tail (plankton's realized p1 ≈ −53%, only 1.1% of sells ≤ −50%).

/**
 * Minimal FIFO lot shape the evaluator needs. Field names match `InventoryLot`
 * (`remainingSize`, `entryPrice`) so callers can pass real lots (from
 * `InventoryLotRepository.findOpen`) straight through without a translation layer.
 */
export interface ExitLossFloorFifoLot {
  readonly remainingSize: number;
  readonly entryPrice: number;
}

export interface EvaluateExitLossFloorArgs {
  readonly submittedPrice: number | null | undefined;
  readonly fifoLots: readonly ExitLossFloorFifoLot[];
  readonly positionSize: number | null | undefined;
  readonly positionCostBasisUsdc: number | null | undefined;
  readonly estSellFeePerShare: number;
  readonly maxExitLossFraction: number;
}

export type ExitLossFloorReason =
  | "invalid_submitted_price"
  | "invalid_position_size"
  | "invalid_position_cost_basis"
  | "insufficient_fifo_lots"
  | "cost_inconsistent"
  | "invalid_fee"
  | "invalid_floor"
  | "invalid_lot"
  | "exchange_state_unreconciled"
  | "exit_loss_floor_blocked";

export interface ExitLossFloorVerdict {
  readonly block: boolean;
  readonly reason: ExitLossFloorReason | null;
}

/**
 * Ledger-consistency tolerance (finding #1): the lot totals must match the
 * position record within this relative tolerance, or the read is treated as
 * corrupt and the evaluator fails closed — a max-lot bound is only provable
 * against a COMPLETE cost ledger. Prod has 0 unavailable/inconsistent bases
 * across 66 live-lite + 29 paper positions, so tripping this is anomalous.
 */
export const EXIT_LOSS_FLOOR_COST_TOLERANCE = 1e-6;

export function evaluateExitLossFloor(args: EvaluateExitLossFloorArgs): ExitLossFloorVerdict {
  if (!isFinitePositive(args.submittedPrice)) return blocked("invalid_submitted_price");
  if (!isFinitePositive(args.positionSize)) return blocked("invalid_position_size");
  if (!isFinitePositive(args.positionCostBasisUsdc)) return blocked("invalid_position_cost_basis");
  // Fail closed on an invalid fee / floor: a NaN/negative fee or an out-of-range
  // floor would make the final comparison silently false and let a dump pass. A
  // fee UNDER-estimate is unsafe, so callers must pass a non-underestimated fee.
  if (!Number.isFinite(args.estSellFeePerShare) || args.estSellFeePerShare < 0) {
    return blocked("invalid_fee");
  }
  if (
    !Number.isFinite(args.maxExitLossFraction) ||
    args.maxExitLossFraction <= 0 ||
    args.maxExitLossFraction > 1
  ) {
    return blocked("invalid_floor");
  }

  // The cost ledger must be present and complete: walk every lot, validate it,
  // total remaining size + cost for the consistency check, and track the most
  // expensive remaining lot.
  let totalRemainingSize = 0;
  let totalRemainingCostUsdc = 0;
  let maxRemainingLotEntryPrice = 0;
  let hasRemaining = false;
  for (const lot of args.fifoLots) {
    if (
      !Number.isFinite(lot.remainingSize) ||
      lot.remainingSize < 0 ||
      !Number.isFinite(lot.entryPrice) ||
      lot.entryPrice <= 0
    ) {
      return blocked("invalid_lot");
    }
    totalRemainingSize += lot.remainingSize;
    totalRemainingCostUsdc += lot.remainingSize * lot.entryPrice;
    if (lot.remainingSize > 0) {
      hasRemaining = true;
      if (lot.entryPrice > maxRemainingLotEntryPrice) maxRemainingLotEntryPrice = lot.entryPrice;
    }
  }
  if (!hasRemaining) return blocked("insufficient_fifo_lots");

  const sizeConsistent = withinRelativeTolerance(
    totalRemainingSize,
    args.positionSize,
    EXIT_LOSS_FLOOR_COST_TOLERANCE,
  );
  const costConsistent = withinRelativeTolerance(
    totalRemainingCostUsdc,
    args.positionCostBasisUsdc,
    EXIT_LOSS_FLOOR_COST_TOLERANCE,
  );
  if (!sizeConsistent || !costConsistent) return blocked("cost_inconsistent");

  const netPrice = args.submittedPrice - args.estSellFeePerShare;
  const lossFraction = 1 - netPrice / maxRemainingLotEntryPrice;
  if (lossFraction > args.maxExitLossFraction) return blocked("exit_loss_floor_blocked");
  return { block: false, reason: null };
}

function withinRelativeTolerance(actual: number, expected: number, relTolerance: number): boolean {
  return Math.abs(actual - expected) / expected <= relTolerance;
}

function blocked(reason: ExitLossFloorReason): ExitLossFloorVerdict {
  return { block: true, reason };
}

function isFinitePositive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}
