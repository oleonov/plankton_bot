import { describe, it, expect } from "vitest";
import {
  applyPricingSnapshot,
  applyStreamUpdate,
  didMarketPricingChange,
} from "../market-pricing-utils.js";
import type {
  MarketPricingSnapshot,
  MarketPricingStreamUpdate,
  NormalizedMarket,
  TokenId,
} from "@krabs/domain";

const baseMarket = (overrides: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  tokenId: "t1" as TokenId,
  conditionId: "c1",
  slug: "s1",
  eventSlug: null,
  eventMarketCount: 1,
  question: "q",
  outcome: "Yes",
  outcomeIndex: 0,
  regime: null,
  horizon: null,
  endDate: null,
  active: true,
  tradable: true,
  tickSize: 0.01,
  negRisk: false,
  gammaCreatedAt: null,
  acceptingOrders: true,
  enableOrderBook: true,
  bestBid: 0.4,
  bestAsk: 0.5,
  midPrice: 0.45,
  spread: 0.1,
  snapshotTs: 0,
  ...overrides,
});

const baseSnapshot = (overrides: Partial<MarketPricingSnapshot> = {}): MarketPricingSnapshot => ({
  bestBid: 0.4,
  bestAsk: 0.5,
  acceptingOrders: true,
  enableOrderBook: true,
  lastTradePrice: null,
  ...overrides,
});

describe("applyPricingSnapshot — liveness fields", () => {
  it("copies acceptingOrders + enableOrderBook from snapshot", () => {
    const next = applyPricingSnapshot(
      baseMarket({ acceptingOrders: false, enableOrderBook: false }),
      baseSnapshot({ acceptingOrders: true, enableOrderBook: true }),
      100,
    );
    expect(next.acceptingOrders).toBe(true);
    expect(next.enableOrderBook).toBe(true);
  });

  it("can flip fields to false", () => {
    const next = applyPricingSnapshot(
      baseMarket(),
      baseSnapshot({ acceptingOrders: false, enableOrderBook: false }),
      100,
    );
    expect(next.acceptingOrders).toBe(false);
    expect(next.enableOrderBook).toBe(false);
  });
});

describe("didMarketPricingChange — liveness fields", () => {
  it("returns true when only acceptingOrders differs", () => {
    expect(didMarketPricingChange(baseMarket(), baseMarket({ acceptingOrders: false }))).toBe(true);
  });

  it("returns true when only enableOrderBook differs", () => {
    expect(didMarketPricingChange(baseMarket(), baseMarket({ enableOrderBook: false }))).toBe(true);
  });

  it("returns false when both equal and nothing else changed", () => {
    expect(didMarketPricingChange(baseMarket(), baseMarket())).toBe(false);
  });
});

describe("applyPricingSnapshot — executable top-of-book", () => {
  it("drops non-executable scalar quotes before they reach the normalized market", () => {
    const next = applyPricingSnapshot(
      baseMarket({ tickSize: 0.001 }),
      baseSnapshot({ bestBid: 0.0005, bestAsk: 1 }),
      100,
    );

    expect(next.bestBid).toBeNull();
    expect(next.bestAsk).toBeNull();
    expect(next.midPrice).toBeNull();
    expect(next.spread).toBeNull();
  });
});

describe("applyStreamUpdate — executable top-of-book", () => {
  it("preserves Gamma liveness across alternating REST and WS updates", () => {
    const gammaOpen = applyPricingSnapshot(
      baseMarket({ acceptingOrders: false, enableOrderBook: false }),
      baseSnapshot({ acceptingOrders: true, enableOrderBook: true }),
      0,
    );

    const wsAfterOpen: MarketPricingStreamUpdate = {
      tokenId: "t1",
      pricing: baseSnapshot({
        bestBid: 0.41,
        bestAsk: 0.51,
        acceptingOrders: false,
        enableOrderBook: false,
        bookSource: "clob",
      }),
    };
    const afterWsOpen = applyStreamUpdate(gammaOpen, wsAfterOpen, 100);
    expect(afterWsOpen.acceptingOrders).toBe(true);
    expect(afterWsOpen.enableOrderBook).toBe(true);

    const gammaClosed = applyPricingSnapshot(
      afterWsOpen,
      baseSnapshot({ acceptingOrders: false, enableOrderBook: false }),
      5_000,
    );
    expect(gammaClosed.acceptingOrders).toBe(false);
    expect(gammaClosed.enableOrderBook).toBe(false);

    const wsAfterClosed: MarketPricingStreamUpdate = {
      tokenId: "t1",
      pricing: baseSnapshot({
        bestBid: 0.42,
        bestAsk: 0.52,
        acceptingOrders: true,
        enableOrderBook: true,
        bookSource: "clob",
      }),
    };
    const afterWsClosed = applyStreamUpdate(gammaClosed, wsAfterClosed, 5_100);
    expect(afterWsClosed.acceptingOrders).toBe(false);
    expect(afterWsClosed.enableOrderBook).toBe(false);
  });

  it("uses the first deeper executable book levels when the raw top-of-book is invalid", () => {
    const update: MarketPricingStreamUpdate = {
      tokenId: "t1",
      pricing: baseSnapshot({ bestBid: 0.0005, bestAsk: 1, bookSource: "clob" }),
      book: {
        tokenId: "t1" as TokenId,
        bids: [
          { price: 0.0005, size: 100 },
          { price: 0.001, size: 90 },
        ],
        asks: [
          { price: 1, size: 100 },
          { price: 0.999, size: 90 },
        ],
        bestBid: 0.0005,
        bestAsk: 1,
        midPrice: 0.50025,
        spread: 0.9995,
        timestamp: 1234,
      },
    };

    const next = applyStreamUpdate(baseMarket({ tickSize: 0.001 }), update, 100);

    expect(next.bestBid).toBe(0.001);
    expect(next.bestAsk).toBe(0.999);
    expect(next.midPrice).toBe(0.5);
    expect(next.spread).toBe(0.998);
    expect(next.snapshotTs).toBe(1234);
  });
});
