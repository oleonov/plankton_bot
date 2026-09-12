import { describe, expect, it, vi } from "vitest";
import {
  GATE_ENTRY_RULE_ID,
  createBotRunId,
  createConditionId,
  createFillId,
  createOrderId,
  createTokenId,
} from "@krabs/domain";
import type { ClientOrderId, Fill, FillRepository, Order } from "@krabs/domain";
import { computeBounceAskCaptureCandidate } from "../bounce-ask-capture.js";
import {
  buildReservationSnapshot,
  getReservedSellSize,
} from "../modules/execution/reservation-utils.js";

const TOKEN_ID = createTokenId("tok-yes");
const BOT_RUN_ID = createBotRunId("run-1");

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_ord_1" as ClientOrderId,
    tokenId: TOKEN_ID,
    conditionId: createConditionId("cond-1"),
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
    conditionId: createConditionId("cond-1"),
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
  it.each([0, 5, 17.08])("SIGNED_ASK preserves logical reservation after fill %s", (filled) => {
    const sell = makeOrder({ side: "sell", price: 0.11, size: 17.08803 });
    sell.metadata = {
      signedOrderFactsV1: {
        version: 1,
        orderId: sell.orderId,
        tokenId: TOKEN_ID,
        side: "sell",
        logicalSize: sell.size,
        shares: 17.08,
      },
    };
    const fills = filled ? [{ ...makeFill(sell.orderId, filled), side: "sell" as const }] : [];
    const before = structuredClone({ sell, fills });
    const result = computeBounceAskCaptureCandidate({
      book: {
        tokenId: TOKEN_ID,
        bids: [{ price: 0.06, size: 20 }],
        asks: [
          { price: 0.1, size: 20 },
          { price: 0.11, size: filled === 17.08 ? 0.001 : 17.08 - filled },
        ],
        bestBid: 0.06,
        bestAsk: 0.1,
        midPrice: 0.08,
        spread: 0.04,
        timestamp: 0,
      },
      tickSize: 0.01,
      ownSellOrders: [sell],
      originalTargetPrice: 0.07,
      fillsByOrder: new Map([[String(sell.orderId), fills]]),
    });
    const snapshot = buildReservationSnapshot([sell], { findByOrderId: () => fills });
    expect(getReservedSellSize(snapshot, TOKEN_ID)).toBeCloseTo(17.08803 - filled, 9);
    expect({ sell, fills }).toEqual(before);
    expect(result).toMatchObject({ ok: true, price: 0.09 });
  });

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

  it("openGateBuyOrderCount counts GATE buys from persisted orders AND in-flight reservations", () => {
    const gateBuy = makeOrder({
      orderId: createOrderId("ord-gate"),
      side: "buy",
      decisionRuleId: GATE_ENTRY_RULE_ID,
    });
    const r23Buy = makeOrder({
      orderId: createOrderId("ord-r23"),
      side: "buy",
      decisionRuleId: "R23",
    });
    const gateSell = makeOrder({
      orderId: createOrderId("ord-gate-sell"),
      side: "sell",
      decisionRuleId: GATE_ENTRY_RULE_ID,
    });
    const fillRepo = {
      findByOrderId: vi.fn().mockReturnValue([]),
    } satisfies Pick<FillRepository, "findByOrderId">;

    // 1 persisted GATE buy + 1 in-flight GATE buy reservation = 2; R23 buy and GATE sell excluded.
    const snapshot = buildReservationSnapshot([gateBuy, r23Buy, gateSell], fillRepo, [
      { tokenId: TOKEN_ID, side: "buy", size: 10, price: 0.5, decisionRuleId: GATE_ENTRY_RULE_ID },
    ]);

    expect(snapshot.openGateBuyOrderCount).toBe(2);
    expect(snapshot.openBuyOrderCount).toBe(3); // gate + r23 persisted + 1 pending gate
  });

  it("openGateBuyOrderCount is 0 when there are no GATE buys", () => {
    const r23Buy = makeOrder({ side: "buy", decisionRuleId: "R23" });
    const fillRepo = {
      findByOrderId: vi.fn().mockReturnValue([]),
    } satisfies Pick<FillRepository, "findByOrderId">;
    const snapshot = buildReservationSnapshot([r23Buy], fillRepo);
    expect(snapshot.openGateBuyOrderCount).toBe(0);
  });
});
