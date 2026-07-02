import { describe, it, expect } from "vitest";
import { mapGammaMarket, mapMarket } from "../mappers.js";

describe("volume24hr mapping", () => {
  it("mapGammaMarket reads rolling volume24hr distinct from lifetime volumeNum", () => {
    const clob = mapGammaMarket(
      {
        conditionId: "0xabc",
        clobTokenIds: '["t0","t1"]',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.05","0.95"]',
        volumeNum: 500000,
        volume24hr: 123.4,
        liquidity: 800,
        endDate: "2026-12-31T00:00:00Z",
        orderPriceMinTickSize: 0.001,
      },
      { slug: "e", marketCount: 2 },
    );
    expect(clob.volume24h).toBe(500000); // lifetime unchanged
    expect(clob.volume24hr).toBe(123.4); // rolling
  });
  it("mapMarket (CLOB path) leaves volume24hr null", () => {
    expect(mapMarket({ condition_id: "0x1", tokens: [] }).volume24hr).toBeNull();
  });
});
