import { describe, it, expect, vi, beforeEach } from "vitest";
import { importExchangeFills } from "../modules/reconciliation/fill-reconciler.js";
import {
  createOrderId,
  createTokenId,
  createFamilyId,
} from "@plankton/domain";
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
      familyId: createFamilyId("fam-1"),
      size: 10,
    }),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
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
    const fills: ExchangeFill[] = [{
      fillId: "fill-1",
      orderId: "ord-1",
      clientOrderId: "co-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      price: 0.5,
      size: 10,
      fee: 0,
      timestamp: Date.now(),
    }];

    const localOrder = {
      orderId: createOrderId("ord-1"),
      familyId: createFamilyId("fam-1"),
      size: 10,
    };
    (orderRepo.findByClientOrderId as any).mockReturnValue(localOrder);
    (orderRepo.findById as any).mockReturnValue(localOrder);

    (fillRepo.findByOrderId as any).mockReturnValue([
      { size: 10 },
    ]);

    const received: any[] = [];
    bus.subscribe("FillReceived", async (p) => { received.push(p); });

    const result = await importExchangeFills(fills, { fillRepo, orderRepo, bus, log: silentLog });

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(fillRepo.save).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0].fillId).toBe("fill-1");
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("ord-1"), "filled");
  });

  it("skips already-existing fills (dedup by fillId)", async () => {
    (fillRepo.exists as any).mockReturnValue(true);

    const fills: ExchangeFill[] = [{
      fillId: "fill-dup",
      orderId: "ord-1",
      clientOrderId: "co-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      price: 0.5,
      size: 10,
      fee: 0,
      timestamp: Date.now(),
    }];

    const result = await importExchangeFills(fills, { fillRepo, orderRepo, bus, log: silentLog });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(fillRepo.save).not.toHaveBeenCalled();
  });

  it("skips fills with no matching local order", async () => {
    (orderRepo.findByClientOrderId as any).mockReturnValue(null);

    const fills: ExchangeFill[] = [{
      fillId: "fill-orphan",
      orderId: "ord-unknown",
      clientOrderId: "co-unknown",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      price: 0.5,
      size: 10,
      fee: 0,
      timestamp: Date.now(),
    }];

    const result = await importExchangeFills(fills, { fillRepo, orderRepo, bus, log: silentLog });

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.details).toHaveLength(1);
  });

  it("sets partially-filled when cumulative < order size", async () => {
    const fills: ExchangeFill[] = [{
      fillId: "fill-partial",
      orderId: "ord-1",
      clientOrderId: "co-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      price: 0.5,
      size: 4,
      fee: 0,
      timestamp: Date.now(),
    }];

    const localOrder = {
      orderId: createOrderId("ord-1"),
      familyId: createFamilyId("fam-1"),
      size: 10,
    };
    (orderRepo.findByClientOrderId as any).mockReturnValue(localOrder);
    (orderRepo.findById as any).mockReturnValue(localOrder);
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 4 }]);

    await importExchangeFills(fills, { fillRepo, orderRepo, bus, log: silentLog });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("ord-1"), "partially-filled");
  });
});
