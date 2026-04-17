import { describe, it, expect } from "vitest";
import {
  computeRecurrenceScore,
  computeRecycleScore,
  computeLiveViabilityScore,
  computeToxicityPenalty,
} from "./scoring.js";

const approx = (v: number, decimals = 4) => Math.round(v * 10 ** decimals) / 10 ** decimals;

describe("computeRecurrenceScore", () => {
  it("returns 0 for all-zero inputs", () => {
    expect(
      computeRecurrenceScore({
        spanDays: 0,
        presenceDays: 0,
        totalDays: 0,
        cadenceStddev: 0,
        cadenceMean: 0,
        distinctConditions: 0,
      }),
    ).toBe(0);
  });

  it("returns 1 for maxed-out inputs", () => {
    expect(
      computeRecurrenceScore({
        spanDays: 60,
        presenceDays: 30,
        totalDays: 30,
        cadenceStddev: 0,
        cadenceMean: 5,
        distinctConditions: 40,
      }),
    ).toBe(1);
  });

  it("computes a typical mid-range score", () => {
    const score = computeRecurrenceScore({
      spanDays: 15,
      presenceDays: 10,
      totalDays: 30,
      cadenceStddev: 1,
      cadenceMean: 2,
      distinctConditions: 5,
    });
    // observation_span = 0.5 * 0.25 = 0.125
    // presence_ratio = (10/30) * 0.30 = 0.1
    // cadence_stability = (1 - 0.5/2) * 0.20 = 0.75 * 0.20 = 0.15
    // slug_diversity = 0.25 * 0.25 = 0.0625
    expect(approx(score)).toBe(0.4375);
  });

  it("clamps spanDays above 30", () => {
    const a = computeRecurrenceScore({
      spanDays: 30,
      presenceDays: 0,
      totalDays: 0,
      cadenceStddev: 0,
      cadenceMean: 0,
      distinctConditions: 0,
    });
    const b = computeRecurrenceScore({
      spanDays: 100,
      presenceDays: 0,
      totalDays: 0,
      cadenceStddev: 0,
      cadenceMean: 0,
      distinctConditions: 0,
    });
    expect(a).toBe(b);
  });

  it("cadenceStability is 0 when cadenceMean is 0", () => {
    const score = computeRecurrenceScore({
      spanDays: 0,
      presenceDays: 0,
      totalDays: 0,
      cadenceStddev: 5,
      cadenceMean: 0,
      distinctConditions: 0,
    });
    expect(score).toBe(0);
  });

  it("clamps cadenceStddev/cadenceMean ratio at 2", () => {
    const a = computeRecurrenceScore({
      spanDays: 0,
      presenceDays: 0,
      totalDays: 0,
      cadenceStddev: 10,
      cadenceMean: 1,
      distinctConditions: 0,
    });
    const b = computeRecurrenceScore({
      spanDays: 0,
      presenceDays: 0,
      totalDays: 0,
      cadenceStddev: 100,
      cadenceMean: 1,
      distinctConditions: 0,
    });
    expect(a).toBe(b);
    expect(a).toBe(0); // cadence_stability = 0 when ratio >= 2
  });
});

describe("computeRecycleScore", () => {
  it("returns 0 for all-zero inputs", () => {
    expect(
      computeRecycleScore({
        tradeCount: 0,
        distinctMarkets: 0,
        tailAdjustedPnl: 0,
        repricingExits: 0,
        totalNonSettlementClosed: 0,
      }),
    ).toBe(0);
  });

  it("returns 1 for maxed-out inputs", () => {
    expect(
      computeRecycleScore({
        tradeCount: 200,
        distinctMarkets: 20,
        tailAdjustedPnl: 100,
        repricingExits: 10,
        totalNonSettlementClosed: 10,
      }),
    ).toBe(1);
  });

  it("tailAdjustedPnl sign: positive gives 0.3, zero/negative gives 0", () => {
    const positive = computeRecycleScore({
      tradeCount: 0,
      distinctMarkets: 0,
      tailAdjustedPnl: 1,
      repricingExits: 0,
      totalNonSettlementClosed: 0,
    });
    const zero = computeRecycleScore({
      tradeCount: 0,
      distinctMarkets: 0,
      tailAdjustedPnl: 0,
      repricingExits: 0,
      totalNonSettlementClosed: 0,
    });
    const negative = computeRecycleScore({
      tradeCount: 0,
      distinctMarkets: 0,
      tailAdjustedPnl: -5,
      repricingExits: 0,
      totalNonSettlementClosed: 0,
    });
    expect(positive).toBe(0.3);
    expect(zero).toBe(0);
    expect(negative).toBe(0);
  });

  it("recycleExitRatio is 0 when totalNonSettlementClosed is 0", () => {
    const score = computeRecycleScore({
      tradeCount: 0,
      distinctMarkets: 0,
      tailAdjustedPnl: 0,
      repricingExits: 5,
      totalNonSettlementClosed: 0,
    });
    expect(score).toBe(0);
  });

  it("computes typical mid-range", () => {
    const score = computeRecycleScore({
      tradeCount: 50,
      distinctMarkets: 5,
      tailAdjustedPnl: 10,
      repricingExits: 3,
      totalNonSettlementClosed: 6,
    });
    // trade_density = 0.5 * 0.2 = 0.1
    // market_breadth = 0.5 * 0.2 = 0.1
    // pnl_sign = 1.0 * 0.3 = 0.3
    // recycle_exit = 0.5 * 0.3 = 0.15
    expect(approx(score)).toBe(0.65);
  });
});

describe("computeLiveViabilityScore", () => {
  it("returns 0 for all-zero inputs", () => {
    expect(
      computeLiveViabilityScore({
        activeMarketCount: 0,
        healthyEndDateFraction: 0,
        clusterVolume24h: 0,
      }),
    ).toBe(0);
  });

  it("returns 1 for maxed-out inputs", () => {
    expect(
      computeLiveViabilityScore({
        activeMarketCount: 10,
        healthyEndDateFraction: 1,
        clusterVolume24h: 100_000,
      }),
    ).toBe(1);
  });

  it("computes typical mid-range", () => {
    const score = computeLiveViabilityScore({
      activeMarketCount: 3,
      healthyEndDateFraction: 0.8,
      clusterVolume24h: 25_000,
    });
    // active = 0.6 * 0.35 = 0.21
    // health = 0.8 * 0.35 = 0.28
    // volume = 0.5 * 0.30 = 0.15
    expect(approx(score)).toBe(0.64);
  });

  it("clamps activeMarketCount above 5", () => {
    const a = computeLiveViabilityScore({
      activeMarketCount: 5,
      healthyEndDateFraction: 0,
      clusterVolume24h: 0,
    });
    const b = computeLiveViabilityScore({
      activeMarketCount: 50,
      healthyEndDateFraction: 0,
      clusterVolume24h: 0,
    });
    expect(a).toBe(b);
  });
});

describe("computeToxicityPenalty", () => {
  const zeros = {
    dustCount: 0,
    positionCount: 0,
    tailCostUsdc: 0,
    realizedPnlUsdc: 0,
    reduceOnlyCount: 0,
    weeksDeployed: 0,
    staleCount: 0,
    totalOpen: 0,
  };

  it("returns 0 for all-zero inputs", () => {
    expect(computeToxicityPenalty(zeros)).toBe(0);
  });

  it("computes dust_ratio correctly", () => {
    const score = computeToxicityPenalty({ ...zeros, dustCount: 5, positionCount: 5 });
    // dust_ratio = 5/10 = 0.5 * 0.30 = 0.15
    expect(approx(score)).toBe(0.15);
  });

  it("computes tail_burden correctly", () => {
    const score = computeToxicityPenalty({ ...zeros, tailCostUsdc: 50, realizedPnlUsdc: 100 });
    // tail_burden = clamp(50/100, 0, 2) / 2 = 0.25 * 0.35 = 0.0875
    expect(approx(score)).toBe(0.0875);
  });

  it("uses abs(realizedPnlUsdc) for negative pnl", () => {
    const score = computeToxicityPenalty({ ...zeros, tailCostUsdc: 50, realizedPnlUsdc: -100 });
    expect(approx(score)).toBe(0.0875);
  });

  it("clamps tail_burden ratio at 2", () => {
    const a = computeToxicityPenalty({ ...zeros, tailCostUsdc: 200, realizedPnlUsdc: 1 });
    const b = computeToxicityPenalty({ ...zeros, tailCostUsdc: 9999, realizedPnlUsdc: 1 });
    expect(approx(a)).toBe(approx(b));
    // tail_burden = 1.0 * 0.35 = 0.35
    expect(approx(a)).toBe(0.35);
  });

  it("reduce_only_frequency is 0 when weeksDeployed is 0", () => {
    const score = computeToxicityPenalty({ ...zeros, reduceOnlyCount: 10 });
    expect(score).toBe(0);
  });

  it("stale_position_ratio is 0 when totalOpen is 0", () => {
    const score = computeToxicityPenalty({ ...zeros, staleCount: 5 });
    expect(score).toBe(0);
  });

  it("computes typical mid-range", () => {
    const score = computeToxicityPenalty({
      dustCount: 2,
      positionCount: 8,
      tailCostUsdc: 10,
      realizedPnlUsdc: 50,
      reduceOnlyCount: 2,
      weeksDeployed: 4,
      staleCount: 1,
      totalOpen: 10,
    });
    // dust = 2/10 = 0.2 * 0.30 = 0.06
    // tail = (10/50)/2 = 0.1 * 0.35 = 0.035
    // reduce = 0.5 * 0.20 = 0.10
    // stale = 0.1 * 0.15 = 0.015
    expect(approx(score)).toBe(0.21);
  });
});

