import { describe, it, expect, vi, beforeEach } from "vitest";
import { importExchangeFills } from "../modules/reconciliation/fill-reconciler.js";
import { createConditionId, createOrderId, createTokenId } from "@plankton/domain";
import type { ExchangeFill, FillRepository, OrderRepository } from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";

function createMockFillRepo(): FillRepository {
  return {
    save: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    findByOrderId: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    findRecent: vi.fn().mockReturnValue([]),
    findUnreconciled: vi.fn().mockReturnValue([]),
    markReconciled: vi.fn(),
    getLatestTimestamp: vi.fn().mockReturnValue(null),
  };
}

function createMockOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue({
      orderId: createOrderId("ord-1"),
      size: 10,
    }),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLog,
} as any;

describe("importExchangeFills", () => {
  let fillRepo: ReturnType<typeof createMockFillRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let bus: InProcessEventBus;

  beforeEach(() => {
    fillRepo = createMockFillRepo();
    orderRepo = createMockOrderRepo();
    bus = new InProcessEventBus();
  });

  it("imports a new fill, publishes FillReceived, and updates order status", async () => {
    const fills: ExchangeFill[] = [
      {
        fillId: "fill-1",
        orderId: "ord-1",
        clientOrderId: "co-1",
        tokenId: createTokenId("tok-1"),
        side: "buy",
        price: 0.5,
        size: 10,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        timestamp: Date.now(),
      },
    ];

    const localOrder = {
      orderId: createOrderId("ord-1"),
      conditionId: createConditionId("cond-1"),
      signalId: "sig-1",
      signalReason: "repricing-exit",
      decisionRuleId: "D5",
      signalTimestamp: "2026-04-26T00:00:00.000Z",
      size: 10,
    };
    (orderRepo.findByClientOrderId as any).mockReturnValue(localOrder);
    (orderRepo.findById as any).mockReturnValue(localOrder);

    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 10 }]);

    const received: any[] = [];
    bus.subscribe("FillReceived", async (p) => {
      received.push(p);
    });

    const result = await importExchangeFills(fills, {
      fillRepo,
      orderRepo,
      bus,
      log: silentLog,
    });

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(fillRepo.save).toHaveBeenCalledTimes(1);
    expect((fillRepo.save as any).mock.calls[0][0]).toMatchObject({
      signalId: "sig-1",
      decisionRuleId: "D5",
      signalTimestamp: "2026-04-26T00:00:00.000Z",
    });
    expect(received).toHaveLength(1);
    expect(received[0].fillId).toBe("fill-1");
    expect(received[0].decisionRuleId).toBe("D5");
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("ord-1"), "filled");
  });

  it("skips already-existing fills (dedup by fillId)", async () => {
    (fillRepo.exists as any).mockReturnValue(true);

    const fills: ExchangeFill[] = [
      {
        fillId: "fill-dup",
        orderId: "ord-1",
        clientOrderId: "co-1",
        tokenId: createTokenId("tok-1"),
        side: "buy",
        price: 0.5,
        size: 10,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        timestamp: Date.now(),
      },
    ];

    const result = await importExchangeFills(fills, {
      fillRepo,
      orderRepo,
      bus,
      log: silentLog,
    });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fillRepo.save).not.toHaveBeenCalled();
  });

  it("skips fills with no matching local order", async () => {
    (orderRepo.findByClientOrderId as any).mockReturnValue(null);

    const fills: ExchangeFill[] = [
      {
        fillId: "fill-orphan",
        orderId: "ord-unknown",
        clientOrderId: "co-unknown",
        tokenId: createTokenId("tok-1"),
        side: "buy",
        price: 0.5,
        size: 10,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        timestamp: Date.now(),
      },
    ];

    const result = await importExchangeFills(fills, {
      fillRepo,
      orderRepo,
      bus,
      log: silentLog,
    });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.details).toHaveLength(1);
  });

  // Regression for "taker BUY orders never reach `filled`": Polymarket deducts
  // the share-side fee from gross at fill time, so `fill.size` is NET shares
  // while `order.size` is GROSS shares. Without compensation, the cumulative
  // sum of `fill.size` never catches up to `order.size`. The order is then
  // stuck `partially-filled`, its full sizeUsdc continues to be reserved by
  // `OrderRepository.sumOpenBuyNotional()`, and new BUY budget silently dries
  // up over uptime.
  it("marks taker BUY filled when cumulative NET fill.size is below GROSS order.size", async () => {
    const fills: ExchangeFill[] = [
      {
        fillId: "fill-taker-buy",
        orderId: "ord-1",
        clientOrderId: "co-1",
        tokenId: createTokenId("tok-1"),
        side: "buy",
        price: 0.95,
        // Gross 100 - shareFee 0.095 = 99.905 NET shares delivered.
        size: 99.905,
        sizeUsdc: 95, // gross USDC = grossSize × price = 100 × 0.95
        liquidityRole: "taker",
        fee: 95 * 0.02 * (1 - 0.95), // 0.095 USDC, irrelevant to status logic
        feeRateBps: 200,
        timestamp: Date.now(),
      },
    ];

    const localOrder = {
      orderId: createOrderId("ord-1"),
      size: 100, // gross shares originally requested
    };
    (orderRepo.findByClientOrderId as any).mockReturnValue(localOrder);
    (orderRepo.findById as any).mockReturnValue(localOrder);
    (fillRepo.findByOrderId as any).mockReturnValue([
      {
        side: "buy",
        size: 99.905,
        price: 0.95,
        sizeUsdc: 95,
        liquidityRole: "taker",
      },
    ]);

    await importExchangeFills(fills, { fillRepo, orderRepo, bus, log: silentLog });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("ord-1"), "filled");
  });

  // Regression for "RiskInventory built positions from raw exchange size":
  // FillReceived.size must equal the V2-recomputed net size (`resolved.fill.size`)
  // so the persisted fill, the published event, and the inventory replay all
  // agree on share count. Pre-fix, the publish path used `ef.size`, drifting
  // the in-memory inventory away from the DB after V2 fee recompute.
  it("publishes FillReceived.size as V2-recomputed net (not raw ef.size)", async () => {
    const fills: ExchangeFill[] = [
      {
        fillId: "fill-v2",
        orderId: "ord-1",
        clientOrderId: "co-1",
        tokenId: createTokenId("tok-1"),
        side: "buy",
        price: 0.5,
        // mapper-baked size = gross to simulate an exchange that didn't
        // pre-deduct share fees (V2 reconciler is responsible for net).
        size: 100,
        grossSize: 100,
        liquidityRole: "taker",
        fee: 0,
        feeRateBps: 0,
        timestamp: Date.now(),
      },
    ];

    const localOrder = {
      orderId: createOrderId("ord-1"),
      conditionId: createConditionId("cond-v2"),
      signalId: null,
      signalReason: null,
      decisionRuleId: null,
      signalTimestamp: null,
      size: 100,
    };
    (orderRepo.findByClientOrderId as any).mockReturnValue(localOrder);
    (orderRepo.findById as any).mockReturnValue(localOrder);
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 98, sizeUsdc: 50 }]);

    // V2 feeInfo: rate=0.04, e=1, p=0.5 → platformFeeRate = 0.01.
    // shareFee = 100 * 0.01 / 0.5 = 2 → net size = 98.
    const gateway = {
      getMarketFeeInfo: vi.fn().mockResolvedValue({
        rate: 0.04,
        exponent: 1,
        takerOnly: false,
      }),
    } as any;

    const received: any[] = [];
    bus.subscribe("FillReceived", async (p) => {
      received.push(p);
    });

    await importExchangeFills(fills, {
      fillRepo,
      orderRepo,
      bus,
      log: silentLog,
      gateway,
    });

    expect(received).toHaveLength(1);
    expect(received[0].size).toBeCloseTo(98, 9);
    expect(received[0].fee).toBeCloseTo(1, 9); // 100 * 0.01
    // Sanity: persisted size matches published size.
    const savedFill = (fillRepo.save as any).mock.calls[0][0];
    expect(savedFill.size).toBeCloseTo(received[0].size, 9);
  });

  it("sets partially-filled when cumulative < order size", async () => {
    const fills: ExchangeFill[] = [
      {
        fillId: "fill-partial",
        orderId: "ord-1",
        clientOrderId: "co-1",
        tokenId: createTokenId("tok-1"),
        side: "buy",
        price: 0.5,
        size: 4,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        timestamp: Date.now(),
      },
    ];

    const localOrder = {
      orderId: createOrderId("ord-1"),
      size: 10,
    };
    (orderRepo.findByClientOrderId as any).mockReturnValue(localOrder);
    (orderRepo.findById as any).mockReturnValue(localOrder);
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 4 }]);

    await importExchangeFills(fills, { fillRepo, orderRepo, bus, log: silentLog });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("ord-1"), "partially-filled");
  });
});
