import { describe, expect, it } from "vitest";
import { roundToTick } from "./tick-math.js";

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
