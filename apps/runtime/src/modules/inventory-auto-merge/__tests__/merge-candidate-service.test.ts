import { describe, it, expect, vi, beforeEach } from "vitest";
import { MergeCandidateService } from "../merge-candidate-service.js";
import type {
  PositionRepository,
  OrderRepository,
  MarketRepository,
  Position,
  Market,
  Order,
} from "@plankton/domain";

describe("MergeCandidateService", () => {
  let positionRepo: PositionRepository;
  let orderRepo: OrderRepository;
  let marketRepo: MarketRepository;
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
    service = new MergeCandidateService(positionRepo, orderRepo, marketRepo);
  });

  it("returns empty array when no positions are open", () => {
    (positionRepo.findOpen as any).mockReturnValue([]);
    const result = service.findMergeCandidates();
    expect(result).toEqual([]);
  });

  it("identifies mergeable YES and NO positions", () => {
    const yesToken = "tok-yes";
    const noToken = "tok-no";
    const conditionId = "cond-1";

    const yesMarket: Partial<Market> = { tokenId: yesToken, conditionId, outcome: "Yes" };
    const noMarket: Partial<Market> = { tokenId: noToken, conditionId, outcome: "No" };

    const yesPos: Partial<Position> = {
      positionId: "pos-yes" as any,
      tokenId: yesToken,
      size: 100,
      familyId: "fam-1" as any,
    };
    const noPos: Partial<Position> = {
      positionId: "pos-no" as any,
      tokenId: noToken,
      size: 80,
      familyId: "fam-1" as any,
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
    const yesToken = "tok-yes";
    const noToken = "tok-no";
    const conditionId = "cond-1";

    const yesMarket: Partial<Market> = { tokenId: yesToken, conditionId, outcome: "Yes" };
    const noMarket: Partial<Market> = { tokenId: noToken, conditionId, outcome: "No" };

    const yesPos: Partial<Position> = {
      positionId: "pos-yes" as any,
      tokenId: yesToken,
      size: 100,
      familyId: "fam-1" as any,
    };
    const noPos: Partial<Position> = {
      positionId: "pos-no" as any,
      tokenId: noToken,
      size: 80,
      familyId: "fam-1" as any,
    };

    const yesOrder: Partial<Order> = { tokenId: yesToken, side: "sell", size: 30, status: "open" };

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

    const result = service.findMergeCandidates();

    expect(result).toHaveLength(1);
    // yesFree = 100 - 30 = 70. noFree = 80. min(70, 80) = 70.
    expect(result[0].mergeAmount).toBe(70);
  });

  it("skips if merge amount is below dust threshold", () => {
    const yesToken = "tok-yes";
    const noToken = "tok-no";
    const conditionId = "cond-1";

    const yesMarket: Partial<Market> = { tokenId: yesToken, conditionId, outcome: "Yes" };
    const noMarket: Partial<Market> = { tokenId: noToken, conditionId, outcome: "No" };

    const yesPos: Partial<Position> = {
      positionId: "pos-yes" as any,
      tokenId: yesToken,
      size: 0.5,
      familyId: "fam-1" as any,
    };
    const noPos: Partial<Position> = {
      positionId: "pos-no" as any,
      tokenId: noToken,
      size: 0.5,
      familyId: "fam-1" as any,
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
