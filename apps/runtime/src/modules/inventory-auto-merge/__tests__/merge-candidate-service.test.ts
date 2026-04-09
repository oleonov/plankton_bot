import { describe, it, expect, vi, beforeEach } from "vitest";
import { MergeCandidateService } from "../merge-candidate-service.js";
import { createTokenId, createFamilyId, createPositionId } from "@plankton/domain";
import type {
  PositionRepository,
  OrderRepository,
  MarketRepository,
  FillRepository,
  Position,
  Market,
  Order,
} from "@plankton/domain";

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
      familyId: createFamilyId("fam-1"),
    };
    const noPos: Partial<Position> = {
      positionId: createPositionId("pos-no"),
      tokenId: noToken,
      size: 80,
      familyId: createFamilyId("fam-1"),
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
      familyId: createFamilyId("fam-1"),
    };
    const noPos: Partial<Position> = {
      positionId: createPositionId("pos-no"),
      tokenId: noToken,
      size: 80,
      familyId: createFamilyId("fam-1"),
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
      familyId: createFamilyId("fam-1"),
    };
    const noPos: Partial<Position> = {
      positionId: createPositionId("pos-no"),
      tokenId: noToken,
      size: 0.5,
      familyId: createFamilyId("fam-1"),
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
});
