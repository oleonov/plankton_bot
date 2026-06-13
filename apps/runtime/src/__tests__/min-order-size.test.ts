import { describe, expect, it } from "vitest";
import { floorToMinOrderStep } from "../min-order-size.js";

describe("floorToMinOrderStep (Track S5 P1)", () => {
  it("truncates down to whole shares when no market step is known (fallback 1)", () => {
    expect(floorToMinOrderStep(100.7, undefined)).toBe(100);
    expect(floorToMinOrderStep(100, undefined)).toBe(100);
    expect(floorToMinOrderStep(0.9, undefined)).toBe(0);
  });

  it("floors to a multiple of the market min order step", () => {
    expect(floorToMinOrderStep(47.3, 5)).toBe(45);
    expect(floorToMinOrderStep(50, 5)).toBe(50);
    expect(floorToMinOrderStep(4, 5)).toBe(0);
  });

  it("uses the explicit fallback step when the market step is unknown", () => {
    expect(floorToMinOrderStep(47.3, null, 5)).toBe(45);
    expect(floorToMinOrderStep(47.3, 0, 5)).toBe(45);
  });

  it("absorbs tiny float undershoot so an exact multiple is not dropped a step", () => {
    expect(floorToMinOrderStep(100 - 1e-12, undefined)).toBe(100);
    expect(floorToMinOrderStep(45 - 1e-12, 5)).toBe(45);
  });

  it("returns 0 for non-positive or non-finite sizes", () => {
    expect(floorToMinOrderStep(0, undefined)).toBe(0);
    expect(floorToMinOrderStep(-5, undefined)).toBe(0);
    expect(floorToMinOrderStep(Number.NaN, undefined)).toBe(0);
    expect(floorToMinOrderStep(Number.POSITIVE_INFINITY, undefined)).toBe(0);
  });
});
