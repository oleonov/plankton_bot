import { describe, expect, it } from "vitest";
import { roundToTick, computeHarvestTarget } from "./tick-math.js";

describe("roundToTick", () => {
  it("rounds down to the nearest tick when below midpoint", () => {
    expect(roundToTick(0.124, 0.01)).toBe(0.12);
  });

  it("rounds up to the nearest tick when above midpoint", () => {
    expect(roundToTick(0.126, 0.01)).toBe(0.13);
  });

  it("keeps exact boundary prices stable", () => {
    expect(roundToTick(0.125, 0.005)).toBe(0.125);
  });

  it("leaves the price unchanged when tick size is not usable", () => {
    expect(roundToTick(0.123, 0)).toBe(0.123);
  });
});

// Moved from apps/runtime/src/modules/algo-decision/maker-entry.ts
// (docs/plans/2026-07-15-gate-bounce-live-experiment.md, Phase 3). Same three
// cases as apps/runtime/src/modules/algo-decision/__tests__/maker-entry.test.ts
// verify the move didn't change behavior.
describe("computeHarvestTarget", () => {
  it("ceil-snaps a fine tick grid", () => {
    expect(computeHarvestTarget(0.051, 0.5, 0.001)).toBeCloseTo(0.077, 10);
  });

  it("ceil-snaps a coarse tick grid", () => {
    expect(computeHarvestTarget(0.033, 0.5, 0.01)).toBeCloseTo(0.05, 10);
  });

  it("hits an exact tick boundary without snapping past it", () => {
    expect(computeHarvestTarget(0.1, 0.5, 0.01)).toBeCloseTo(0.15, 10);
  });
});
