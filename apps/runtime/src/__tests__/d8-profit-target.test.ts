import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFIT_TARGET_POLICY,
  D8_THRESHOLD_BUCKETS,
  evaluateD8ProfitRatio,
  getProfitThresholdByPrice,
} from "@krabs/domain";
import type { AlgoState } from "@krabs/domain";

const HOLD_OK = DEFAULT_PROFIT_TARGET_POLICY.holdSecondsMin;

function ctx(overrides: Partial<Parameters<typeof evaluateD8ProfitRatio>[0]> = {}) {
  return {
    state: "S1" as AlgoState,
    sellCount: 0,
    currentPrice: 0.05,
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 1,
    holdDurationSeconds: HOLD_OK,
    ...overrides,
  };
}

describe("getProfitThresholdByPrice", () => {
  it("returns R66 bucket thresholds exactly", () => {
    expect(getProfitThresholdByPrice(0.005)).toBe(2.0);
    expect(getProfitThresholdByPrice(0.02 - 1e-9)).toBe(2.0);
    expect(getProfitThresholdByPrice(0.03)).toBe(1.2412);
    expect(getProfitThresholdByPrice(0.07)).toBe(1.228);
    expect(getProfitThresholdByPrice(0.15)).toBe(1.2105);
    expect(getProfitThresholdByPrice(0.3)).toBe(1.1364);
    expect(getProfitThresholdByPrice(0.4)).toBe(1.1005);
  });

  it("falls back to highest bucket for prices >= 0.50", () => {
    const tail = D8_THRESHOLD_BUCKETS[D8_THRESHOLD_BUCKETS.length - 1]!.ratio;
    expect(getProfitThresholdByPrice(0.5)).toBe(tail);
    expect(getProfitThresholdByPrice(0.9)).toBe(tail);
  });
});

describe("evaluateD8ProfitRatio", () => {
  it("fires when profit_ratio >= bucket threshold in S1", () => {
    // avg buy = 0.01, current = 0.025 → ratio = 2.5 ≥ 2.0
    const result = evaluateD8ProfitRatio(
      ctx({ cumulativeBuyNotional: 1, cumulativeBuySize: 100, currentPrice: 0.025 }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(true);
    if (result.fire) {
      expect(result.profitRatio).toBeCloseTo(2.5, 6);
      expect(result.threshold).toBe(2.0);
      expect(result.avgBuyPrice).toBeCloseTo(0.01, 6);
    }
  });

  it("does not fire below threshold", () => {
    // avg buy = 0.01, current = 0.015 → ratio = 1.5 < 2.0
    const result = evaluateD8ProfitRatio(
      ctx({ cumulativeBuyNotional: 1, cumulativeBuySize: 100, currentPrice: 0.015 }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(false);
  });

  it("fires in S2 also (allowed states are S1, S2)", () => {
    const result = evaluateD8ProfitRatio(
      ctx({ state: "S2", cumulativeBuyNotional: 1, cumulativeBuySize: 100, currentPrice: 0.025 }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(true);
  });

  it("does not fire in other states (S3 etc.)", () => {
    const result = evaluateD8ProfitRatio(
      ctx({ state: "S3" as AlgoState, currentPrice: 0.025 }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(false);
    if (!result.fire) expect(result.reason).toBe("state-mismatch");
  });

  it("does not fire below holdSecondsMin boundary", () => {
    const result = evaluateD8ProfitRatio(
      ctx({ holdDurationSeconds: HOLD_OK - 1, currentPrice: 0.025 }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(false);
    if (!result.fire) expect(result.reason).toBe("hold-time-not-met");
  });

  it("fires exactly at holdSecondsMin boundary", () => {
    const result = evaluateD8ProfitRatio(
      ctx({
        holdDurationSeconds: HOLD_OK,
        cumulativeBuyNotional: 1,
        cumulativeBuySize: 100,
        currentPrice: 0.025,
      }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(true);
  });

  it("does not fire when cumulativeBuySize is 0 (no division by zero)", () => {
    const result = evaluateD8ProfitRatio(
      ctx({ cumulativeBuySize: 0, cumulativeBuyNotional: 1 }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(false);
    if (!result.fire) expect(result.reason).toBe("no-buy-data");
  });

  it("does not fire when holdDurationSeconds is null", () => {
    const result = evaluateD8ProfitRatio(
      ctx({ holdDurationSeconds: null }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(false);
    if (!result.fire) expect(result.reason).toBe("hold-time-not-met");
  });

  it("fires from S1/S2 even when sellCount > 0", () => {
    const result = evaluateD8ProfitRatio(
      ctx({
        state: "S2",
        sellCount: 1,
        cumulativeBuyNotional: 1,
        cumulativeBuySize: 100,
        currentPrice: 0.025,
      }),
      DEFAULT_PROFIT_TARGET_POLICY,
    );
    expect(result.fire).toBe(true);
  });

  it("does not fire when policy disabled", () => {
    const result = evaluateD8ProfitRatio(
      ctx({ currentPrice: 0.025, cumulativeBuyNotional: 1, cumulativeBuySize: 100 }),
      { ...DEFAULT_PROFIT_TARGET_POLICY, enabled: false },
    );
    expect(result.fire).toBe(false);
    if (!result.fire) expect(result.reason).toBe("policy-disabled");
  });
});
