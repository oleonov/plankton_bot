import { describe, expect, it } from "vitest";
import { PositionStatus, createConditionId, createPositionId, createTokenId } from "./index.js";
import type { OrderBookSnapshot, Position } from "./types.js";
import { DEFAULT_TRACK_S1_WALKING_LADDER_POLICY } from "./ladder-construction.js";
import { isS1Eligible } from "./s1-eligibility.js";

const tokenId = createTokenId("s1-eligible-token");
const conditionId = createConditionId("s1-cond");
const nowMs = Date.parse("2026-06-12T10:00:00.000Z");
const endDate = "2026-06-12T12:00:01.000Z";
const enabledPolicy = { ...DEFAULT_TRACK_S1_WALKING_LADDER_POLICY, enabled: true };

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("s1-pos"),
    tokenId,
    conditionId,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.014,
    costBasisUsdc: 1.4,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: PositionStatus.Open,
    entryStyle: "probe",
    openedAt: "2026-06-12T09:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-06-12T09:00:00.000Z",
    ...overrides,
  };
}

function book(overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    tokenId,
    bids: [{ price: 0.02, size: 5 }],
    asks: [{ price: 0.12, size: 100 }],
    bestBid: 0.02,
    bestAsk: 0.12,
    midPrice: 0.07,
    spread: 0.1,
    minOrderSize: 10,
    timestamp: nowMs,
    ...overrides,
  };
}

describe("isS1Eligible", () => {
  it("accepts a cheap open longshot with exhausted effective fill depth", () => {
    const result = isS1Eligible({
      position: position(),
      book: book(),
      marketEndDate: endDate,
      nowMs,
      hasActiveS1Ladder: false,
      policy: enabledPolicy,
    });

    expect(result).toMatchObject({ eligible: true, thinReason: "exhausted" });
  });

  it("rejects non-cheap positions without assuming ownership", () => {
    const result = isS1Eligible({
      position: position({ avgEntryPrice: 0.05 }),
      book: book(),
      marketEndDate: endDate,
      nowMs,
      hasActiveS1Ladder: false,
      policy: enabledPolicy,
    });

    expect(result).toMatchObject({ eligible: false, reason: "wrong_tier" });
  });

  it("rejects positions inside the Q.D handoff window", () => {
    const result = isS1Eligible({
      position: position(),
      book: book(),
      marketEndDate: "2026-06-12T10:30:00.000Z",
      nowMs,
      hasActiveS1Ladder: false,
      policy: enabledPolicy,
    });

    expect(result).toMatchObject({ eligible: false, reason: "handoff_window" });
  });

  it("rejects dead markets instead of trying to sell them", () => {
    const result = isS1Eligible({
      position: position(),
      book: book({ bestBid: null, bids: [] }),
      marketEndDate: endDate,
      nowMs,
      hasActiveS1Ladder: false,
      policy: enabledPolicy,
    });

    expect(result).toMatchObject({ eligible: false, reason: "dead_market" });
  });

  it("rejects when the smallest tier would be below min order size", () => {
    const result = isS1Eligible({
      position: position({ size: 90 }),
      book: book(),
      marketEndDate: endDate,
      nowMs,
      hasActiveS1Ladder: false,
      policy: enabledPolicy,
    });

    expect(result).toMatchObject({ eligible: false, reason: "below_min_tier_size" });
  });

  it("does not create a second ladder when one is already active", () => {
    const result = isS1Eligible({
      position: position(),
      book: book(),
      marketEndDate: endDate,
      nowMs,
      hasActiveS1Ladder: true,
      policy: enabledPolicy,
    });

    expect(result).toMatchObject({ eligible: false, reason: "active_ladder_exists" });
  });
});
