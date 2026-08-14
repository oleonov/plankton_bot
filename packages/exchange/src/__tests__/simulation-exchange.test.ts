import { describe, it, expect, beforeEach } from "vitest";
import { createTokenId } from "@krabs/domain";
import type { PlaceOrderParams } from "@krabs/domain";
import { SimulationExchangeGateway } from "../simulation/exchange-gateway.js";

function makeParams(overrides?: Partial<PlaceOrderParams>): PlaceOrderParams {
  return {
    clientOrderId: "cloid-1",
    tokenId: createTokenId("tok-1"),
    side: "buy",
    size: 100,
    price: 0.5,
    orderType: "GTC",
    tickSize: 0.01,
    negRisk: false,
    ...overrides,
  };
}

describe("SimulationExchangeGateway (immediate fill)", () => {
  let gw: SimulationExchangeGateway;

  beforeEach(() => {
    gw = new SimulationExchangeGateway({ fillMode: "immediate", initialBalanceUsdc: 1000 });
  });

  it("places order and immediately fills", async () => {
    const result = await gw.placeOrder(makeParams());
    expect(result.success).toBe(true);
    expect(result.orderId).toBeTruthy();

    const open = await gw.getOpenOrders();
    expect(open).toHaveLength(0);

    const fills = await gw.getFills(0);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.size).toBe(100);
    expect(fills[0]!.price).toBe(0.5);
  });

  it("returns fills for one order without scanning unrelated order history", async () => {
    const first = await gw.placeOrder(
      makeParams({ clientOrderId: "c1", tokenId: createTokenId("tok-A") }),
    );
    const second = await gw.placeOrder(
      makeParams({ clientOrderId: "c2", tokenId: createTokenId("tok-B") }),
    );

    const firstFills = await gw.getFillsForOrder(first.orderId!);
    const secondFills = await gw.getFillsForOrder(second.orderId!);
    const missingFills = await gw.getFillsForOrder("missing-order");

    expect(firstFills).toHaveLength(1);
    expect(firstFills[0]!.tokenId).toBe("tok-A");
    expect(secondFills).toHaveLength(1);
    expect(secondFills[0]!.tokenId).toBe("tok-B");
    expect(missingFills).toHaveLength(0);
  });

  it("returns exact orders, including terminal simulation orders", async () => {
    const placed = await gw.placeOrder(makeParams());
    const result = await gw.getOrderResult(placed.orderId!);
    expect(result).toMatchObject({ ok: true, data: { status: "FILLED" } });
    expect(await gw.getOrderResult("missing")).toEqual({ ok: true, data: null });
  });

  it("deducts balance on buy", async () => {
    await gw.placeOrder(makeParams({ size: 100, price: 0.5 }));
    const balances = await gw.getBalances();
    // 1000 - 100*0.5 = 950
    expect(balances[0]!.available).toBe(950);
  });

  it("rejects invalid price", async () => {
    const result = await gw.placeOrder(makeParams({ price: 1.5 }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_PRICE");
  });

  it("rejects zero size", async () => {
    const result = await gw.placeOrder(makeParams({ size: 0 }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_SIZE");
  });

  it("rejects duplicate clientOrderId", async () => {
    await gw.placeOrder(makeParams());
    const result = await gw.placeOrder(makeParams());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("DUPLICATE_CLIENT_ORDER_ID");
  });

  it("rejects insufficient balance", async () => {
    const result = await gw.placeOrder(makeParams({ size: 10000, price: 0.5 }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INSUFFICIENT_BALANCE");
  });

  it("healthCheck returns ok", async () => {
    const health = await gw.healthCheck();
    expect(health.ok).toBe(true);
  });
});

describe("SimulationExchangeGateway (manual fill)", () => {
  let gw: SimulationExchangeGateway;

  beforeEach(() => {
    gw = new SimulationExchangeGateway({ fillMode: "manual", initialBalanceUsdc: 1000 });
  });

  it("places order that stays OPEN", async () => {
    const result = await gw.placeOrder(makeParams());
    expect(result.success).toBe(true);

    const open = await gw.getOpenOrders();
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe("OPEN");
    expect(open[0]!.sizeRemaining).toBe(100);
  });

  it("locks balance for open buy orders", async () => {
    await gw.placeOrder(makeParams({ size: 100, price: 0.5 }));
    const balances = await gw.getBalances();
    expect(balances[0]!.available).toBe(950);
    expect(balances[0]!.locked).toBe(50);
  });

  it("cancels an open order", async () => {
    const placed = await gw.placeOrder(makeParams());
    const result = await gw.cancelOrder({ orderId: placed.orderId! });
    expect(result.success).toBe(true);

    const open = await gw.getOpenOrders();
    expect(open).toHaveLength(0);
  });

  it("cancel returns error for unknown order", async () => {
    const result = await gw.cancelOrder({ orderId: "nonexistent" });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("ORDER_NOT_FOUND");
  });

  it("cancelAllOrders cancels all open orders", async () => {
    await gw.placeOrder(makeParams({ clientOrderId: "c1" }));
    await gw.placeOrder(makeParams({ clientOrderId: "c2" }));
    expect(await gw.getOpenOrders()).toHaveLength(2);

    await gw.cancelAllOrders();
    expect(await gw.getOpenOrders()).toHaveLength(0);
  });

  it("injectFill partially fills an order", async () => {
    const placed = await gw.placeOrder(makeParams({ size: 100 }));
    const fill = gw.injectFill(placed.orderId!, 60);
    expect(fill).not.toBeNull();
    expect(fill!.size).toBe(60);

    const open = await gw.getOpenOrders();
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe("PARTIALLY_FILLED");
    expect(open[0]!.sizeFilled).toBe(60);
    expect(open[0]!.sizeRemaining).toBe(40);
  });

  it("injectFill fully fills an order", async () => {
    const placed = await gw.placeOrder(makeParams({ size: 100 }));
    gw.injectFill(placed.orderId!, 100);

    const open = await gw.getOpenOrders();
    expect(open).toHaveLength(0);
  });

  it("getOpenOrdersForToken filters by token", async () => {
    await gw.placeOrder(makeParams({ clientOrderId: "c1", tokenId: createTokenId("tok-A") }));
    await gw.placeOrder(makeParams({ clientOrderId: "c2", tokenId: createTokenId("tok-B") }));

    const tokA = await gw.getOpenOrdersForToken(createTokenId("tok-A"));
    expect(tokA).toHaveLength(1);
  });

  it("getFills filters by sinceMs", async () => {
    const before = Date.now();
    const placed = await gw.placeOrder(makeParams());
    gw.injectFill(placed.orderId!, 50);

    const fills = await gw.getFills(before);
    expect(fills).toHaveLength(1);

    const noFills = await gw.getFills(Date.now() + 10000);
    expect(noFills).toHaveLength(0);
  });

  it("unlocks balance on cancel", async () => {
    await gw.placeOrder(makeParams({ size: 100, price: 0.5 }));
    const before = await gw.getBalances();
    expect(before[0]!.locked).toBe(50);

    const open = await gw.getOpenOrders();
    await gw.cancelOrder({ orderId: open[0]!.orderId });

    const after = await gw.getBalances();
    expect(after[0]!.locked).toBe(0);
    expect(after[0]!.available).toBe(1000);
  });
});
