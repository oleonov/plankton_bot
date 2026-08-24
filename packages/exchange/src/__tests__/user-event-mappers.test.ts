import { describe, expect, it } from "vitest";
import { mapUserOrderEvent, mapUserTradeEvent } from "../live/user-event-mappers.js";

describe("user event mappers", () => {
  it("maps personal trade event into ExchangeUserTradeEvent", () => {
    const event = mapUserTradeEvent(
      {
        event_type: "trade",
        id: "trade-1",
        taker_order_id: "ord-1",
        asset_id: "tok-1",
        side: "BUY",
        size: "10",
        price: "0.57",
        fee_rate_bps: "0",
        status: "CONFIRMED",
        timestamp: "1672290701",
        maker_address: "0xours",
        trader_side: "TAKER",
      },
      "0xours",
    );

    expect(event).not.toBeNull();
    expect(event!.tradeId).toBe("trade-1");
    expect(event!.status).toBe("CONFIRMED");
    expect(event!.fills).toHaveLength(1);
    expect(event!.fills[0]!.orderId).toBe("ord-1");
    expect(event!.timestamp).toBe(1672290701000);
  });

  it("returns null when trade event has no personal fills", () => {
    const event = mapUserTradeEvent(
      {
        event_type: "trade",
        id: "trade-2",
        status: "CONFIRMED",
        trader_side: "MAKER",
        maker_orders: [{ maker_address: "0xother" }],
      },
      "0xours",
    );

    expect(event).toBeNull();
  });

  it.each(["MATCHED", "MINED", "RETRYING", "FAILED", "UNKNOWN"])(
    "does not publish %s trades as fills before successful finality",
    (status) => {
      const event = mapUserTradeEvent(
        {
          event_type: "trade",
          id: "trade-not-confirmed",
          taker_order_id: "ord-1",
          asset_id: "tok-1",
          side: "BUY",
          size: "10",
          price: "0.57",
          status,
          timestamp: "1672290701",
          maker_address: "0xours",
          trader_side: "TAKER",
        },
        "0xours",
      );

      expect(event).toBeNull();
    },
  );

  it("maps order event into ExchangeUserOrderEvent", () => {
    const event = mapUserOrderEvent({
      event_type: "order",
      id: "ord-1",
      client_order_id: "cloid-1",
      asset_id: "tok-1",
      side: "SELL",
      original_size: "10",
      size_matched: "4",
      type: "UPDATE",
      status: "LIVE",
      timestamp: "1672290687",
    });

    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      orderId: "ord-1",
      clientOrderId: "cloid-1",
      event: "UPDATE",
      status: "OPEN",
      sizeTotal: 10,
      sizeFilled: 4,
      sizeRemaining: 6,
      side: "sell",
    });
    expect(event!.tokenId).toBe("tok-1");
    expect(event!.timestamp).toBe(1672290687000);
  });
});
