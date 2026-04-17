import { describe, it, expect } from "vitest";
import { matchesPreEntryFilter, evaluateContinuation } from "./market-selection.js";

// Spec v2.2 §0 — Live Pre-Entry Filter is slug-prefix only.
describe("matchesPreEntryFilter", () => {
  it("includes when eventSlug starts with elon-musk-", () => {
    expect(matchesPreEntryFilter("elon-musk-tweet-count")).toBe(true);
  });

  it("includes when eventSlug starts with bitcoin-", () => {
    expect(matchesPreEntryFilter("bitcoin-price-above-100k")).toBe(true);
  });

  it("includes when eventSlug starts with ethereum-", () => {
    expect(matchesPreEntryFilter("ethereum-merge-date")).toBe(true);
  });

  it("excludes when eventSlug is null", () => {
    expect(matchesPreEntryFilter(null)).toBe(false);
  });

  it("excludes when eventSlug does not match any prefix", () => {
    expect(matchesPreEntryFilter("us-election-winner")).toBe(false);
  });

  it("excludes partial prefix 'elon-' (not 'elon-musk-')", () => {
    expect(matchesPreEntryFilter("elon-fires-someone")).toBe(false);
  });

  it("excludes 'bitcoins-' (not 'bitcoin-')", () => {
    expect(matchesPreEntryFilter("bitcoins-price")).toBe(false);
  });

  it("excludes 'etherium-' (typo, not 'ethereum-')", () => {
    expect(matchesPreEntryFilter("etherium-price")).toBe(false);
  });

  it("excludes empty string", () => {
    expect(matchesPreEntryFilter("")).toBe(false);
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

  // Boundaries
  it("continues at exactly tradeCount=6 with low price", () => {
    expect(evaluateContinuation(6, 0.01)).toBe(true);
  });

  it("continues at exactly firstTradePrice=0.05 and tradeCount=2", () => {
    expect(evaluateContinuation(2, 0.05)).toBe(true);
  });

  it("stops at firstTradePrice=0.049 and tradeCount=2", () => {
    expect(evaluateContinuation(2, 0.049)).toBe(false);
  });
});
