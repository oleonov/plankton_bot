import { describe, it, expect, beforeEach } from "vitest";
import { createTokenId } from "@plankton/domain";
import type { ClobMarket, TokenId } from "@plankton/domain";
import { SimulationMarketDataGateway } from "../simulation/market-data-gateway.js";

function makeMarket(overrides?: Partial<ClobMarket>): ClobMarket {
  return {
    conditionId: "cond-1",
    tokens: [
      { tokenId: "tok-yes", outcome: "Yes", outcomeIndex: 0 },
      { tokenId: "tok-no", outcome: "No", outcomeIndex: 1 },
    ],
    question: "Will it rain?",
    slug: "will-it-rain",
    endDate: "2026-12-31",
    active: true,
    negRisk: false,
    tickSize: 0.01,
    volume24h: null,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    ...overrides,
  };
}

describe("SimulationMarketDataGateway", () => {
  let gw: SimulationMarketDataGateway;

  beforeEach(() => {
    gw = new SimulationMarketDataGateway();
  });

  it("getMarkets returns added active markets", async () => {
    gw.addMarket(makeMarket());
    const markets = await gw.getMarkets();
    expect(markets).toHaveLength(1);
    expect(markets[0]!.conditionId).toBe("cond-1");
  });

  it("getMarkets excludes inactive markets", async () => {
    gw.addMarket(makeMarket({ active: false }));
    const markets = await gw.getMarkets();
    expect(markets).toHaveLength(0);
  });

  it("getMarket returns by conditionId", async () => {
    gw.addMarket(makeMarket());
    const found = await gw.getMarket("cond-1");
    expect(found).not.toBeNull();
    expect(found!.question).toBe("Will it rain?");
  });

  it("getMarket returns null for unknown conditionId", async () => {
    const found = await gw.getMarket("nonexistent");
    expect(found).toBeNull();
  });

  it("getOrderBook returns empty book by default", async () => {
    const book = await gw.getOrderBook(createTokenId("tok-1"));
    expect(book.bids).toHaveLength(0);
    expect(book.asks).toHaveLength(0);
    expect(book.bestBid).toBeNull();
  });

  it("setOrderBook populates book with derived fields", async () => {
    const tokenId = createTokenId("tok-1");
    gw.setOrderBook(
      tokenId,
      [
        { price: 0.5, size: 100 },
        { price: 0.49, size: 200 },
      ],
      [{ price: 0.52, size: 150 }],
    );

    const book = await gw.getOrderBook(tokenId);
    expect(book.bids).toHaveLength(2);
    expect(book.asks).toHaveLength(1);
    expect(book.bestBid).toBe(0.5);
    expect(book.bestAsk).toBe(0.52);
    expect(book.midPrice).toBe(0.51);
    expect(book.spread).toBeCloseTo(0.02);
  });

  it("getOrderBooks returns stored books for multiple tokens", async () => {
    const tokA = createTokenId("tok-a");
    const tokB = createTokenId("tok-b");
    gw.setOrderBook(tokA, [{ price: 0.1, size: 10 }], [{ price: 0.11, size: 12 }]);
    gw.setOrderBook(tokB, [{ price: 0.2, size: 20 }], [{ price: 0.22, size: 22 }]);

    const books = await gw.getOrderBooks(["tok-a", "tok-b"]);
    expect(books.get("tok-a")!.bestBid).toBe(0.1);
    expect(books.get("tok-b")!.bestAsk).toBe(0.22);
  });

  it("getTickSize returns market tick size", async () => {
    gw.addMarket(makeMarket({ tickSize: 0.001 }));
    const tick = await gw.getTickSize(createTokenId("tok-yes"));
    expect(tick).toBe(0.001);
  });

  it("getTickSize returns default 0.01 for unknown token", async () => {
    const tick = await gw.getTickSize(createTokenId("unknown"));
    expect(tick).toBe(0.01);
  });

  it("healthCheck returns ok", async () => {
    const health = await gw.healthCheck();
    expect(health.ok).toBe(true);
  });
});

describe("SimulationMarketDataGateway — liveness", () => {
  it("returns acceptingOrders=true + enableOrderBook=true by default", async () => {
    const gw = new SimulationMarketDataGateway();
    const out = await gw.getMarketPricing(["t1"]);
    const snap = out.get("t1");
    expect(snap?.acceptingOrders).toBe(true);
    expect(snap?.enableOrderBook).toBe(true);
  });

  it("honors setLivenessOverride for acceptingOrders=false", async () => {
    const gw = new SimulationMarketDataGateway();
    gw.setLivenessOverride("t1" as TokenId, { acceptingOrders: false });
    const out = await gw.getMarketPricing(["t1"]);
    expect(out.get("t1")?.acceptingOrders).toBe(false);
    expect(out.get("t1")?.enableOrderBook).toBe(true);
  });

  it("honors setLivenessOverride for enableOrderBook=false", async () => {
    const gw = new SimulationMarketDataGateway();
    gw.setLivenessOverride("t1" as TokenId, { enableOrderBook: false });
    const out = await gw.getMarketPricing(["t1"]);
    expect(out.get("t1")?.enableOrderBook).toBe(false);
    expect(out.get("t1")?.acceptingOrders).toBe(true);
  });
});
