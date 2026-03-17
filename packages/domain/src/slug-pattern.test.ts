import { describe, it, expect } from "vitest";
import { slugPatternToRegex } from "./slug-pattern.js";

describe("slugPatternToRegex", () => {
  it("converts wildcard * to match any characters", () => {
    const re = slugPatternToRegex("bitcoin-above-*");
    expect(re.test("bitcoin-above-100k-march-28")).toBe(true);
    expect(re.test("bitcoin-above-")).toBe(true);
    expect(re.test("bitcoin-above-50000")).toBe(true);
  });

  it("rejects non-matching slugs", () => {
    const re = slugPatternToRegex("bitcoin-above-*");
    expect(re.test("bitcoin-below-100k")).toBe(false);
    expect(re.test("will-it-rain")).toBe(false);
    expect(re.test("bitcoin-above")).toBe(false); // no trailing dash
  });

  it("is case-insensitive", () => {
    const re = slugPatternToRegex("Bitcoin-Above-*");
    expect(re.test("bitcoin-above-100k")).toBe(true);
  });

  it("anchors the match (no substring matching)", () => {
    const re = slugPatternToRegex("bitcoin-*");
    expect(re.test("prefix-bitcoin-above")).toBe(false);
    expect(re.test("bitcoin-above-suffix")).toBe(true);
  });

  it("escapes regex special characters in the pattern", () => {
    const re = slugPatternToRegex("price-$100+*");
    expect(re.test("price-$100+tax")).toBe(true);
    expect(re.test("price-X100Ytax")).toBe(false);
  });

  it("converts ? to match exactly one character", () => {
    const re = slugPatternToRegex("btc-?-price");
    expect(re.test("btc-a-price")).toBe(true);
    expect(re.test("btc-ab-price")).toBe(false);
  });
});
