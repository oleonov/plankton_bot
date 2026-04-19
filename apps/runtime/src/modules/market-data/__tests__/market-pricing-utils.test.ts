import { describe, it, expect } from "vitest";
import { applyPricingSnapshot, didMarketPricingChange } from "../market-pricing-utils.js";
import type { MarketPricingSnapshot, NormalizedMarket, TokenId } from "@plankton/domain";

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
    expect(
      didMarketPricingChange(baseMarket(), baseMarket({ acceptingOrders: false })),
    ).toBe(true);
  });

  it("returns true when only enableOrderBook differs", () => {
    expect(
      didMarketPricingChange(baseMarket(), baseMarket({ enableOrderBook: false })),
    ).toBe(true);
  });

  it("returns false when both equal and nothing else changed", () => {
    expect(didMarketPricingChange(baseMarket(), baseMarket())).toBe(false);
  });
});
