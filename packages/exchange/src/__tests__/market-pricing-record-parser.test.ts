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
