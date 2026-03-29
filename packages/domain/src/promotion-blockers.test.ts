import { describe, it, expect } from "vitest";
import { getPromotionBlockers } from "./promotion-blockers.js";

describe("getPromotionBlockers", () => {
  const passingInput = {
    repricingExits: 5,
    distinctMarkets: 8,
    tradeCount: 30,
    recycleScore: 0.75,
    toxicity: 0.1,
    tailAdjustedPnl: 10,
  };

  it("returns all passed when thresholds met", () => {
    const blockers = getPromotionBlockers(passingInput);
    expect(blockers.every((b) => b.passed)).toBe(true);
    expect(blockers).toHaveLength(6);
  });

  it("fails repricing exits below 3", () => {
    const blockers = getPromotionBlockers({ ...passingInput, repricingExits: 2 });
    const exits = blockers.find((b) => b.metric === "Repricing exits")!;
    expect(exits.passed).toBe(false);
    expect(exits.current).toBe(2);
    expect(exits.required).toBe(3);
  });

  it("fails distinct markets below 5", () => {
    const blockers = getPromotionBlockers({ ...passingInput, distinctMarkets: 3 });
    const dm = blockers.find((b) => b.metric === "Distinct markets")!;
    expect(dm.passed).toBe(false);
  });

  it("fails trade count below 20", () => {
    const blockers = getPromotionBlockers({ ...passingInput, tradeCount: 15 });
    const tc = blockers.find((b) => b.metric === "Trade count")!;
    expect(tc.passed).toBe(false);
  });

  it("fails recycle score below 0.6", () => {
    const blockers = getPromotionBlockers({ ...passingInput, recycleScore: 0.5 });
    const rs = blockers.find((b) => b.metric === "Recycle score")!;
    expect(rs.passed).toBe(false);
  });

  it("fails toxicity at or above 0.3", () => {
    const blockers = getPromotionBlockers({ ...passingInput, toxicity: 0.35 });
    const tox = blockers.find((b) => b.metric === "Toxicity")!;
    expect(tox.passed).toBe(false);
  });

  it("fails tail-adjusted PnL at or below 0", () => {
    const blockers = getPromotionBlockers({ ...passingInput, tailAdjustedPnl: 0 });
    const tap = blockers.find((b) => b.metric === "Tail-adjusted PnL")!;
    expect(tap.passed).toBe(false);
  });

  it("fails tail-adjusted PnL when negative", () => {
    const blockers = getPromotionBlockers({ ...passingInput, tailAdjustedPnl: -5 });
    const tap = blockers.find((b) => b.metric === "Tail-adjusted PnL")!;
    expect(tap.passed).toBe(false);
    expect(tap.current).toBe(-5);
  });
});
