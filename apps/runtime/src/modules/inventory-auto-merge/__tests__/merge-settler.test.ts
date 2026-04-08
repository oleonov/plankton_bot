import { describe, it, expect, vi, beforeEach } from "vitest";
import { MergeSettler } from "../merge-settler.js";
import type {
  PositionRepository,
  InventoryLotRepository,
  Position,
} from "@plankton/domain";
import type { Database } from "better-sqlite3";

describe("MergeSettler", () => {
  let positionRepo: PositionRepository;
  let lotRepo: InventoryLotRepository;
  let mergeLedgerRepo: MergeLedgerRepository;
  let db: Database;
  let settler: MergeSettler;

  beforeEach(() => {
    positionRepo = {
      findByTokenId: vi.fn(),
      save: vi.fn(),
    } as any;
    lotRepo = {
      consumeFifo: vi.fn(),
    } as any;
    mergeLedgerRepo = {
      save: vi.fn(),
    } as any;
    db = {
      prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
      transaction: vi.fn((cb) => cb),
    } as any;
    settler = new MergeSettler(positionRepo, lotRepo, mergeLedgerRepo, db);
  });

  it("applies merge correctly to both positions and lots", () => {
    const candidate = {
      conditionId: "cond-1",
      familyId: "fam-1" as any,
      mergeAmount: 50,
      yesTokenId: "tok-yes" as any,
      noTokenId: "tok-no" as any,
      yesPositionId: "pos-yes" as any,
      noPositionId: "pos-no" as any,
    };

    const yesPos: Partial<Position> = {
      positionId: "pos-yes" as any,
      tokenId: "tok-yes" as any,
      size: 100,
      costBasisUsdc: 40,
      avgEntryPrice: 0.4,
      realizedPnl: 0,
      status: "open",
    };
    const noPos: Partial<Position> = {
      positionId: "pos-no" as any,
      tokenId: "tok-no" as any,
      size: 80,
      costBasisUsdc: 48,
      avgEntryPrice: 0.6,
      realizedPnl: 0,
      status: "open",
    };

    (positionRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === "tok-yes") return yesPos;
      if (tid === "tok-no") return noPos;
      return null;
    });

    (lotRepo.consumeFifo as any).mockImplementation((pid: string, amount: number) => {
      if (pid === "pos-yes") return [{ lot: { entryPrice: 0.4 }, consumed: amount }];
      if (pid === "pos-no") return [{ lot: { entryPrice: 0.6 }, consumed: amount }];
      return [];
    });

    settler.applyMerge(candidate);

    // Verify lots consumed
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("pos-yes", 50);
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("pos-no", 50);

    // Total cost = 50*0.4 + 50*0.6 = 20 + 30 = 50.
    // Total merge value = 50 * 1.0 = 50.
    // Spread PnL = 50 - 50 = 0.
    
    // Verify positions updated
    expect(positionRepo.save).toHaveBeenCalledTimes(2);
    expect(positionRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      positionId: "pos-yes",
      size: 50,
      costBasisUsdc: 20, // 40 - 20
      realizedPnl: 0,
    }));
    expect(positionRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      positionId: "pos-no",
      size: 30, // 80 - 50
      costBasisUsdc: 18, // 48 - 30
      realizedPnl: 0,
    }));
  });

  it("handles profitable merge spread correctly", () => {
    const candidate = {
      conditionId: "cond-1",
      familyId: "fam-1" as any,
      mergeAmount: 50,
      yesTokenId: "tok-yes" as any,
      noTokenId: "tok-no" as any,
      yesPositionId: "pos-yes" as any,
      noPositionId: "pos-no" as any,
    };

    const yesPos: Partial<Position> = {
      positionId: "pos-yes" as any,
      tokenId: "tok-yes" as any,
      size: 50,
      costBasisUsdc: 10,
      avgEntryPrice: 0.2,
      realizedPnl: 0,
      status: "open",
    };
    const noPos: Partial<Position> = {
      positionId: "pos-no" as any,
      tokenId: "tok-no" as any,
      size: 50,
      costBasisUsdc: 30,
      avgEntryPrice: 0.6,
      realizedPnl: 0,
      status: "open",
    };

    (positionRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === "tok-yes") return yesPos;
      if (tid === "tok-no") return noPos;
      return null;
    });

    (lotRepo.consumeFifo as any).mockImplementation((pid: string, amount: number) => {
      if (pid === "pos-yes") return [{ lot: { entryPrice: 0.2 }, consumed: amount }];
      if (pid === "pos-no") return [{ lot: { entryPrice: 0.6 }, consumed: amount }];
      return [];
    });

    settler.applyMerge(candidate);

    // Total cost = 50*0.2 + 50*0.6 = 10 + 30 = 40.
    // Total merge value = 50 * 1.0 = 50.
    // Spread PnL = 50 - 40 = 10. Profit!
    // Shared profit = 5 per side.

    expect(positionRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      positionId: "pos-yes",
      size: 0,
      status: "closed",
      realizedPnl: 5,
    }));
    expect(positionRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      positionId: "pos-no",
      size: 0,
      status: "closed",
      realizedPnl: 5,
    }));
  });
});
