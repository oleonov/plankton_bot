import { describe, expect, it } from "vitest";
import {
  evaluateExitLossFloor,
  type EvaluateExitLossFloorArgs,
  type ExitLossFloorFifoLot,
} from "../index.js";

/** A single-lot baseline that is deliberately NOT floor-blocked (20% loss vs the
 * 50% floor), so each fail-closed test can override exactly one field. */
function validArgs(overrides: Partial<EvaluateExitLossFloorArgs> = {}): EvaluateExitLossFloorArgs {
  return {
    submittedPrice: 0.4,
    fifoLots: [{ remainingSize: 10, entryPrice: 0.5 }],
    positionSize: 10,
    positionCostBasisUsdc: 5,
    estSellFeePerShare: 0,
    maxExitLossFraction: 0.5,
    ...overrides,
  };
}

describe("evaluateExitLossFloor (max-lot bound)", () => {
  it("does not block an ordinary small-loss exit (baseline sanity)", () => {
    expect(evaluateExitLossFloor(validArgs())).toEqual({ block: false, reason: null });
  });

  it("bounds the loss by the MOST EXPENSIVE remaining lot, not the average", () => {
    // Lots 5@0.90 and 10@0.20 (avg = (4.5+2)/15 ≈ 0.433). A sell at 0.30 is a 31%
    // loss vs the average but a 67% loss vs the 0.90 max-lot → BLOCKED. This is the
    // whole point: no fill order can make a share cost more than the max lot.
    const lots: ExitLossFloorFifoLot[] = [
      { remainingSize: 5, entryPrice: 0.9 },
      { remainingSize: 10, entryPrice: 0.2 },
    ];
    const args = validArgs({
      fifoLots: lots,
      positionSize: 15,
      positionCostBasisUsdc: 5 * 0.9 + 10 * 0.2, // 6.5
      submittedPrice: 0.3,
    });
    expect(evaluateExitLossFloor(args)).toEqual({ block: true, reason: "exit_loss_floor_blocked" });
  });

  it("does not block a profitable exit even on a heterogeneous position", () => {
    // Max-lot 0.90; a sell at 0.80 is well above (1-0.5)*0.90 = 0.45 → passes.
    const args = validArgs({
      fifoLots: [
        { remainingSize: 5, entryPrice: 0.9 },
        { remainingSize: 5, entryPrice: 0.1 },
      ],
      positionSize: 10,
      positionCostBasisUsdc: 5 * 0.9 + 5 * 0.1, // 5
      submittedPrice: 0.8,
    });
    expect(evaluateExitLossFloor(args)).toEqual({ block: false, reason: null });
  });

  it("allows exactly the 50% boundary (strict '>' only blocks beyond it)", () => {
    const args = validArgs({
      fifoLots: [{ remainingSize: 10, entryPrice: 1.0 }],
      positionSize: 10,
      positionCostBasisUsdc: 10,
      submittedPrice: 0.5, // lossFraction = 1 - 0.5/1.0 = 0.5 exactly
    });
    expect(evaluateExitLossFloor(args)).toEqual({ block: false, reason: null });
    expect(evaluateExitLossFloor({ ...args, submittedPrice: 0.49 })).toEqual({
      block: true,
      reason: "exit_loss_floor_blocked",
    });
  });

  it("blocks when the fee pushes the net price below the floor (fee>0 case)", () => {
    const base = validArgs({ submittedPrice: 0.3 }); // max-lot 0.5
    // No fee: 1 - 0.3/0.5 = 0.4 → not blocked.
    expect(evaluateExitLossFloor({ ...base, estSellFeePerShare: 0 })).toEqual({
      block: false,
      reason: null,
    });
    // fee 0.15 → net 0.15 → 1 - 0.15/0.5 = 0.7 > 0.5 → blocked purely due to the fee.
    expect(evaluateExitLossFloor({ ...base, estSellFeePerShare: 0.15 })).toEqual({
      block: true,
      reason: "exit_loss_floor_blocked",
    });
  });

  it("ignores fully-consumed (remainingSize 0) lots when picking the max lot", () => {
    // A pricey 0.99 lot with 0 remaining must NOT raise the max-lot bound.
    const args = validArgs({
      fifoLots: [
        { remainingSize: 0, entryPrice: 0.99 },
        { remainingSize: 10, entryPrice: 0.5 },
      ],
      positionSize: 10,
      positionCostBasisUsdc: 5,
      submittedPrice: 0.3, // 1 - 0.3/0.5 = 0.4 → not blocked (0.99 lot ignored)
    });
    expect(evaluateExitLossFloor(args)).toEqual({ block: false, reason: null });
  });

  describe("fail-closed on missing/NaN/non-positive scalar inputs", () => {
    const invalidValues = [null, undefined, NaN, 0, -1];

    it.each(invalidValues)("blocks with invalid_submitted_price for %s", (value) => {
      expect(evaluateExitLossFloor(validArgs({ submittedPrice: value }))).toEqual({
        block: true,
        reason: "invalid_submitted_price",
      });
    });

    it.each(invalidValues)("blocks with invalid_position_size for %s", (value) => {
      expect(evaluateExitLossFloor(validArgs({ positionSize: value }))).toEqual({
        block: true,
        reason: "invalid_position_size",
      });
    });

    it.each(invalidValues)("blocks with invalid_position_cost_basis for %s", (value) => {
      expect(evaluateExitLossFloor(validArgs({ positionCostBasisUsdc: value }))).toEqual({
        block: true,
        reason: "invalid_position_cost_basis",
      });
    });
  });

  describe("fail-closed on invalid fee / floor / lot values", () => {
    it.each([NaN, Number.POSITIVE_INFINITY, -0.01, -1])(
      "blocks with invalid_fee for estSellFeePerShare %s",
      (value) => {
        expect(evaluateExitLossFloor(validArgs({ estSellFeePerShare: value }))).toEqual({
          block: true,
          reason: "invalid_fee",
        });
      },
    );

    it.each([NaN, 0, -0.5, 1.01, Number.POSITIVE_INFINITY])(
      "blocks with invalid_floor for maxExitLossFraction %s",
      (value) => {
        expect(evaluateExitLossFloor(validArgs({ maxExitLossFraction: value }))).toEqual({
          block: true,
          reason: "invalid_floor",
        });
      },
    );

    it.each([
      { remainingSize: 10, entryPrice: 0 },
      { remainingSize: 10, entryPrice: -0.5 },
      { remainingSize: 10, entryPrice: NaN },
      { remainingSize: -1, entryPrice: 0.5 },
      { remainingSize: NaN, entryPrice: 0.5 },
    ])("blocks with invalid_lot for lot %o", (badLot) => {
      expect(
        evaluateExitLossFloor(
          validArgs({
            fifoLots: [badLot as ExitLossFloorFifoLot],
            positionSize: 10,
            positionCostBasisUsdc: 5,
          }),
        ),
      ).toEqual({ block: true, reason: "invalid_lot" });
    });
  });

  describe("fail-closed on empty lots / ledger inconsistency", () => {
    it("blocks with insufficient_fifo_lots for an empty lot array", () => {
      expect(evaluateExitLossFloor(validArgs({ fifoLots: [] }))).toEqual({
        block: true,
        reason: "insufficient_fifo_lots",
      });
    });

    it("blocks with insufficient_fifo_lots when every lot is fully consumed", () => {
      expect(
        evaluateExitLossFloor(validArgs({ fifoLots: [{ remainingSize: 0, entryPrice: 0.5 }] })),
      ).toEqual({ block: true, reason: "insufficient_fifo_lots" });
    });

    it("blocks with cost_inconsistent when total remaining shares diverge from positionSize", () => {
      expect(evaluateExitLossFloor(validArgs({ positionSize: 999 }))).toEqual({
        block: true,
        reason: "cost_inconsistent",
      });
    });

    it("blocks with cost_inconsistent when total remaining cost diverges from positionCostBasisUsdc", () => {
      expect(evaluateExitLossFloor(validArgs({ positionCostBasisUsdc: 999 }))).toEqual({
        block: true,
        reason: "cost_inconsistent",
      });
    });

    it("does not fail-closed on a mismatch within the 1e-6 relative tolerance", () => {
      expect(evaluateExitLossFloor(validArgs({ positionSize: 10 + 5e-6 }))).toEqual({
        block: false,
        reason: null,
      });
    });
  });
});
