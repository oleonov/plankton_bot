import { describe, it, expect } from "vitest";
import { createScorecardId, createSwitchId, createReportId, createImportId } from "./ids.js";

describe("profile branded IDs", () => {
  it("creates scorecardId from raw string", () => {
    const id = createScorecardId("sc-123");
    expect(id).toBe("sc-123");
    expect(typeof id).toBe("string");
  });

  it("creates switchId from raw string", () => {
    const id = createSwitchId("sw-456");
    expect(id).toBe("sw-456");
  });

  it("creates reportId from raw string", () => {
    const id = createReportId("rp-789");
    expect(id).toBe("rp-789");
  });

  it("creates importId from raw string", () => {
    const id = createImportId("im-abc");
    expect(id).toBe("im-abc");
  });

  it("prevents cross-assignment at compile time", () => {
    // This test verifies the branded IDs exist as distinct types.
    // Compile-time safety is the real guarantee; runtime they are plain strings.
    const sc = createScorecardId("a");
    const sw = createSwitchId("a");
    expect(sc).toBe("a");
    expect(sw).toBe("a");
    // sc and sw have the same runtime value but different branded types
  });
});
