import { describe, expect, it } from "vitest";
import {
  deriveFamilyLiveness,
  emptyFamilyLivenessSnapshot,
  toFamilyLivenessSnapshot,
} from "./family-liveness.js";

describe("family liveness", () => {
  it("marks a family active when it has active markets", () => {
    expect(
      deriveFamilyLiveness({
        activeMarketCount: 2,
        knownMarketCount: 4,
        lastMarketSeenAt: "2026-04-03T00:00:00Z",
      }),
    ).toBe("active");
  });

  it("marks a family dormant when it has known but no active markets", () => {
    expect(
      deriveFamilyLiveness({
        activeMarketCount: 0,
        knownMarketCount: 3,
        lastMarketSeenAt: "2026-04-03T00:00:00Z",
      }),
    ).toBe("dormant");
  });

  it("marks a family unseen when it has never had markets", () => {
    expect(
      toFamilyLivenessSnapshot({
        activeMarketCount: 0,
        knownMarketCount: 0,
        lastMarketSeenAt: null,
      }),
    ).toEqual(emptyFamilyLivenessSnapshot());
  });
});
