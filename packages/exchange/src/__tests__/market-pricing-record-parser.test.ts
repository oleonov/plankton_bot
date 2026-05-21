import { describe, expect, it } from "vitest";
import { collectStreamUpdates } from "../live/market-pricing-record-parser.js";
import type { MarketPricingSnapshot } from "@krabs/domain";

describe("collectStreamUpdates", () => {
  it("turns best_bid_ask records into compact pricing updates", () => {
    const state = new Map<string, MarketPricingSnapshot>();
    const result = collectStreamUpdates(
      [
        {
          event_type: "best_bid_ask",
          asset_id: "token-a",
          best_bid: "0.42",
          best_ask: "0.45",
          timestamp: new Date().toISOString(),
        },
      ],
      state,
      Date.now(),
    );

    expect(result.eventCount).toBe(1);
    expect(result.rawRecordCount).toBe(1);
    expect(result.parsedUpdateCount).toBe(1);
    expect(result.emittedUpdateCount).toBe(1);
    expect(result.noopUpdateCount).toBe(0);
    expect(result.suppressedTradingNoopCount).toBe(0);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.tokenId).toBe("token-a");
    expect(result.updates[0]?.pricing.bestBid).toBe(0.42);
    expect(result.updates[0]?.pricing.bestAsk).toBe(0.45);
    expect(state.get("token-a")?.bookSource).toBe("clob");
  });

  it("carries forward pricing state across price_change deltas", () => {
    const state = new Map<string, MarketPricingSnapshot>();
    collectStreamUpdates(
      [
        {
          event_type: "best_bid_ask",
          asset_id: "token-a",
          best_bid: "0.40",
          best_ask: "0.46",
          timestamp: new Date().toISOString(),
        },
      ],
      state,
      Date.now(),
    );

    const result = collectStreamUpdates(
      [
        {
          event_type: "price_change",
          asset_id: "token-a",
          best_bid: "0.41",
          timestamp: new Date().toISOString(),
        },
      ],
      state,
      Date.now(),
    );

    expect(result.updates[0]?.pricing.bestBid).toBe(0.41);
    expect(result.updates[0]?.pricing.bestAsk).toBe(0.46);
    expect(result.noopUpdateCount).toBe(0);
    expect(result.suppressedTradingNoopCount).toBe(0);
  });

  it("suppresses trading-semantic no-op updates after updating local state", () => {
    const state = new Map<string, MarketPricingSnapshot>([
      [
        "token-a",
        {
          bestBid: 0.4,
          bestAsk: 0.46,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: null,
          bookSource: "clob",
        },
      ],
    ]);

    const result = collectStreamUpdates(
      [
        {
          event_type: "best_bid_ask",
          asset_id: "token-a",
          best_bid: "0.40",
          best_ask: "0.46",
          timestamp: new Date().toISOString(),
        },
      ],
      state,
      Date.now(),
    );

    expect(result.noopUpdateCount).toBe(1);
    expect(result.parsedUpdateCount).toBe(1);
    expect(result.emittedUpdateCount).toBe(0);
    expect(result.suppressedTradingNoopCount).toBe(1);
    expect(result.suppressedTradingNoopByReason).toEqual({
      topOfBook: 1,
      acceptingOrdersOrBook: 0,
      minSizeOrSource: 0,
    });
    expect(result.updates).toHaveLength(0);
    expect(state.get("token-a")?.bestBid).toBe(0.4);
    expect(state.get("token-a")?.bestAsk).toBe(0.46);
  });

  it("does not suppress tick size changes", () => {
    const state = new Map<string, MarketPricingSnapshot>([
      [
        "token-a",
        {
          bestBid: 0.4,
          bestAsk: 0.46,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: null,
          bookSource: "clob",
        },
      ],
    ]);

    const result = collectStreamUpdates(
      [
        {
          event_type: "tick_size_change",
          asset_id: "token-a",
          new_tick_size: "0.001",
          timestamp: new Date().toISOString(),
        },
      ],
      state,
      Date.now(),
    );

    expect(result.parsedUpdateCount).toBe(1);
    expect(result.emittedUpdateCount).toBe(1);
    expect(result.suppressedTradingNoopCount).toBe(0);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.tickSize).toBe(0.001);
  });

  it("does not suppress book events even when top-of-book is unchanged", () => {
    const state = new Map<string, MarketPricingSnapshot>([
      [
        "token-a",
        {
          bestBid: 0.4,
          bestAsk: 0.46,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: null,
          minOrderSize: 1,
          bookSource: "clob",
        },
      ],
    ]);

    const result = collectStreamUpdates(
      [
        {
          event_type: "book",
          asset_id: "token-a",
          bids: [
            { price: "0.40", size: "10" },
            { price: "0.39", size: "50" },
          ],
          asks: [
            { price: "0.46", size: "20" },
            { price: "0.47", size: "60" },
          ],
          min_order_size: "1",
          timestamp: new Date().toISOString(),
        },
      ],
      state,
      Date.now(),
    );

    expect(result.noopUpdateCount).toBe(1);
    expect(result.emittedUpdateCount).toBe(1);
    expect(result.suppressedTradingNoopCount).toBe(0);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]?.book?.bids).toHaveLength(2);
  });

  it("suppresses last-trade-only updates as the accepted R73b trade-off", () => {
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
      Date.now(),
    );

    expect(result.emittedUpdateCount).toBe(0);
    expect(result.suppressedTradingNoopCount).toBe(1);
    expect(result.updates).toHaveLength(0);
    expect(state.get("token-a")?.lastTradePrice).toBe(0.44);
    expect(state.get("token-a")?.lastTradeAt).toBe("2026-05-21T00:01:00.000Z");
  });

  it("keeps lifecycle events separate while suppressing no-op pricing updates", () => {
    const state = new Map<string, MarketPricingSnapshot>([
      [
        "token-a",
        {
          bestBid: 0.4,
          bestAsk: 0.46,
          acceptingOrders: true,
          enableOrderBook: true,
          lastTradePrice: null,
          bookSource: "clob",
        },
      ],
    ]);
    const records: unknown[] = [
      {
        event_type: "market_resolved",
        condition_id: "cond-a",
        market: "market-a",
        slug: "slug-a",
        token_ids: ["token-a"],
        winning_token_id: "token-a",
        timestamp: new Date().toISOString(),
      },
    ];
    for (let i = 0; i < 10; i++) {
      records.push({
        event_type: "best_bid_ask",
        asset_id: "token-a",
        best_bid: "0.40",
        best_ask: "0.46",
        timestamp: new Date().toISOString(),
      });
    }

    const result = collectStreamUpdates(records, state, Date.now());

    expect(result.marketResolvedEventCount).toBe(1);
    expect(result.lifecycleEvents).toHaveLength(1);
    expect(result.lifecycleEvents[0]?.type).toBe("market_resolved");
    expect(result.parsedUpdateCount).toBe(10);
    expect(result.emittedUpdateCount).toBe(0);
    expect(result.suppressedTradingNoopCount).toBe(10);
    expect(result.updates).toHaveLength(0);
  });

  it("emits lifecycle events without requiring raw record cloning on the parent", () => {
    const result = collectStreamUpdates(
      [
        {
          event_type: "new_market",
          condition_id: "cond-a",
          market: "market-a",
          slug: "slug-a",
          question: "Question?",
          active: true,
          token_ids: ["token-a", "token-b"],
          timestamp: new Date().toISOString(),
        },
      ],
      new Map(),
      Date.now(),
    );

    expect(result.newMarketEventCount).toBe(1);
    expect(result.lifecycleEvents[0]).toMatchObject({
      type: "new_market",
      conditionId: "cond-a",
      slug: "slug-a",
    });
  });
});
