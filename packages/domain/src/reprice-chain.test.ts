import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPRICE_CHAIN_POLICY,
  resolveDynamicChainCap,
  resolveDynamicChainCapDetails,
} from "./reprice-chain.js";

describe("resolveDynamicChainCap", () => {
  it("uses the unknown-market cap when trade-count data is missing", () => {
    expect(resolveDynamicChainCap(null)).toBe(30);
    expect(resolveDynamicChainCap({ publicTradeCount24h: null })).toBe(30);
    expect(resolveDynamicChainCap({ publicTradeCount24h: Number.NaN })).toBe(30);
  });

  it("maps thin, medium, and liquid markets to their configured caps", () => {
    expect(resolveDynamicChainCap({ publicTradeCount24h: 0 })).toBe(50);
    expect(resolveDynamicChainCap({ publicTradeCount24h: 10 })).toBe(50);
    expect(resolveDynamicChainCap({ publicTradeCount24h: 11 })).toBe(30);
    expect(resolveDynamicChainCap({ publicTradeCount24h: 49 })).toBe(30);
    expect(resolveDynamicChainCap({ publicTradeCount24h: 50 })).toBe(13);
    expect(resolveDynamicChainCap({ publicTradeCount24h: 200 })).toBe(13);
  });

  it("returns legacy fixed cap when dynamic policy is disabled", () => {
    expect(
      resolveDynamicChainCap(
        { publicTradeCount24h: 0 },
        {
          ...DEFAULT_REPRICE_CHAIN_POLICY,
          maxChainCount: 13,
          dynamicChainCap: {
            ...DEFAULT_REPRICE_CHAIN_POLICY.dynamicChainCap,
            enabled: false,
          },
        },
      ),
    ).toBe(13);
  });

  it("returns bucket telemetry for cap resolution", () => {
    expect(resolveDynamicChainCapDetails({ publicTradeCount24h: 3 }).bucket).toBe("50");
    expect(resolveDynamicChainCapDetails({ publicTradeCount24h: 22 }).bucket).toBe("30");
    expect(resolveDynamicChainCapDetails({ publicTradeCount24h: 100 }).bucket).toBe("13");
    expect(resolveDynamicChainCapDetails({ publicTradeCount24h: null }).bucket).toBe("unknown");
  });
});
