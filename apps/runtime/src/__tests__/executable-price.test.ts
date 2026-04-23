import { describe, expect, it } from "vitest";
import { validateExecutablePrice } from "../executable-price.js";

describe("validateExecutablePrice", () => {
  it("accepts tick-aligned prices inside the executable interval", () => {
    expect(validateExecutablePrice(0.001, 0.001)).toMatchObject({ ok: true });
    expect(validateExecutablePrice(0.999, 0.001)).toMatchObject({ ok: true });
    expect(validateExecutablePrice(0.505, 0.001)).toMatchObject({ ok: true });
  });

  it("rejects prices outside the executable interval", () => {
    expect(validateExecutablePrice(0.0005, 0.001)).toMatchObject({
      ok: false,
      reason: "price-below-min-tick",
    });
    expect(validateExecutablePrice(1, 0.001)).toMatchObject({
      ok: false,
      reason: "price-above-max-bound",
    });
  });

  it("rejects off-grid prices inside the numeric interval", () => {
    expect(validateExecutablePrice(0.5005, 0.001)).toMatchObject({
      ok: false,
      reason: "price-off-tick-grid",
    });
  });
});
