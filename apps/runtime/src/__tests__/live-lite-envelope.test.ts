import { describe, expect, it } from "vitest";
import { resolveLiveLiteMaxFamilies } from "../live-lite-envelope.js";

describe("resolveLiveLiteMaxFamilies", () => {
  it("keeps explicit maxFamilies when configured", () => {
    expect(resolveLiveLiteMaxFamilies({ maxFamilies: 7 }, 12)).toBe(7);
  });

  it("defaults to 100 when maxFamilies not configured", () => {
    expect(resolveLiveLiteMaxFamilies({}, 12)).toBe(100);
  });

  it("defaults to 100 regardless of deployed count", () => {
    expect(resolveLiveLiteMaxFamilies({}, 3)).toBe(100);
  });
});
