import { describe, expect, it } from "vitest";
import { evaluateD9LossExit, type D9LossExitContext, type D9LossExitPolicy } from "../index.js";

const policy: D9LossExitPolicy = {
  enabled: true,
  states: ["S1", "S2"],
  minPublicTradeCount24h: 41,
};

function ctx(overrides: Partial<D9LossExitContext> = {}): D9LossExitContext {
  return {
    state: "S2",
    currentPrice: 0.07,
    cumulativeBuyNotional: 10,
    cumulativeBuySize: 100,
    publicTradeCount24h: 41,
    ...overrides,
  };
}

describe("evaluateD9LossExit", () => {
  it("disabled → no fire", () => {
    const result = evaluateD9LossExit(ctx(), { ...policy, enabled: false });
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("disabled");
  });

  it("state=S3 → no fire", () => {
    const result = evaluateD9LossExit(ctx({ state: "S3" }), policy);
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("state-mismatch");
  });

  it("state=OTHER → no fire", () => {
    const result = evaluateD9LossExit(ctx({ state: "OTHER" }), policy);
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("state-mismatch");
  });

  it("cumulativeBuySize=0 → no fire", () => {
    const result = evaluateD9LossExit(ctx({ cumulativeBuySize: 0 }), policy);
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("avg-buy-unavailable");
  });

  it("profit_ratio=1.0 exact → no fire", () => {
    const result = evaluateD9LossExit(ctx({ currentPrice: 0.1 }), policy);
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("not-in-loss");
    expect(result.profitRatio).toBe(1);
  });

  it("profit_ratio=1.0001 → no fire", () => {
    const result = evaluateD9LossExit(ctx({ currentPrice: 0.10001 }), policy);
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("not-in-loss");
  });

  it("profit_ratio=0.9999 → fire when liquidity passes", () => {
    const result = evaluateD9LossExit(ctx({ currentPrice: 0.09999 }), policy);
    expect(result.fire).toBe(true);
    expect(result.reason).toBe("d9-loss-exit-fired");
  });

  it("publicTradeCount24h=null → no fire", () => {
    const result = evaluateD9LossExit(ctx({ publicTradeCount24h: null }), policy);
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("liquidity-data-missing");
  });

  it("publicTradeCount24h=40 → no fire", () => {
    const result = evaluateD9LossExit(ctx({ publicTradeCount24h: 40 }), policy);
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("market-illiquid");
  });

  it("publicTradeCount24h=41 exact → fire", () => {
    const result = evaluateD9LossExit(ctx({ publicTradeCount24h: 41 }), policy);
    expect(result.fire).toBe(true);
    expect(result.reason).toBe("d9-loss-exit-fired");
  });

  it("publicTradeCount24h=42 → fire", () => {
    const result = evaluateD9LossExit(ctx({ publicTradeCount24h: 42 }), policy);
    expect(result.fire).toBe(true);
  });

  it("state=S1 + profit=0.7 + liq=100 → fire", () => {
    const result = evaluateD9LossExit(
      ctx({ state: "S1", currentPrice: 0.07, publicTradeCount24h: 100 }),
      policy,
    );
    expect(result.fire).toBe(true);
    expect(result.profitRatio).toBeCloseTo(0.7);
  });

  it("state=S2 + profit=0.458 + liq=100 → fire", () => {
    const result = evaluateD9LossExit(
      ctx({ currentPrice: 0.0458, publicTradeCount24h: 100 }),
      policy,
    );
    expect(result.fire).toBe(true);
    expect(result.profitRatio).toBeCloseTo(0.458);
  });

  it("state=S2 + profit=0.458 + liq=20 → no fire", () => {
    const result = evaluateD9LossExit(
      ctx({ currentPrice: 0.0458, publicTradeCount24h: 20 }),
      policy,
    );
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("market-illiquid");
  });

  it("state=S2 + profit=0.9 + liq=50 → fire", () => {
    const result = evaluateD9LossExit(ctx({ currentPrice: 0.09, publicTradeCount24h: 50 }), policy);
    expect(result.fire).toBe(true);
    expect(result.profitRatio).toBeCloseTo(0.9);
  });

  it("state=S2 + profit=1.5 + liq=100 → no fire", () => {
    const result = evaluateD9LossExit(
      ctx({ currentPrice: 0.15, publicTradeCount24h: 100 }),
      policy,
    );
    expect(result.fire).toBe(false);
    expect(result.reason).toBe("not-in-loss");
  });
});
