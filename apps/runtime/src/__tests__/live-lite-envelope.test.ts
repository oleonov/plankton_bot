import { describe, expect, it } from "vitest";
import { resolveLiveLiteMaxFamilies } from "../live-lite-envelope.js";

describe("resolveLiveLiteMaxFamilies", () => {
  it("keeps explicit maxFamilies when configured", () => {
    expect(resolveLiveLiteMaxFamilies({ maxFamilies: 7 }, 12)).toBe(7);
  });

  it("defaults to deployed family count when it exceeds the legacy floor", () => {
    expect(resolveLiveLiteMaxFamilies({}, 12)).toBe(12);
  });

  it("keeps the legacy floor when deployed family count is smaller", () => {
    expect(resolveLiveLiteMaxFamilies({}, 3)).toBe(10);
  });
});
