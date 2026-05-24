import { describe, expect, it } from "vitest";
import { resolveOpenPositionStatus } from "../position-status.js";

describe("resolveOpenPositionStatus", () => {
  it("keeps sellable low-notional positions open when size meets market minimum", () => {
    expect(resolveOpenPositionStatus(0.34, { size: 23.94, minOrderSize: 5 })).toBe("open");
  });

  it("marks real share dust when size is below market minimum", () => {
    expect(resolveOpenPositionStatus(0.34, { size: 2, minOrderSize: 5 })).toBe("dust");
  });

  it("fails open when market minimum order size is unknown", () => {
    expect(resolveOpenPositionStatus(0.01, { size: 2, minOrderSize: null })).toBe("open");
  });
});
