import { describe, expect, it, vi } from "vitest";
import {
  createBotRunId,
  createFamilyId,
  createFillId,
  createOrderId,
  createTokenId,
} from "@plankton/domain";
import type { ClientOrderId, Fill, FillRepository, Order } from "@plankton/domain";
import {
  buildReservationSnapshot,
  getReservedSellSize,
} from "../modules/execution/reservation-utils.js";

const FAMILY_ID = createFamilyId("fam-1");
const TOKEN_ID = createTokenId("tok-yes");
const BOT_RUN_ID = createBotRunId("run-1");

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_ord_1" as ClientOrderId,
    tokenId: TOKEN_ID,
    familyId: FAMILY_ID,
    side: "buy",
    orderType: "GTC",
    price: 0.5,
    size: 10,
    sizeUsdc: 5,
    status: "open",
    exchangeOrderId: "ord-1",
    signalId: null,
    signalReason: "probe-entry",
    botRunId: BOT_RUN_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFill(orderId: string, size: number): Fill {
  return {
    fillId: createFillId(`fill-${orderId}-${size}`),
    orderId: createOrderId(orderId),
    tokenId: TOKEN_ID,
    familyId: FAMILY_ID,
    side: "buy",
    price: 0.5,
    size,
    sizeUsdc: size * 0.5,
    liquidityRole: "unknown",
    fee: 0,
    feeRateBps: 0,
    filledAt: new Date().toISOString(),
  };
}

describe("reservation-utils", () => {
  it("uses bulk fill lookup for open-order reservations when available", () => {
    const buy = makeOrder({ orderId: createOrderId("ord-buy"), side: "buy", size: 10, price: 0.5 });
    const sell = makeOrder({
      orderId: createOrderId("ord-sell"),
      side: "sell",
      size: 8,
      price: 0.6,
    });
    const fillRepo = {
      findByOrderId: vi.fn().mockReturnValue([]),
      findByOrderIds: vi.fn().mockReturnValue([makeFill("ord-buy", 4), makeFill("ord-sell", 1)]),
    } satisfies Pick<FillRepository, "findByOrderId" | "findByOrderIds">;

    const snapshot = buildReservationSnapshot([buy, sell], fillRepo);

    expect(fillRepo.findByOrderIds).toHaveBeenCalledTimes(1);
    expect(fillRepo.findByOrderIds).toHaveBeenCalledWith([buy.orderId, sell.orderId]);
    expect(fillRepo.findByOrderId).not.toHaveBeenCalled();
    expect(snapshot.reservedBuyUsdc).toBeCloseTo(3); // (10 - 4) * 0.5
    expect(getReservedSellSize(snapshot, TOKEN_ID)).toBeCloseTo(7); // 8 - 1
  });

  it("falls back to per-order lookup when the repository has no bulk method", () => {
    const buy = makeOrder({ orderId: createOrderId("ord-buy"), side: "buy", size: 10, price: 0.5 });
    const sell = makeOrder({
      orderId: createOrderId("ord-sell"),
      side: "sell",
      size: 8,
      price: 0.6,
    });
    const fillRepo = {
      findByOrderId: vi.fn((orderId) =>
        String(orderId) === "ord-buy" ? [makeFill("ord-buy", 4)] : [makeFill("ord-sell", 1)],
      ),
    } satisfies Pick<FillRepository, "findByOrderId">;

    const snapshot = buildReservationSnapshot([buy, sell], fillRepo);

    expect(fillRepo.findByOrderId).toHaveBeenCalledTimes(2);
    expect(snapshot.reservedBuyUsdc).toBeCloseTo(3);
    expect(getReservedSellSize(snapshot, TOKEN_ID)).toBeCloseTo(7);
  });
});
