import { describe, it, expect, vi, beforeEach } from "vitest";
import { MergeSettler } from "../merge-settler.js";
import type {
  PositionRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
  Position,
} from "@krabs/domain";
import type { Database } from "better-sqlite3";

describe("MergeSettler", () => {
  let positionRepo: PositionRepository;
  let lotRepo: InventoryLotRepository;
  let mergeLedgerRepo: MergeLedgerRepository;
  let db: Database;
  let settler: MergeSettler;

  beforeEach(() => {
    positionRepo = {
      findById: vi.fn(),
      findByTokenId: vi.fn(),
      save: vi.fn(),
    } as any;
    lotRepo = {
      consumeFifo: vi.fn(),
    } as any;
    mergeLedgerRepo = {
      recordPending: vi.fn(),
      markOnchain: vi.fn(),
      markApplied: vi.fn(),
      deletePending: vi.fn(),
      findNonTerminal: vi.fn().mockReturnValue([]),
    } as any;
    db = {
      prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
      transaction: vi.fn((cb) => cb),
    } as any;
    settler = new MergeSettler(positionRepo, lotRepo, mergeLedgerRepo, db);
  });

  it("applies merge correctly to both positions and lots", () => {
    const candidate = {
      conditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
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

    (positionRepo.findById as any).mockImplementation((pid: string) => {
      if (pid === "pos-yes") return yesPos;
      if (pid === "pos-no") return noPos;
      return null;
    });

    (lotRepo.consumeFifo as any).mockImplementation((pid: string, amount: number) => {
      if (pid === "pos-yes") return [{ lot: { entryPrice: 0.4 }, consumed: amount }];
      if (pid === "pos-no") return [{ lot: { entryPrice: 0.6 }, consumed: amount }];
      return [];
    });

    settler.applyMerge(candidate, "merge-cond-1");

    // The settler must advance the SAME mergeId it was given, not mint its own — that id is the
    // one InventoryManagerModule already wrote as 'pending'/'onchain' before this ran.
    expect(mergeLedgerRepo.markApplied).toHaveBeenCalledWith(
      expect.objectContaining({ mergeId: "merge-cond-1", status: "applied" }),
    );

    // Verify lots consumed
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("pos-yes", 50);
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("pos-no", 50);

    // Total cost = 50*0.4 + 50*0.6 = 20 + 30 = 50.
    // Total merge value = 50 * 1.0 = 50.
    // Spread PnL = 50 - 50 = 0.

    // Verify positions updated
    expect(positionRepo.save).toHaveBeenCalledTimes(2);
    expect(positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "pos-yes",
        size: 50,
        costBasisUsdc: 20, // 40 - 20
        avgEntryPrice: 0.4,
        currentValueUsdc: null,
        realizedPnl: 0,
      }),
    );
    expect(positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "pos-no",
        size: 30, // 80 - 50
        costBasisUsdc: 18, // 48 - 30
        avgEntryPrice: 0.6,
        currentValueUsdc: null,
        realizedPnl: 0,
      }),
    );
  });

  it("handles profitable merge spread correctly", () => {
    const candidate = {
      conditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
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

    (positionRepo.findById as any).mockImplementation((pid: string) => {
      if (pid === "pos-yes") return yesPos;
      if (pid === "pos-no") return noPos;
      return null;
    });

    (lotRepo.consumeFifo as any).mockImplementation((pid: string, amount: number) => {
      if (pid === "pos-yes") return [{ lot: { entryPrice: 0.2 }, consumed: amount }];
      if (pid === "pos-no") return [{ lot: { entryPrice: 0.6 }, consumed: amount }];
      return [];
    });

    settler.applyMerge(candidate, "merge-cond-2");

    // Total cost = 50*0.2 + 50*0.6 = 10 + 30 = 40.
    // Total merge value = 50 * 1.0 = 50.
    // Spread PnL = 50 - 40 = 10. Profit!
    // Shared profit = 5 per side.

    expect(positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "pos-yes",
        size: 0,
        status: "closed",
        realizedPnl: 5,
      }),
    );
    expect(positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "pos-no",
        size: 0,
        status: "closed",
        realizedPnl: 5,
      }),
    );
  });

  it("anchors both legs to the candidate's positionId, not the newest row for the token (TOCTOU)", () => {
    // P is the row the candidate was built against; Q is a NEWER non-closed sibling row for the
    // SAME yes token — the very row `findByTokenId` would (wrongly) pick if the settler re-selected
    // by token instead of trusting the candidate's captured identity. Q is NOT an await-window BUY:
    // the fill path resolves any non-closed row and adds to it rather than creating a sibling, so a
    // live P never grows a Q that way. This is the legacy multi-non-closed-row shape that predates
    // (and motivates) the open-position conflict detector, which is exactly why the settler must
    // never re-select by token.
    const candidate = {
      conditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
      familyId: "fam-1" as any,
      mergeAmount: 50,
      yesTokenId: "tok-yes" as any,
      noTokenId: "tok-no" as any,
      yesPositionId: "pos-yes-P" as any,
      noPositionId: "pos-no" as any,
    };

    const yesPosP: Partial<Position> = {
      positionId: "pos-yes-P" as any,
      tokenId: "tok-yes" as any,
      size: 100,
      costBasisUsdc: 40,
      avgEntryPrice: 0.4,
      realizedPnl: 0,
      // dust, not open: migration 032's partial unique index permits only ONE open row per token,
      // so P and Q coexisting as both "open" is a state the real repository can never produce. Q
      // stays "open" — the winner findByTokenId would (wrongly) pick if the settler re-selected by
      // token instead of trusting the candidate's captured identity.
      status: "dust",
      openedAt: "2026-01-01T00:00:00.000Z",
    };
    const yesPosQ: Partial<Position> = {
      positionId: "pos-yes-Q" as any,
      tokenId: "tok-yes" as any,
      size: 30,
      costBasisUsdc: 9,
      avgEntryPrice: 0.3,
      realizedPnl: 0,
      status: "open",
      openedAt: "2026-01-02T00:00:00.000Z", // newer than P
    };
    const noPos: Partial<Position> = {
      positionId: "pos-no" as any,
      tokenId: "tok-no" as any,
      size: 80,
      costBasisUsdc: 48,
      avgEntryPrice: 0.6,
      realizedPnl: 0,
      status: "open",
      openedAt: "2026-01-01T00:00:00.000Z",
    };
    const rowsById = new Map<string, Partial<Position>>([
      ["pos-yes-P", yesPosP],
      ["pos-yes-Q", yesPosQ],
      ["pos-no", noPos],
    ]);

    (positionRepo.findById as any).mockImplementation((pid: string) => rowsById.get(pid) ?? null);
    // Faithful to the real repository: newest non-closed row by openedAt DESC. For tok-yes that is
    // Q, not the candidate's P — this is what makes the test fail if the settler reverts to
    // findByTokenId.
    (positionRepo.findByTokenId as any).mockImplementation((tid: string) => {
      const matches = [...rowsById.values()].filter(
        (p) => p.tokenId === tid && p.status !== "closed",
      );
      matches.sort((a, b) => (a.openedAt! < b.openedAt! ? 1 : -1));
      return matches[0] ?? null;
    });

    (lotRepo.consumeFifo as any).mockImplementation((pid: string, amount: number) => {
      if (pid === "pos-yes-P") return [{ lot: { entryPrice: 0.4 }, consumed: amount }];
      if (pid === "pos-no") return [{ lot: { entryPrice: 0.6 }, consumed: amount }];
      return [];
    });

    settler.applyMerge(candidate, "merge-cond-toctou");

    // Settlement must consume P's lots — the candidate's anchored row.
    expect(lotRepo.consumeFifo).toHaveBeenCalledWith("pos-yes-P", 50);
    // Q must never be touched: not consumed, not saved.
    expect(lotRepo.consumeFifo).not.toHaveBeenCalledWith("pos-yes-Q", expect.anything());
    expect(positionRepo.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ positionId: "pos-yes-Q" }),
    );
    expect(positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: "pos-yes-P",
        size: 50,
        costBasisUsdc: 20, // 40 - 50*0.4
      }),
    );
  });

  it("aborts on the closed-then-replaced race rather than debiting the token's newest row", () => {
    // The reachable await-window race, and the one the anchored lookup exists for: P — the row the
    // candidate was built against — is fully CLOSED by a SELL, and only THEN does a BUY create Q
    // for the same token (a closed row is no longer resolvable by the fill path, so that BUY has
    // nothing to add to). The anchored lookup finds the closed P and aborts. A settler that
    // re-selected by token would find Q — by then the token's only non-closed row — and debit lots
    // the on-chain merge never moved. `findByTokenId` is configured faithfully here on purpose: the
    // sibling test below leaves it unset, so a reverted implementation throws there for the wrong
    // reason and that test alone would NOT catch the regression.
    const candidate = {
      conditionId: "0x3333333333333333333333333333333333333333333333333333333333333333",
      familyId: "fam-3" as any,
      mergeAmount: 50,
      yesTokenId: "tok-yes" as any,
      noTokenId: "tok-no" as any,
      yesPositionId: "pos-yes-P" as any,
      noPositionId: "pos-no" as any,
    };

    const rowsById = new Map<string, Partial<Position>>([
      [
        "pos-yes-P",
        {
          positionId: "pos-yes-P" as any,
          tokenId: "tok-yes" as any,
          size: 0,
          costBasisUsdc: 0,
          avgEntryPrice: 0.4,
          realizedPnl: 0,
          status: "closed",
          openedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [
        "pos-yes-Q",
        {
          positionId: "pos-yes-Q" as any,
          tokenId: "tok-yes" as any,
          size: 30,
          costBasisUsdc: 9,
          avgEntryPrice: 0.3,
          realizedPnl: 0,
          status: "open",
          openedAt: "2026-01-02T00:00:00.000Z", // created only after P closed
        },
      ],
      [
        "pos-no",
        {
          positionId: "pos-no" as any,
          tokenId: "tok-no" as any,
          size: 80,
          costBasisUsdc: 48,
          avgEntryPrice: 0.6,
          realizedPnl: 0,
          status: "open",
          openedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    ]);

    (positionRepo.findById as any).mockImplementation((pid: string) => rowsById.get(pid) ?? null);
    (positionRepo.findByTokenId as any).mockImplementation((tid: string) => {
      const matches = [...rowsById.values()].filter(
        (p) => p.tokenId === tid && p.status !== "closed",
      );
      matches.sort((a, b) => (a.openedAt! < b.openedAt! ? 1 : -1));
      return matches[0] ?? null;
    });
    (lotRepo.consumeFifo as any).mockImplementation((pid: string, amount: number) => {
      if (pid === "pos-yes-Q") return [{ lot: { entryPrice: 0.3 }, consumed: amount }];
      if (pid === "pos-no") return [{ lot: { entryPrice: 0.6 }, consumed: amount }];
      return [];
    });

    expect(() => settler.applyMerge(candidate, "merge-cond-replaced")).toThrow(
      "Cannot merge: one or both positions are missing or closed",
    );

    // Q is the row the wrong lookup would have debited — it must not be touched, and neither may
    // anything else: the abort has to happen before the first mutation.
    expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
    expect(positionRepo.save).not.toHaveBeenCalled();
    expect(mergeLedgerRepo.markApplied).not.toHaveBeenCalled();
  });

  it("throws and mutates nothing when the candidate's anchored position no longer resolves", () => {
    // pos-yes-gone was fully closed by a SELL during the on-chain-settlement await window, and
    // nothing new was created for that token — findById on the candidate's own id is the only
    // lookup this exercises, so it must come back null and abort before any mutation.
    const candidate = {
      conditionId: "0x2222222222222222222222222222222222222222222222222222222222222222",
      familyId: "fam-2" as any,
      mergeAmount: 50,
      yesTokenId: "tok-yes" as any,
      noTokenId: "tok-no" as any,
      yesPositionId: "pos-yes-gone" as any,
      noPositionId: "pos-no" as any,
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

    (positionRepo.findById as any).mockImplementation((pid: string) => {
      if (pid === "pos-no") return noPos;
      return null; // pos-yes-gone: closed, nothing recreated
    });

    expect(() => settler.applyMerge(candidate, "merge-cond-gone")).toThrow(
      "Cannot merge: one or both positions are missing or closed",
    );

    expect(lotRepo.consumeFifo).not.toHaveBeenCalled();
    expect(mergeLedgerRepo.markApplied).not.toHaveBeenCalled();
    expect(positionRepo.save).not.toHaveBeenCalled();
  });
});
