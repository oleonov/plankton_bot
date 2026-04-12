import { describe, expect, it } from "vitest";
import { resolveFamilyAssignmentMaxDaysAhead } from "../family-assignment-window.js";

describe("resolveFamilyAssignmentMaxDaysAhead", () => {
  it("caps long-dated threshold deadline families to one week", () => {
    expect(
      resolveFamilyAssignmentMaxDaysAhead({
        horizon: "deadline",
        regime: "threshold",
      }),
    ).toBe(7);
  });

  it("leaves generic deadline families on the default horizon window", () => {
    expect(
      resolveFamilyAssignmentMaxDaysAhead({
        horizon: "deadline",
        regime: "generic",
      }),
    ).toBeUndefined();
  });
});
