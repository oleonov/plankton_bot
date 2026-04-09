import { describe, it, expect, vi, beforeEach } from "vitest";
import { InventoryManagerModule } from "../inventory-manager-module.js";
import type {
  EventBus,
  ExchangeGateway,
  PositionRepository,
  OrderRepository,
  MarketRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
} from "@plankton/domain";
import type { Logger } from "../../../logger.js";

describe("InventoryManagerModule", () => {
  let bus: EventBus;
  let gateway: ExchangeGateway;
  let positionRepo: PositionRepository;
  let orderRepo: OrderRepository;
  let marketRepo: MarketRepository;
  let fillRepo: import("@plankton/domain").FillRepository;
  let lotRepo: InventoryLotRepository;
  let mergeLedgerRepo: MergeLedgerRepository;
  let db: any;
  let log: Logger;
  let mod: InventoryManagerModule;

  beforeEach(() => {
    bus = { subscribe: vi.fn(), publish: vi.fn() } as any;
    gateway = { mergePositions: vi.fn().mockResolvedValue(undefined) } as any;
    positionRepo = {
      findOpen: vi.fn().mockReturnValue([]),
      findByTokenId: vi.fn(),
      save: vi.fn(),
    } as any;
    orderRepo = { findByTokenId: vi.fn().mockReturnValue([]) } as any;
    marketRepo = { findByTokenId: vi.fn() } as any;
    fillRepo = { findByOrderId: vi.fn().mockReturnValue([]) } as any;
    lotRepo = { consumeFifo: vi.fn() } as any;
    mergeLedgerRepo = { save: vi.fn(), findByFamily: vi.fn() } as any;
    db = { prepare: vi.fn().mockReturnValue({ run: vi.fn() }), transaction: vi.fn((cb) => cb) } as any;
    log = { info: vi.fn(), error: vi.fn() } as any;

    mod = new InventoryManagerModule({
      bus,
      gateway,
      positionRepo,
      orderRepo,
      marketRepo,
      fillRepo,
      lotRepo,
      mergeLedgerRepo,
      db,
      log,
    });
  });

  it("finds and executes merges during sweep", async () => {
    const yesToken = "tok-yes";
    const noToken = "tok-no";
    const condId = "cond-1";

    const yesMarket = { tokenId: yesToken, conditionId: condId, outcome: "Yes" };
    const noMarket = { tokenId: noToken, conditionId: condId, outcome: "No" };

    const yesPos = { positionId: "p-yes", tokenId: yesToken, size: 100, familyId: "f1", status: "open", realizedPnl: 0, costBasisUsdc: 40, avgEntryPrice: 0.4 };
    const noPos = { positionId: "p-no", tokenId: noToken, size: 100, familyId: "f1", status: "open", realizedPnl: 0, costBasisUsdc: 60, avgEntryPrice: 0.6 };

    (positionRepo.findOpen as any).mockReturnValue([yesPos, noPos]);
    (positionRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === yesToken) return yesPos;
      if (tid === noToken) return noPos;
      return null;
    });
    (marketRepo.findByTokenId as any).mockImplementation((tid: string) => {
      if (tid === yesToken) return yesMarket;
      if (tid === noToken) return noMarket;
      return null;
    });
    (lotRepo.consumeFifo as any).mockReturnValue([{ lot: { entryPrice: 0.5 }, consumed: 100 }]);

    await mod.sweep();

    expect(gateway.mergePositions).toHaveBeenCalledWith([{ conditionId: condId, amount: 100 }]);
    expect(bus.publish).toHaveBeenCalledWith("PositionUpdated", expect.anything());
  });
});
