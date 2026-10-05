import { describe, expect, it } from "vitest";
import { isSellablePositionSize, resolveSellableShareFloor } from "../sellable-sizing.js";

// Bounce default fractions used across tests; smallest fraction sets the binding rung.
const FRACS = [0.1, 0.2, 0.3, 0.4];

describe("resolveSellableShareFloor", () => {
  it("derives the floor from the SMALLEST ladder fraction, not tier count", () => {
    // min5 / 0.1 * 1.2 = 60
    expect(resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: FRACS })).toBe(60);
  });

  it("honours a custom buffer", () => {
    // min5 / 0.1 * 1.0 = 50 ; * 1.5 = 75
    expect(resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: FRACS, buffer: 1 })).toBe(
      50,
    );
    expect(
      resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: FRACS, buffer: 1.5 }),
    ).toBe(75);
  });

  it("ceils to a whole share", () => {
    // min5 / 0.3 * 1.2 = 20 exactly; min5 / 0.35 * 1.2 = 17.14 -> 18
    expect(resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: [0.3, 0.7] })).toBe(20);
    expect(resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: [0.35, 0.65] })).toBe(18);
  });

  it("lowers the entry floor from 20 to 6 shares when the ladder is one whole-inventory rung", () => {
    // Accepted entry side effect of the single-rung exit (docs/plans/2026-10-05-single-rung-bounce-exit.md).
    expect(resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: [0.3, 0.4, 0.3] })).toBe(
      20,
    );
    expect(resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: [1] })).toBe(6);
  });

  it("returns null for unknown/invalid minOrderSize (NEVER a fallback floor)", () => {
    expect(resolveSellableShareFloor({ minOrderSize: null, ladderFractions: FRACS })).toBeNull();
    expect(
      resolveSellableShareFloor({ minOrderSize: undefined, ladderFractions: FRACS }),
    ).toBeNull();
    expect(resolveSellableShareFloor({ minOrderSize: 0, ladderFractions: FRACS })).toBeNull();
    expect(resolveSellableShareFloor({ minOrderSize: -5, ladderFractions: FRACS })).toBeNull();
    expect(resolveSellableShareFloor({ minOrderSize: NaN, ladderFractions: FRACS })).toBeNull();
  });

  it("returns null when there is no positive fraction", () => {
    expect(resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: [] })).toBeNull();
    expect(resolveSellableShareFloor({ minOrderSize: 5, ladderFractions: [0, -1] })).toBeNull();
  });
});

describe("isSellablePositionSize", () => {
  it("is true only at/above the floor", () => {
    expect(isSellablePositionSize(60, 60)).toBe(true);
    expect(isSellablePositionSize(61, 60)).toBe(true);
    expect(isSellablePositionSize(59, 60)).toBe(false);
  });

  it("treats a null floor (unknown min) as NOT sellable", () => {
    expect(isSellablePositionSize(1000, null)).toBe(false);
  });
});
