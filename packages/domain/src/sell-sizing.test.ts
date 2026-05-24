import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELL_TIMEOUT_MS,
  computeSellSize,
  computeSellSizingPlan,
  estimateTotalSells,
  isSellTimeoutReplacement,
  normalizeSellSizeForMinOrder,
} from "./sell-sizing.js";

const nowMs = Date.parse("2026-05-24T12:00:00.000Z");

describe("Plankton-aligned SELL sizing", () => {
  it("closes the Vance/Iran-sized residual in one SELL instead of fixed-dollar dust", () => {
    const plan = computeSellSizingPlan({
      position: { size: 17.64, avgEntryPrice: 0.25, costBasisUsdc: 4.41 },
      sellCount: 3,
      price: 0.535,
      nowMs,
      marketMinOrderSize: 5,
    });

    expect(plan.baseTotalSells).toBe(1);
    expect(plan.size).toBeCloseTo(17.64, 8);
    expect(plan.sizeUsdc).toBeCloseTo(9.4374, 8);
  });

  it("uses a two-SELL plan at the $50 boundary and closes on the second SELL", () => {
    const position = { size: 100, avgEntryPrice: 0.5, costBasisUsdc: 50 };

    expect(estimateTotalSells(position.costBasisUsdc)).toBe(2);
    expect(
      computeSellSize({
        position,
        sellNumberInSequence: 1,
        expectedTotalSells: 2,
        marketMinOrderSize: 5,
      }),
    ).toBeCloseTo(43.58, 8);
    expect(
      computeSellSize({
        position,
        sellNumberInSequence: 2,
        expectedTotalSells: 2,
        marketMinOrderSize: 5,
      }),
    ).toBeCloseTo(100, 8);
  });

  it("uses a three-SELL plan at the $100 boundary and closes on the third SELL", () => {
    const position = { size: 100, avgEntryPrice: 1, costBasisUsdc: 100 };

    expect(estimateTotalSells(position.costBasisUsdc)).toBe(3);
    expect(
      computeSellSize({
        position,
        sellNumberInSequence: 1,
        expectedTotalSells: 3,
        marketMinOrderSize: 5,
      }),
    ).toBeCloseTo(27.16, 8);
    expect(
      computeSellSize({
        position,
        sellNumberInSequence: 2,
        expectedTotalSells: 3,
        marketMinOrderSize: 5,
      }),
    ).toBeCloseTo(36.76, 8);
    expect(
      computeSellSize({
        position,
        sellNumberInSequence: 3,
        expectedTotalSells: 3,
        marketMinOrderSize: 5,
      }),
    ).toBeCloseTo(100, 8);
  });

  it("uses the cheap-entry first multi-SELL fraction before the final close", () => {
    const position = { size: 100, avgEntryPrice: 0.04, costBasisUsdc: 50 };

    expect(
      computeSellSize({
        position,
        sellNumberInSequence: 1,
        expectedTotalSells: 2,
        marketMinOrderSize: 5,
      }),
    ).toBeCloseTo(7.03, 8);
  });

  it("clamps below-min intents to full position size", () => {
    expect(
      normalizeSellSizeForMinOrder({
        availableSize: 10,
        desiredSize: 2,
        marketMinOrderSize: 5,
      }),
    ).toEqual({ kind: "clamp", size: 10, reason: "intent-below-min" });
  });

  it("clamps sellable intents that would leave an orphan residual", () => {
    expect(
      normalizeSellSizeForMinOrder({
        availableSize: 8,
        desiredSize: 5,
        marketMinOrderSize: 5,
      }),
    ).toEqual({ kind: "clamp", size: 8, reason: "orphan-residual" });
  });

  it("escalates a timed-out single SELL into the next split tier", () => {
    const plan = computeSellSizingPlan({
      position: { size: 100, avgEntryPrice: 0.25, costBasisUsdc: 10 },
      sellCount: 0,
      price: 0.25,
      nowMs,
      marketMinOrderSize: 5,
      latestSellOrder: {
        size: 100,
        createdAt: new Date(nowMs - DEFAULT_SELL_TIMEOUT_MS - 1).toISOString(),
        status: "open",
      },
    });

    expect(plan.baseTotalSells).toBe(1);
    expect(plan.expectedTotalSells).toBe(2);
    expect(plan.inferredCurrentTier).toBe(1);
    expect(plan.timeoutEscalated).toBe(true);
    expect(plan.size).toBeCloseTo(43.58, 8);
  });

  it("escalates a timed-out first split SELL into the next split tier", () => {
    const plan = computeSellSizingPlan({
      position: { size: 100, avgEntryPrice: 0.5, costBasisUsdc: 50 },
      sellCount: 0,
      price: 0.5,
      nowMs,
      marketMinOrderSize: 5,
      latestSellOrder: {
        size: 43.58,
        createdAt: new Date(nowMs - DEFAULT_SELL_TIMEOUT_MS - 1).toISOString(),
        status: "cancelled",
        cancelReason: "stale_exit_ttl",
      },
    });

    expect(plan.baseTotalSells).toBe(2);
    expect(plan.expectedTotalSells).toBe(3);
    expect(plan.inferredCurrentTier).toBe(2);
    expect(plan.timeoutEscalated).toBe(true);
    expect(plan.size).toBeCloseTo(27.16, 8);
  });

  it("does not treat an in-window same-price reprice as timeout escalation", () => {
    expect(
      isSellTimeoutReplacement({
        existingOrder: {
          size: 100,
          createdAt: new Date(nowMs - DEFAULT_SELL_TIMEOUT_MS + 1).toISOString(),
          status: "open",
        },
        requestedSize: 43.58,
        nowMs,
        sellTimeoutMs: undefined,
      }),
    ).toBe(false);
  });
});
