import { describe, it, expect } from "vitest";
import { matchesPreEntryFilter, evaluateContinuation } from "./market-selection.js";

describe("matchesPreEntryFilter", () => {
  // STEP 1: event_slug prefix match
  it("includes when eventSlug starts with elon-musk-", () => {
    expect(matchesPreEntryFilter("elon-musk-tweet-count", 5)).toBe(true);
  });

  it("includes when eventSlug starts with bitcoin-", () => {
    expect(matchesPreEntryFilter("bitcoin-price-above-100k", 3)).toBe(true);
  });

  it("includes when eventSlug starts with ethereum-", () => {
    expect(matchesPreEntryFilter("ethereum-merge-date", 2)).toBe(true);
  });

  it("slug prefix match wins regardless of distinctOutcomes", () => {
    expect(matchesPreEntryFilter("elon-musk-fires-someone", 10)).toBe(true);
  });

  // STEP 2: distinct_outcomes = 1
  it("includes when distinctOutcomes is 1 and no slug match", () => {
    expect(matchesPreEntryFilter("random-event", 1)).toBe(true);
  });

  it("includes when eventSlug is null and distinctOutcomes is 1", () => {
    expect(matchesPreEntryFilter(null, 1)).toBe(true);
  });

  // FINAL: exclude
  it("excludes when eventSlug is null and distinctOutcomes > 1", () => {
    expect(matchesPreEntryFilter(null, 2)).toBe(false);
  });

  it("excludes when eventSlug does not match prefix and distinctOutcomes > 1", () => {
    expect(matchesPreEntryFilter("us-election-winner", 3)).toBe(false);
  });

  it("excludes when distinctOutcomes is 0", () => {
    expect(matchesPreEntryFilter(null, 0)).toBe(false);
  });

  // Edge: partial prefix that does NOT match
  it("excludes partial prefix like 'elon-' (not 'elon-musk-')", () => {
    expect(matchesPreEntryFilter("elon-fires-someone", 4)).toBe(false);
  });

  it("excludes 'bitcoins-' (not 'bitcoin-')", () => {
    expect(matchesPreEntryFilter("bitcoins-price", 2)).toBe(false);
  });
});

describe("evaluateContinuation", () => {
  // R1: tradeCount >= 6 → CONTINUE
  it("continues when tradeCount >= 6 regardless of firstTradePrice", () => {
    expect(evaluateContinuation(6, 0.01)).toBe(true);
    expect(evaluateContinuation(10, 0.03)).toBe(true);
  });

  // R2: firstTradePrice >= 0.05 AND tradeCount >= 2 → CONTINUE
  it("continues when firstTradePrice >= 0.05 and tradeCount >= 2", () => {
    expect(evaluateContinuation(2, 0.05)).toBe(true);
    expect(evaluateContinuation(3, 0.1)).toBe(true);
  });

  // R3/Fallback: STOP
  it("stops when tradeCount < 6 and firstTradePrice < 0.05", () => {
    expect(evaluateContinuation(5, 0.04)).toBe(false);
    expect(evaluateContinuation(1, 0.01)).toBe(false);
  });

  it("stops when firstTradePrice >= 0.05 but tradeCount < 2", () => {
    expect(evaluateContinuation(1, 0.05)).toBe(false);
    expect(evaluateContinuation(0, 0.1)).toBe(false);
  });

  it("stops when tradeCount is 0", () => {
    expect(evaluateContinuation(0, 0.03)).toBe(false);
  });

  // Boundary: exactly at R1 threshold
  it("continues at exactly tradeCount=6 with low price", () => {
    expect(evaluateContinuation(6, 0.01)).toBe(true);
  });

  // Boundary: R2 exact threshold
  it("continues at exactly firstTradePrice=0.05 and tradeCount=2", () => {
    expect(evaluateContinuation(2, 0.05)).toBe(true);
  });

  // Boundary: just below R2
  it("stops at firstTradePrice=0.049 and tradeCount=2", () => {
    expect(evaluateContinuation(2, 0.049)).toBe(false);
  });
});
