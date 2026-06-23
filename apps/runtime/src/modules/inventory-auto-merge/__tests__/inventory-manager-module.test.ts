import { describe, it, expect, vi, beforeEach } from "vitest";
import { InventoryManagerModule } from "../inventory-manager-module.js";
import { SettlementInfraBreaker } from "../../settlement-infra-breaker.js";
import type {
  EventBus,
  ExchangeGateway,
  PositionRepository,
  OrderRepository,
  MarketRepository,
  InventoryLotRepository,
  MergeLedgerRepository,
} from "@krabs/domain";
import type { Logger } from "../../../logger.js";

describe("InventoryManagerModule", () => {
  let bus: EventBus;
  let gateway: ExchangeGateway;
  let positionRepo: PositionRepository;
  let orderRepo: OrderRepository;
  let marketRepo: MarketRepository;
  let fillRepo: import("@krabs/domain").FillRepository;
  let lotRepo: InventoryLotRepository;
  let mergeLedgerRepo: MergeLedgerRepository;
  let db: any;
  let log: Logger;
  let runtimeMetrics: any;
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
    db = {
      prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
      transaction: vi.fn((cb) => cb),
    } as any;
    log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    runtimeMetrics = { writeCounter: vi.fn(), writeEvent: vi.fn() };

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
      runtimeMetrics,
    });
  });

  function makeMergeableInventory(): { condId: string } {
    const yesToken = "tok-yes";
    const noToken = "tok-no";
    const condId = "cond-1";

    const yesMarket = { tokenId: yesToken, conditionId: condId, outcome: "Yes" };
    const noMarket = { tokenId: noToken, conditionId: condId, outcome: "No" };

    const yesPos = {
      positionId: "p-yes",
      tokenId: yesToken,
      size: 100,
      familyId: "f1",
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 40,
      avgEntryPrice: 0.4,
    };
    const noPos = {
      positionId: "p-no",
      tokenId: noToken,
      size: 100,
      familyId: "f1",
      status: "open",
      realizedPnl: 0,
      costBasisUsdc: 60,
      avgEntryPrice: 0.6,
    };

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

    return { condId };
  }

  it("finds and executes merges during sweep", async () => {
    const { condId } = makeMergeableInventory();

    await mod.sweep();

    expect(gateway.mergePositions).toHaveBeenCalledWith([{ conditionId: condId, amount: 100 }]);
    expect(bus.publish).toHaveBeenCalledWith("PositionUpdated", expect.anything());
  });

  it("does not call mergePositions while the shared settlement breaker is open", async () => {
    makeMergeableInventory();
    const breaker = new SettlementInfraBreaker({ now: () => 1_000 });
    breaker.pause("POLYGON_RPC_RATE_LIMITED", new Error("quota exceeded, resets in 600 seconds"));
    const guarded = new InventoryManagerModule({
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
      runtimeMetrics,
      settlementInfraBreaker: breaker,
    });

    await guarded.sweep();

    expect(gateway.mergePositions).not.toHaveBeenCalled();
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "inventory_merge_suppressed_settlement_breaker_total",
      1,
      JSON.stringify({ code: "POLYGON_RPC_RATE_LIMITED" }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: "POLYGON_RPC_RATE_LIMITED" }),
      "inventory manager merge skipped by settlement infra breaker",
    );
  });

  it("resumes merge attempts after the shared settlement breaker closes", async () => {
    const { condId } = makeMergeableInventory();
    let now = 1_000;
    const breaker = new SettlementInfraBreaker({ now: () => now });
    breaker.pause("POLYGON_RPC_RATE_LIMITED", new Error("quota exceeded, resets in 600 seconds"));
    now = 601_001;
    const guarded = new InventoryManagerModule({
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
      runtimeMetrics,
      settlementInfraBreaker: breaker,
    });

    await guarded.sweep();

    expect(gateway.mergePositions).toHaveBeenCalledWith([{ conditionId: condId, amount: 100 }]);
  });

  it("opens the shared settlement breaker when mergePositions throws a rate-limit error", async () => {
    makeMergeableInventory();
    let now = 1_000;
    const breaker = new SettlementInfraBreaker({ now: () => now });
    (gateway.mergePositions as any).mockRejectedValueOnce(
      new Error(
        '{"error":"request error","status":429,"data":{"error":"quota exceeded: 0 units remaining, resets in 600 seconds"}}',
      ),
    );
    const guarded = new InventoryManagerModule({
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
      runtimeMetrics,
      settlementInfraBreaker: breaker,
    });

    await guarded.sweep();

    expect(gateway.mergePositions).toHaveBeenCalledTimes(1);
    expect(breaker.isOpen()).toBe(true);
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "inventory_merge_settlement_rate_limited_total",
      1,
      JSON.stringify({ code: "POLYGON_RPC_RATE_LIMITED" }),
    );

    now = 601_001;
    expect(breaker.isOpen()).toBe(false);
  });

  it("skips sweep while the runtime is paused", async () => {
    const isPaused = vi.fn(() => true);
    const paused = new InventoryManagerModule({
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
      runtimeControl: { isPaused },
    });

    (positionRepo.findOpen as any).mockReturnValue([]);

    await paused.sweep();

    expect(isPaused).toHaveBeenCalledTimes(1);
    expect(positionRepo.findOpen).not.toHaveBeenCalled();
    expect(gateway.mergePositions).not.toHaveBeenCalled();
  });
});
