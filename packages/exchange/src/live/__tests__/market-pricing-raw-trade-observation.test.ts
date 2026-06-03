import { describe, expect, it } from "vitest";
import { collectStreamUpdates } from "../market-pricing-record-parser.js";
import type { MarketPricingSnapshot } from "@krabs/domain";

describe("market pricing raw trade observations", () => {
  it("emits raw last_trade_price observations before no-op suppression", () => {
    const state = new Map<string, MarketPricingSnapshot>([
      [
        "token-a",
        {
          bestBid: 0.4,
          bestAsk: 0.46,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: 0.43,
          lastTradeAt: "2026-05-21T00:00:00.000Z",
          bookSource: "clob",
        },
      ],
    ]);

    const result = collectStreamUpdates(
      [
        {
          event_type: "last_trade_price",
          asset_id: "token-a",
          price: "0.44",
          timestamp: "2026-05-21T00:01:00.000Z",
        },
      ],
      state,
      Date.parse("2026-05-21T00:01:05.000Z"),
    );

    expect(result.updates).toHaveLength(0);
    expect(result.suppressedTradingNoopByReason.lastTradeOnly).toBe(1);
    expect(result.rawTradeObservations).toEqual([
      {
        tokenId: "token-a",
        price: 0.44,
        timestamp: Date.parse("2026-05-21T00:01:00.000Z"),
        observedAt: Date.parse("2026-05-21T00:01:05.000Z"),
      },
    ]);
  });
});
