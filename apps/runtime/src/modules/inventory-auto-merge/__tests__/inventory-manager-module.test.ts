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
      // `MergeSettler` re-reads both legs by `candidate.yesPositionId`/`noPositionId`, not by token,
      // so a mock without `findById` makes settlement throw and silently swallow the whole sweep.
      findById: vi.fn(),
      save: vi.fn(),
    } as any;
    orderRepo = { findByTokenId: vi.fn().mockReturnValue([]) } as any;
    marketRepo = { findByTokenId: vi.fn() } as any;
    fillRepo = { findByOrderId: vi.fn().mockReturnValue([]) } as any;
    lotRepo = { consumeFifo: vi.fn() } as any;
    mergeLedgerRepo = {
      // `true` = the claim was won. The real repository returns `false` only when another writer
      // already holds a non-terminal merge for that condition, which is not what these tests cover.
      recordPending: vi.fn().mockReturnValue(true),
      markOnchain: vi.fn(),
      markApplied: vi.fn(),
      deletePending: vi.fn(),
      findNonTerminal: vi.fn().mockReturnValue([]),
    } as any;
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
    (positionRepo.findById as any).mockImplementation((pid: string) => {
      if (pid === "p-yes") return yesPos;
      if (pid === "p-no") return noPos;
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

  it("records the merge intent as 'pending' before the on-chain call, then drains to 'applied' on stop()", async () => {
    makeMergeableInventory();
    // Park the sweep exactly where the damage lives: the merge is irrevocable on chain and the
    // ledger row that mirrors it is not 'applied' yet. A stop that returns here lets the process
    // exit into permanent drift, and nothing downstream reconciles it unless that row is already
    // discoverable — which is what recordPending (below, before the gateway call) exists for.
    let releaseMerge!: () => void;
    (gateway.mergePositions as any).mockImplementation(
      () => new Promise<void>((resolve) => (releaseMerge = resolve)),
    );

    void mod.sweep();
    // `runSweep()` now awaits an async ledger-repair pass before computing candidates, so the
    // number of microtask ticks before the gateway call is reached is an implementation detail —
    // pinning it with a fixed `await Promise.resolve()` count is exactly what broke here. Poll for
    // the call instead of pinning a tick count.
    await vi.waitFor(() => expect(gateway.mergePositions).toHaveBeenCalledTimes(1));
    // The pending row must already be written by the time the on-chain call is in flight — it is
    // written and committed BEFORE that call, not merely queued behind it.
    expect(mergeLedgerRepo.recordPending).toHaveBeenCalledTimes(1);
    expect(mergeLedgerRepo.markOnchain).not.toHaveBeenCalled();
    expect(mergeLedgerRepo.markApplied).not.toHaveBeenCalled();

    let stopped = false;
    const stopping = mod.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseMerge();
    await stopping;

    expect(stopped).toBe(true);
    expect(mergeLedgerRepo.markOnchain).toHaveBeenCalledTimes(1);
    expect(mergeLedgerRepo.markApplied).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("start() re-arms the module after a stop, so a restart still merges", async () => {
    const { condId } = makeMergeableInventory();
    (bus.subscribe as any).mockReturnValue(() => undefined);

    await mod.start();
    await mod.stop();
    // `Supervisor.stop()` -> `start()` is a supported sequence. `stopping` is a latch against a
    // sweep already past clearTimeout's reach, not a terminal state: left set, auto-merge is
    // silently off for the whole next run while `healthCheck()` keeps reporting ok.
    await mod.start();

    await mod.sweep();

    expect(gateway.mergePositions).toHaveBeenCalledWith([{ conditionId: condId, amount: 100 }]);
    await mod.stop();
  });

  it("stop() keeps a late sweep from opening a new on-chain merge", async () => {
    makeMergeableInventory();

    await mod.stop();
    // The debounce timer is cleared by stop(), but a timer that has ALREADY fired is past its
    // reach — this is that sweep, arriving after the module was told to shut down.
    await mod.sweep();

    expect(gateway.mergePositions).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      { reason: "shutting down" },
      "inventory manager sweep skipped",
    );
  });
});
