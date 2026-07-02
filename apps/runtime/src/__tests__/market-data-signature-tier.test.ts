import { describe, it, expect } from "vitest";
import { countTrackedRoleCounts } from "../modules/market-data/market-data-module.js";

describe("signature tier role counting", () => {
  it("counts planktonSignature as its own role", () => {
    const counts = countTrackedRoleCounts([
      "planktonSignature",
      "entryCandidate",
      "planktonSignature",
    ] as never);
    expect(counts.planktonSignature).toBe(2);
    expect(counts.entryCandidate).toBe(1);
  });
});
