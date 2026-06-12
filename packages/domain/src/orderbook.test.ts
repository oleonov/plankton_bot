import { describe, expect, it } from "vitest";
import { computeEffectiveFillPrice } from "./orderbook.js";
import type { OrderBookSnapshot } from "./types.js";
import { createTokenId } from "./ids.js";

function book(overrides: Partial<OrderBookSnapshot>): OrderBookSnapshot {
  return {
    tokenId: createTokenId("tok-book"),
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    midPrice: null,
    spread: null,
    timestamp: 1_718_000_000_000,
    ...overrides,
  };
}

describe("computeEffectiveFillPrice", () => {
  it("uses the top bid when one level covers the full SELL size", () => {
    const result = computeEffectiveFillPrice(
      book({
        bestBid: 0.046,
        bids: [
          { price: 0.046, size: 500 },
          { price: 0.03, size: 500 },
        ],
      }),
      290,
      "sell",
    );

    expect(result).toEqual({
      effectiveFillPrice: 0.046,
      worstFillPrice: 0.046,
      liquidityAvailable: 290,
      targetSize: 290,
      exhausted: false,
      levelsTouched: 1,
    });
  });

  it("walks thin bids and returns weighted average below bestBid for ALIGN-like SELL", () => {
    const result = computeEffectiveFillPrice(
      book({
        bestBid: 0.046,
        bids: [
          { price: 0.046, size: 5 },
          { price: 0.015, size: 200 },
          { price: 0.01, size: 85 },
        ],
      }),
      290,
      "sell",
    );

    expect(result.effectiveFillPrice).toBeCloseTo((0.046 * 5 + 0.015 * 200 + 0.01 * 85) / 290);
    expect(result.effectiveFillPrice).toBeLessThan(0.046);
    expect(result.worstFillPrice).toBe(0.01);
    expect(result.liquidityAvailable).toBe(290);
    expect(result.exhausted).toBe(false);
    expect(result.levelsTouched).toBe(3);
  });

  it("marks exhausted when the book cannot fill the target size", () => {
    const result = computeEffectiveFillPrice(
      book({
        bestBid: 0.04,
        bids: [
          { price: 0.04, size: 10 },
          { price: 0.02, size: 15 },
        ],
      }),
      100,
      "sell",
    );

    expect(result.effectiveFillPrice).toBeCloseTo((0.04 * 10 + 0.02 * 15) / 25);
    expect(result.liquidityAvailable).toBe(25);
    expect(result.targetSize).toBe(100);
    expect(result.exhausted).toBe(true);
  });

  it("walks asks ascending for BUY", () => {
    const result = computeEffectiveFillPrice(
      book({
        bestAsk: 0.11,
        asks: [
          { price: 0.12, size: 10 },
          { price: 0.11, size: 10 },
        ],
      }),
      15,
      "buy",
    );

    expect(result.effectiveFillPrice).toBeCloseTo((0.11 * 10 + 0.12 * 5) / 15);
    expect(result.worstFillPrice).toBe(0.12);
    expect(result.exhausted).toBe(false);
  });

  it("returns top of book without walking when target size is zero", () => {
    expect(computeEffectiveFillPrice(book({ bestBid: 0.04 }), 0, "sell")).toMatchObject({
      effectiveFillPrice: 0.04,
      worstFillPrice: 0.04,
      liquidityAvailable: 0,
      exhausted: false,
    });
    expect(computeEffectiveFillPrice(book({ bestAsk: 0.06 }), 0, "buy")).toMatchObject({
      effectiveFillPrice: 0.06,
      worstFillPrice: 0.06,
      liquidityAvailable: 0,
      exhausted: false,
    });
  });
});
