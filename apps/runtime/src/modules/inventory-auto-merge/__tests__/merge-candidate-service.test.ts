import { describe, it, expect, vi, beforeEach } from "vitest";
import { MergeCandidateService } from "../merge-candidate-service.js";
import { createTokenId, createPositionId } from "@krabs/domain";
import type {
  PositionRepository,
  OrderRepository,
  MarketRepository,
  FillRepository,
  Position,
  Market,
  Order,
} from "@krabs/domain";

describe("MergeCandidateService", () => {
  let positionRepo: PositionRepository;
  let orderRepo: OrderRepository;
  let marketRepo: MarketRepository;
  let fillRepo: FillRepository;
  let service: MergeCandidateService;

  beforeEach(() => {
    positionRepo = {
      findOpen: vi.fn(),
    } as any;
    orderRepo = {
      findByTokenId: vi.fn(),
    } as any;
    marketRepo = {
      findByTokenId: vi.fn(),
    } as any;
    fillRepo = {
      findByOrderId: vi.fn().mockReturnValue([]),
    } as any;
    service = new MergeCandidateService(positionRepo, orderRepo, marketRepo, fillRepo);
  });

  it("returns empty array when no positions are open", () => {
    (positionRepo.findOpen as any).mockReturnValue([]);
    const result = service.findMergeCandidates();
    expect(result).toEqual([]);
  });

  it("identifies mergeable YES and NO positions", () => {
    const yesToken = createTokenId("tok-yes");
    const noToken = createTokenId("tok-no");
    const conditionId = "cond-1";

    const yesMarket: Partial<Market> = {
      tokenId: yesToken,
      conditionId,
      outcome: "Yes",
      outcomeIndex: 0,
    };
    const noMarket: Partial<Market> = {
      tokenId: noToken,
      conditionId,
      outcome: "No",
      outcomeIndex: 1,
    };

    const yesPos: Partial<Position> = {
      positionId: createPositionId("pos-yes"),
      tokenId: yesToken,
      size: 100,
    };
    const noPos: Partial<Position> = {
      positionId: createPositionId("pos-no"),
      tokenId: noToken,
      size: 80,
    };

    (positionRepo.findOpen as any).mockReturnValue([yesPos, noPos]);
    (marketRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === yesToken) return yesMarket;
      if (tid === noToken) return noMarket;
      return null;
    });
    (orderRepo.findByTokenId as any).mockReturnValue([]);

    const result = service.findMergeCandidates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      conditionId,
      mergeAmount: 80,
      yesTokenId: yesToken,
      noTokenId: noToken,
    });
  });

  it("accounts for locked tokens in open SELL orders", () => {
    const yesToken = createTokenId("tok-yes");
    const noToken = createTokenId("tok-no");
    const conditionId = "cond-1";

    const yesMarket: Partial<Market> = {
      tokenId: yesToken,
      conditionId,
      outcome: "Yes",
      outcomeIndex: 0,
    };
    const noMarket: Partial<Market> = {
      tokenId: noToken,
      conditionId,
      outcome: "No",
      outcomeIndex: 1,
    };

    const yesPos: Partial<Position> = {
      positionId: createPositionId("pos-yes"),
      tokenId: yesToken,
      size: 100,
    };
    const noPos: Partial<Position> = {
      positionId: createPositionId("pos-no"),
      tokenId: noToken,
      size: 80,
    };

    const yesOrder: Partial<Order> = {
      orderId: "yes-ord-1" as any,
      tokenId: yesToken,
      side: "sell",
      size: 30,
      status: "open",
    };

    (positionRepo.findOpen as any).mockReturnValue([yesPos, noPos]);
    (marketRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === yesToken) return yesMarket;
      if (tid === noToken) return noMarket;
      return null;
    });
    (orderRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === yesToken) return [yesOrder];
      return [];
    });
    (fillRepo.findByOrderId as any).mockImplementation((oid: string) => {
      if (oid === "yes-ord-1") return [{ size: 10 }]; // Partial fill of 10
      return [];
    });

    const result = service.findMergeCandidates();

    expect(result).toHaveLength(1);
    // yesFree = 100 - (30 - 10) = 80. noFree = 80. min(80, 80) = 80.
    expect(result[0]!.mergeAmount).toBe(80);
  });

  it("skips if merge amount is below dust threshold", () => {
    const yesToken = createTokenId("tok-yes");
    const noToken = createTokenId("tok-no");
    const conditionId = "cond-1";

    const yesMarket: Partial<Market> = {
      tokenId: yesToken,
      conditionId,
      outcome: "Yes",
      outcomeIndex: 0,
    };
    const noMarket: Partial<Market> = {
      tokenId: noToken,
      conditionId,
      outcome: "No",
      outcomeIndex: 1,
    };

    const yesPos: Partial<Position> = {
      positionId: createPositionId("pos-yes"),
      tokenId: yesToken,
      size: 0.5,
    };
    const noPos: Partial<Position> = {
      positionId: createPositionId("pos-no"),
      tokenId: noToken,
      size: 0.5,
    };

    (positionRepo.findOpen as any).mockReturnValue([yesPos, noPos]);
    (marketRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === yesToken) return yesMarket;
      if (tid === noToken) return noMarket;
      return null;
    });
    (orderRepo.findByTokenId as any).mockReturnValue([]);

    const result = service.findMergeCandidates();

    expect(result).toHaveLength(0);
  });

  it("abstains from a token that holds both an open and a dust row", () => {
    // yesLocked/noLocked are summed per TOKEN from open SELL orders, not per row — with both an
    // open and a dust row on tok-yes, sizing off the open row's free size can undercount a lock
    // that actually belongs to the dust row. `MergeSettler.applyMerge` now anchors by the
    // candidate's captured positionId (fixing the earlier wrong-row TOCTOU), but that does not
    // close this token-level undercount — so the only safe disposition for an ambiguous token
    // remains producing no candidate at all.
    const yesToken = createTokenId("tok-yes");
    const noToken = createTokenId("tok-no");
    const conditionId = "cond-1";

    const yesMarket: Partial<Market> = {
      tokenId: yesToken,
      conditionId,
      outcome: "Yes",
      outcomeIndex: 0,
    };
    const noMarket: Partial<Market> = {
      tokenId: noToken,
      conditionId,
      outcome: "No",
      outcomeIndex: 1,
    };

    const yesOpen: Partial<Position> = {
      positionId: createPositionId("pos-yes-open"),
      tokenId: yesToken,
      size: 100,
      status: "open",
      openedAt: "2026-08-11T10:00:00.000Z",
    };
    const yesDust: Partial<Position> = {
      positionId: createPositionId("pos-yes-dust"),
      tokenId: yesToken,
      size: 2,
      status: "dust",
      openedAt: "2026-08-11T12:00:00.000Z",
    };
    const noPos: Partial<Position> = {
      positionId: createPositionId("pos-no"),
      tokenId: noToken,
      size: 50,
      status: "open",
      openedAt: "2026-08-11T10:00:00.000Z",
    };

    (positionRepo.findOpen as any).mockReturnValue([yesOpen, noPos]);
    (positionRepo as any).findDust = vi.fn().mockReturnValue([yesDust]);
    (marketRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === yesToken) return yesMarket;
      if (tid === noToken) return noMarket;
      return null;
    });
    (orderRepo.findByTokenId as any).mockReturnValue([]);

    // Without the abstention this yields one candidate sized 50 off the open row.
    expect(service.findMergeCandidates()).toEqual([]);
  });
});
