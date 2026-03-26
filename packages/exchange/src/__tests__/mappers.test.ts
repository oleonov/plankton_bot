import { describe, it, expect } from "vitest";
import {
  toDomainSide,
  toSdkSide,
  toSdkTickSize,
  mapOpenOrder,
  mapTrade,
  mapMarket,
  mapOrderBook,
  mapBalance,
  mapGammaMarket,
  mapGammaPricing,
} from "../mappers.js";
import { createTokenId } from "@plankton/domain";

describe("side mapping", () => {
  it("toDomainSide converts BUY/SELL to buy/sell", () => {
    expect(toDomainSide("BUY")).toBe("buy");
    expect(toDomainSide("SELL")).toBe("sell");
    expect(toDomainSide("buy")).toBe("buy");
    expect(toDomainSide("Sell")).toBe("sell");
  });

  it("toDomainSide throws on unknown side", () => {
    expect(() => toDomainSide("HOLD")).toThrow('Unknown order side: "HOLD"');
    expect(() => toDomainSide("")).toThrow('Unknown order side: ""');
  });

  it("toSdkSide converts buy/sell to BUY/SELL", () => {
    expect(toSdkSide("buy")).toBe("BUY");
    expect(toSdkSide("sell")).toBe("SELL");
  });
});

describe("toSdkTickSize", () => {
  it("converts number to string", () => {
    expect(toSdkTickSize(0.01)).toBe("0.01");
    expect(toSdkTickSize(0.001)).toBe("0.001");
  });
});

describe("mapOpenOrder", () => {
  it("maps SDK order to domain ExchangeOrder", () => {
    const order = mapOpenOrder({
      id: "ord-123",
      asset_id: "tok-abc",
      side: "BUY",
      original_size: "100",
      size_matched: "30",
      price: "0.55",
      status: "LIVE",
      created_at: 1700000000000,
    });

    expect(order.orderId).toBe("ord-123");
    expect(order.tokenId).toBe("tok-abc");
    expect(order.side).toBe("buy");
    expect(order.sizeTotal).toBe(100);
    expect(order.sizeFilled).toBe(30);
    expect(order.sizeRemaining).toBe(70);
    expect(order.status).toBe("OPEN");
    expect(order.price).toBe(0.55);
    expect(order.createdAt).toBe(1700000000000);
  });

  it("maps MATCHED status to FILLED", () => {
    const order = mapOpenOrder({ status: "MATCHED" });
    expect(order.status).toBe("FILLED");
  });

  it("maps CANCELED to CANCELLED", () => {
    const order = mapOpenOrder({ status: "CANCELED" });
    expect(order.status).toBe("CANCELLED");
  });
});

describe("mapTrade", () => {
  it("maps SDK trade to domain ExchangeFill", () => {
    const fill = mapTrade({
      id: "fill-1",
      taker_order_id: "ord-1",
      client_order_id: "cloid-1",
      asset_id: "tok-x",
      side: "SELL",
      size: "50",
      price: "0.60",
      fee_rate_bps: "200",
      match_time: "2026-01-15T12:00:00Z",
    });

    expect(fill.fillId).toBe("fill-1");
    expect(fill.orderId).toBe("ord-1");
    expect(fill.clientOrderId).toBe("cloid-1");
    expect(fill.tokenId).toBe("tok-x");
    expect(fill.side).toBe("sell");
    expect(fill.size).toBe(50);
    expect(fill.price).toBe(0.6);
    // fee = 50 * 0.60 * (200/10000) = 0.60
    expect(fill.fee).toBeCloseTo(0.6);
  });

  it("clientOrderId defaults to empty when SDK omits it", () => {
    const fill = mapTrade({
      id: "fill-2",
      taker_order_id: "ord-2",
      side: "BUY",
    });
    expect(fill.orderId).toBe("ord-2");
    expect(fill.clientOrderId).toBe("");
  });
});

describe("mapMarket", () => {
  it("maps SDK market to domain ClobMarket", () => {
    const market = mapMarket({
      condition_id: "cond-1",
      tokens: [
        { token_id: "tok-yes", outcome: "Yes" },
        { token_id: "tok-no", outcome: "No" },
      ],
      question: "Will X happen?",
      slug: "will-x-happen",
      end_date_iso: "2026-12-31",
      active: true,
      neg_risk: false,
      minimum_tick_size: 0.01,
    });

    expect(market.conditionId).toBe("cond-1");
    expect(market.tokens).toHaveLength(2);
    expect(market.tokens[0]!.tokenId).toBe("tok-yes");
    expect(market.question).toBe("Will X happen?");
    expect(market.active).toBe(true);
    expect(market.tickSize).toBe(0.01);
  });

  it("handles missing tokens array", () => {
    const market = mapMarket({ condition_id: "c1" });
    expect(market.tokens).toEqual([]);
  });
});

describe("mapOrderBook", () => {
  it("maps SDK order book to domain OrderBookSnapshot", () => {
    const tokenId = createTokenId("tok-1");
    const book = mapOrderBook(tokenId, {
      bids: [
        { price: "0.50", size: "100" },
        { price: "0.49", size: "200" },
      ],
      asks: [{ price: "0.52", size: "150" }],
    });

    expect(book.tokenId).toBe("tok-1");
    expect(book.bids).toHaveLength(2);
    expect(book.asks).toHaveLength(1);
    expect(book.bids[0]!.price).toBe(0.5);
    expect(book.bestBid).toBe(0.5);
    expect(book.bestAsk).toBe(0.52);
    expect(book.midPrice).toBe(0.51);
    expect(book.spread).toBeCloseTo(0.02);
  });

  it("handles empty order book", () => {
    const book = mapOrderBook(createTokenId("tok-1"), {});
    expect(book.bids).toEqual([]);
    expect(book.bestBid).toBeNull();
    expect(book.midPrice).toBeNull();
  });
});

describe("mapBalance", () => {
  it("maps SDK balance to domain ExchangeBalance", () => {
    const balance = mapBalance({ balance: "1500.50", allowance: "2000" });
    expect(balance.asset).toBe("USDC");
    expect(balance.available).toBe(1500.5);
    // locked is always 0 — SDK doesn't provide real locked collateral info;
    // actual locked amount is computed by reconciliation from open orders
    expect(balance.locked).toBe(0);
  });

  it("reports zero locked regardless of allowance", () => {
    const balance = mapBalance({ balance: "1000", allowance: "500" });
    expect(balance.available).toBe(1000);
    expect(balance.locked).toBe(0);
  });
});

// ─── Gamma mapper tests ───────────────────────────────────────────────────

describe("mapGammaMarket", () => {
  it("maps a typical Gamma response to ClobMarket", () => {
    const market = mapGammaMarket({
      conditionId: "cond-gamma-1",
      clobTokenIds: ["tok-yes-1", "tok-no-1"],
      outcomes: ["Yes", "No"],
      question: "Will BTC hit 100k?",
      slug: "bitcoin-above-100k",
      endDate: "2026-06-30T00:00:00Z",
      active: true,
      negRisk: true,
      orderPriceMinTickSize: 0.001,
    });

    expect(market.conditionId).toBe("cond-gamma-1");
    expect(market.tokens).toHaveLength(2);
    expect(market.tokens[0]!.tokenId).toBe("tok-yes-1");
    expect(market.tokens[0]!.outcome).toBe("Yes");
    expect(market.tokens[1]!.tokenId).toBe("tok-no-1");
    expect(market.tokens[1]!.outcome).toBe("No");
    expect(market.question).toBe("Will BTC hit 100k?");
    expect(market.slug).toBe("bitcoin-above-100k");
    expect(market.endDate).toBe("2026-06-30T00:00:00Z");
    expect(market.active).toBe(true);
    expect(market.negRisk).toBe(true);
    expect(market.tickSize).toBe(0.001);
  });

  it("zips clobTokenIds and outcomes into tokens array", () => {
    const market = mapGammaMarket({
      clobTokenIds: ["a", "b", "c"],
      outcomes: ["Yes", "No", "Maybe"],
    });

    expect(market.tokens).toEqual([
      { tokenId: "a", outcome: "Yes" },
      { tokenId: "b", outcome: "No" },
      { tokenId: "c", outcome: "Maybe" },
    ]);
  });

  it("uses orderPriceMinTickSize for tickSize", () => {
    const market = mapGammaMarket({ orderPriceMinTickSize: 0.0001 });
    expect(market.tickSize).toBe(0.0001);
  });

  it("handles missing fields with defaults", () => {
    const market = mapGammaMarket({});

    expect(market.conditionId).toBe("");
    expect(market.tokens).toEqual([]);
    expect(market.question).toBe("");
    expect(market.slug).toBe("");
    expect(market.endDate).toBe("");
    expect(market.active).toBe(false);
    expect(market.negRisk).toBe(false);
    expect(market.tickSize).toBe(0.01);
  });

  it("defaults outcome to empty string when outcomes array is shorter than clobTokenIds", () => {
    const market = mapGammaMarket({
      clobTokenIds: ["tok-1", "tok-2"],
      outcomes: ["Yes"],
    });

    expect(market.tokens[0]!.outcome).toBe("Yes");
    expect(market.tokens[1]!.outcome).toBe("");
  });

  it("parses JSON-stringified clobTokenIds and outcomes (Gamma event nesting)", () => {
    const market = mapGammaMarket({
      conditionId: "cond-nested",
      clobTokenIds: '["tok-yes","tok-no"]',
      outcomes: '["Yes","No"]',
      slug: "will-bitcoin-reach-200k",
      active: true,
    });

    expect(market.tokens).toHaveLength(2);
    expect(market.tokens[0]!.tokenId).toBe("tok-yes");
    expect(market.tokens[0]!.outcome).toBe("Yes");
    expect(market.tokens[1]!.tokenId).toBe("tok-no");
    expect(market.tokens[1]!.outcome).toBe("No");
  });
});

describe("mapGammaPricing", () => {
  it("extracts bestBid, bestAsk, lastTradePrice", () => {
    const pricing = mapGammaPricing({
      bestBid: 0.45,
      bestAsk: 0.55,
      lastTradePrice: 0.5,
    });

    expect(pricing.bestBid).toBe(0.45);
    expect(pricing.bestAsk).toBe(0.55);
    expect(pricing.lastTradePrice).toBe(0.5);
  });

  it("returns null for missing pricing fields", () => {
    const pricing = mapGammaPricing({});

    expect(pricing.bestBid).toBeNull();
    expect(pricing.bestAsk).toBeNull();
    expect(pricing.lastTradePrice).toBeNull();
  });

  it("handles string numeric values by converting to number", () => {
    const pricing = mapGammaPricing({
      bestBid: "0.35",
      bestAsk: "0.65",
      lastTradePrice: "0.50",
    });

    expect(pricing.bestBid).toBe(0.35);
    expect(pricing.bestAsk).toBe(0.65);
    expect(pricing.lastTradePrice).toBe(0.5);
  });

  it("returns null when fields are explicitly null", () => {
    const pricing = mapGammaPricing({
      bestBid: null,
      bestAsk: null,
      lastTradePrice: null,
    });

    expect(pricing.bestBid).toBeNull();
    expect(pricing.bestAsk).toBeNull();
    expect(pricing.lastTradePrice).toBeNull();
  });
});
