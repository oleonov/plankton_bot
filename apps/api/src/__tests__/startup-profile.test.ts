import { describe, expect, it } from "vitest";
import { resolveStartupLedgerProfile } from "../startup-profile.js";

describe("resolveStartupLedgerProfile", () => {
  it("uses live-lite current profile for API active context", () => {
    expect(
      resolveStartupLedgerProfile({
        currentProfile: "live-lite",
        desiredProfile: "paper",
        envMode: undefined,
      }),
    ).toBe("live-lite");
  });

  it("falls back to live-lite desired profile", () => {
    expect(
      resolveStartupLedgerProfile({
        currentProfile: null,
        desiredProfile: "live-lite",
        envMode: undefined,
      }),
    ).toBe("live-lite");
  });

  it("falls back to live-lite env mode", () => {
    expect(
      resolveStartupLedgerProfile({
        currentProfile: null,
        desiredProfile: null,
        envMode: "live-lite",
      }),
    ).toBe("live-lite");
  });

  it.each([
    { currentProfile: null, desiredProfile: null, envMode: undefined },
    { currentProfile: "paper", desiredProfile: "live-lite", envMode: "live-lite" },
    { currentProfile: "simulation", desiredProfile: "live-lite", envMode: "live-lite" },
    { currentProfile: null, desiredProfile: "paper", envMode: "live-lite" },
    { currentProfile: null, desiredProfile: null, envMode: "paper" },
  ])("rejects unsupported active context %#", (input) => {
    expect(() => resolveStartupLedgerProfile(input)).toThrow(/UNSUPPORTED_RUNTIME_PROFILE/);
  });
});
